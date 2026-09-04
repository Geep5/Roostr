/**
 * Installable skills — a curated catalog of device-local capabilities
 * (CLIs the agents can shell out to). Toggling one on in Settings runs a
 * one-shot installer subagent (the harness's own spawn machinery, holdfast
 * lineage) gated by a deterministic check
 * command. State is device-local (~/.glon/skills.json — installs don't
 * sync); the agent-facing skill body is a DAG `skill` object created on
 * success, so every agent picks it up through the normal skills listing.
 *
 * Auth handoff: when a skill installs fine but needs a human to finish
 * OAuth (gws), the row goes `needs-auth` and the installer posts to the
 * shared "Setup" chat object — the coordinator-channel pattern, on-DAG.
 */

import { createObject, chatPost, fetchObject, mutate, query, str, queryAll } from "./api";
import { objectText } from "./skills";

export interface CatalogEntry {
	key: string;
	name: string;
	description: string;
	/** One-shot OMP prompt that performs the install. */
	installPrompt: string;
	/** Uninstall prompt for the rare toggle-off-and-remove path. */
	uninstallPrompt: string;
	/** Deterministic gate: exit 0 = installed. */
	checkCmd: string;
	/** Optional second gate: exit 0 = authenticated. Failing => needs-auth. */
	authCheckCmd?: string;
	/** Human instruction shown in Settings + posted to the Setup chat. */
	authHint?: string;
	/** Agent-facing skill body written to the DAG on successful install. */
	skillBody: string;
}

export const CATALOG: CatalogEntry[] = [
	{
		key: "browserless",
		name: "browserless",
		description: "Drive a headless Chrome from the shell — fetch rendered pages, screenshots, and PDFs of JS-heavy sites.",
		// Two traps, both learned the hard way. The npm package named
		// `browserless` is a Puppeteer *library* with no `bin`, so installing
		// it can never satisfy `command -v browserless`. And a throwaway
		// --user-data-dir makes Chrome finish the page but never exit: the DOM
		// lands on stdout complete, then the command hangs until something
		// kills it. `--headless=new` already runs in its own `Chrome-headless`
		// profile, separate from the human's, so no profile flag is wanted.
		installPrompt:
			"Put a `browserless` command on PATH on this Mac that drives the locally installed Chrome in headless mode. " +
			"Do NOT `npm install -g browserless` — that package is a library with no executable, so the check would keep failing. " +
			"Write a small shell script named `browserless` into a directory that is already on PATH AND writable by you without sudo " +
			"(check with `test -w`; on a Homebrew Mac that is usually $(brew --prefix)/bin, otherwise ~/.local/bin — create it and say so if you use it), then chmod +x it. " +
			"NEVER use sudo or any command that can prompt for a password: nothing can type it, so the install would hang until it times out. " +
			"It must find a Chrome binary, trying in order: " +
			"'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', " +
			"'/Applications/Chromium.app/Contents/MacOS/Chromium', " +
			"'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', " +
			"then `command -v chromium chrome google-chrome-stable`; exit 1 with a clear message if none exist. " +
			"Use EXACTLY these Chrome flags and no others: --headless=new --disable-gpu --virtual-time-budget=15000. " +
			"Do NOT pass --user-data-dir and do not create any temp directory: --headless=new already uses its own profile, and a fresh " +
			"temp profile makes Chrome dump the page and then never exit, so the command hangs until it is killed. " +
			"Send Chrome's stderr to /dev/null so its GPU and updater noise never reaches the caller; leave stdout clean. " +
			"Behaviour: `browserless <url>` prints the rendered DOM (--dump-dom); " +
			"`browserless --screenshot <file> <url>` writes a PNG (--screenshot=FILE --window-size=1280,900); " +
			"`browserless --pdf <file> <url>` writes a PDF (--print-to-pdf=FILE); `browserless --help` prints this usage. " +
			"Do not start any long-running service. " +
			"Verify all of these yourself before finishing, and fix the script if any of them is slow or hangs: " +
			"`time browserless https://example.com | head -3` (must finish in a few seconds), " +
			"`browserless https://example.com | wc -c` (must be non-empty), and `browserless --help`. " +
			"Finish only when `command -v browserless` succeeds.",
		uninstallPrompt:
			"Remove the `browserless` wrapper script from this Mac: find it with `command -v browserless` and delete that file " +
			"(it is a small shell script this machine wrote, not a package). Finish when `command -v browserless` fails.",
		checkCmd: "command -v browserless",
		skillBody:
			"Web pages through this machine's headless Chrome.\n" +
			"Every agent has the `web_fetch` tool — that IS this capability, brokered by the harness; just call it with a URL.\n" +
			"Agents with shell access can also run the `browserless` command directly for screenshots/PDFs.\n" +
			"Use it when a page needs JavaScript to render (SPAs, dashboards) and plain curl returns an empty shell.\n" +
			"`browserless <url>` prints the rendered DOM; `browserless --screenshot out.png <url>` and `browserless --pdf out.pdf <url>` capture the page.\n" +
			"It runs in Chrome's own headless profile, never signed in as the human — expect logged-out pages.\n" +
			"Prefer plain curl for static pages: this launches a browser per call.",
	},
	{
		key: "google",
		name: "google",
		description: "Google Workspace from the shell via the gws CLI — Gmail, Calendar, Drive under the signed-in account.",
		installPrompt:
			"Install the `gws` Google Workspace CLI on this Mac (Homebrew or npm, whichever the project documents). " +
			"Do NOT attempt the OAuth login — a human completes that separately. " +
			"Finish only when `command -v gws` succeeds.",
		uninstallPrompt:
			"Uninstall the `gws` Google Workspace CLI from this Mac (reverse however it was installed — brew or npm). " +
			"Finish when `command -v gws` fails.",
		checkCmd: "command -v gws",
		authCheckCmd: "gws auth status",
		authHint: "Run `gws auth` in a terminal and sign in with your Google account, then hit Re-check.",
		skillBody:
			"Google Workspace access through the `gws` CLI (already authenticated on this device).\n" +
			"Gmail, Calendar, and Drive operations run under the signed-in account — see `gws --help` for subcommands.\n" +
			"Read before you write: list/search first, and never send mail or modify events unless the task explicitly asks.",
	},
];

