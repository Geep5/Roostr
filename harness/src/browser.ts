/**
 * Minimal Chrome DevTools Protocol driver for credential-backed browser
 * actions. Headless Chrome owns the saved profile and all cookies; agents
 * receive only page text/screenshots and never the profile or cookies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEBUG_PORT_BASE = 9223;
const DEFAULT_TIMEOUT_MS = 60_000;
const PAGE_TEXT_LIMIT = 14_000;

interface Target {
	id: string;
	type: string;
	url: string;
}

interface Frame {
	params?: Record<string, unknown>;
	method?: string;
	result?: Record<string, unknown>;
	error?: { message?: string };
}

function chromeBinary(): string | undefined {
	return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"].find((p) => Bun.file(p).size > 0);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function targetFor(port: number, timeoutMs: number): Promise<Target> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (res.ok) {
				const targets = (await res.json()) as Target[];
				const page = targets.find((t) => t.type === "page");
				if (page) return page;
			} else lastError = `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await sleep(150);
	}
	throw new Error(`Chrome did not expose a page target${lastError ? `: ${lastError}` : ""}`);
}

/** A raw CDP connection: one command at a time, one reply per id. */
class CdpSocket {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }>();

	private constructor(ws: WebSocket) {
		this.ws = ws;
	}

	static async open(debuggerUrl: string): Promise<CdpSocket> {
		const ws = new WebSocket(debuggerUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), { once: true });
		});
		const socket = new CdpSocket(ws);
		ws.addEventListener("message", (event) => {
			const frame = JSON.parse(String(event.data)) as Frame & { id?: number };
			if (!frame.id) return;
			const waiter = socket.pending.get(frame.id);
			if (!waiter) return;
			socket.pending.delete(frame.id);
			if (frame.error) waiter.reject(new Error(frame.error.message ?? "CDP command failed"));
			else waiter.resolve(frame.result ?? {});
		});
		return socket;
	}

	call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5_000): Promise<T> {
		const id = this.nextId++;
		this.ws.send(JSON.stringify({ id, method, params }));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					(resolve as (value: Record<string, unknown>) => void)(value);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
		});
	}

	close(): void {
		for (const waiter of this.pending.values()) waiter.reject(new Error("CDP socket closed"));
		this.pending.clear();
		this.ws.close();
	}
}

async function evaluate(cdp: CdpSocket, expression: string, asyncBody = false): Promise<unknown> {
	const source = asyncBody ? `(async () => {\n${expression}\n})()` : expression;
	const out = await cdp.call<{ result?: { value?: unknown; description?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: source, returnByValue: true, awaitPromise: asyncBody, replMode: asyncBody });
	if (out.exceptionDetails) {
		const details = out.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown } };
		return `EVAL EXCEPTION ${details.text ?? ""} ${details.exception?.description ?? JSON.stringify(details.exception ?? details)}`;
	}
	if (out.result && "value" in out.result) return out.result.value;
	if (out.result && Object.keys(out.result).length > 0) return `EVAL RAW ${JSON.stringify(out.result)}`;
	return `EVAL EMPTY ${JSON.stringify(out)}`;
}

async function waitFor(cdp: CdpSocket, expression: string, timeoutMs: number, label: string): Promise<unknown> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		last = await evaluate(cdp, expression);
		if (last) return last;
		await sleep(250);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function pageTextExpression(): string {
	return `(() => { const title = document.title || ""; const url = location.href; const body = document.body ? document.body.innerText : ""; return JSON.stringify({ title, url, text: body.slice(0, ${PAGE_TEXT_LIMIT}) }); })()`;
}

/** Run a JavaScript snippet in the logged-in profile and return the page after it. */
export async function credentialPageAction(profile: string, url: string, actionJs: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ title: string; url: string; text: string; actionResult: string }> {
	const chrome = chromeBinary();
	if (!chrome) throw new Error("no Chrome/Chromium/Brave binary found");
	const home = mkdtempSync(join(tmpdir(), "roostr-cdp-home-"));
	const args = [
		chrome,
		"--headless=new",
		"--disable-gpu",
		"--disable-background-networking",
		"--disable-component-update",
		"--disable-sync",
		"--metrics-recording-only",
		"--no-first-run",
		"--no-default-browser-check",
		`--remote-debugging-port=${DEBUG_PORT_BASE}`,
		`--remote-debugging-address=127.0.0.1`,
		`--user-data-dir=${profile}`,
		url,
	];
	const debugPort = DEBUG_PORT_BASE + (process.pid % 1000);
	const proc: ChildProcess = spawn(args[0], args.slice(1).map((arg) => arg.replace(String(DEBUG_PORT_BASE), String(debugPort))), { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home } });
	const timeout = setTimeout(() => {
		spawn("pkill", ["-TERM", "-P", String(proc.pid ?? "")], { stdio: "ignore" });
		proc.kill();
	}, timeoutMs);
	let cdp: CdpSocket | undefined;
	try {
		await targetFor(debugPort, timeoutMs);
		const info = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<Target & { webSocketDebuggerUrl?: string }>;
		const page = info.find((t) => t.type === "page" && t.url === url) ?? info.find((t) => t.type === "page");
		if (!page?.webSocketDebuggerUrl) throw new Error("Chrome page target has no debugger URL");
		cdp = await CdpSocket.open(page.webSocketDebuggerUrl);
		await cdp.call("Runtime.enable");
		await cdp.call("Page.enable");
		await sleep(1_000);
		let actionResult = "";
		if (actionJs.trim()) {
			const value = await evaluate(cdp, `(() => {\n${actionJs}\n})()`);
			actionResult = typeof value === "string" ? value : JSON.stringify(value ?? null);
		}
		await sleep(1_000);
		const state = JSON.parse(String(await evaluate(cdp, pageTextExpression()))) as { title: string; url: string; text: string };
		if (!state.text) state.text = `NO TEXT title=${state.title} url=${state.url} target=${page.url}`;
		return { ...state, actionResult };
	} finally {
		clearTimeout(timeout);
		cdp?.close();
		spawn("pkill", ["-TERM", "-P", String(proc.pid ?? "")], { stdio: "ignore" });
		proc.kill();
		rmSync(home, { recursive: true, force: true });
	}
}

/** Retweet and confirm the menu/dialog in one page action. */
export const X_RETWEET_JS = `(() => {
	const label = document.body?.innerText ?? "";
	const retweet = [...document.querySelectorAll('[data-testid="retweet"], [aria-label*="Repost"], [aria-label*="Retweet"]')][0];
	if (!retweet) return JSON.stringify({ ok: false, error: "retweet button not found", snippet: label.slice(0, 500) });
	retweet.click();
	setTimeout(() => {
		const confirm = [...document.querySelectorAll('[data-testid="retweetConfirm"], [role="button"]')].find((el) => /repost|retweet/i.test(el.textContent ?? ""));
		if (confirm) confirm.click();
	}, 400);
	return "retweet click issued";
})()`;

/** Read the visible X mentions/timeline text. */
export const X_TIMELINE_JS = `(() => document.body?.innerText?.slice(0, ${PAGE_TEXT_LIMIT}) ?? "")()`;
