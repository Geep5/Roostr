/**
 * The ReAct loop — port of glon agent-runner.ts runLoop with:
 *   - pre-flight auto-compaction (estimate > window − reserve)
 *   - mid-run overflow → compact → retry
 *   - steering: the view is rebuilt from a fresh fetch every iteration, so
 *     user messages that land mid-run are drained naturally
 *   - OMP lift: token-ratio calibration from actual API usage, kept in
 *     memory on the machine that measured it
 * System prompt assembly (buildEffectiveSystem): base system field +
 * <conversation-summary> + memory digest + skills listing + channel
 * instructions.
 */

import { choice, fetchObject, flag, iv, num, setField, str, sv, type ObjectJSON } from "./api";
import { addConvBlock, postTo, type ConvRef } from "./conv";
import { objectContext } from "./spacemap";
import { compactionConfig, doCompact, shouldAutoCompact } from "./compaction";
import { buildConversationView, estimateAskTokens, estimateTokens, type ConversationView } from "./conversation";
import { callLLM, isContextOverflowError, modelProvider } from "./llm";
import { channelInstructions, listSkills, skillsPromptSection } from "./skills";
import { agentModelKey, credentialsPromptLine } from "./credential-objects";
import { dispatchTool, toolDefs, type ToolContext } from "./tools";
import { workspaceAt, workspacePromptSection } from "./workspace";
import { genesisCalls, genesisFingerprint, lastGenesis } from "./genesis";
import { ensureAgentPrompt, promptFor, promptTarget } from "./prompts";
import { digest } from "./memory";
import { BLOCK_TOOL_RESULT, BLOCK_TOOL_USE, MAX_TOOL_ITERATIONS, TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

/**
 * The one rule every agent works under, whatever its editable prompt says:
 * this is a workspace shared with people, who see only what the app shows.
 * An agent once "made a task recurring" by writing a field nothing reads,
 * then said it was done.
 */
export const WORKSPACE_CONTRACT = `<workspace-contract>
You share this space with people. They see only what the app shows: properties, the page body, links, the Repeat cell, the chat.
- Say something is done only when a tool's reply shows it done, and describe it the way that reply does (e.g. "Repeats every 2 weeks on Mon at 9:00 AM", "Due date is now: Oct 3").
- A reply starting "error:" means nothing changed. Do what it points to (another tool, an existing property), or tell the person what didn't happen and why.
- If no tool does what was asked, say so plainly. Never imitate it with a made-up field, a line of text, an emoji or a note - that looks done to you and invisible to them.
</workspace-contract>`;

/**
 * How an agent speaks in a shared chat. Harness-owned like the workspace
 * contract: it holds for every agent, whatever its system prompt says.
 */
export const CHAT_CONDUCT = `<chat-conduct>
The chat is shared by people and agents; every message you post is read. Keep it clean:
- Post only what someone needs: an answer, a result, a question you need answered, or a problem that blocks you. If nothing needs saying, say nothing.
- One message per turn. When your message is the deliverable (you tagged someone, you asked a question, you gave the answer), stop there - no follow-up recapping what you just did.
- Don't narrate your steps ("let me check...", "sending now:"), announce that you're waiting, or explain how someone will reply or how to read their reply. People see replies in the chat on their own.
- To ask another agent something here, tag them once with the question itself.
</chat-conduct>`;

/**
 * Chars-per-token calibration, per agent, in memory only.
 *
 * It used to be a `token_ratio` field on the agent object: one permanent,
 * replicated commit per turn to store a smoothed float that only this
 * machine's provider mix justifies. Each turn recalibrates from actual
 * usage at weight 0.5, so a restart costs at most one turn of slightly
 * coarse estimation - and estimation only sizes the context window.
 */
const tokenRatios = new Map<string, number>();

function tokenRatio(obj: ObjectJSON): number {
	return tokenRatios.get(obj.id) ?? 1;
}

async function persistToolUse(ref: ConvRef, use: { id: string; name: string; input: Record<string, unknown> }): Promise<void> {
	await addConvBlock(ref, {
		id: crypto.randomUUID(),
		childrenIds: [],
		content: {
			custom: {
				contentType: BLOCK_TOOL_USE,
				meta: { tool_use_id: use.id, tool_name: use.name, input: JSON.stringify(use.input), ts: String(Date.now()) },
			},
		},
	});
}

async function persistToolResult(ref: ConvRef, toolUseId: string, content: string, isError: boolean): Promise<void> {
	await addConvBlock(ref, {
		id: crypto.randomUUID(),
		childrenIds: [],
		content: {
			custom: {
				contentType: BLOCK_TOOL_RESULT,
				meta: { tool_use_id: toolUseId, content: content.slice(0, TOOL_RESULT_TRUNCATE), is_error: String(isError), ts: String(Date.now()) },
			},
		},
	});
}

export interface RunOptions {
	template?: string;
	depth?: number;
	spawn?: ToolContext["spawn"];
	submitResult?: (content: string) => void;
	systemSuffix?: string;
	/** True when this turn answers another agent: agent_ask is withheld. */
	a2aTurn?: boolean;
}

/**
 * The system prompt, in labelled sections. Kept as parts (not a joined
 * string) so the exact text the model receives can be published for remote
 * inspection without a second implementation drifting from this one.
 */
export interface SystemPart {
	label: string;
	text: string;
}

async function buildSystemParts(agent: ObjectJSON, host: ObjectJSON, view: ConversationView, opts: RunOptions): Promise<SystemPart[]> {
	// The object this transcript is about: the object naming this agent
	// (`object.agent`) when the thread lives on it; nothing when the thread is
	// the agent's own page or its space (those get the prompt's standing text).
	const objectId = host.id === agent.id || host.typeKey === "channel" ? "" : host.id;
	const spec = await promptFor(agent);
	// The linked prompt object's text. Never a hardcoded fallback - what runs
	// is what Roostr shows.
	const parts: SystemPart[] = [{ label: "Base prompt", text: spec.system }];
	// Fast parts: per-turn context that can change between tool iterations -
	// always re-rendered, never cached.
	if (objectId) {
		try {
			const bc = await objectContext(objectId, str(agent.fields, "channel"));
			parts.push({ label: "Your object", text: bc.object });
			parts.push({ label: "Your type", text: bc.type });
			parts.push({ label: "Connections", text: bc.connections });
			parts.push({ label: "Space map", text: bc.space });
		} catch (err) {
			console.error(`[harness] object context failed for ${agent.id.slice(0, 8)}:`, err);
		}
	}
	if (opts.systemSuffix) parts.push({ label: "Subagent template", text: opts.systemSuffix });
	if (view.systemExtension) parts.push({ label: "Conversation summary", text: view.systemExtension });
	// Slow parts: agent-scoped, expensive to assemble, change only when an
	// input the fingerprint covers changes.
	parts.push(...(await slowSystemParts(agent, spec, opts, objectId)));
	return parts;
}

/**
 * The slow prompt parts, cached per agent. These are the multi-fetch,
 * machine-heavy sections (memory, skills, auth, capabilities, workspace)
 * that stay identical across a turn and across turns until one of their
 * inputs changes. `buildSystemParts` re-renders only the per-turn object
 * and conversation context around them.
 *
 * The fingerprint covers every input, so a hit is never stale:
 *   agent.updatedAt           - model/memory_digest_enabled/repo_path/prompt link
 *   prompt object updatedAt   - the linked system_prompt's own fields
 *   memory count+maxUpdated   - new/edited facts and milestones (separate objects)
 *   skills/credentials/auth/capabilities/instructions/workspace signature
 * A mismatch rebuilds just these parts and re-caches them.
 */
interface SlowParts {
	fingerprint: string;
	parts: SystemPart[];
}
const slowCache = new Map<string, SlowParts>();

/** Max of a set of updatedAt stamps; 0 when the set is empty. */
const maxUpdated = (rows: Array<{ updatedAt: number }>): number => rows.reduce((m, r) => Math.max(m, r.updatedAt ?? 0), 0);

export async function slowSystemParts(agent: ObjectJSON, spec: Awaited<ReturnType<typeof promptFor>>, opts: RunOptions, objectId: string): Promise<SystemPart[]> {
	const agentId = agent.id;
	const channelId = str(agent.fields, "channel");

	// ── Fingerprint inputs (cheap reads; the expensive assembly only runs on a miss) ──
	const promptId = promptTarget(agent.fields);
	const promptObj = promptId ? await fetchObject(promptId).catch(() => null) : null;
	const { listFacts, listMilestones } = await import("./memory");
	const [facts, milestones, skills] = await Promise.all([
		flag(agent.fields, "memory_digest_enabled") ? listFacts(agentId) : Promise.resolve([]),
		flag(agent.fields, "memory_digest_enabled") ? listMilestones(agentId) : Promise.resolve([]),
		listSkills(agentId),
	]);
	const credsLine = await credentialsPromptLine(agent);
	const repo = str(agent.fields, "repo_path");
	const ws = repo ? await workspaceAt(repo).catch(() => null) : null;
	const fingerprint = [
		agent.updatedAt ?? 0,
		promptObj?.updatedAt ?? 0,
		facts.length,
		maxUpdated(facts),
		milestones.length,
		maxUpdated(milestones),
		skills.map((s) => s.id).sort().join(","),
		credsLine,
		channelId,
		repo,
		ws?.path ?? "",
		objectId,
	].join("|");

	const hit = slowCache.get(agentId);
	if (hit && hit.fingerprint === fingerprint) return hit.parts;

	// ── Miss: assemble the slow parts ──
	const parts: SystemPart[] = [];
	if (flag(agent.fields, "memory_digest_enabled")) {
		const d = await digest(agentId);
		if (d) parts.push({ label: "Memory digest", text: d });
	}
	const skillsSection = skillsPromptSection(skills);
	if (skillsSection) parts.push({ label: "Skills", text: skillsSection });
	if (credsLine) parts.push({ label: "Credentials", text: credsLine });
	parts.push({ label: "Workspace contract", text: WORKSPACE_CONTRACT });
	parts.push({ label: "Chat conduct", text: CHAT_CONDUCT });
	const instructions = await channelInstructions(channelId);
	if (instructions) parts.push({ label: "Space instructions", text: instructions });
	// Machine-local by design: the agent's Project folder (`repo_path`) exists
	// only on the machine holding the checkout - which the serving gate
	// guarantees is the one running this turn.
	if (ws) parts.push({ label: "Workspace", text: workspacePromptSection(ws) });

	slowCache.set(agentId, { fingerprint, parts });
	slowStats.builds++;
	return parts;
}

/** Test seam: how many times the slow parts were (re)assembled. Reset per test. */
export const slowStats = { builds: 0 };
export function resetSlowCache(): void {
	slowCache.clear();
	slowStats.builds = 0;
}

/**
 * Publish the assembled prompt so a remote client can read exactly what the
 * model receives — including the sections it could never derive itself (the
 * device note depends on which machine has which skills installed).
 *
 * Written only when the prompt CONTENT changes, which in practice means
 * someone edited the prompt, installed a skill, edited space instructions,
 * or a compaction landed. Steady state costs nothing.
 *
 * The hash deliberately ignores the token estimates carried in the payload:
 * they are derived from a calibration that drifts with every turn's measured
 * usage, so hashing them rewrote both fields on turns where the prompt was
 * byte-identical.
 */
async function publishSystemParts(agentId: string, parts: SystemPart[], ratio: number): Promise<void> {
	const payload = JSON.stringify(parts.map((p) => ({ ...p, tokens: estimateTokens(p.text, ratio) })));
	const hash = Bun.hash(JSON.stringify(parts.map((p) => [p.label, p.text]))).toString(16);
	const agent = await fetchObject(agentId);
	if (str(agent.fields, "system_effective_hash") === hash) return;
	await setField(agentId, "system_effective", sv(payload));
	await setField(agentId, "system_effective_hash", sv(hash));
}

/**
 * Publish an agent's prompt without running a turn, so a client can read what
 * the agent WOULD send before it has ever been messaged. Without this, a
 * freshly created agent shows an empty prompt panel: its `system` field is
 * unset because it uses the built-in default, and that default lives here in
 * the harness where no remote client can see it.
 */
export async function publishSystemSnapshot(agentId: string, ref: ConvRef): Promise<void> {
	try {
		const agent = await ensureAgentPrompt(await fetchObject(agentId));
		const conv = ref.objectId === agentId ? agent : await fetchObject(ref.objectId);
		const view = buildConversationView(conv, agentId, tokenRatio(agent), ref.threadId);
		await publishSystemParts(agentId, await buildSystemParts(agent, conv, view, {}), tokenRatio(agent));
	} catch (err) {
		console.error(`[harness] prompt snapshot failed for ${agentId.slice(0, 8)}:`, err);
	}
}

/**
 * Run the agent until it stops calling tools. Returns the final reply text.
 * The conversation is a thread inside the object it is about: `ref.objectId`
 * is that object (an agent's own transcript lives on the agent object, so
 * ref.objectId === agentId there) and `ref.threadId` is the thread. Every
 * turn artifact (assistant text, tool_use, tool_result) is persisted to the
 * DAG as it happens — a crash resumes cleanly via repairToolPairs.
 */
export async function runTurn(agentId: string, ref: ConvRef, opts: RunOptions = {}): Promise<string> {
	let overflowRetries = 0;
	let lastText = "";

	const ctx: ToolContext = {
		agentId,
		channelId: "",
		depth: opts.depth ?? 0,
		spawn: opts.spawn,
		submitResult: opts.submitResult,
		touched: new Set(),
		allowAsk: !opts.a2aTurn && (opts.depth ?? 0) === 0,
	};

	for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
		// Fresh fetch each iteration: picks up steered user messages and the
		// blocks we just appended.
		const agent = await ensureAgentPrompt(await fetchObject(agentId));
		const conv = ref.objectId === agentId ? agent : await fetchObject(ref.objectId);
		ctx.channelId = str(agent.fields, "channel");
		// The object this turn is about is where its transcript lives: the
		// object naming this agent, or its space - never the agent's own page.
		ctx.boundObject = ref.objectId === agentId ? undefined : ref.objectId;
		// Same checkout the Workspace prompt section describes; a missing
		// directory means home, never a spawn failure.
		const repo = str(agent.fields, "repo_path");
		ctx.workspacePath = repo ? (await workspaceAt(repo).catch(() => null))?.path : undefined;
		const ratio = tokenRatio(agent);
		const cfg = compactionConfig(agent);
		// The model picked on the agent (a select stores a one-item list), else its prompt's.
		const model = choice(agent.fields, "model") || (await promptFor(agent)).model;
		// Its login travels with it: a model credential it lists beats this computer's.
		const apiKey = (await agentModelKey(agent, modelProvider(model))) ?? undefined;
		// Re-read every iteration with everything else, so revoking the grant
		// takes effect on the agent's next tool call rather than its next turn.
		const tools = toolDefs(opts.template ?? "", ctx.depth, ctx.allowAsk);

		let view = buildConversationView(conv, agentId, ratio, ref.threadId);
		const systemParts = await buildSystemParts(agent, conv, view, opts);
		const system = systemParts.map((p) => p.text).join("\n\n");
		// Subagent prompts are per-spawn and ephemeral; only a top-level
		// served agent's prompt is worth publishing for remote inspection.
		if (ctx.depth === 0) await publishSystemParts(agentId, systemParts, ratio);

		// Pre-flight auto-compaction (agent-runner.ts:369-374).
		if (shouldAutoCompact(system, view, tools, cfg, ratio)) {
			const compacted = await doCompact(agentId, ref, view, cfg, ratio);
			if (compacted) {
				const fresh = await fetchObject(ref.objectId);
				view = buildConversationView(fresh, agentId, ratio, ref.threadId);
			}
		}

		if (view.turns.length === 0) return lastText;

		// Genesis: the first turn of this conversation, or the first since an
		// important property changed, opens with the agent reading itself,
		// the object it is on, and this conversation - as tool calls kept in
		// the transcript, so later turns carry them instead of repeating them.
		if (iter === 0 && ctx.depth === 0) {
			const fingerprint = genesisFingerprint(agent, model, (await promptFor(agent)).system);
			if (lastGenesis(view.items) !== fingerprint) {
				for (const call of genesisCalls(agent, ref, fingerprint)) {
					const use = { id: `toolu_genesis_${crypto.randomUUID().replaceAll("-", "")}`, name: call.name, input: call.input };
					await persistToolUse(ref, use);
					const out = await dispatchTool(use.name, use.input, ctx);
					await persistToolResult(ref, use.id, out.content, out.isError);
				}
				view = buildConversationView(await fetchObject(ref.objectId), agentId, ratio, ref.threadId);
				console.log(`[harness] genesis for ${str(agent.fields, "name") || agentId.slice(0, 8)} on ${ref.objectId.slice(0, 8)}/${ref.threadId}`);
			}
		}

		let res;
		try {
			res = await callLLM({ model, system, turns: view.turns, tools, temperature: num(agent.fields, "temperature"), apiKey });
		} catch (err) {
			// Overflow → compact → retry (agent-runner.ts:507-527).
			if (isContextOverflowError(err) && overflowRetries < 2 && cfg.enabled) {
				overflowRetries++;
				await doCompact(agentId, ref, view, cfg, ratio);
				continue;
			}
			throw err;
		}

		// OMP lift: calibrate the estimator from actual usage.
		if (res.inputTokens > 0) {
			const estimated = estimateAskTokens(system, view, tools, 1);
			if (estimated > 0) {
				const newRatio = Math.min(3, Math.max(0.5, res.inputTokens / estimated));
				const smoothed = ratio * 0.5 + newRatio * 0.5;
				tokenRatios.set(agentId, Math.round(smoothed * 100) / 100);
			}
		}

		if (res.text.trim()) {
			await postTo(ref, res.text.trim(), agentId);
			lastText = res.text.trim();
		}

		if (res.toolUses.length === 0) return lastText;

		for (const use of res.toolUses) {
			// Persist into the CONVERSATION thread - the same one the next
			// iteration's view is built from. Writing these to the agent
			// object instead once made every turn amnesiac about its own
			// tool calls: the model re-ran the same action until the
			// iteration cap (14 grocery lists on one page).
			await persistToolUse(ref, use);
			const out = await dispatchTool(use.name, use.input, ctx);
			await persistToolResult(ref, use.id, out.content, out.isError);
		}
	}
	await setField(agentId, "last_run_iterations", iv(MAX_TOOL_ITERATIONS));
	return lastText || "(stopped: tool iteration limit)";
}