// -- Device-local state -------------------------------------------

export type SkillPhase = "off" | "installing" | "needs-auth" | "on" | "failed" | "uninstalling";

interface SkillState {
	enabled: boolean;
	installed: boolean;
	log?: string;
	updatedAt: number;
}

const STATE_PATH = `${process.env.GLON_DATA ?? `${process.env.HOME}/.glon`}/skills.json`;

/** An agent needed a machine capability and could not proceed. */
export interface Holdup {
	id: string;
	capability: string;
	agentId: string;
	agentName: string;
	objectId: string;
	objectName: string;
	error: string;
	count: number;
	firstAt: number;
	updatedAt: number;
}

interface StateFile {
	skills: Record<string, SkillState>;
	holdups?: Holdup[];
}

async function readState(): Promise<StateFile> {
	try {
		const j = (await Bun.file(STATE_PATH).json()) as Record<string, unknown>;
		if (j && typeof j === "object" && "skills" in j) return j as unknown as StateFile;
		if (j && typeof j === "object") return { skills: j as unknown as Record<string, SkillState> };
	} catch {
		/* fresh */
	}
	return { skills: {} };
}

async function writeState(state: StateFile): Promise<void> {
	await Bun.write(STATE_PATH, JSON.stringify(state, null, "\t"));
}

/**
 * The global set is hardcoded: it is exactly this catalog. Their skill
 * objects carry `scope: global` so both apps can tell a device capability
 * from a hand-written skill without asking the daemon — the latter is
 * assignable to one agent, the former never is.
 */
export const GLOBAL_SCOPE = "global";

/** Backfill the marker on catalog objects installed before it existed. */
export async function convergeCatalogScope(): Promise<void> {
	const names = new Map(CATALOG.map((c) => [c.name.toLowerCase(), c]));
	const rows = await queryAll({ type: "skill" });
	for (const r of rows) {
		const name = str(r.fields, "name").toLowerCase();
		if (!names.has(name) || str(r.fields, "scope") === GLOBAL_SCOPE) continue;
		await mutate("set_field", { object_id: r.id, key: "scope", value: { stringValue: GLOBAL_SCOPE } });
	}
}

