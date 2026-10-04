/**
 * Installable skills — a curated catalog of device-local capabilities
 * (CLIs the agents can shell out to). Toggling one on in Settings runs a
 * one-shot installer subagent (the harness's own spawn machinery, holdfast
 * lineage) gated by a deterministic check command.
 *
 * State lives only in vault objects: this machine's `capability` object per
 * key (status/error). The harness never derives it from local files; an
 * install/enable/disable action writes it, and whatever the objects say is
 * what this machine can do. The agent-facing skill body is the key's
 * shared `skill` object.
 *
 * Auth handoff: when a skill installs fine but needs a human to finish
 * OAuth (gws), the capability goes `needs_auth` and the installer posts to
 * this machine's own discussion - the state is a fact about this device,
 * and the Machine panel is where a human already looks for it.
 */

import { createObject, fetchObject, mutate, setField, str, sv, queryAll, type QueryRow } from "./api";
import { machines, publishMachine } from "./machine";
import { machineId } from "./roster";
import { humanRef, postTo } from "./conv";
import { activeCapabilityKeys, myCapabilities, publishHoldup, sweepHoldupBadges, upsertCapability, type CapabilityStatus } from "./capabilities";
import { SKILL_TYPE, objectText } from "./skills";

export interface CatalogEntry {
	key: string;
	/** The human name ("Headless Chrome"): the key's Skill object is created with it, and every display of the key reads that object's name. */
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
	/** Agent-facing skill body: the Skill object's page until someone edits it. */
	skillBody: string;
}

