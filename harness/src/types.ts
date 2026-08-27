/**
 * Shared harness types — ported from glon's agent-types.ts, adapted to
 * Roostr's chat-block conversation model:
 *   - user/assistant turns are Discussion chat blocks (contentType "chat";
 *     author === agentId ⇒ assistant, anyone else ⇒ user)
 *   - tool_use / tool_result / compaction_summary are custom blocks under
 *     the same __discussion__ root, ordered by child order (append order).
 */

export const BLOCK_TOOL_USE = "tool_use";
export const BLOCK_TOOL_RESULT = "tool_result";
export const BLOCK_COMPACTION = "compaction_summary";

export const TOOL_RESULT_TRUNCATE = 8192;
export const SUMMARY_TEMPERATURE = 0.3;
export const SUMMARY_MAX_TOKENS = 2048;
export const SUMMARY_TOOL_RESULT_CAP = 2000;

/** Compaction defaults (holdfast agent-types.ts:16-19). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_RESERVE_TOKENS = 32_768;
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/** OMP-lifted pruning valve defaults (oh-my-pi pruning.ts:18-23). */
export const PRUNE_PROTECT_TOKENS = 40_000;
export const PRUNE_MINIMUM_SAVINGS = 20_000;
/** Tools whose outputs are never pruned (OMP protects read/skill). */
export const PRUNE_PROTECTED_TOOLS = new Set(["object_get", "skill_read"]);

export const MAX_TOOL_ITERATIONS = 50;
export const MAX_SPAWN_DEPTH = 3;
export const SPAWN_CONCURRENCY = 4;

export interface CompactionConfig {
	enabled: boolean;
	contextWindow: number;
	reserveTokens: number;
	keepRecentTokens: number;
	model: string;
}

export type ClassifiedItem =
	| { kind: "user_text"; blockId: string; text: string; author: string }
	| { kind: "assistant_text"; blockId: string; text: string }
	| { kind: "tool_use"; blockId: string; toolUseId: string; name: string; input: Record<string, unknown> }
	| { kind: "tool_result"; blockId: string; toolUseId: string; content: string; isError: boolean; pruned?: boolean }
	| {
			kind: "compaction";
			blockId: string;
			summary: string;
			firstKeptBlockId: string;
			tokensBefore: number;
			touchedObjects: string[];
	  };

export type AnthropicContent =
	| { type: "text"; text: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Turn {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
}

export interface ToolDef {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

export interface LLMResult {
	text: string;
	toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
	stopReason: string;
	inputTokens: number;
	outputTokens: number;
}

export function safeJsonParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}