// ── Holdups: the machine's ledger of blocked capability calls ─────
//
// Filed by brokered tools when a capability is missing or broken;
// listed in the Machine panel; cleared by the human after fixing.

export async function listHoldups(): Promise<Holdup[]> {
	return (await readState()).holdups ?? [];
}

export async function fileHoldup(h: Omit<Holdup, "id" | "count" | "firstAt" | "updatedAt">): Promise<void> {
	const state = await readState();
	state.holdups ??= [];
	const existing = state.holdups.find((x) => x.capability === h.capability && x.agentId === h.agentId);
	if (existing) {
		existing.error = h.error;
		existing.count += 1;
		existing.updatedAt = Date.now();
	} else {
		state.holdups.push({ ...h, id: crypto.randomUUID(), count: 1, firstAt: Date.now(), updatedAt: Date.now() });
	}
	await writeState(state);
}

export async function clearHoldup(id: string): Promise<void> {
	const state = await readState();
	state.holdups = (state.holdups ?? []).filter((x) => x.id !== id);
	await writeState(state);
}

/** Is a catalog capability ready to serve? Reason strings are shown to agents and humans. */
export async function skillReady(key: string): Promise<{ ok: boolean; reason: string }> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) return { ok: false, reason: `unknown capability "${key}"` };
	const st = (await readState()).skills[key];
	if (!st?.enabled) return { ok: false, reason: `${entry.name} is switched off on this machine` };
	if (!st.installed) return { ok: false, reason: `${entry.name} is not installed on this machine` };
	return { ok: true, reason: "" };
}

/** Catalog skills enabled on this device. */
export async function enabledCatalogKeys(): Promise<Set<string>> {
	const state = await readState();
	return new Set(CATALOG.filter((c) => state.skills[c.key]?.enabled).map((c) => c.key));
}


// -- Live jobs ----------------------------------------------------

interface Job {
	phase: "installing" | "uninstalling";
	log: string[];
}

const jobs = new Map<string, Job>();

// -- Helpers ------------------------------------------------------

async function sh(cmd: string): Promise<{ ok: boolean; out: string }> {
	const proc = Bun.spawn(["sh", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const code = await proc.exited;
	return { ok: code === 0, out: (out + err).trim() };
}

/** Find-or-create the shared "Setup" coordinator chat; post a line to it. */
async function postToSetupChat(text: string): Promise<void> {
	try {
		const rows = await query({ type: "chat", limit: 50 });
		let id = rows.find((r) => str(r.fields, "name") === "Setup")?.id;
		if (!id) {
			id = (await createObject("Setup", "chat", { iconEmoji: { stringValue: "\u2699\uFE0F" } })).id;
		}
		await chatPost(id, text, "Installer");
	} catch (err) {
		console.error("[skills] setup-chat post failed:", err);
	}
}

/** The catalog entry's skill object, if it exists. */
async function findSkillObject(entry: CatalogEntry): Promise<string | null> {
	const rows = await queryAll({ type: "skill" });
	return rows.find((r) => str(r.fields, "name") === entry.name)?.id ?? null;
}

/**
 * Seed the agent-facing skill object in the DAG. An existing body is the
 * user's to edit (Settings exposes it) - only an empty shell is reseeded
 * with the catalog default.
 */
async function upsertSkillObject(entry: CatalogEntry): Promise<void> {
	const hitId = await findSkillObject(entry);
	if (hitId) {
		const obj = await fetchObject(hitId);
		if (objectText(obj).trim() !== "") return;
		await mutate("delete", { object_id: hitId });
	}
	const { id } = await createObject(entry.name, "skill", {
		description: { stringValue: entry.description },
		scope: { stringValue: GLOBAL_SCOPE },
	});
	await mutate("block_add", { object_id: id, block: { content: { text: { text: entry.skillBody, style: 0 } } } });
}

/** Restore a skill's prompt to the catalog default (the "reinstall" button). */
export async function resetSkillPrompt(key: string): Promise<string> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill "${key}"`);
	await setSkillPrompt(key, entry.skillBody);
	return entry.skillBody;
}

/** Replace a skill's prompt body (Settings editor). Creates the object if missing. */
export async function setSkillPrompt(key: string, text: string): Promise<void> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill "${key}"`);
	let id = await findSkillObject(entry);
	if (!id) {
		id = (
			await createObject(entry.name, "skill", {
				description: { stringValue: entry.description },
				scope: { stringValue: GLOBAL_SCOPE },
			})
		).id;
	} else {
		// Drop the existing body blocks (everything except the discussion subtree).
		const obj = await fetchObject(id);
		const referenced = new Set<string>();
		for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
		for (const b of obj.blocks) {
			if (referenced.has(b.id) || b.id === "__discussion__") continue;
			await mutate("block_remove", { object_id: id, block_id: b.id });
		}
	}
	await mutate("block_add", { object_id: id, block: { content: { text: { text, style: 0 } } } });
}