export const CATALOG: CatalogEntry[] = [
	{
		key: "browserless",
		name: "Headless Chrome",
		description: "Render pages, screenshots, and PDFs in headless Chrome; use machine credential profiles when a task needs a signed-in account.",
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
			"For a task that needs an account, do NOT use browserless. Read logged-in pages with credential_fetch and act with credential_action, both through a Credential the agent lists in its Credentials property.\n" +
			"Prefer plain curl for static pages: this launches a browser per call.",
	},
	{
		key: "google",
		name: "Google Workspace",
		description: "Google Workspace from the shell via the gws CLI — Gmail, Calendar, Drive under the signed-in account.",
		installPrompt:
			"Install the `gws` Google Workspace CLI on this Mac (Homebrew or npm, whichever the project documents). " +
			"Do NOT attempt the OAuth login — a human completes that separately. " +
			"Finish only when `command -v gws` succeeds.",
		uninstallPrompt:
			"Uninstall the `gws` Google Workspace CLI from this Mac (reverse however it was installed — brew or npm). " +
			"Finish when `command -v gws` fails.",
		checkCmd: "command -v gws",
		// No machine-wide sign-in to check: each account's sign-in is a Google
		// Credential (google-credentials.ts), used per call by gws-as.
		skillBody:
			"Google Workspace access through the `gws` CLI. Google accounts are Credentials (service google-account) listed in your Credentials property - `gws-as <that account> ...` uses its sign-in on whatever computer you run on. Never call bare `gws` when the object names an account or has a `google_account` property; call `gws-as <account> ...` so the mailbox/calendar/drive identity is explicit. If no account is named, first check the object and its discussion; if still ambiguous, say which account you need before reading private data.\n" +
			"Check auth FIRST: `gws-as <account> auth status` — `auth_method` must not be `none`.\n" +
			"An absent or under-scoped token makes Gmail list calls answer `exit 0` with `{\"resultSizeEstimate\": 0}`, which is indistinguishable from an empty mailbox. Never conclude \"no such mail\" from a zero result you did not auth-check.\n" +
			"Shape: `gws <service> <resource> [sub-resource] <method> --params '<JSON>'`. Path parameters go INSIDE --params (`userId` for Gmail), not as flags — there is no `--user-id`, and omitting it fails with \"Required path parameter userId is missing\".\n" +
			"Gmail has helpers; prefer them over raw methods. There is no `gws gmail search`.\n" +
			"Search: `gws gmail +triage --query \"from:someone@example.com\" --max 10 --format table` — prints date, from, id, subject. Any Gmail query works (`from:`, `subject:`, `newer_than:7d`); default query is `is:unread`.\n" +
			"Read one: `gws gmail +read --id <id>` for the plain-text body, `--headers` to include From/To/Subject/Date. Raw `users messages get` returns base64 — use `+read` instead.\n" +
			"Raw search when you need message ids only: `gws gmail users messages list --params '{\"userId\":\"me\",\"q\":\"from:someone@example.com\"}'`.\n" +
			"Write helpers: `+reply`, `+reply-all`, `+forward`, `+send` (they handle threading). Calendar and Drive follow the same shape: `gws calendar events list --params '{\"calendarId\":\"primary\"}'`, `gws drive files list --params '{\"pageSize\":10}'`.\n" +
			"Read before you write: list/search first, and never send mail or modify events unless the task explicitly asks.",
	},
	{
		key: "matcherino-dev",
		name: "Matcherino dev environment",
		description: "The Matcherino checkout at /home/geep/Matcherino plus the SSH tunnel to the production read replica on 127.0.0.1:15432.",
		// The checkout is a human's clone (ssh key, repo access); the
		// installer's job is only the tunnel, which is idempotent and dies
		// with the box, so a reboot puts this back to "failed" until re-run.
		installPrompt:
			"Bring up the Matcherino dev environment on this machine. " +
			"The checkout must already exist at /home/geep/Matcherino (apiserver, reactui, provision); if it does not, stop and say so - cloning needs a human's ssh key. " +
			"Open the SSH tunnel to the production read replica, idempotently: " +
			"`ss -tlnp 2>/dev/null | grep -q ':15432 ' || (cd /home/geep/Matcherino/provision && ssh -F ssh.config -f -N -L 15432:localhost:5432 root@45.33.24.114)`. " +
			"NEVER use sudo or any command that can prompt for a password. " +
			"Finish only when `test -d /home/geep/Matcherino` succeeds and `bash -c 'exec 3<>/dev/tcp/127.0.0.1/15432'` connects.",
		uninstallPrompt:
			"Close the SSH tunnel to the Matcherino read replica: find the `ssh -F ssh.config -f -N -L 15432:localhost:5432` process with `pgrep -f 15432:localhost:5432` and kill it. " +
			"Leave the checkout at /home/geep/Matcherino in place. Finish when nothing listens on 127.0.0.1:15432.",
		checkCmd: "bash -c 'test -d /home/geep/Matcherino && (exec 3<>/dev/tcp/127.0.0.1/15432)'",
		skillBody:
			"Matcherino development on this machine.\n" +
			"Checkout: /home/geep/Matcherino (apiserver in Go, reactui in Next.js, provision for infrastructure, MatcherinoReports/Guides for pre-built queries and procedures).\n" +
			"Production read replica: an SSH tunnel on 127.0.0.1:15432. If a query gets \"connection refused\", re-open it: `ss -tlnp 2>/dev/null | grep -q ':15432 ' || (cd /home/geep/Matcherino/provision && ssh -F ssh.config -f -N -L 15432:localhost:5432 root@45.33.24.114)`.\n" +
			"There is no psql on the host; query through docker: `docker run --rm --network host postgres:16.3 psql -h 127.0.0.1 -p 15432 -U readonly_user -d mno_production -c 'SQL;'` (credentials in the guides). SELECT only - the replica rejects writes.\n" +
			"Read the guide before exploring from scratch: /home/geep/Matcherino/MatcherinoReports/Guides/matcherino-query-guide.md.",
	},
];

// -- Object-backed state ------------------------------------------

export type SkillPhase = "off" | "installing" | "needs-auth" | "on" | "failed" | "uninstalling";

/** Capability statuses that mean the software is present on this machine. */
const PRESENT: Partial<Record<string, true>> = { active: true, disabled: true, needs_auth: true };

/** An agent needed a machine capability and could not proceed. */
export interface Holdup {
	capability: string;
	agentId: string;
	agentName: string;
	objectId: string;
	objectName: string;
	error: string;
}

