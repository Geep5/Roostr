/**
 * Minimal Chrome DevTools Protocol driver for credential-backed browser
 * work. A Credential's signed-in session travels as its cookies (the
 * credential object's `session` property): sign-in exports them from the
 * headed login window, and every later action injects them into a fresh,
 * throwaway headless Chrome - so any computer can act with the login.
 * Agents receive only page text, never the cookies.
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * A throwaway profile's cookie store must not touch the OS keychain: with a
 * temp HOME, macOS Chrome blocks on it and every cookie command hangs.
 * (The legacy-profile export keeps the real keychain - it must decrypt.)
 */
const THROWAWAY_STORE = ["--use-mock-keychain", "--password-store=basic"];
const PAGE_TEXT_LIMIT = 14_000;

interface Target {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

interface Frame {
	params?: Record<string, unknown>;
	method?: string;
	result?: Record<string, unknown>;
	error?: { message?: string };
}

export function chromeBinary(): string | undefined {
	return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => Bun.file(p).size > 0);
}

/** A cookie as CDP reports and accepts it. */
export interface SessionCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite?: string;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The DevTools port Chrome picked. Every launch passes
 * `--remote-debugging-port=0` and reads the port back from the profile,
 * so two Chromes never race for one fixed port (and a stale one on it is
 * never mistaken for ours).
 */
async function devtoolsPort(profile: string, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
			if (port > 0) return port;
		} catch {
			/* not written yet */
		}
		await sleep(100);
	}
	throw new Error("Chrome did not open DevTools");
}

async function debuggerUrlFor(profile: string, timeoutMs: number, url: string): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	const port = await devtoolsPort(profile, timeoutMs);
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (res.ok) {
				const targets = (await res.json()) as Target[];
				const page = targets.find((t) => t.type === "page" && t.url === url) ?? targets.find((t) => t.type === "page");
				if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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

/**
 * Run a JavaScript snippet in a throwaway headless Chrome carrying the
 * credential's session cookies and return the page after it. `arrived` is
 * false when the site sent the page elsewhere (a login wall): the action is
 * then NOT run, and the page returned is where it ended up.
 */
export async function credentialPageAction(cookies: SessionCookie[], url: string, actionJs: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ title: string; url: string; text: string; actionResult: string; arrived: boolean }> {
	const chrome = chromeBinary();
	if (!chrome) throw new Error("no Chrome/Chromium/Brave binary found");
	const home = mkdtempSync(join(tmpdir(), "roostr-cdp-home-"));
	const profile = join(home, "profile");
	const args = ["--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check", ...THROWAWAY_STORE, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"];
	const proc: ChildProcess = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, HOME: home } });
	const timeout = setTimeout(() => {
		spawn("pkill", ["-TERM", "-P", String(proc.pid ?? "")], { stdio: "ignore" });
		proc.kill();
	}, timeoutMs);
	let cdp: CdpSocket | undefined;
	try {
		cdp = await CdpSocket.open(await debuggerUrlFor(profile, timeoutMs, "about:blank"));
		await cdp.call("Runtime.enable");
		await cdp.call("Page.enable");
		await cdp.call("Network.enable");
		// Sites refuse a "HeadlessChrome" user agent outright (x.com: 403); present as the Chrome it is.
		const { userAgent } = await cdp.call<{ userAgent: string }>("Browser.getVersion");
		await cdp.call("Network.setUserAgentOverride", { userAgent: userAgent.replace("HeadlessChrome", "Chrome") });
		await cdp.call("Network.setCookies", { cookies: cookies.map((c) => ({ ...c, expires: c.expires > 0 ? c.expires : undefined })) });
		await cdp.call("Page.navigate", { url });
		const wanted = new URL(url);
		const wantedHosts = new Set([wanted.host]);
		if (wanted.host === "twitter.com") wantedHosts.add("x.com");
		if (wanted.host === "x.com") wantedHosts.add("twitter.com");
		const arrived = await waitFor(cdp, `(() => { const ready = document.readyState === "interactive" || document.readyState === "complete"; const host = new URL(location.href).host; const requested = ${JSON.stringify([...wantedHosts])}.includes(host) && location.pathname === ${JSON.stringify(wanted.pathname)}; return ready && requested && !!document.body && document.body.innerText.length > 0; })()`, Math.min(20_000, timeoutMs), "requested rendered page").then(() => true, () => false);
		let actionResult = "";
		if (arrived && actionJs.trim()) {
			const value = await evaluate(cdp, `(() => {\n${actionJs}\n})()`);
			actionResult = typeof value === "string" ? value : JSON.stringify(value ?? null);
		}
		await sleep(1_000);
		const state = JSON.parse(String(await evaluate(cdp, pageTextExpression()))) as { title: string; url: string; text: string };
		if (!state.text) state.text = `NO TEXT title=${state.title} url=${state.url} requested=${url}`;
		return { ...state, actionResult, arrived };
	} finally {
		clearTimeout(timeout);
		cdp?.close();
		spawn("pkill", ["-TERM", "-P", String(proc.pid ?? "")], { stdio: "ignore" });
		proc.kill();
		rmSync(home, { recursive: true, force: true });
	}
}