// -- Status -------------------------------------------------------

export interface SkillStatus {
	key: string;
	name: string;
	description: string;
	phase: SkillPhase;
	installed: boolean;
	log: string;
	authHint?: string;
	/** The live prompt body from the skill object (empty until seeded). */
	prompt: string;
	/** The catalog's stock prompt - the "reinstall" target. */
	defaultPrompt: string;
}

export async function skillStatus(): Promise<SkillStatus[]> {
	const state = await readState();
	const prompts = new Map<string, string>();
	for (const c of CATALOG) {
		try {
			const id = await findSkillObject(c);
			prompts.set(c.key, id ? objectText(await fetchObject(id)) : "");
		} catch {
			prompts.set(c.key, "");
		}
	}
	return CATALOG.map((c) => {
		const job = jobs.get(c.key);
		const s = state.skills[c.key];
		let phase: SkillPhase = "off";
		if (job) phase = job.phase;
		else if (s?.enabled) phase = "on";
		else if (s?.log?.startsWith("[needs-auth]")) phase = "needs-auth";
		else if (s?.log?.startsWith("[failed]")) phase = "failed";
		return {
			key: c.key,
			name: c.name,
			description: c.description,
			phase,
			installed: s?.installed ?? false,
			log: job ? job.log.join("") : (s?.log ?? ""),
			authHint: c.authHint,
			prompt: prompts.get(c.key) ?? "",
			defaultPrompt: c.skillBody,
		};
	});
}

// -- Gates --------------------------------------------------------

/**
 * Run the install/auth gates for an already-installed skill and settle
 * state accordingly. Returns the resulting phase.
 */