/** This machine's status for a catalog key, read from its capability object. */
async function localStatus(key: string): Promise<{ status: CapabilityStatus | ""; error: string }> {
	const row = (await myCapabilities()).get(key);
	return { status: row?.status ?? "", error: row?.error ?? "" };
}

/**
 * Write a skill's state on this machine's capability object. A heal clears
 * its error and retracts the badges its holdups filed.
 */
async function recordSkill(entry: CatalogEntry, status: CapabilityStatus, error = ""): Promise<void> {
	const previous = await localStatus(entry.key);
	await upsertCapability({ key: entry.key, name: entry.name, description: entry.description }, { status, error });
	if (status === "active" && previous.error) await sweepHoldupBadges(entry.key);
	await publishMachine();
}

/**
 * This machine's active capability keys: the capability objects that name
 * it as `served_by` with status `active`. Anything short of that is not
 * offered - not to agents, not to the resolver.
 */
export async function capabilities(): Promise<string[]> {
	return activeCapabilityKeys();
}

/**
 * The global set is hardcoded: it is exactly this catalog. Their skill
 * objects carry `scope: global` so both apps can tell a device capability
 * from a hand-written skill without asking the daemon — the latter is
 * assignable to one agent, the former never is.
 */
export const GLOBAL_SCOPE = "global";

// ── Holdups: blocked capability calls ─────
//
// A holdup is the capability's `error` text - visible and sortable. It
// never changes the capability's status: a blocked call is an observation,
// and letting it rewrite status would keep the capability off for good.

export async function fileHoldup(h: Holdup): Promise<void> {
	void publishHoldup(h.capability, h.error);
}

/** Is a catalog capability ready to serve? Reason strings are shown to agents and humans. */
export async function skillReady(key: string): Promise<{ ok: boolean; reason: string }> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) return { ok: false, reason: `unknown capability "${key}"` };
	if ((await activeCapabilityKeys()).includes(key)) return { ok: true, reason: "" };
	const { status } = await localStatus(key);
	if (status === "disabled") return { ok: false, reason: `${entry.name} is switched off on this machine` };
	if (status === "needs_auth") return { ok: false, reason: `${entry.name} needs sign-in on this machine` };
	return { ok: false, reason: `${entry.name} is not active on this machine` };
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

/** Post a setup line to this machine's discussion (the Machine panel's thread). */
async function postSetupNotice(text: string): Promise<void> {
	try {
		const me = await machineId();
		const mine = (await machines()).find((m) => m.machineId === me);
		// serve() publishes this machine before anything can install
		// (index.ts:208), so a miss means the registration itself failed.
		if (!mine) throw new Error(`machine ${me.slice(0, 8)} is not registered`);
		await postTo(humanRef(mine.objectId), text, "Installer");
	} catch (err) {
		console.error("[skills] setup post failed:", err);
	}
}

/**
 * The catalog entry's Skill object among `rows`: the one carrying its key,
 * else a keyless one still named for it (made before skills had keys,
 * named by its catalog name or by the key that was its name then).
 */
function findSkillObject(entry: CatalogEntry, rows: QueryRow[]): QueryRow | null {
	const names = [entry.name.toLowerCase(), entry.key.toLowerCase()];
	return rows.find((r) => str(r.fields, "key") === entry.key) ?? rows.find((r) => !str(r.fields, "key") && names.includes(str(r.fields, "name").toLowerCase())) ?? null;
}

async function createSkillObject(entry: CatalogEntry): Promise<string> {
	const { id } = await createObject(entry.name, SKILL_TYPE, { key: sv(entry.key), description: sv(entry.description), scope: sv(GLOBAL_SCOPE) });
	return id;
}

const addBody = (id: string, text: string) => mutate("block_add", { object_id: id, block: { content: { text: { text, style: 0 } } } });

/**
 * Converge the key's shared Skill object (seeded at boot, catalog-seeds.ts):
 * a missing one is created with the catalog name, description and body. An
 * older one gains its `key` and the global scope, a name still equal to its
 * key becomes the catalog name, and an empty page gets the catalog body;
 * everything else is the user's to edit. `rows` are the vault's skill
 * objects. Returns whether it wrote.
 */
