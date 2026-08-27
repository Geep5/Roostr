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

import { addBlock, chatPost, fetchObject, flag, fv, iv, num, setField, str, type ObjectJSON } from "./api";
import { compactionConfig, doCompact, shouldAutoCompact } from "./compaction";
import { buildConversationView, estimateAskTokens, type ConversationView } from "./conversation";
import { callLLM, isContextOverflowError } from "./llm";
import { channelInstructions, listSkills, skillsPromptSection } from "./skills";
import { dispatchTool, toolDefs, type ToolContext } from "./tools";
import { digest } from "./memory";
import { BLOCK_TOOL_RESULT, BLOCK_TOOL_USE, MAX_TOOL_ITERATIONS, TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

const DEFAULT_SYSTEM = `You are a helpful agent living inside Roostr, a local-first notes app where
everything is an object in a content-addressed DAG. You converse with your
principal through your chat and through any object's discussion — messages
from other objects arrive framed with their origin and the object's contents.
Use tools to read, search, create, and organize objects; use memory_* tools
to pin durable facts and milestones. Be concise and concrete. When a listed
skill matches the task, read it with skill_read before starting.`;

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
}

async function buildEffectiveSystem(agent: ObjectJSON, view: ConversationView, opts: RunOptions): Promise<string> {
	const parts: string[] = [str(agent.fields, "system") || DEFAULT_SYSTEM];
	if (opts.systemSuffix) parts.push(opts.systemSuffix);
	if (view.systemExtension) parts.push(view.systemExtension);
	if (flag(agent.fields, "memory_digest_enabled")) {
		const d = await digest(agent.id);
		if (d) parts.push(d);
	}
	const skills = await listSkills();
	const skillsSection = skillsPromptSection(skills);
	if (skillsSection) parts.push(skillsSection);
	const instructions = await channelInstructions(str(agent.fields, "channel"));
	if (instructions) parts.push(instructions);
	return parts.join("\n\n");
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
		const ratio = tokenRatio(agent);
		const cfg = compactionConfig(agent);
		const model = str(agent.fields, "model") || "mock";
		const tools = toolDefs(opts.template ?? "", ctx.depth);

		let view = buildConversationView(conv, agentId, ratio);
		const system = await buildEffectiveSystem(agent, view, opts);

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
			await persistToolUse(agentId, use);
			const out = await dispatchTool(use.name, use.input, ctx);
			await persistToolResult(agentId, use.id, out.content, out.isError);
		}
	}
	await setField(agentId, "last_run_iterations", iv(MAX_TOOL_ITERATIONS));
	return lastText || "(stopped: tool iteration limit)";
}
