/**
 * Compaction — port of glon agent-compaction.ts with the OMP lifts:
 *   Stage A (opt-in): extraction mini-loop writes facts/milestones from the
 *     to-be-compacted slice BEFORE summarizing.
 *   Stage B: rolling-summary LLM call (exact holdfast markdown structure),
 *     stored as ONE compaction_summary block. Old blocks stay in the DAG —
 *     compaction is a view, not a delete.
 *   OMP lift: touched-object ids are carried across stacked compactions.
 */

import { addBlock, fetchObject, flag, str, type ObjectJSON } from "./api";
import { estimateAskTokens, estimateTokens, findCutIndex, itemText, type ConversationView } from "./conversation";
import { callLLM } from "./llm";
import { dispatchTool, toolDefs, type ToolContext } from "./tools";
import {
	BLOCK_COMPACTION,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_KEEP_RECENT_TOKENS,
	DEFAULT_RESERVE_TOKENS,
	SUMMARY_MAX_TOKENS,
	SUMMARY_TEMPERATURE,
	SUMMARY_TOOL_RESULT_CAP,
	type AnthropicContent,
	type ClassifiedItem,
	type CompactionConfig,
	type ToolDef,
	type Turn,
} from "./types";

export function compactionConfig(obj: ObjectJSON): CompactionConfig {
	const numField = (key: string, dflt: number) => {
		const v = obj.fields[key];
		return v?.intValue ?? v?.floatValue ?? dflt;
	};
	return {
		enabled: obj.fields["compaction_enabled"]?.boolValue !== false,
		contextWindow: numField("compaction_context_window", DEFAULT_CONTEXT_WINDOW),
		reserveTokens: numField("compaction_reserve_tokens", DEFAULT_RESERVE_TOKENS),
		keepRecentTokens: numField("compaction_keep_recent_tokens", DEFAULT_KEEP_RECENT_TOKENS),
		model: str(obj.fields, "compaction_model") || str(obj.fields, "model") || "mock",
	};
}

export function shouldAutoCompact(system: string, view: ConversationView, tools: ToolDef[], cfg: CompactionConfig, ratio: number): boolean {
	if (!cfg.enabled) return false;
	return estimateAskTokens(system, view, tools, ratio) > cfg.contextWindow - cfg.reserveTokens;
}

function serializeForSummary(items: ClassifiedItem[]): string {
	const lines: string[] = [];
	for (const item of items) {
		switch (item.kind) {
			case "user_text":
				lines.push(`[user${item.author ? ` ${item.author}` : ""}] ${item.text}`);
				break;
			case "assistant_text":
				lines.push(`[assistant] ${item.text}`);
				break;
			case "tool_use":
				lines.push(`[tool ${item.name}] ${JSON.stringify(item.input).slice(0, 400)}`);
				break;
			case "tool_result":
				lines.push(`[result${item.isError ? " ERROR" : ""}] ${item.content.slice(0, SUMMARY_TOOL_RESULT_CAP)}`);
				break;
			case "compaction":
				break;
		}
	}
	return lines.join("\n");
}

/** Exact holdfast summary structure (agent-compaction.ts:85-133). */
function buildSummaryPrompt(items: ClassifiedItem[], priorSummary: string, extractionRan: boolean): string {
	const priorBlock = priorSummary
		? `\n\nPrior summary being superseded (integrate into the new summary — do not drop facts from it):\n${priorSummary}\n`
		: "";
	const extractionBlock = extractionRan
		? `\n\nDurable facts and narrative milestones have already been extracted to a structured memory store in a prior pass. Keep this summary focused on the short-term arc of the kept region — goal, current state, next steps. Do not re-enumerate every fact; memory covers that.\n`
		: "";
	return `You are summarising an agent's conversation to free up context window space.

Preserve everything the agent will need to continue without re-reading the prior turns:
- What the primary peer is trying to accomplish
- Constraints, preferences, and boundaries stated
- Progress so far — what's done, what's in flight, what's blocked
- Key decisions and their rationale
- Concrete next steps
- Facts that must survive future compactions (names, dates, ids, contact info, pinned context)
- Open threads (things started but not yet resolved)

Write the summary in this exact markdown structure:

## Goal
[1-3 sentences on what the peer wants right now]

## Constraints & Preferences
- [one item per line]

## Progress
### Done
- [x] [completed items]
### In Progress
- [ ] [current work]
### Blocked
- [blockers, if any]

## Key Decisions
- **[decision]**: [rationale]

## Next Steps
1. [most important next action]
2. [...]

## Critical Context
- [concrete facts: names, dates, ids, contact info]

<pinned-facts>
[one short line per fact worth carrying forever]
</pinned-facts>

<open-threads>
[one short line per unresolved thread]
</open-threads>
${priorBlock}${extractionBlock}

Conversation to summarise:

${serializeForSummary(items)}`;
}

