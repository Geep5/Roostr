/**
 * Conversation view: projects the agent object's __discussion__ blocks into
 * Anthropic messages. Ported from glon agent-conversation.ts (classify /
 * filterToKept / repairToolPairs / groupIntoTurns / mergeConsecutiveTurns /
 * findCutIndex) with two OMP lifts:
 *   - in-view tool-output pruning valve (never mutates blocks)
 *   - calibrated token estimator (ratio persisted on the agent object)
 *
 * Compaction stays view-only: every pre-compaction block survives in the
 * DAG; the view starts at the latest summary's first_kept_block_id.
 */

import type { BlockJSON, ObjectJSON } from "./api";
import {
	BLOCK_COMPACTION,
	BLOCK_TOOL_RESULT,
	BLOCK_TOOL_USE,
	PRUNE_MINIMUM_SAVINGS,
	PRUNE_PROTECTED_TOOLS,
	PRUNE_PROTECT_TOKENS,
	safeJsonParse,
	type AnthropicContent,
	type ClassifiedItem,
	type ToolDef,
	type Turn,
} from "./types";

/** Base chars-per-token guess; calibrated by the agent's token_ratio field. */
const CHARS_PER_TOKEN = 2.8;

export function estimateTokens(text: string, ratio = 1): number {
	return Math.ceil((text.length / CHARS_PER_TOKEN) * ratio);
}

export function itemText(item: ClassifiedItem): string {
	switch (item.kind) {
		case "user_text":
		case "assistant_text":
			return item.text;
		case "tool_use":
			return `${item.name} ${JSON.stringify(item.input)}`;
		case "tool_result":
			return item.content;
		case "compaction":
			return item.summary;
	}
}

/** Classify __discussion__ children in append order. */
export function classifyBlocks(object: ObjectJSON, agentId: string): ClassifiedItem[] {
	const byId = new Map(object.blocks.map((b) => [b.id, b]));
	const root = byId.get("__discussion__");
	if (!root) return [];
	const items: ClassifiedItem[] = [];
	for (const cid of root.childrenIds) {
		const block = byId.get(cid);
		const custom = block?.content.custom;
		if (!block || !custom) continue;
		const meta = custom.meta ?? {};
		switch (custom.contentType) {
			case "chat": {
				const author = meta["author"] ?? "";
				const text = meta["text"] ?? "";
				if (author === agentId) items.push({ kind: "assistant_text", blockId: cid, text });
				else items.push({ kind: "user_text", blockId: cid, text, author });
				break;
			}
			case BLOCK_TOOL_USE:
				items.push({
					kind: "tool_use",
					blockId: cid,
					toolUseId: meta["tool_use_id"] ?? "",
					name: meta["tool_name"] ?? "",
					input: (safeJsonParse(meta["input"] ?? "{}") as Record<string, unknown>) ?? {},
				});
				break;
			case BLOCK_TOOL_RESULT:
				items.push({
					kind: "tool_result",
					blockId: cid,
					toolUseId: meta["tool_use_id"] ?? "",
					content: meta["content"] ?? "",
					isError: meta["is_error"] === "true",
				});
				break;
			case BLOCK_COMPACTION:
				items.push({
					kind: "compaction",
					blockId: cid,
					summary: meta["summary"] ?? "",
					firstKeptBlockId: meta["first_kept_block_id"] ?? "",
					tokensBefore: parseInt(meta["tokens_before"] ?? "0", 10) || 0,
					touchedObjects: (meta["touched_objects"] ?? "").split(",").filter(Boolean),
				});
				break;
		}
	}
	return items;
}

export function findLatestCompaction(items: ClassifiedItem[]): Extract<ClassifiedItem, { kind: "compaction" }> | null {
	let latest: Extract<ClassifiedItem, { kind: "compaction" }> | null = null;
	for (const item of items) if (item.kind === "compaction") latest = item; // append order — last wins
	return latest;
}

export function filterToKept(items: ClassifiedItem[], firstKeptBlockId: string): ClassifiedItem[] {
	const idx = items.findIndex((i) => i.blockId === firstKeptBlockId);
	if (idx === -1) return items.filter((i) => i.kind !== "compaction");
	return items.slice(idx).filter((i) => i.kind !== "compaction");
}

/**
 * Enforce tool_use → tool_result adjacency (Anthropic rejects otherwise).
 * Synthesizes an error stub for interrupted calls; drops orphan results.
 * Ported verbatim from agent-conversation.ts:194-234.
 */
export function repairToolPairs(items: ClassifiedItem[]): ClassifiedItem[] {
	const resultByUseId = new Map<string, Extract<ClassifiedItem, { kind: "tool_result" }>>();
	for (const item of items) {
		if (item.kind === "tool_result" && item.toolUseId && !resultByUseId.has(item.toolUseId)) {
			resultByUseId.set(item.toolUseId, item);
		}
	}
	const out: ClassifiedItem[] = [];
	for (const item of items) {
		if (item.kind === "tool_result") continue; // re-emitted adjacent to its use
		out.push(item);
		if (item.kind === "tool_use" && item.toolUseId) {
			const real = resultByUseId.get(item.toolUseId);
			out.push(
				real ?? {
					kind: "tool_result",
					blockId: `__synthetic:${item.toolUseId}`,
					toolUseId: item.toolUseId,
					content: "[tool call was interrupted before producing a result — treat this as a failed call and proceed.]",
					isError: true,
				},
			);
		}
	}
	return out;
}

/**
 * OMP pruning valve (pruning.ts:18-91), applied to the VIEW only: replace
 * old tool_result content with a truncation notice, protecting the newest
 * PRUNE_PROTECT_TOKENS and outputs of read-ish tools; only prunes at all
 * when the total savings clear PRUNE_MINIMUM_SAVINGS.
 */
