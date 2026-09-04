/**
 * The ReAct loop — port of glon agent-runner.ts runLoop with:
 *   - pre-flight auto-compaction (estimate > window − reserve)
 *   - mid-run overflow → compact → retry
 *   - steering: the view is rebuilt from a fresh fetch every iteration, so
 *     user messages that land mid-run are drained naturally
 *   - OMP lift: token-ratio calibration from actual API usage, persisted
 *     on the agent object (token_ratio field)
 * System prompt assembly (buildEffectiveSystem): base system field +
 * <conversation-summary> + memory digest + skills listing + channel
 * instructions.
 */

import { addBlock, chatPost, fetchObject, flag, fv, iv, num, setField, str, sv, type ObjectJSON } from "./api";
import { boundObjectContext } from "./spacemap";
import { compactionConfig, doCompact, shouldAutoCompact } from "./compaction";
import { buildConversationView, estimateAskTokens, estimateTokens, type ConversationView } from "./conversation";
import { callLLM, isContextOverflowError } from "./llm";
import { channelInstructions, listSkills, skillsPromptSection } from "./skills";
import { dispatchTool, toolDefs, type ToolContext } from "./tools";
import { digest } from "./memory";
import { BLOCK_TOOL_RESULT, BLOCK_TOOL_USE, MAX_TOOL_ITERATIONS, TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

const OBJECT_AGENT_PRIMER = `You are the agent of exactly one object in Roostr - a local-first
knowledge space where every note, person, task, and project is an object
with typed properties, living in exactly one space, connected by links.
Saved views (queries/collections) are the human's own groupings of the
space - treat them as the semantic map.

Your world, in the sections below: your object (its fields), its type
(what the human says it means), its connections (typed links in and out),
and the space census. Bodies of neighbors are one object_get away.

Economics: reading is free and unlimited - space_map, neighborhood, find,
query_run, object_get cost nothing. Query until you understand. Act on
your object and its space with the write tools when asked. Answer the
human in the discussion plainly and concretely.

Identity: in this workspace you go by your object's name. If your object
is "Maki Ehara", you ARE the Maki Ehara object's mind and that is the only
name you use - never introduce yourself as Claude, an AI model, or "the
agent for X". For a person object you are the keeper of their profile,
not the person: speak about them in third person, never pretend to be
them. Skip introductions and menu-of-options boilerplate entirely -
answer the question directly, as this object.`;

const DEFAULT_SYSTEM = `You are a helpful agent living inside Roostr, a local-first notes app where
everything is an object in a content-addressed DAG. You converse with your
principal through your chat and through any object's discussion — messages
from other objects arrive framed with their origin and the object's contents.
ALWAYS answer in plain text: your final reply is posted to the surface the
question came from automatically (never use chat_reply_on for that; it is
only for unprompted messages on OTHER objects). Use tools to read, search,
create, and organize objects; use memory_* tools to pin durable facts and
milestones. Be concise and concrete. When a listed skill matches the task,
read it with skill_read before starting.`;

function tokenRatio(obj: ObjectJSON): number {
	return num(obj.fields, "token_ratio") ?? 1;
}

async function persistToolUse(convId: string, use: { id: string; name: string; input: Record<string, unknown> }): Promise<void> {
	await addBlock(
		convId,
		{
			id: crypto.randomUUID(),
			childrenIds: [],
			content: {
				custom: {
					contentType: BLOCK_TOOL_USE,
					meta: { tool_use_id: use.id, tool_name: use.name, input: JSON.stringify(use.input), ts: String(Date.now()) },
				},
			},
		},
		"__discussion__",
		5,
	);
}

async function persistToolResult(convId: string, toolUseId: string, content: string, isError: boolean): Promise<void> {
	await addBlock(
		convId,
		{
			id: crypto.randomUUID(),
			childrenIds: [],
			content: {
				custom: {
					contentType: BLOCK_TOOL_RESULT,
					meta: { tool_use_id: toolUseId, content: content.slice(0, TOOL_RESULT_TRUNCATE), is_error: String(isError), ts: String(Date.now()) },
				},
			},
		},
		"__discussion__",
		5,
	);
}

export interface RunOptions {
	template?: string;
	depth?: number;
	spawn?: ToolContext["spawn"];
	submitResult?: (content: string) => void;
	systemSuffix?: string;
	/** Wake another agent on a pair chat - present on human-rooted turns only. */
	wake?: (targetAgentId: string, pairChatId: string) => Promise<string>;
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

async function buildSystemParts(agent: ObjectJSON, view: ConversationView, opts: RunOptions): Promise<SystemPart[]> {
	const boundId = str(agent.fields, "bound_object");
	const parts: SystemPart[] = [{ label: "Base prompt", text: str(agent.fields, "system") || (boundId ? OBJECT_AGENT_PRIMER : DEFAULT_SYSTEM) }];
	if (boundId) {
		try {
			const bc = await boundObjectContext(boundId, str(agent.fields, "channel"));
			parts.push({ label: "Your object", text: bc.object });
			parts.push({ label: "Your type", text: bc.type });
			parts.push({ label: "Connections", text: bc.connections });
			parts.push({ label: "Space map", text: bc.space });
		} catch (err) {
			console.error(`[harness] bound context failed for ${agent.id.slice(0, 8)}:`, err);
		}
	}
	if (opts.systemSuffix) parts.push({ label: "Subagent template", text: opts.systemSuffix });
	if (view.systemExtension) parts.push({ label: "Conversation summary", text: view.systemExtension });
	if (flag(agent.fields, "memory_digest_enabled")) {
		const d = await digest(agent.id);
		if (d) parts.push({ label: "Memory digest", text: d });
	}
	const skills = await listSkills(agent.id);
	const skillsSection = skillsPromptSection(skills);
	if (skillsSection) parts.push({ label: "Skills", text: skillsSection });
	const instructions = await channelInstructions(str(agent.fields, "channel"));
	if (instructions) parts.push({ label: "Space instructions", text: instructions });
	return parts;
}

/**
 * Publish the assembled prompt so a remote client can read exactly what the
 * model receives — including the sections it could never derive itself (the
 * device note depends on which machine has which skills installed).
 *
 * Written only when the text changes, which in practice means when someone
 * edits the prompt, installs a skill, edits space instructions, or a
 * compaction lands. Steady state costs nothing.
 */
async function publishSystemParts(agentId: string, parts: SystemPart[], ratio: number): Promise<void> {
	const payload = JSON.stringify(parts.map((p) => ({ ...p, tokens: estimateTokens(p.text, ratio) })));
	const hash = Bun.hash(payload).toString(16);
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
export async function publishSystemSnapshot(agentId: string, convId: string): Promise<void> {
	try {
		const agent = await fetchObject(agentId);
		const conv = convId === agentId ? agent : await fetchObject(convId);
		const view = buildConversationView(conv, agentId, tokenRatio(agent));
		await publishSystemParts(agentId, await buildSystemParts(agent, view, {}), tokenRatio(agent));
	} catch (err) {
		console.error(`[harness] prompt snapshot failed for ${agentId.slice(0, 8)}:`, err);
	}
}

/**
 * Run the agent until it stops calling tools. Returns the final reply text.
 * The conversation lives on `convId` (the agent's holistic chat; subagents
 * converse on their own object, convId === agentId). Every turn artifact
 * (assistant text, tool_use, tool_result) is persisted to the DAG as it
 * happens — a crash resumes cleanly via repairToolPairs.
 */
export async function runTurn(agentId: string, convId: string, opts: RunOptions = {}): Promise<string> {
	let overflowRetries = 0;
	let lastText = "";

	const ctx: ToolContext = {
		agentId,
		channelId: "",
		depth: opts.depth ?? 0,
		spawn: opts.spawn,
		submitResult: opts.submitResult,
		touched: new Set(),
	};

	for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
		// Fresh fetch each iteration: picks up steered user messages and the
		// blocks we just appended.
		const agent = await fetchObject(agentId);
		const conv = convId === agentId ? agent : await fetchObject(convId);
		ctx.channelId = str(agent.fields, "channel");
		ctx.boundObject = str(agent.fields, "bound_object") || undefined;
		ctx.wake = opts.a2aTurn ? undefined : opts.wake;
		const ratio = tokenRatio(agent);
		const cfg = compactionConfig(agent);
		const model = str(agent.fields, "model") || "mock";
		// Re-read every iteration with everything else, so revoking the grant
		// takes effect on the agent's next tool call rather than its next turn.
		const tools = toolDefs(opts.template ?? "", ctx.depth, !opts.a2aTurn && !!opts.wake);

		let view = buildConversationView(conv, agentId, ratio);
		const systemParts = await buildSystemParts(agent, view, opts);
		const system = systemParts.map((p) => p.text).join("\n\n");
		// Subagent prompts are per-spawn and ephemeral; only a top-level
		// served agent's prompt is worth publishing for remote inspection.
		if (ctx.depth === 0) await publishSystemParts(agentId, systemParts, ratio);

		// Pre-flight auto-compaction (agent-runner.ts:369-374).
		if (shouldAutoCompact(system, view, tools, cfg, ratio)) {
			const compacted = await doCompact(agentId, convId, view, cfg, ratio);
			if (compacted) {
				const fresh = await fetchObject(convId);
				view = buildConversationView(fresh, agentId, ratio);
			}
		}

		if (view.turns.length === 0) return lastText;

		let res;
		try {
			res = await callLLM({ model, system, turns: view.turns, tools, temperature: num(agent.fields, "temperature") });
		} catch (err) {
			// Overflow → compact → retry (agent-runner.ts:507-527).
			if (isContextOverflowError(err) && overflowRetries < 2 && cfg.enabled) {
				overflowRetries++;
				await doCompact(agentId, convId, view, cfg, ratio);
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
				await setField(agentId, "token_ratio", fv(Math.round(smoothed * 100) / 100));
			}
		}

		if (res.text.trim()) {
			await chatPost(convId, res.text.trim(), agentId);
			lastText = res.text.trim();
		}

		if (res.toolUses.length === 0) return lastText;

		for (const use of res.toolUses) {
			// Persist to the CONVERSATION object - the same one the next
			// iteration's view is built from. Writing these to the agent
			// object instead once made every turn amnesiac about its own
			// tool calls: the model re-ran the same action until the
			// iteration cap (14 grocery lists on one page).
			await persistToolUse(convId, use);
			const out = await dispatchTool(use.name, use.input, ctx);
			await persistToolResult(convId, use.id, out.content, out.isError);
		}
	}
	await setField(agentId, "last_run_iterations", iv(MAX_TOOL_ITERATIONS));
	return lastText || "(stopped: tool iteration limit)";
}