export async function upsertSkillObject(entry: CatalogEntry, rows: QueryRow[]): Promise<boolean> {
	const hit = findSkillObject(entry, rows);
	if (!hit) {
		await addBody(await createSkillObject(entry), entry.skillBody);
		return true;
	}
	let wrote = false;
	const fix = async (key: string, value: string) => {
		await setField(hit.id, key, sv(value));
		wrote = true;
	};
	if (str(hit.fields, "key") !== entry.key) await fix("key", entry.key);
	if (str(hit.fields, "scope") !== GLOBAL_SCOPE) await fix("scope", GLOBAL_SCOPE);
	if (str(hit.fields, "name") === entry.key && entry.name !== entry.key) await fix("name", entry.name);
	if (objectText(await fetchObject(hit.id)).trim() === "") {
		await addBody(hit.id, entry.skillBody);
		wrote = true;
	}
	return wrote;
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
	let id = findSkillObject(entry, await queryAll({ type: SKILL_TYPE }))?.id;
	if (!id) {
		id = await createSkillObject(entry);
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
	await addBody(id, text);
}


/** Execution state from the live job, else this machine's capability object - no gates run. */
export async function skillOperationState(key: string): Promise<{ phase: SkillPhase; installed: boolean }> {
	if (!CATALOG.some((entry) => entry.key === key)) throw new Error("Unknown skill.");
	const { status } = await localStatus(key);
	const settled: SkillPhase = status === "active" ? "on" : status === "needs_auth" ? "needs-auth" : status === "broken" ? "failed" : "off";
	return { phase: jobs.get(key)?.phase ?? settled, installed: PRESENT[status] === true };
}


// -- Gates --------------------------------------------------------

/**
 * Run the install/auth gates for an already-installed skill and settle
 * state accordingly. Returns the resulting phase.
 */
export async function recheckSkill(key: string): Promise<SkillPhase> {
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill: ${key}`);
	const check = await sh(entry.checkCmd);
	if (!check.ok) {
		await recordSkill(entry, "broken", `check "${entry.checkCmd}" failed:\n${check.out}`);
		return "failed";
	}
	if (entry.authCheckCmd) {
		const auth = await sh(entry.authCheckCmd);
		if (!auth.ok) {
			await recordSkill(entry, "needs_auth", `${entry.authHint ?? "authentication required"}\n${auth.out}`);
			return "needs-auth";
		}
	}
	await recordSkill(entry, "active");
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

	// Already present (per its capability object, or on the machine anyway)? Just gate.
	const { status } = await localStatus(key);
	if (PRESENT[status] || (await sh(entry.checkCmd)).ok) {
		return recheckSkill(key);
	}

	runInstaller(
		key,
		"installing",
		entry.installPrompt,
		async () => {
			const phase = await recheckSkill(key);
			if (phase === "needs-auth") {
				await postSetupNotice(
					`\u2699\uFE0F **${entry.name}** installed, but needs you to finish sign-in: ${entry.authHint ?? "authenticate, then hit Re-check in Settings."}`,
				);
			} else if (phase === "failed") {
				await postSetupNotice(`\u26A0\uFE0F **${entry.name}** install failed — see the log in Settings \u2192 Skills.`);
				await recordSkill(entry, "broken", `install did not pass "${entry.checkCmd}"\n${jobLogTail(key)}`);
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
	const entry = CATALOG.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown skill: ${key}`);
	const { status } = await localStatus(key);
	if (PRESENT[status]) await recordSkill(entry, "disabled");
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
			const gone = !(await sh(entry.checkCmd)).ok;
			await recordSkill(entry, gone ? "missing" : "disabled", gone ? "" : `uninstall left "${entry.checkCmd}" passing\n${jobLogTail(key)}`);
		},
		// Symmetric finish line: gone from PATH is what removal means.
		async () => !(await sh(entry.checkCmd)).ok,
	);
	return "uninstalling";
}