const EXTRACTION_SYSTEM = `You are extracting durable knowledge from a
conversation slice that is about to be compacted. Write structured memory
via the memory_* tools:

- memory_upsert_fact for atomic, key-value truths (preferences, contact info,
  configuration, boundaries). One row per \`key\`; upserting with the same key
  replaces the value. Use short, stable keys.
- memory_upsert_milestone for narrative arcs: projects, decisions, phases.
  Pass supersedes=[id,...] when this milestone amends or replaces older ones.
- memory_amend_milestone when correcting an existing milestone in place — prefer
  this over creating a new milestone with supersedes when the change is small.
- memory_list_facts / memory_list_milestones / memory_recall to inspect the
  current memory state BEFORE writing, so you don't duplicate what's already known.

Rules:
- Quality over quantity. A terse, accurate set beats a verbose, speculative one.
- Do not invent facts. If the conversation didn't state something, don't pin it.
- Prefer amendments over new milestones when the subject already exists.
- When done, reply with one short paragraph summarising what you wrote and why.`;

const MEMORY_TOOL_NAMES = new Set([
	"memory_upsert_fact",
	"memory_upsert_milestone",
	"memory_amend_milestone",
	"memory_list_facts",
	"memory_list_milestones",
	"memory_recall",
]);

/** Stage A: extraction mini-loop, max 8 iterations, never blocks Stage B. */
async function runExtractionLoop(agentId: string, model: string, items: ClassifiedItem[]): Promise<boolean> {
	const tools = toolDefs("", 0).filter((t) => MEMORY_TOOL_NAMES.has(t.name));
	const ctx: ToolContext = { agentId, channelId: "", depth: 0, touched: new Set() };
	const turns: Turn[] = [
		{ role: "user", content: `Extract durable memory from this conversation slice:\n\n${serializeForSummary(items)}` },
	];
	try {
		for (let i = 0; i < 8; i++) {
			const res = await callLLM({ model, system: EXTRACTION_SYSTEM, turns, tools, maxTokens: 2048 });
			if (res.toolUses.length === 0) return true;
			const assistantContent: AnthropicContent[] = [];
			if (res.text) assistantContent.push({ type: "text", text: res.text });
			for (const use of res.toolUses) assistantContent.push({ type: "tool_use", id: use.id, name: use.name, input: use.input });
			turns.push({ role: "assistant", content: assistantContent });
			const results: AnthropicContent[] = [];
			for (const use of res.toolUses) {
				const out = await dispatchTool(use.name, use.input, ctx);
				results.push({ type: "tool_result", tool_use_id: use.id, content: out.content, is_error: out.isError || undefined });
			}
			turns.push({ role: "user", content: results });
		}
		return true;
	} catch {
		return false; // extraction is best-effort; Stage B proceeds regardless
	}
}

/**
 * Compact: cut, (extract), summarize, append ONE compaction_summary block.
 * Returns true when a compaction happened.
 */
export async function doCompact(agentId: string, view: ConversationView, cfg: CompactionConfig, ratio: number): Promise<boolean> {
	const cut = findCutIndex(view.items, cfg.keepRecentTokens, ratio);
	if (cut <= 0) return false;
	const toCompact = view.items.slice(0, cut);
	const firstKept = view.items[cut];

	const agent = await fetchObject(agentId);
	let extractionRan = false;
	if (flag(agent.fields, "memory_extraction_enabled")) {
		extractionRan = await runExtractionLoop(agentId, cfg.model, toCompact);
	}

	const prior = view.latestCompaction;
	const res = await callLLM({
		model: cfg.model,
		system: "You are summarising an agent's conversation to free up context window space.",
		turns: [{ role: "user", content: buildSummaryPrompt(toCompact, prior?.summary ?? "", extractionRan) }],
		tools: [],
		maxTokens: SUMMARY_MAX_TOKENS,
		temperature: SUMMARY_TEMPERATURE,
	});

	// OMP lift: carry touched object ids across stacked compactions.
	const touched = new Set(prior?.touchedObjects ?? []);
	for (const item of toCompact) {
		if (item.kind !== "tool_use") continue;
		const id = item.input["id"] ?? item.input["object_id"];
		if (typeof id === "string" && id) touched.add(id);
	}

	let tokensBefore = 0;
	for (const item of toCompact) tokensBefore += estimateTokens(itemText(item), ratio);

	await addBlock(
		agentId,
		{
			id: crypto.randomUUID(),
			childrenIds: [],
			content: {
				custom: {
					contentType: BLOCK_COMPACTION,
					meta: {
						summary: res.text,
						first_kept_block_id: firstKept.blockId,
						tokens_before: String(tokensBefore),
						touched_objects: [...touched].slice(0, 40).join(","),
						ts: String(Date.now()),
						...(prior ? { prior_summary_id: prior.blockId } : {}),
					},
				},
			},
		},
		"__discussion__",
		5, // INNER
	);
	return true;
}
