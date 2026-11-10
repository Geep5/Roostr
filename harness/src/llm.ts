/**
 * Provider layer — trimmed port of glon agent-llm.ts. Anthropic Messages
 * API (streamed, with thinking on agent turns) + Moonshot Kimi
 * (OpenAI-shaped), plus a deterministic "mock" model for offline smoke
 * tests. Overflow detection mirrors isContextOverflowError
 * (agent-llm.ts:673-676).
 */

import type { LLMProgress, LLMResult, ThinkingContent, ToolDef, Turn } from "./types";
import { resolveAnthropicAuth, resolveKimiKey } from "./auth";

export interface LLMRequest {
	model: string;
	system: string;
	turns: Turn[];
	tools: ToolDef[];
	maxTokens?: number;
	/** Ignored when `thinking` is on: thinking takes no custom temperature. */
	temperature?: number;
	/** The agent's own model key (a Credential it lists); overrides this computer's login. */
	apiKey?: string;
	/** Ask Claude to think first (agent turns). Kimi and the mock model never think. */
	thinking?: boolean;
	/** Called as the streamed answer arrives. */
	progress?: LLMProgress;
}

/**
 * Tokens of thinking a manual-mode model may spend per call, added on top of
 * the caller's `maxTokens` so the answer keeps all of its room (the API
 * wants max_tokens > budget_tokens >= 1024).
 */
export const THINKING_BUDGET_TOKENS = 8192;

/**
 * The documented thinking configuration for a model, with the max_tokens it
 * needs. Claude 4.6 and later (and every Claude 5) take only adaptive
 * thinking - `type: "enabled"` is a 400 there - and return thinking text only
 * with `display: "summarized"`; earlier models take manual extended thinking
 * with a budget.
 */
export function thinkingConfig(model: string, maxTokens: number): { thinking: Record<string, unknown>; maxTokens: number; manual: boolean } {
	const version = model.match(/^claude-(?:[a-z]+-)?(\d+)(?:-(\d{1,2}))?(?:-|$)/);
	const major = version ? Number(version[1]) : 0;
	const minor = version?.[2] ? Number(version[2]) : 0;
	const adaptive = major > 4 || (major === 4 && minor >= 6);
	if (adaptive) return { thinking: { type: "adaptive", display: "summarized" }, maxTokens: maxTokens + THINKING_BUDGET_TOKENS, manual: false };
	return { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS }, maxTokens: maxTokens + THINKING_BUDGET_TOKENS, manual: true };
}

export function isContextOverflowError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /prompt is too long|context.*(length|window)|maximum.*tokens|too many tokens/i.test(msg);
}

// ── Claude Code OAuth impersonation (glon agent-llm.ts:35-58) ────

/** Must be a current Claude Code release: Anthropic refuses newer models (Opus 5.5 needs 2.1.280+) to older versions on a plan login. */
const CLAUDE_CODE_VERSION = "2.1.302";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_TOOL_PREFIX = "proxy_";
/** Interleaved thinking: manual-mode models think between tool calls only with this beta. */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	INTERLEAVED_THINKING_BETA,
	"prompt-caching-scope-2026-01-05",
].join(",");
const PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000];
const RETRYABLE_PROVIDER_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function retryableProviderError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /socket connection was closed unexpectedly|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|temporarily unavailable/i.test(msg);
}

export async function fetchWithRetry(input: string, init: RequestInit, retryDelaysMs: readonly number[] = PROVIDER_RETRY_DELAYS_MS): Promise<Response> {
	let last: unknown;
	for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
		try {
			const res = await fetch(input, init);
			if (!RETRYABLE_PROVIDER_STATUS.has(res.status)) return res;
			const body = await res.text();
			last = new Error(`${input} ${res.status}: ${body.slice(0, 600)}`);
		} catch (err) {
			last = err;
			if (!retryableProviderError(err)) throw err;
		}
		if (attempt < retryDelaysMs.length) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
	}
	throw last instanceof Error ? last : new Error(String(last));
}

const CLAUDE_CODE_STAINLESS_HEADERS: Record<string, string> = {
	"X-Stainless-Helper-Method": "stream",
	"X-Stainless-Retry-Count": "0",
	"X-Stainless-Runtime-Version": "v24.13.1",
	"X-Stainless-Package-Version": "0.73.0",
	"X-Stainless-Runtime": "node",
	"X-Stainless-Lang": "js",
	"X-Stainless-Arch": "arm64",
	"X-Stainless-Os": "MacOS",
	"X-Stainless-Timeout": "600",
};