/** Every cookie a saved Chrome profile holds, decrypted by a headless Chrome on it (legacy migration). */
export async function profileCookies(profile: string, timeoutMs = 20_000): Promise<SessionCookie[]> {
	const chrome = chromeBinary();
	if (!chrome) throw new Error("no Chrome/Chromium/Brave binary found");
	rmSync(join(profile, "DevToolsActivePort"), { force: true });
	const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
	let cdp: CdpSocket | undefined;
	try {
		cdp = await CdpSocket.open(await debuggerUrlFor(profile, timeoutMs, "about:blank"));
		return (await cdp.call<{ cookies: SessionCookie[] }>("Network.getAllCookies")).cookies;
	} finally {
		cdp?.close();
		proc.kill();
	}
}

export interface LoginWindow {
	/** Whether the window's profile holds a cookie by that name for that host yet (names are plaintext on disk). */
	hasCookie(host: string, name: string): boolean;
	/** Close the window (Chrome flushes its cookies on a clean quit), export every cookie, delete the profile. */
	finish(): Promise<SessionCookie[]>;
	/** Resolves when the person closes the window. */
	exited: Promise<unknown>;
}

/**
 * Open a plain HEADED Chrome on a fresh profile at a login page. Nothing is
 * attached while the person signs in: sites' bot checks (Twitch, X) reject a
 * window with a live DevTools connection. The cookies are read afterwards,
 * from the closed profile; the profile is then thrown away.
 */
export function openLoginWindow(loginUrl: string): LoginWindow {
	const chrome = chromeBinary();
	if (!chrome) throw new Error("No Chrome, Chromium or Brave is installed on this computer.");
	const profile = mkdtempSync(join(tmpdir(), "roostr-login-"));
	const proc = spawn(chrome, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--new-window", loginUrl], { stdio: "ignore" });
	const exited = new Promise((resolve) => proc.once("exit", resolve));
	let gone = false;
	void exited.then(() => (gone = true));
	return {
		exited,
		hasCookie(host, name) {
			const db = [join(profile, "Default", "Network", "Cookies"), join(profile, "Default", "Cookies")].find((p) => existsSync(p));
			if (!db) return false;
			// Chrome holds the db open; read a snapshot.
			const snap = join(tmpdir(), `roostr-cookies-${crypto.randomUUID()}`);
			try {
				copyFileSync(db, snap);
				const sqlite = new Database(snap, { readonly: true });
				const row = sqlite.query("SELECT 1 FROM cookies WHERE name = ? AND host_key LIKE ? LIMIT 1").get(name, `%${host.replace(/^www\./, "")}`);
				sqlite.close();
				return row !== null;
			} catch {
				return false;
			} finally {
				rmSync(snap, { force: true });
			}
		},
		async finish() {
			if (!gone) {
				proc.kill("SIGTERM");
				await exited;
			}
			try {
				return await profileCookies(profile);
			} finally {
				rmSync(profile, { recursive: true, force: true });
			}
		},
	};
}

/** Retweet and confirm the menu/dialog in one page action. */
export const X_RETWEET_JS = `(() => {
	const label = document.body?.innerText ?? "";
	const button = document.querySelector('[data-testid="retweet"]') ?? [...document.querySelectorAll('[aria-label*="Repost"], [aria-label*="Retweet"]')][0];
	if (!button) return JSON.stringify({ ok: false, error: "retweet button not found", snippet: label.slice(0, 500) });
	button.click();
	let confirmed = false;
	const started = Date.now();
	const clickConfirm = () => {
		const confirm = document.querySelector('[data-testid="retweetConfirm"]') ?? [...document.querySelectorAll('[role="button"]')].find((el) => /^(repost|retweet)$/i.test((el.textContent ?? "").trim()));
		if (confirm) {
			confirm.click();
			confirmed = true;
			return;
		}
		if (Date.now() - started < 2_000) setTimeout(clickConfirm, 150);
	};
	clickConfirm();
	return confirmed ? "retweet confirmed" : "retweet click issued";
})()`;

/** Read the visible X mentions/timeline text. */
export const X_TIMELINE_JS = `(() => document.body?.innerText?.slice(0, ${PAGE_TEXT_LIMIT}) ?? "")()`;
