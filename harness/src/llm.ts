/**
 * Provider layer — trimmed port of glon agent-llm.ts. Anthropic Messages
 * API (non-streaming) + Moonshot Kimi (OpenAI-shaped), plus a deterministic
 * "mock" model for offline smoke tests. Overflow detection mirrors
 * isContextOverflowError (agent-llm.ts:673-676).
 */

import type { LLMResult, ToolDef, Turn } from "./types";

export interface LLMRequest {
	model: string;
	system: string;
	turns: Turn[];
	tools: ToolDef[];
	maxTokens?: number;
	temperature?: number;
}

export function isContextOverflowError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /prompt is too long|context.*(length|window)|maximum.*tokens|too many tokens/i.test(msg);
}

// ── Claude Code OAuth impersonation (glon agent-llm.ts:35-58) ────

const CLAUDE_CODE_VERSION = "2.1.39";
const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_TOOL_PREFIX = "proxy_";
const CLAUDE_CODE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
].join(",");
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

interface AnthropicAuth {
	token: string;
	isOAuth: boolean;
}

/** GLON_DATA/auth.json — written by the Settings UI (Settings → Agent). */
async function readAuthFile(): Promise<{ anthropic?: string; kimi?: string }> {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	try {
		return (await Bun.file(`${root}/auth.json`).json()) as { anthropic?: string; kimi?: string };
	} catch {
		return {};
	}
}

let cachedKeychainAuth: AnthropicAuth | null = null;

/**
 * Resolution order: auth.json (Settings UI) → env → Claude Code keychain
 * OAuth. auth.json is re-read every call so a key saved in Settings takes
 * effect without restarting the daemon.
 */
async function resolveAnthropicAuth(): Promise<AnthropicAuth> {
	const file = await readAuthFile();
	if (file.anthropic) return { token: file.anthropic, isOAuth: false };
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return { token: envKey, isOAuth: false };
	if (cachedKeychainAuth) return cachedKeychainAuth;
	try {
		const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
		const raw = await new Response(proc.stdout).text();
		const parsed = JSON.parse(raw.trim()) as { claudeAiOauth?: { accessToken?: string } };
		const token = parsed.claudeAiOauth?.accessToken;
		if (token) {
			cachedKeychainAuth = { token, isOAuth: true };
			return cachedKeychainAuth;
		}
	} catch {
		/* fall through */
	}
	throw new Error("No Anthropic credentials: add a key in Settings → Agent, set ANTHROPIC_API_KEY, or log into Claude Code.");
}

/** Kimi key: auth.json → env. */
export async function resolveKimiKey(): Promise<string> {
	const file = await readAuthFile();
	return file.kimi ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? "";
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
	const auth = await resolveAnthropicAuth();
	const body: Record<string, unknown> = {
		model: req.model,
		max_tokens: req.maxTokens ?? 4096,
		messages: req.turns,
	};
	if (req.temperature !== undefined) body.temperature = req.temperature;
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
	}

	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const errBody = await res.text();
		throw new Error(`anthropic ${res.status}: ${errBody.slice(0, 600)}`);
	}
	const out = (await res.json()) as {
		content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
		stop_reason: string;
		usage: { input_tokens: number; output_tokens: number };
	};
	const text = out.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
	const toolUses = out.content
		.filter((c) => c.type === "tool_use")
		.map((c) => {
			let name = c.name ?? "";
			if (auth.isOAuth && name.startsWith(CLAUDE_CODE_TOOL_PREFIX)) name = name.slice(CLAUDE_CODE_TOOL_PREFIX.length);
			return { id: c.id ?? "", name, input: c.input ?? {} };
		});
	return {
		text,
		toolUses,
		stopReason: out.stop_reason,
		inputTokens: out.usage.input_tokens,
		outputTokens: out.usage.output_tokens,
	};
}
async function callKimi(req: LLMRequest): Promise<LLMResult> {
	const key = await resolveKimiKey();
	if (!key) throw new Error("No Kimi key: add one in Settings → Agent or set KIMI_API_KEY.");
	// OpenAI-shaped; tools mapped to function-calling.
	const messages: Array<Record<string, unknown>> = [{ role: "system", content: req.system }];
	for (const t of req.turns) {
		if (typeof t.content === "string") {
			messages.push({ role: t.role, content: t.content });
			continue;
		}
		// Flatten content blocks: text joins; tool blocks become tool messages.
		const texts = t.content.filter((c) => c.type === "text").map((c) => (c.type === "text" ? c.text : ""));
		if (texts.length) messages.push({ role: t.role, content: texts.join("\n") });
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
	const res = await fetch("https://api.moonshot.ai/v1/chat/completions", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
		body: JSON.stringify({
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
 *  - anything else → echoes. Summaries return a canned structure.
 */
function callMock(req: LLMRequest): LLMResult {
	const last = req.turns[req.turns.length - 1];
	const lastText =
		typeof last?.content === "string"
			? last.content
			: (last?.content ?? [])
					.map((c) => (c.type === "text" ? c.text : c.type === "tool_result" ? `RESULT:${c.content.slice(0, 120)}` : ""))
					.join(" ");
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

export async function callLLM(req: LLMRequest): Promise<LLMResult> {
	if (req.model === "mock") return callMock(req);
	if (req.model.startsWith("kimi")) return callKimi(req);
	return callAnthropic(req);
}