/** Half a UTF-16 pair: a high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A model request as JSON with every string well-formed. Text cut anywhere
 * along the way (`.slice` through an emoji) leaves half a UTF-16 pair, which
 * JSON.stringify writes as a lone `\ud83d` - and the API rejects the whole
 * request ("unexpected end of hex escape"), on every turn after. The half
 * becomes U+FFFD instead.
 */
export function requestJson(body: unknown): string {
	return JSON.stringify(body, (_key, value: unknown) => (typeof value === "string" ? value.replace(LONE_SURROGATE, "\uFFFD") : value));
}

/** Prompt-caching stamps (agent-llm.ts:137-163). */
function applyPromptCaching(body: Record<string, unknown>): void {
	const stamp = { type: "ephemeral" } as const;
	const system = body.system as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(system) && system.length > 0) system[system.length - 1].cache_control = stamp;
	const tools = body.tools as Array<Record<string, unknown>> | undefined;
	if (Array.isArray(tools) && tools.length > 0) tools[tools.length - 1].cache_control = stamp;
	const messages = body.messages as Array<{ content: unknown }> | undefined;
	if (Array.isArray(messages) && messages.length > 0) {
		const last = messages[messages.length - 1];
		if (typeof last.content === "string") {
			last.content = [{ type: "text", text: last.content, cache_control: stamp }];
		} else if (Array.isArray(last.content) && last.content.length > 0) {
			const tail = last.content[last.content.length - 1] as Record<string, unknown>;
			last.content[last.content.length - 1] = { ...tail, cache_control: stamp };
		}
	}
}