export async function recheckSkill(key: string): Promise<SkillPhase> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill: ${key}`);
	const state = await readState();
	const check = await sh(entry.checkCmd);
	if (!check.ok) {
		state.skills[key] = { enabled: false, installed: false, log: `[failed] check "${entry.checkCmd}" failed:\n${check.out}`, updatedAt: Date.now() };
		await writeState(state);
		return "failed";
	}
	if (entry.authCheckCmd) {
		const auth = await sh(entry.authCheckCmd);
		if (!auth.ok) {
			state.skills[key] = { enabled: false, installed: true, log: `[needs-auth] ${entry.authHint ?? "authentication required"}\n${auth.out}`, updatedAt: Date.now() };
			await writeState(state);
			return "needs-auth";
		}
	}
	state.skills[key] = { enabled: true, installed: true, log: "", updatedAt: Date.now() };
	await writeState(state);
	await upsertSkillObject(entry);
	return "on";
}

// -- Enable / disable / uninstall ---------------------------------

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
/** How often to ask the machine whether the (un)install already landed. */
const SETTLE_POLL_MS = 4_000;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function expire(ms: number, message: string): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	setTimeout(() => reject(new Error(message)), ms);
	return promise;
}

/** Which agent the installer runs as a subagent of: any served agent. */
async function installerParentId(): Promise<string> {
	const { readRoster } = await import("./roster");
	const roster = await readRoster();
	if (roster.length > 0) return roster[0];
	throw new Error("no served agent — enable one so installs can run as its subagent");
}

/**
 * Run the (un)install as a one-shot installer subagent of the harness itself.
 *
 * `settled` is the machine's own answer to "is this done" — the same check
 * the prompt names as the finish line. It is polled alongside the agent,
 * because the agent returning is NOT the definition of done: it keeps
 * narrating after the observable work lands, and one blocked shell call
 * costs five minutes, so a finished install could report "installing" for
 * as long as fifteen. Whichever settles first wins; either way onExit
 * rechecks and writes the real state.
 */
function runInstaller(
	key: string,
	phase: "installing" | "uninstalling",
	prompt: string,
	onExit: () => Promise<void>,
	settled?: () => Promise<boolean>,
): void {
	const job: Job = { phase, log: [] };
	jobs.set(key, job);
	void (async () => {
		try {
			const parentId = await installerParentId();
			const { spawnSubagent } = await import("./spawn");
			const races: Promise<string>[] = [
				spawnSubagent(prompt, "installer", { agentId: parentId, channelId: "", depth: 0, touched: new Set() }),
				expire(INSTALL_TIMEOUT_MS, "install timed out"),
			];
			if (settled) {
				races.push(
					(async () => {
						for (;;) {
							await sleep(SETTLE_POLL_MS);
							if (!jobs.has(key)) return "";
							if (await settled()) return `\n[installer] ${key} passed its check; the agent's remaining narration is not waited on.\n`;
						}
					})(),
				);
			}
			job.log.push(await Promise.race(races));
		} catch (err) {
			job.log.push(`\n[installer error] ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			try {
				await onExit();
			} finally {
				jobs.delete(key);
			}
		}
	})();
}

export async function enableSkill(key: string): Promise<SkillPhase> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill: ${key}`);
	if (jobs.has(key)) return jobs.get(key)!.phase;

	// Already installed (or present on the machine anyway)? Just gate.
	const state = await readState();
	if (state.skills[key]?.installed || (await sh(entry.checkCmd)).ok) {
		return recheckSkill(key);
	}

	runInstaller(
		key,
		"installing",
		entry.installPrompt,
		async () => {
			const phase = await recheckSkill(key);
			if (phase === "needs-auth") {
				await postToSetupChat(
					`\u2699\uFE0F **${entry.name}** installed, but needs you to finish sign-in: ${entry.authHint ?? "authenticate, then hit Re-check in Settings."}`,
				);
			} else if (phase === "failed") {
				const st = await readState();
				const job = st.skills[key];
				await postToSetupChat(`\u26A0\uFE0F **${entry.name}** install failed — see the log in Settings \u2192 Skills.`);
				if (job) {
					job.log = `[failed] install did not pass "${entry.checkCmd}"\n${jobLogTail(key)}`;
					await writeState(st);
				}
			}
		},
		async () => (await sh(entry.checkCmd)).ok,
	);
	return "installing";
}

function jobLogTail(key: string): string {
	const job = jobs.get(key);
	if (!job) return "";
	return job.log.join("").slice(-4000);
}

export async function disableSkill(key: string): Promise<void> {
	const state = await readState();
	const s = state.skills[key];
	if (s) {
		s.enabled = false;
		s.log = "";
		s.updatedAt = Date.now();
		await writeState(state);
	}
	// Skill object stays in the DAG but stops being listed (device filter).
}

export async function uninstallSkill(key: string): Promise<SkillPhase> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill: ${key}`);
	if (jobs.has(key)) return jobs.get(key)!.phase;
	await disableSkill(key);
	runInstaller(
		key,
		"uninstalling",
		entry.uninstallPrompt,
		async () => {
			const state = await readState();
			const gone = !(await sh(entry.checkCmd)).ok;
			state.skills[key] = {
				enabled: false,
				installed: !gone,
				log: gone ? "" : `[failed] uninstall left "${entry.checkCmd}" passing\n${jobLogTail(key)}`,
				updatedAt: Date.now(),
			};
			await writeState(state);
		},
		// Symmetric finish line: gone from PATH is what removal means.
		async () => !(await sh(entry.checkCmd)).ok,
	);
	return "uninstalling";
}
