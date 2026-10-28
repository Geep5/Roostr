#!/usr/bin/env bun
/**
 * Claude Design for Roostr agents: draft a design with Claude Code's `/design`
 * (a Claude Design canvas published on claude.ai), render each artboard to a
 * PNG and store the PNGs as File objects in a space. Run as `roostr-design`
 * (harness/bin, linked into ~/.local/bin by the harness):
 *
 *   roostr-design --space <space id> <<'BRIEF'
 *   <what to design - $ and quotes are safe inside the quoted heredoc>
 *   BRIEF
 *
 * Prints one JSON line: {"url": <claude.ai link>, "title", "files": [{"id", "name", "board"}]}
 * or {"error": "..."} with exit 1. `--check` and `--auth-check` are the
 * "claude-design" capability's gates (harness/src/skillmgr.ts).
 *
 * Why a background session: `/design` publishes an artifact, and Claude Code
 * turns artifacts off in `claude -p` and the Agent SDK. A background session
 * (`claude --bg`) is a full session, signed in with the computer's claude.ai
 * account (`claude` then `/login`), working in DESIGN_DIR, which this script
 * creates and records as trusted.
 */
import { mkdirSync, unlinkSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DESIGN_DIR = process.env.DESIGN_DIR || join(homedir(), "projekt/3/roostr-design");
const TIMEOUT_MS = 20 * 60_000;
const HARNESS = "http://127.0.0.1:7334";

function fail(message: string): never {
	console.log(JSON.stringify({ error: message }));
	process.exit(1);
}

function arg(name: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? (process.argv[i + 1] ?? "") : "";
}

async function run(cmd: string[], cwd = DESIGN_DIR): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0" } });
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, out, err };
}

interface Session {
	id: string;
	sessionId: string;
	name: string;
	status: string;
}

async function sessions(): Promise<Session[]> {
	const { out } = await run(["claude", "agents", "--json"]);
	try {
		return JSON.parse(out) as Session[];
	} catch {
		return [];
	}
}

/** Claude Code's transcript lines for a session: one JSON object per line. */
async function transcript(sessionId: string): Promise<Array<Record<string, unknown>>> {
	const projects = join(homedir(), ".claude/projects");
	for (const dir of await readdir(projects)) {
		const file = join(projects, dir, `${sessionId}.jsonl`);
		const text = await readFile(file, "utf8").catch(() => "");
		if (text) return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	}
	return [];
}

type Part = { type: string; name?: string; input?: Record<string, unknown>; text?: string; content?: unknown };

function parts(entry: Record<string, unknown>): Part[] {
	const message = entry["message"] as { content?: unknown } | undefined;
	return Array.isArray(message?.content) ? (message.content as Part[]) : [];
}

async function findChrome(): Promise<string | null> {
	for (const path of ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]) {
		if (await Bun.file(path).exists()) return path;
	}
	for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chrome"]) {
		const found = Bun.which(name);
		if (found) return found;
	}
	return null;
}

async function chrome(): Promise<string> {
	return (await findChrome()) ?? fail("No Chrome on this computer to render the artboards (install Google Chrome).");
}