async function callAnthropic(req: LLMRequest): Promise<LLMResult> {
	// A pasted subscription token (`claude setup-token`) is OAuth; an API key is not.
	// No key on the agent: this computer's own Claude sign-in - which, when it fails, says what the agent is missing.
	const auth = req.apiKey
		? { token: req.apiKey, isOAuth: req.apiKey.startsWith("sk-ant-oat") }
		: await resolveAnthropicAuth().catch((err) => {
				throw new Error(`This agent lists no Anthropic credential, and this computer's own Claude sign-in failed (${err instanceof Error ? err.message.slice(0, 160) : String(err)}). Add the space's "Anthropic" credential to the agent's Credentials, and sign in with Claude in Settings or paste a key in it.`);
			});
	const maxTokens = req.maxTokens ?? 4096;
	const thinking = req.thinking ? thinkingConfig(req.model, maxTokens) : null;
	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: thinking ? thinking.maxTokens : maxTokens,
		messages: req.turns,
		stream: true,
	};
	if (thinking) body.thinking = thinking.thinking;
	else if (req.temperature !== undefined) body.temperature = req.temperature;
	body.system = auth.isOAuth
		? [{ type: "text", text: CLAUDE_CODE_SYSTEM_INSTRUCTION }, ...(req.system ? [{ type: "text", text: req.system }] : [])]
		: req.system
			? [{ type: "text", text: req.system }]
			: undefined;
	if (req.tools.length > 0) {
		body.tools = req.tools.map((t) => ({
			name: auth.isOAuth ? `${CLAUDE_CODE_TOOL_PREFIX}${t.name}` : t.name,
			description: t.description,
			input_schema: t.input_schema,
		}));
	}
	applyPromptCaching(body);

	const headers: Record<string, string> = {
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	};
	if (auth.isOAuth) {
		headers["Authorization"] = `Bearer ${auth.token}`;
		headers["anthropic-beta"] = CLAUDE_CODE_BETAS;
		headers["User-Agent"] = `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
		headers["X-App"] = "cli";
		Object.assign(headers, CLAUDE_CODE_STAINLESS_HEADERS);
	} else {
		headers["x-api-key"] = auth.token;
		if (thinking?.manual) headers["anthropic-beta"] = INTERLEAVED_THINKING_BETA;
	}

	const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers,
		body: requestJson(body),
	});
	if (!res.ok) {
		const errBody = await res.text();
		// A refused plan login is marked on the credentials holding it (loaded lazily: claude-plan reaches the store).
		if (res.status === 401 && auth.isOAuth) {
			const why = (errBody.match(/"message"\s*:\s*"([^"]*)"/)?.[1] ?? "HTTP 401").slice(0, 150);
			await import("./claude-plan").then((m) => m.planRefused(auth.token, why)).catch((err) => console.error("[claude-plan] marking a refused login:", err instanceof Error ? err.message : err));
		}
		throw new Error(`anthropic ${res.status}: ${errBody.slice(0, 600)}`);
	}
	return readAnthropicStream(res, req.progress, auth.isOAuth ? CLAUDE_CODE_TOOL_PREFIX : "");
}

/** One content block of a streamed message, as it accumulates. */
type StreamBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature: string }
	| { type: "redacted_thinking"; data: string }
	| { type: "tool_use"; id: string; name: string; json: string }
	| { type: "other" };

/**
 * A streamed Messages response (server-sent events) folded into the result
 * callers expect, reporting thinking and text deltas as they arrive. Thinking
 * blocks are kept whole - signature included - on the tool call they precede,
 * because the next request of the tool-use turn has to carry them back.
 */
export async function readAnthropicStream(res: Response, progress: LLMProgress | undefined, toolPrefix: string): Promise<LLMResult> {
	const reader = res.body?.getReader();
	if (!reader) throw new Error("anthropic: no response body");
	const blocks: StreamBlock[] = [];
	let stopReason = "";
	let inputTokens = 0;
	let outputTokens = 0;
	const decoder = new TextDecoder();
	let buf = "";
	const onEvent = (data: string): void => {
		const event = JSON.parse(data) as {
			type: string;
			index?: number;
			message?: { usage?: { input_tokens?: number; output_tokens?: number } };
			content_block?: { type: string; text?: string; thinking?: string; signature?: string; data?: string; id?: string; name?: string };
			delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
			usage?: { input_tokens?: number; output_tokens?: number };
			error?: { type?: string; message?: string };
		};
		switch (event.type) {
			case "message_start":
				inputTokens = event.message?.usage?.input_tokens ?? 0;
				outputTokens = event.message?.usage?.output_tokens ?? 0;
				return;
			case "content_block_start": {
				const b = event.content_block;
				const block: StreamBlock =
					b?.type === "text"
						? { type: "text", text: b.text ?? "" }
						: b?.type === "thinking"
							? { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" }
							: b?.type === "redacted_thinking"
								? { type: "redacted_thinking", data: b.data ?? "" }
								: b?.type === "tool_use"
									? { type: "tool_use", id: b.id ?? "", name: b.name ?? "", json: "" }
									: { type: "other" };
				blocks[event.index ?? blocks.length] = block;
				if (block.type === "text" && block.text) progress?.text?.(block.text);
				if (block.type === "thinking" && block.thinking) progress?.thinking?.(block.thinking);
				return;
			}
			case "content_block_delta": {
				const block = blocks[event.index ?? -1];
				const d = event.delta;
				if (!block || !d) return;
				if (d.type === "text_delta" && block.type === "text") {
					block.text += d.text ?? "";
					if (d.text) progress?.text?.(d.text);
				} else if (d.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += d.thinking ?? "";
					if (d.thinking) progress?.thinking?.(d.thinking);
				} else if (d.type === "signature_delta" && block.type === "thinking") {
					block.signature += d.signature ?? "";
				} else if (d.type === "input_json_delta" && block.type === "tool_use") {
					block.json += d.partial_json ?? "";
				}
				return;
			}
			case "message_delta":
				if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
				if (event.usage?.output_tokens !== undefined) outputTokens = event.usage.output_tokens;
				if (event.usage?.input_tokens) inputTokens = event.usage.input_tokens;
				return;
			case "error":
				throw new Error(`anthropic stream ${event.error?.type ?? "error"}: ${(event.error?.message ?? data).slice(0, 600)}`);
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (value) buf += decoder.decode(value, { stream: !done });
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (data) onEvent(data);
		}
		if (done) break;
	}
	if (!stopReason) throw new Error("anthropic: the response stream ended early");

	let text = "";
	const toolUses: LLMResult["toolUses"] = [];
	let thinking: ThinkingContent[] = [];
	for (const block of blocks) {
		if (!block) continue;
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") thinking.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
		else if (block.type === "redacted_thinking") thinking.push({ type: "redacted_thinking", data: block.data });
		else if (block.type === "tool_use") {
			const name = toolPrefix && block.name.startsWith(toolPrefix) ? block.name.slice(toolPrefix.length) : block.name;
			// A call cut off by max_tokens arrives with partial input: `{}` (the runner refuses it).
			let input: Record<string, unknown> = {};
			try {
				input = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
			} catch {
				input = {};
			}
			toolUses.push({ id: block.id, name, input, ...(thinking.length ? { thinking } : {}) });
			thinking = [];
		}
	}
	return { text, toolUses, stopReason, inputTokens, outputTokens };
}
async function callKimi(req: LLMRequest): Promise<LLMResult> {
	const key = req.apiKey || (await resolveKimiKey());
	if (!key) throw new Error("No Kimi key: add a Kimi credential to the agent's Credentials, or set one in Settings → Agent.");
	// OpenAI-shaped; tools mapped to function-calling.
	const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
	for (const t of req.turns) {
		if (typeof t.content === "string") {
			messages.push({ role: t.role, content: t.content });
			continue;
		}
		// Flatten content blocks: text joins; images ride as data-URL parts
		// (OpenAI-style content array); tool blocks become tool messages.
		const texts = t.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : ""));
		const images = t.content.flatMap((c) => (c.type === "image" ? [{ type: "image_url", image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }] : []));
		if (images.length) messages.push({ role: t.role, content: [...(texts.length ? [{ type: "text", text: texts.join("\n") }] : []), ...images] });
		else if (texts.length) messages.push({ role: t.role, content: texts.join("\n") });
		for (const c of t.content) {
			if (c.type === "tool_use") {
				messages.push({
					role: "assistant",
					tool_calls: [{ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }],
				});
			} else if (c.type === "tool_result") {
				messages.push({ role: "tool", tool_call_id: c.tool_use_id, content: c.content });
			}
		}
	}
	const res = await fetchWithRetry("https://api.moonshot.ai/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: requestJson({
			model: req.model,
			max_tokens: req.maxTokens ?? 4096,
			temperature: req.temperature,
			messages,
			tools: req.tools.length
				? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }))
				: undefined,
		}),
	});
	if (!res.ok) throw new Error(`kimi ${res.status}: ${(await res.text()).slice(0, 600)}`);
	const out = (await res.json()) as {
		choices: Array<{
			message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
			finish_reason: string;
		}>;
		usage: { prompt_tokens: number; completion_tokens: number };
	};
	const choice = out.choices[0];
	return {
		text: choice.message.content ?? "",
		toolUses: (choice.message.tool_calls ?? []).map((c) => ({
			id: c.id,
			name: c.function.name,
			input: (JSON.parse(c.function.arguments || "{}") as Record<string, unknown>) ?? {},
		})),
		stopReason: choice.finish_reason,
		inputTokens: out.usage.prompt_tokens,
		outputTokens: out.usage.completion_tokens,
	};
}

/**
 * Deterministic offline model for smoke tests:
 *  - "search: X"  → calls object_search with query X, then echoes results
 *  - "answer alongside a tool: X" → writes X with a tool call (object_search),
 *    then says nothing once it answers - as a model does when it answers and
 *    closes a scheduled run in one step
 *  - anything else → echoes. Summaries return a canned structure.
 */
function callMock(req: LLMRequest): LLMResult {
	const textOf = (turn: LLMRequest["turns"][number] | undefined): string =>
		typeof turn?.content === "string"
			? turn.content
			: (turn?.content ?? [])
					.map((c) => (c.type === "text" ? c.text : c.type === "tool_result" ? `RESULT:${c.content.slice(0, 120)}` : ""))
					.join(" ");
	const lastText = textOf(req.turns[req.turns.length - 1]);
	const ALONGSIDE = "answer alongside a tool:";
	const asked = req.turns.map(textOf).find((t) => t.includes(ALONGSIDE));
	if (asked) {
		const answer = asked.slice(asked.indexOf(ALONGSIDE) + ALONGSIDE.length).trim();
		const answered = req.turns.some((t) => t.role === "assistant" && textOf(t).includes(answer));
		if (answered) return { text: "", toolUses: [], stopReason: "end_turn", inputTokens: 50, outputTokens: 0 };
		return { text: answer, toolUses: [{ id: `mock-${Date.now()}`, name: "object_search", input: { query: "x" } }], stopReason: "tool_use", inputTokens: 50, outputTokens: 10 };
	}
	if (req.system.includes("You are summarising")) {
		return { text: "## Goal\nMock summary.\n\n## Next Steps\n1. continue", toolUses: [], stopReason: "end_turn", inputTokens: 100, outputTokens: 20 };
	}
	const m = lastText.match(/search:\s*(\S+)/);
	if (m && !lastText.includes("RESULT:")) {
		return {
			text: "",
			toolUses: [{ id: `mock-${Date.now()}`, name: "object_search", input: { query: m[1] } }],
			stopReason: "tool_use",
			inputTokens: 50,
			outputTokens: 10,
		};
	}
	return { text: `mock reply: ${lastText.slice(0, 200)}`, toolUses: [], stopReason: "end_turn", inputTokens: 50, outputTokens: 10 };
}

/** Which credential service a model's key comes from; "" when it needs none. */
export function modelProvider(model: string): string {
	if (model === "mock") return "";
	return model.startsWith("kimi") ? "kimi" : "anthropic";
}

export async function callLLM(req: LLMRequest): Promise<LLMResult> {
	const provider = modelProvider(req.model);
	if (!provider) return callMock(req);
	if (provider === "kimi") return callKimi(req);
	return callAnthropic(req);
}