export function pruneToolOutputs(items: ClassifiedItem[], ratio: number): ClassifiedItem[] {
	const useNames = new Map<string, string>();
	for (const item of items) if (item.kind === "tool_use") useNames.set(item.toolUseId, item.name);

	// Walk backwards accumulating protected budget.
	let acc = 0;
	let protectFrom = items.length;
	for (let i = items.length - 1; i >= 0; i--) {
		acc += estimateTokens(itemText(items[i]), ratio);
		protectFrom = i;
		if (acc >= PRUNE_PROTECT_TOKENS) break;
	}

	let savings = 0;
	const candidates: number[] = [];
	for (let i = 0; i < protectFrom; i++) {
		const item = items[i];
		if (item.kind !== "tool_result" || item.pruned) continue;
		if (PRUNE_PROTECTED_TOOLS.has(useNames.get(item.toolUseId) ?? "")) continue;
		const tokens = estimateTokens(item.content, ratio);
		if (tokens < 100) continue;
		savings += tokens;
		candidates.push(i);
	}
	if (savings < PRUNE_MINIMUM_SAVINGS) return items;

	return items.map((item, i) => {
		if (!candidates.includes(i) || item.kind !== "tool_result") return item;
		const tokens = estimateTokens(item.content, ratio);
		return { ...item, content: `[Output truncated — ${tokens} tokens]`, pruned: true };
	});
}

/** Group contiguous same-role items into turns (agent-conversation.ts:269+). */
export function groupIntoTurns(items: ClassifiedItem[]): Turn[] {
	const roleOf = (item: ClassifiedItem): "user" | "assistant" | null => {
		switch (item.kind) {
			case "user_text":
			case "tool_result":
				return "user";
			case "assistant_text":
			case "tool_use":
				return "assistant";
			case "compaction":
				return null;
		}
	};
	const contentOf = (item: ClassifiedItem): AnthropicContent | null => {
		switch (item.kind) {
			case "user_text":
				return { type: "text", text: item.author ? `[from ${item.author}] ${item.text}` : item.text };
			case "assistant_text":
				return item.text.length > 0 ? { type: "text", text: item.text } : null;
			case "tool_use":
				return { type: "tool_use", id: item.toolUseId, name: item.name, input: item.input };
			case "tool_result":
				return { type: "tool_result", tool_use_id: item.toolUseId, content: item.content, is_error: item.isError || undefined };
			case "compaction":
				return null;
		}
	};

	const turns: Turn[] = [];
	let current: { role: "user" | "assistant"; content: AnthropicContent[] } | null = null;
	for (const item of items) {
		const role = roleOf(item);
		const content = contentOf(item);
		if (!role || !content) continue;
		if (!current || current.role !== role) {
			if (current) turns.push(current);
			current = { role, content: [] };
		}
		current.content.push(content);
	}
	if (current) turns.push(current);
	return turns;
}

/** Merge adjacent same-role turns (agent-conversation.ts:243-265). */
export function mergeConsecutiveTurns(turns: Turn[]): Turn[] {
	const toArray = (c: Turn["content"]): AnthropicContent[] =>
		typeof c === "string" ? (c.length > 0 ? [{ type: "text", text: c }] : []) : [...c];
	const out: Turn[] = [];
	for (const t of turns) {
		const last = out[out.length - 1];
		if (last && last.role === t.role) last.content = [...toArray(last.content), ...toArray(t.content)];
		else out.push({ ...t });
	}
	return out;
}

export interface ConversationView {
	turns: Turn[];
	systemExtension: string;
	items: ClassifiedItem[];
	allItems: ClassifiedItem[];
	latestCompaction: Extract<ClassifiedItem, { kind: "compaction" }> | null;
}

/** Full projection: latest summary → systemExtension; kept items → turns. */
export function buildConversationView(object: ObjectJSON, agentId: string, ratio = 1): ConversationView {
	const allItems = classifyBlocks(object, agentId);
	const latest = findLatestCompaction(allItems);
	let kept = latest ? filterToKept(allItems, latest.firstKeptBlockId) : allItems.filter((i) => i.kind !== "compaction");
	kept = repairToolPairs(kept);
	kept = pruneToolOutputs(kept, ratio);
	const turns = mergeConsecutiveTurns(groupIntoTurns(kept));
	const systemExtension = latest
		? `<conversation-summary>\nEarlier conversation was compacted. Summary:\n${latest.summary}${
				latest.touchedObjects.length ? `\n\nObjects touched earlier: ${latest.touchedObjects.join(", ")}` : ""
			}\n</conversation-summary>`
		: "";
	return { turns, systemExtension, items: kept, allItems, latestCompaction: latest };
}

/** Estimate the full ask payload (agent-conversation.ts:73-90). */
export function estimateAskTokens(system: string, view: ConversationView, tools: ToolDef[], ratio: number): number {
	let total = estimateTokens(system, ratio) + estimateTokens(view.systemExtension, ratio);
	for (const tool of tools) total += estimateTokens(tool.name + tool.description + JSON.stringify(tool.input_schema), ratio);
	for (const item of view.items) total += estimateTokens(itemText(item), ratio) + 8;
	return total;
}

/**
 * Backward walk to the cut point: the first user_text (from newest) where
 * the accumulated kept tokens reach keepRecentTokens (agent-conversation.ts:373-388).
 * Returns the index into `items`; everything before it gets summarized.
 */
export function findCutIndex(items: ClassifiedItem[], keepRecentTokens: number, ratio: number): number {
	let acc = 0;
	for (let i = items.length - 1; i >= 0; i--) {
		acc += estimateTokens(itemText(items[i]), ratio);
		if (acc >= keepRecentTokens && items[i].kind === "user_text") return i;
	}
	return -1;
}