async function upload(bytes: Uint8Array, name: string, space: string): Promise<string> {
	const token = (await readFile(join(process.env.GLON_DATA || join(homedir(), ".glon"), "api-token"), "utf8")).trim();
	const res = await fetch(`${HARNESS}/files?name=${encodeURIComponent(name)}&mime=image%2Fpng&space=${encodeURIComponent(space)}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: bytes,
	});
	const body = (await res.json()) as { id?: string; error?: string };
	if (!res.ok || !body.id) fail(`Storing ${name} in Roostr failed: ${body.error ?? res.status}`);
	return body.id;
}

/** A background session publishes artifacts from this Claude Code version on. */
const MIN_CLAUDE = [2, 1, 281];

async function claudeVersion(): Promise<number[] | null> {
	const found = await run(["claude", "--version"], homedir()).catch(() => null);
	const m = found?.out.match(/(\d+)\.(\d+)\.(\d+)/);
	return m ? m.slice(1).map(Number) : null;
}

const atLeast = (v: number[], min: number[]): boolean => {
	for (let i = 0; i < min.length; i++) if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
	return true;
};

async function signedIn(): Promise<boolean> {
	const status = await run(["claude", "auth", "status"], homedir());
	return /"loggedIn":\s*true/.test(status.out) && /"authMethod":\s*"claude\.ai"/.test(status.out);
}

/**
 * Claude Code asks before working in a folder it hasn't been told to trust,
 * and a background session can't answer: the design folder is created and
 * recorded as trusted here, the way accepting that prompt records it.
 */
async function trustDesignDir(): Promise<void> {
	mkdirSync(DESIGN_DIR, { recursive: true });
	const path = join(homedir(), ".claude.json");
	const config = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
	config.projects ??= {};
	if (config.projects[DESIGN_DIR]?.hasTrustDialogAccepted) return;
	config.projects[DESIGN_DIR] = { ...config.projects[DESIGN_DIR], hasTrustDialogAccepted: true };
	await Bun.write(path, JSON.stringify(config, null, 2));
}

// Roostr's capability gates (harness/src/skillmgr.ts, "claude-design").
if (process.argv.includes("--check")) {
	const v = await claudeVersion();
	if (!v) fail("Claude Code is not installed (https://claude.ai/install.sh).");
	if (!atLeast(v, MIN_CLAUDE)) fail(`Claude Code ${v.join(".")} is too old: ${MIN_CLAUDE.join(".")} or later publishes designs (claude update).`);
	if (!(await findChrome())) fail("Google Chrome is not installed: it renders the artboards.");
	console.log(JSON.stringify({ ok: true, claude: v.join(".") }));
	process.exit(0);
}
if (process.argv.includes("--auth-check")) {
	if (!(await signedIn())) fail("Claude Code is not signed in to a claude.ai account.");
	console.log(JSON.stringify({ ok: true }));
	process.exit(0);
}

const space = arg("space");
// The brief on standard input, untouched: in a double-quoted --brief the
// shell ate "$1" from "$1.3M", and the poster read "$[X].3M".
const brief = (arg("brief") || (process.stdin.isTTY ? "" : await Bun.stdin.text())).trim();
if (!space || !brief) fail("Usage: roostr-design --space <space id> <<'BRIEF'\n<what to design>\nBRIEF");
if (!(await signedIn())) fail("Claude Code on this computer is not signed in to a claude.ai account: run `claude`, then /login, then /design consent.");
await trustDesignDir();

// One design at a time on a computer: two background sessions started
// together left the second with its prompt half-typed and blocked.
const lock = join(DESIGN_DIR, ".roostr-design.lock");
for (const until = Date.now() + TIMEOUT_MS; ; await Bun.sleep(3_000)) {
	const held = await Bun.file(lock).text().catch(() => "");
	const holder = Number(held.trim());
	const alive = holder > 0 && (() => {
		try {
			process.kill(holder, 0);
			return true;
		} catch {
			return false;
		}
	})();
	if (!alive) break;
	if (Date.now() > until) fail("Another design has been running on this computer for over 20 minutes; try again later.");
}
await Bun.write(lock, String(process.pid));
process.on("exit", () => {
	try {
		unlinkSync(lock);
	} catch {}
});

// 1. Draft it in a background session.
const name = `roostr-design-${Date.now()}`;
// Claude Design's page runtime lives on claude.ai: loops and variables in an
// artboard only expand there. The session writes a static copy of each
// artboard, which Roostr screenshots; it knows the format, this script doesn't.
const exportDir = join(DESIGN_DIR, `export-${name}`);
const prompt = `/design ${brief}\n\nAfter it is published, also write a static copy of every artboard to ${exportDir}/<artboard file name> (for example ${exportDir}/Main.dc.html): plain self-contained HTML at the artboard's exact size that looks the same, with every template value, variable and repeated item written out, no scripts and no x-dc runtime; web fonts may stay as <link> tags.\n\nThen reply with only the artifact URL.`;
const started = await run(["claude", "--bg", "-n", name, "--permission-prompts", "none", prompt]);
if (started.code !== 0) fail(`Claude Code would not start the design: ${(started.err || started.out).trim().slice(0, 300)}`);

/** Claude's final reply has landed: the transcript ends on assistant text with no tool call after it. */
function finished(entries: Array<Record<string, unknown>>): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const ps = parts(entries[i]);
		if (ps.some((p) => p.type === "tool_use" || p.type === "tool_result")) return false;
		if (entries[i]["type"] === "assistant" && ps.some((p) => p.type === "text" && p.text)) return true;
	}
	return false;
}

