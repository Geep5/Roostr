#!/usr/bin/env bun
/**
 * Palmier Pro for Roostr agents: call the video editor's tools through its
 * local MCP server (http://127.0.0.1:19789/mcp) from a shell. Run as
 * `roostr-palmier` (harness/bin, linked into ~/.local/bin by the harness):
 *
 *   roostr-palmier tools                 every tool, one line each
 *   roostr-palmier tools <name>          one tool's description and inputs (JSON schema)
 *   roostr-palmier call <name> <<'JSON'
 *   {"projectId": "...", ...}
 *   JSON
 *   roostr-palmier --check | --auth-check
 *
 * `call` prints the tool's result text (usually JSON) and exits 0, or
 * {"error": "..."} with exit 1. Palmier runs headless: when the app isn't
 * running it is started hidden (`open -g -j`), and agents open projects
 * without a window. `--check` and `--auth-check` are the "palmier"
 * capability's gates (harness/src/skillmgr.ts).
 */
import { existsSync } from "node:fs";

export const ENDPOINT = process.env.PALMIER_MCP_URL || "http://127.0.0.1:19789/mcp";
const APP = "/Applications/PalmierPro.app";
const START_WAIT_MS = 60_000;

/** The JSON-RPC message answering `id` in a Streamable-HTTP body: plain JSON or server-sent events. */
export function rpcReply(body: string, id: number): { result?: unknown; error?: { message?: string } } | null {
	const candidates = body.trim().startsWith("{") ? [body] : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
	for (const c of candidates) {
		if (!c.startsWith("{")) continue;
		try {
			const msg = JSON.parse(c) as { id?: number; result?: unknown; error?: { message?: string } };
			if (msg.id === id) return msg;
		} catch {}
	}
	return null;
}

/** A tools/call result as the text an agent reads, and whether the tool reported an error. */
export function resultText(result: unknown): { text: string; isError: boolean } {
	const r = (result ?? {}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
	const text = (r.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`)).join("\n");
	return { text, isError: r.isError === true };
}

function fail(message: string): never {
	console.log(JSON.stringify({ error: message }));
	process.exit(1);
}

class Session {
	private id = "";
	private seq = 0;

	private async post(payload: Record<string, unknown>): Promise<string> {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(this.id ? { "Mcp-Session-Id": this.id } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", ...payload }),
		});
		this.id ||= res.headers.get("mcp-session-id") ?? "";
		return res.text();
	}

	async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		const id = ++this.seq;
		const reply = rpcReply(await this.post({ id, method, params }), id);
		if (!reply) throw new Error(`Palmier gave no answer to ${method}.`);
		if (reply.error) throw new Error(reply.error.message ?? `Palmier refused ${method}.`);
		return reply.result;
	}

	async open(): Promise<void> {
		await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "roostr-palmier", version: "1" } });
		await this.post({ method: "notifications/initialized" });
	}
}

/** A session with Palmier, starting the app hidden when its server isn't up. */
async function connect(): Promise<Session> {
	const attempt = async () => {
		const s = new Session();
		await s.open();
		return s;
	};
	try {
		return await attempt();
	} catch {
		if (!existsSync(APP)) fail("Palmier Pro is not installed on this computer: a person installs it from https://www.palmier.io/download (macOS 26 or newer).");
		// Hidden and in the background: no window, no focus taken.
		Bun.spawnSync(["open", "-g", "-j", "-a", APP]);
		for (const deadline = Date.now() + START_WAIT_MS; Date.now() < deadline; await Bun.sleep(1000)) {
			try {
				return await attempt();
			} catch {}
		}
		fail(`Palmier Pro did not answer at ${ENDPOINT} within a minute of starting it. Open Palmier Pro on this computer and check Help -> MCP Instructions.`);
	}
}

async function call(session: Session, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
	return resultText(await session.request("tools/call", { name, arguments: args }));
}

if (import.meta.main) {
	const [cmd, name] = process.argv.slice(2);
	try {
		if (cmd === "--check") {
			const s = await connect();
			const tools = (await s.request("tools/list")) as { tools?: unknown[] };
			console.log(JSON.stringify({ ok: true, tools: tools.tools?.length ?? 0 }));
		} else if (cmd === "--auth-check") {
			const { text } = await call(await connect(), "get_account", {});
			const account = JSON.parse(text || "{}") as { status?: string; plan?: string; email?: string };
			if (account.status !== "signedIn") fail("Palmier Pro is not signed in: open it on this computer and sign in (Settings -> Account).");
			console.log(JSON.stringify({ ok: true, plan: account.plan, email: account.email }));
		} else if (cmd === "tools") {
			const s = await connect();
			const { tools = [] } = (await s.request("tools/list")) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
			if (name) {
				const tool = tools.find((t) => t.name === name) ?? fail(`No Palmier tool named "${name}". Run \`roostr-palmier tools\` for the list.`);
				console.log(JSON.stringify({ name: tool.name, description: tool.description, inputs: tool.inputSchema }, null, 1));
			} else {
				for (const t of tools) console.log(`${t.name}: ${(t.description ?? "").split(/(?<=\.)\s/)[0]}`);
			}
		} else if (cmd === "call" && name) {
			const raw = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
			let args: Record<string, unknown> = {};
			try {
				args = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
			} catch {
				fail("The tool's input on standard input must be one JSON object (use a quoted <<'JSON' block).");
			}
			const { text, isError } = await call(await connect(), name, args);
			if (isError) fail(text || `Palmier's ${name} failed.`);
			console.log(text);
		} else {
			fail("Usage: roostr-palmier tools [name] | roostr-palmier call <tool> <<'JSON' {...} JSON | --check | --auth-check");
		}
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
}