// 2. Wait for its final reply. A new session reads "not busy" before it
// starts, so only a finished transcript, seen twice, counts as done.
const deadline = Date.now() + TIMEOUT_MS;
let session: Session | undefined;
let doneTwice = 0;
let blockedSince = 0;
for (;;) {
	await Bun.sleep(5_000);
	session = (await sessions()).find((s) => s.name === name);
	if (!session) {
		if (Date.now() > deadline - TIMEOUT_MS + 60_000) fail("The design session disappeared before it finished.");
		continue;
	}
	const state = (session as Session & { state?: string }).state ?? "";
	if (state === "blocked") {
		blockedSince ||= Date.now();
		if (Date.now() - blockedSince > 60_000) {
			await run(["claude", "stop", session.id]);
			fail(`The design session stopped to ask for something and was stopped (attach with \`claude attach ${session.id}\` on this computer to see it).`);
		}
	} else blockedSince = 0;
	doneTwice = session.status !== "busy" && finished(await transcript(session.sessionId)) ? doneTwice + 1 : 0;
	if (doneTwice >= 2) break;
	if (Date.now() > deadline) {
		await run(["claude", "stop", session.id]);
		fail(`The design took over ${TIMEOUT_MS / 60_000} minutes and was stopped.`);
	}
}

// 3. What it published: the artifact's URL and the canvas it wrote.
const entries = await transcript(session.sessionId);
let url = "";
let canvasPath = "";
let reply = "";
for (const entry of entries) {
	for (const part of parts(entry)) {
		if (part.type === "tool_use" && part.name === "Artifact" && typeof part.input?.["url"] === "string") {
			url = part.input["url"] as string;
			const file = part.input["file_path"];
			if (typeof file === "string" && file.endsWith("canvas.json")) canvasPath = isAbsolute(file) ? file : join(DESIGN_DIR, file);
		}
		if (entry["type"] === "assistant" && part.type === "text" && part.text) reply = part.text;
	}
}
url ||= reply.match(/https:\/\/claude\.ai\/artifact\/[\w-]+/)?.[0] ?? "";
if (!url) fail(`Claude Code did not publish a design. Its last words: ${reply.slice(0, 300) || "(none)"}`);
await run(["claude", "stop", session.id]);
if (!canvasPath) {
	console.log(JSON.stringify({ url, title: "", files: [] }));
	process.exit(0);
}

// 4. Each artboard as a PNG at its own size, stored in Roostr.
const canvas = JSON.parse(await readFile(canvasPath, "utf8")) as { title?: string; order?: string[]; boards?: Record<string, { w: number; h: number; title?: string }> };
const dir = canvasPath.slice(0, canvasPath.lastIndexOf("/"));
const browser = await chrome();
const files: Array<{ id: string; name: string; board: string }> = [];
for (const board of canvas.order ?? Object.keys(canvas.boards ?? {})) {
	const meta = canvas.boards?.[board];
	if (!meta) continue;
	const out = join(dir, `${board.replace(/\W+/g, "-")}.png`);
	// The session's static copy when it wrote one; else the artboard with its
	// {{variables}} filled from their data-props defaults (loops stay unexpanded).
	const exported = join(exportDir, board.split("/").pop() ?? board);
	let page = exported;
	if (!(await Bun.file(exported).exists())) {
		const html = await readFile(join(dir, board), "utf8");
		const props = html.match(/data-props='([^']*)'/)?.[1];
		let filled = html;
		try {
			const defs = props ? (JSON.parse(props) as Record<string, { default?: unknown }>) : {};
			filled = html.replace(/\{\{(\w+)\}\}/g, (all, key: string) => (defs[key]?.default !== undefined ? String(defs[key].default) : all));
		} catch {
			// Props it can't read: render as written.
		}
		page = join(dir, `.render-${board}`);
		await Bun.write(page, filled);
	}
	const shot = await run([browser, "--headless=new", "--hide-scrollbars", "--disable-gpu", `--window-size=${meta.w},${meta.h}`, `--screenshot=${out}`, `file://${page}`], dir);
	const png = Bun.file(out);
	if (shot.code !== 0 || !(await png.exists())) fail(`Rendering ${board} failed: ${shot.err.trim().slice(0, 300)}`);
	const title = `${canvas.title || "Design"} - ${meta.title || board}.png`;
	files.push({ id: await upload(new Uint8Array(await png.arrayBuffer()), title, space), name: title, board: meta.title || board });
}
console.log(JSON.stringify({ url, title: canvas.title ?? "", files }));
