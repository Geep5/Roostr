/**
 * Credential objects: logins people create and pin to a computer.
 *
 * A Credential (typeKey `credential`) is an ordinary synced object that
 * carries its own login (credentials.ts): pasted keys in `key_*`, a browser
 * sign-in's cookies in `cookie_*` + `cookie_meta`, a Google sign-in's
 * OAuth client and refresh token in `key_*`. So an agent on ANY computer
 * can use a credential it lists in its Credentials property.
 *
 * Connect runs on whichever of the person's computers the app asks: it opens
 * the headed sign-in window (or gws's Google sign-in) THERE and saves the
 * login onto the credential. `served_by` names the computer that looks
 * after it: it keeps `status` / `auth` / `error` / `checked_at` true for
 * everyone to see, and the first time it meets cookies signed in on another
 * computer it tries them on the site before calling them connected. One
 * writer per credential outside a sign-in, so two computers never fight
 * over its status. Check, pressed on any device, writes `check_requested`;
 * the computer serving it runs the live check and stamps `checked_at`.
 * Disconnect stops a sign-in in progress and forgets this
 * computer's local Google sign-in; the login saved on the credential stays
 * and keeps being used until the site refuses it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createObject, deleteField, fetchObject, mutate, num, queryAll, setField, str, sv, iv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { linkTarget } from "./capabilities";
import { credentialPageAction, openLoginWindow, profileCookies, type LoginWindow, type SessionCookie } from "./browser";
import { actionsOf, KEY_PREFIX, COOKIE_META, cookieProperty, cookieValueKeys, credentialKeys, credentialProperties, credentialSession, dropLegacySecrets, LEGACY_SESSION, legacyKeyName, legacyKeys, legacyProfileDir, legacyProfileExists, legacySession, recipeOf, seedFor, seedRecipeFields, serviceCookies, sessionAccepted, sessionDecision, sessionFields, sessionHash, sessionMeta, sessionSignedIn, type SessionCheck } from "./credentials";
import { ensureProperties } from "./credential-seeds";
import { legacyInstalls } from "./migrate-capabilities";
import { sessionRenewers } from "./extensions";
import { ensureGoogleClient, GOOGLE_SERVICE, googleSignInWorks, localSignIn, signInOf, syncGoogleCredentials } from "./google-credentials";
import { removeGoogleAccount } from "./google";
import { machines } from "./machine";
import { machineId } from "./roster";
import { checkPostgres, POSTGRES_SERVICE } from "./sql";
import { CREDENTIAL_BADGE, credentialBadge } from "./credential-issues";

export const CREDENTIAL_TYPE = "credential";

export type CredentialStatus = "missing" | "connecting" | "active" | "needs_auth" | "broken";

export interface CredentialRow {
	id: string;
	name: string;
	service: string;
	account: string;
	/** machine_id of the computer that looks after it; "" when no Served by is set. */
	servedBy: string;
	status: CredentialStatus | "";
	auth: "browser_profile" | "api_key" | "";
	error: string;
	fields: Record<string, ValueJSON>;
}

/** Credentials this computer looks after, as last refreshed. */
let mine: CredentialRow[] = [];

export function localCredentials(): CredentialRow[] {
	return mine;
}

/**
 * The machine_id a `served_by` value names. Hosts write a machine_id string
 * or link; the app's object picker can write a link (or one-item list) to
 * the machine OBJECT - that maps to its machine_id.
 */
export async function pinOf(fields: Record<string, ValueJSON>): Promise<string> {
	const v = fields["served_by"];
	const raw = linkTarget(fields, "served_by") || v?.valuesValue?.items?.[0]?.linkValue?.targetId || v?.valuesValue?.items?.[0]?.stringValue || "";
	if (!raw) return "";
	const byObject = (await machines()).find((m) => m.objectId === raw);
	return byObject ? byObject.machineId : raw;
}

async function rowOf(r: QueryRow | ObjectJSON): Promise<CredentialRow> {
	return {
		id: r.id,
		name: str(r.fields, "name"),
		service: str(r.fields, "service"),
		account: str(r.fields, "account"),
		servedBy: await pinOf(r.fields),
		status: str(r.fields, "status") as CredentialRow["status"],
		auth: str(r.fields, "auth") as CredentialRow["auth"],
		error: str(r.fields, "error"),
		fields: r.fields,
	};
}

/** Sign-in windows open on this computer, by credential id. */
const windows = new Map<string, LoginWindow>();
/** What a sign-in running on this computer tells the person (its `error` while `connecting`), by credential id. */
const signInText = new Map<string, string>();
/** A `connecting` status another computer wrote is left alone this long: its sign-in window stays open at most this. */
const SIGN_IN_MS = 15 * 60_000;

/** A computer's name, from its machine_id. */
async function computerName(id: string): Promise<string> {
	return (await machines()).find((m) => m.machineId === id)?.name ?? (id.slice(0, 8) || hostname());
}

/** What is true for a credential right now, from what it carries. */
function liveState(row: CredentialRow): LiveState {
	const recipe = recipeOf(row.fields);
	const label = recipe.label || "this service";
	if (!recipe.sessionCookie && recipe.passwordFields.length === 0) {
		return { status: "broken", auth: "", error: "Say how this credential signs in: a login page and signed-in cookie, or the keys to paste (or start from a template)." };
	}
	const session = credentialSession(row.fields);
	if (sessionSignedIn(session, recipe)) return { status: "active", auth: "browser_profile", error: "" };
	if (credentialKeys(row.fields)) return { status: "active", auth: "api_key", error: "" };
	if (windows.has(row.id)) return { status: "connecting", auth: "", error: signInText.get(row.id) ?? `Finish signing in to ${label} in the Chrome window on ${hostname()}.` };
	// It carried a login and the login is gone (expired, signed out): say so, rather than looking never-connected.
	if (session.length > 0 || row.status === "active" || row.status === "needs_auth") return { status: "needs_auth", auth: "", error: `The ${label} sign-in expired or was signed out - press Reconnect.` };
	// Never filled in: a keys-only credential says which ones to paste, by the names its Properties show.
	if (!recipe.sessionCookie) {
		const labels = recipe.passwordFields.map((f) => seedFor(row.service)?.passwordFields?.find((p) => p.key === f.key)?.label ?? f.label);
		return { status: "missing", auth: "", error: `No key yet - paste ${labels.map((l) => `"${l}"`).join(" and ")} to use it.` };
	}
	return { status: "missing", auth: "", error: "" };
}

type LiveState = { status: CredentialStatus; auth: CredentialRow["auth"]; error: string };

/** Write a credential's live state (`next`, else what it carries) when it changed (or always, with `stamp`); returns the new row. */
async function publishState(row: CredentialRow, stamp = false, next: LiveState = liveState(row)): Promise<CredentialRow> {
	const changed = next.status !== row.status || next.auth !== row.auth || next.error !== row.error;
	if (changed) {
		await setField(row.id, "status", sv(next.status));
		if (next.auth) await setField(row.id, "auth", sv(next.auth));
		else if (row.auth) await deleteField(row.id, "auth");
		if (next.error) await setField(row.id, "error", sv(next.error));
		else if (row.error) await deleteField(row.id, "error");
	}
	if (changed || stamp) await setField(row.id, "checked_at", iv(Date.now()));
	return { ...row, ...next };
}

/**
 * Save a sign-in's cookies on the credential: one `cookie_<name>` property
 * each (their definitions made in its space when missing), then
 * `cookie_meta` - written last, so a reader never meets a description of
 * values not there yet. Cookies the previous sign-in had and this one
 * lacks are removed, as is the pre-property `session`. Returns the fields
 * the credential carries afterwards.
 */
async function saveSession(row: CredentialRow, cookies: SessionCookie[], signedInOn: string): Promise<Record<string, ValueJSON>> {
	const next = sessionFields(cookies, signedInOn);
	const metaProperty = credentialProperties().filter((p) => p.key === COOKIE_META);
	await ensureProperties(str(row.fields, "channel"), [...metaProperty, ...(sessionMeta(next)?.cookies ?? []).map((c) => cookieProperty(c.key, c.name))]).catch((err) => console.error("[credentials] cookie properties:", err instanceof Error ? err.message : err));
	for (const [key, value] of Object.entries(next)) if (key !== COOKIE_META && row.fields[key]?.stringValue !== value.stringValue) await setField(row.id, key, value);
	await setField(row.id, COOKIE_META, next[COOKIE_META]);
	const fields = { ...row.fields };
	for (const key of [...cookieValueKeys(row.fields).filter((k) => !next[k]), ...(row.fields[LEGACY_SESSION] ? [LEGACY_SESSION] : [])]) {
		await deleteField(row.id, key);
		delete fields[key];
	}
	return { ...fields, ...next };
}

/** Renew this long before the cookie runs out, so a 5-minute refresh never lets it lapse. */
const RENEW_AHEAD_S = 20 * 60;

/**
 * A renewable credential whose session cookie is about to lapse (or has),
 * renewed; else unchanged. Renewable: a service with an extension's session
 * renewer - the site re-sets the cookie on every visit while the login behind
 * it lives much longer, so the renewer visits the way a browser would and
 * returns the re-stamped cookies, or null when the login is really gone.
 */
async function renewSession(row: CredentialRow, me: string): Promise<CredentialRow> {
	const renew = sessionRenewers[row.service];
	const recipe = recipeOf(row.fields);
	const session = credentialSession(row.fields);
	if (!renew || !recipe.sessionCookie || session.length === 0) return row;
	const soon = Date.now() / 1000 + RENEW_AHEAD_S;
	const cookie = session.find((c) => c.name === recipe.sessionCookie!.name);
	if (!cookie || (cookie.expires > 0 && cookie.expires > soon)) return row;
	const renewed = await renew(row.fields).catch(() => null);
	if (!renewed) return row;
	// The site re-stamped them here: they work on this computer.
	return { ...row, fields: await saveSession(row, renewed, me) };
}

/** A credential still carrying the pre-property `session` JSON, converted to `cookie_*` properties (the computer serving it does this once). */
async function convertLegacySession(row: CredentialRow, me: string): Promise<CredentialRow> {
	if (!row.fields[LEGACY_SESSION]) return row;
	const cookies = legacySession(row.fields);
	if (cookies.length > 0) return { ...row, fields: await saveSession(row, cookies, me) };
	await deleteField(row.id, LEGACY_SESSION);
	const { [LEGACY_SESSION]: _, ...fields } = row.fields;
	return { ...row, fields };
}

// ── Cookies signed in on another computer ────────────────────────

/** What this computer found trying each credential's cookies on its site: <GLON_DATA>/session-checks.json, credential id → SessionCheck. Hashes only, no secrets. */
const checksPath = (): string => join(process.env.GLON_DATA ?? join(homedir(), ".glon"), "session-checks.json");

function sessionChecks(): Record<string, SessionCheck> {
	try {
		return JSON.parse(readFileSync(checksPath(), "utf8")) as Record<string, SessionCheck>;
	} catch {
		return {};
	}
}

function recordSessionCheck(id: string, check: SessionCheck): void {
	const all = { ...sessionChecks(), [id]: check };
	mkdirSync(join(checksPath(), ".."), { recursive: true });
	writeFileSync(checksPath(), JSON.stringify(all), { mode: 0o600 });
}

/** Tries under way, by credential id and cookie hash: a refresh landing mid-try waits for it instead of opening a second Chrome. */
const trying = new Map<string, Promise<boolean | null>>();

/**
 * Open the site's front page in a throwaway headless Chrome carrying the
 * credential's cookies: true when the site kept the login, false when it
 * sent the page to a login wall or cleared the session cookie, null when it
 * could not be tried (no Chrome, no network).
 */
function trySession(row: CredentialRow): Promise<boolean | null> {
	const recipe = recipeOf(row.fields);
	const key = `${row.id}:${sessionHash(row.fields)}`;
	const running = trying.get(key);
	if (running) return running;
	const attempt = (async () => {
		if (!recipe.sessionCookie) return null;
		try {
			return sessionAccepted(await credentialPageAction(credentialSession(row.fields), `https://${recipe.sessionCookie.host}/`, "", 45_000), recipe);
		} catch (err) {
			console.error(`[credentials] could not try ${row.name || row.id}'s cookies:`, err instanceof Error ? err.message : err);
			return null;
		} finally {
			trying.delete(key);
		}
	})();
	trying.set(key, attempt);
	return attempt;
}

/** The site refused the credential's cookies here: say where they were made and where to sign in instead. */
async function refusedState(row: CredentialRow, me: string): Promise<LiveState> {
	const label = recipeOf(row.fields).label || "This site";
	const from = sessionMeta(row.fields)?.signedInOn ?? "";
	if (!from || from === me) return { status: "needs_auth", auth: "", error: `The ${label} sign-in expired or was signed out - press Reconnect.` };
	return { status: "needs_auth", auth: "", error: `${label} didn't accept the login made on ${await computerName(from)}; sign in on ${await computerName(me)} instead (press Reconnect there).` };
}

/**
 * A browser sign-in's state on the computer serving it, beyond what its
 * cookies say (undefined = liveState): cookies signed in on another
 * computer are tried on the site the first time this computer meets them
 * (sessionDecision); `force` (Check now) tries them whatever their origin.
 * The values stay on the credential either way.
 */
async function browserState(row: CredentialRow, me: string, force = false): Promise<LiveState | undefined> {
	const recipe = recipeOf(row.fields);
	if (!sessionSignedIn(credentialSession(row.fields), recipe)) return undefined;
	const decision = force ? "check" : sessionDecision(row.fields, me, sessionChecks()[row.id]);
	if (decision === "rejected") return refusedState(row, me);
	if (decision !== "check") return undefined;
	const hash = sessionHash(row.fields);
	const accepted = await trySession(row);
	if (accepted === null) return undefined;
	recordSessionCheck(row.id, { hash, accepted });
	return accepted ? undefined : refusedState(row, me);
}

/** What the computer serving a credential writes for it now; `force` runs the live check (Check now). */
async function servedState(row: CredentialRow, me: string, force = false): Promise<LiveState | undefined> {
	if (row.service === GOOGLE_SERVICE) return force ? googleCheck(row) : googleState(row);
	if (row.service === POSTGRES_SERVICE) return force ? postgresCheck(row) : postgresState(row);
	return browserState(row, me, force);
}

/**
 * On a credential: a person pressed Check (epoch ms, the asking device's
 * clock), on any device. The computer serving it runs the live check and
 * stamps `checked_at`, which is the answer every device waits for; the
 * request stays as the record of when it was asked.
 */
export const CHECK_REQUEST_KEY = "check_requested";

/**
 * The Check asked for that the computer serving the credential has not
 * answered (0 = none): newer than `checked_at`, and not the one it last
 * answered (`answered`) - a device clock running ahead of this one's would
 * otherwise keep a request newer than every answer.
 */
export function pendingCheck(fields: Record<string, ValueJSON>, answered = 0): number {
	const at = num(fields, CHECK_REQUEST_KEY) ?? 0;
	return at > (num(fields, "checked_at") ?? 0) && at !== answered ? at : 0;
}

/**
 * What a refresh does with a credential this computer serves (`here`: a
 * sign-in window or Google sign-in for it runs on this computer; `answered`:
 * the request this computer answered last):
 * - `answer`: a Check was asked for while a sign-in runs here - its window
 *   stays open; the answer is its `connecting` status, stamped;
 * - `check`: a Check was asked for - the live check runs now, even while
 *   another computer's sign-in is marked running (the request is newer than
 *   its start: the person says they finished signing in);
 * - `leave`: a sign-in owns the status until it finishes (or SIGN_IN_MS
 *   passes) - here, or on another computer that wrote `connecting` - so a
 *   Reconnect never reads "Connected" off the old login mid-sign-in;
 * - `refresh`: the usual quiet refresh.
 */
export function refreshPlan(fields: Record<string, ValueJSON>, status: string, here: boolean, answered = 0, now = Date.now()): "answer" | "check" | "leave" | "refresh" {
	const asked = pendingCheck(fields, answered) > 0;
	if (here) return asked ? "answer" : "leave";
	if (asked) return "check";
	return status === "connecting" && now - (num(fields, "checked_at") ?? 0) < SIGN_IN_MS ? "leave" : "refresh";
}

/** The Check request this computer answered (or is answering) last, by credential id: each is answered once, overlapping refreshes included. */
const answeredChecks = new Map<string, number>();

/** Run the live check a person asked for (any device's Check, or this computer's POST /credentials/check) and stamp `checked_at`. */
async function checkNow(row: CredentialRow, me: string): Promise<CredentialRow> {
	// A sign-in running here owns the status: the answer is that it is still waiting, its window left open.
	if (windows.has(row.id) || googleLogins.has(row.id)) return publishState(row, true, { status: "connecting", auth: "", error: signInText.get(row.id) ?? row.error });
	return publishState(row, true, await servedState(row, me, true));
}

/**
 * Re-read the credentials this computer looks after and write any status
 * that changed - and answer any Check asked for since the last one. Boot,
 * every credential change and a slow timer call it.
 */
export async function refreshCredentials(): Promise<CredentialRow[]> {
	const me = await machineId();
	const rows = await Promise.all((await queryAll({ type: CREDENTIAL_TYPE })).map(rowOf));
	mine = await Promise.all(
		rows
			.filter((r) => r.servedBy === me)
			.map(async (r) => {
				const plan = refreshPlan(r.fields, r.status, windows.has(r.id) || googleLogins.has(r.id), answeredChecks.get(r.id));
				if (plan === "leave") return r;
				if (plan !== "refresh") {
					const request = pendingCheck(r.fields);
					answeredChecks.set(r.id, request);
					try {
						return await checkNow(r, me);
					} catch (err) {
						// Not answered: the next refresh tries it again.
						if (answeredChecks.get(r.id) === request) answeredChecks.delete(r.id);
						throw err;
					}
				}
				const row = r.service === GOOGLE_SERVICE || r.service === POSTGRES_SERVICE ? r : await renewSession(await convertLegacySession(r, me), me);
				return publishState(row, false, await servedState(row, me));
			}),
	);
	// Google sign-ins travel on their Credentials: import local ones, write the listed ones here.
	await syncGoogleCredentials().catch((err) => console.error("[google] sync failed:", err instanceof Error ? err.message : err));
	const current = new Map(rows.map((r) => [r.id, r]));
	for (const r of mine) current.set(r.id, r);
	await badgeAgents(me, current).catch((err) => console.error("[harness] agent credential badges:", err instanceof Error ? err.message : err));
	return mine;
}

/**
 * An agent served here that lists a signed-out or disconnected Credential
 * carries "credential signed out: <names>" on its Error, so the dead login
 * shows on the agent and not only on the Credential; reconnecting clears it
 * on the next check. Only this badge is ours - a run failure or a holdup
 * already on the agent is left alone.
 */
async function badgeAgents(me: string, credentials: Map<string, CredentialRow>): Promise<void> {
	for (const agent of await queryAll({ type: "agent" })) {
		if (str(agent.fields, "served_by") !== me) continue;
		const dead = agentCredentialIds(agent).map((id) => credentials.get(id)).filter((c): c is CredentialRow => !!c && c.status !== "active").map((c) => c.name);
		const badge = str(agent.fields, "error");
		const ours = badge.startsWith(CREDENTIAL_BADGE);
		if (dead.length > 0) {
			const next = credentialBadge(dead);
			if ((!badge || ours) && badge !== next) await setField(agent.id, "error", sv(next));
		} else if (ours) {
			await deleteField(agent.id, "error");
		}
	}
}

export class CredentialError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** The agent's credential for a service exists but is signed out or disconnected (not a setup mistake). */
export class CredentialNotConnected extends Error {
	constructor(
		readonly credentialName: string,
		message: string,
	) {
		super(message);
	}
}

async function credentialObject(id: string): Promise<CredentialRow> {
	const obj = await fetchObject(id).catch(() => null);
	if (!obj || obj.deleted || obj.typeKey !== CREDENTIAL_TYPE) throw new CredentialError(404, "No such credential.");
	return rowOf(obj);
}

/** A credential this computer looks after, or the refusal an endpoint returns. */
async function keptHere(id: string): Promise<CredentialRow> {
	const row = await credentialObject(id);
	if (row.servedBy !== (await machineId())) {
		throw new CredentialError(409, row.servedBy ? `This credential is looked after by ${await computerName(row.servedBy)}.` : "Set this credential's Served by to a computer first.");
	}
	return row;
}

/**
 * Sign a credential in on THIS computer, whichever computer serves it: a
 * browser login opens a plain headed sign-in window here, a Google account
 * runs gws's sign-in here (connectGoogle). The moment the service's session
 * cookie shows up in the window's profile (or the person closes the
 * window), the window is closed, its cookies are exported, and a signed-in
 * set is saved on the credential as `cookie_*` properties naming this
 * computer - the computer serving it takes it from there. A database has no
 * sign-in: its Connect is its live check, on the computer serving it.
 */
export async function connectCredential(id: string): Promise<CredentialRow> {
	const row = await credentialObject(id);
	if (row.service === POSTGRES_SERVICE) return checkCredential(id);
	if (!row.servedBy) throw new CredentialError(409, "Set this credential's Served by to a computer first.");
	const me = await machineId();
	const here = await computerName(me);
	const handOff = row.servedBy === me ? "" : `; Roostr then hands the login to ${await computerName(row.servedBy)}`;
	if (row.service === GOOGLE_SERVICE) return connectGoogle(row, me, `Finish signing in to Google in the browser on ${here}${handOff}.`);
	const recipe = recipeOf(row.fields);
	if (!recipe.loginUrl || !recipe.sessionCookie) throw new CredentialError(400, `${recipe.label || "This credential"} has no login page and signed-in cookie - it connects with pasted keys.`);
	if (windows.has(row.id)) throw new CredentialError(409, "A sign-in window for this credential is already open on this computer.");
	let win: LoginWindow;
	try {
		win = openLoginWindow(recipe.loginUrl);
	} catch (err) {
		throw new CredentialError(409, err instanceof Error ? err.message : String(err));
	}
	windows.set(row.id, win);
	const text = `Finish signing in to ${recipe.label || "this service"} in the Chrome window on ${here}${handOff}.`;
	signInText.set(row.id, text);
	const state = await publishState(row, true, { status: "connecting", auth: "", error: text });
	const deadline = Date.now() + SIGN_IN_MS;
	let closed = false;
	void win.exited.then(() => (closed = true));
	const cookie = recipe.sessionCookie;
	void (async () => {
		while (!closed && Date.now() < deadline && !win.hasCookie(cookie.host, cookie.name)) await Bun.sleep(2000);
		// Let the site finish setting its other cookies before closing.
		if (!closed) await Bun.sleep(3000);
		try {
			const cookies = serviceCookies(await win.finish(), recipe);
			if (windows.get(row.id) === win && sessionSignedIn(cookies, recipe)) await saveSession(await credentialObject(row.id), cookies, me);
		} catch (err) {
			console.error("[credentials] reading the sign-in window's cookies failed:", err instanceof Error ? err.message : err);
		}
		if (windows.get(row.id) !== win) return; // disconnected meanwhile
		windows.delete(row.id);
		signInText.delete(row.id);
		try {
			// The sign-in's own end: what it left (the computer serving it then tries cookies made elsewhere on its next refresh).
			const fresh = await credentialObject(row.id);
			await publishState(fresh, true, fresh.servedBy === me ? await servedState(fresh, me) : undefined);
		} catch (err) {
			console.error("[credentials] finishing the sign-in failed:", err instanceof Error ? err.message : err);
		}
		await refreshCredentials().catch((err) => console.error("[credentials] refresh after sign-in failed:", err instanceof Error ? err.message : err));
	})();
	return state;
}

/**
 * Check a credential now, on the computer serving it, and stamp
 * `checked_at`: a browser sign-in's cookies are tried on the site, a Google
 * credential's refresh token on Google, a PostgreSQL one connects and runs
 * `select 1`. The same check a Check asked for from any device runs
 * (`check_requested`, refreshCredentials).
 */
export async function checkCredential(id: string): Promise<CredentialRow> {
	const row = await checkNow(await keptHere(id), await machineId());
	mine = [...mine.filter((c) => c.id !== row.id), row];
	return row;
}

/** PostgreSQL credentials this computer checked since it started: what was checked (URL and ssh host, hashed) and when. */
const postgresChecks = new Map<string, { fingerprint: string; at: number }>();
/** A broken database is tried again on a refresh at most this often. */
const POSTGRES_RETRY_MS = 5 * 60_000;

/** The live check: connect (through the SSH tunnel, when ssh_host is set) and run `select 1`; the error says why not, with no secret in it. */
async function postgresCheck(row: CredentialRow): Promise<LiveState> {
	const url = credentialKeys(row.fields)?.url ?? "";
	const sshHost = str(row.fields, "ssh_host").trim();
	if (!url) return { status: "missing", auth: "", error: "Fill in the Database URL (postgres://user:password@host:port/database), then press Connect." };
	const error = await checkPostgres({ id: row.id, url, sshHost });
	postgresChecks.set(row.id, { fingerprint: Bun.hash(`${url}\n${sshHost}`).toString(16), at: Date.now() });
	return error ? { status: "broken", auth: "", error: `Could not query the database from ${hostname()}: ${error}` } : { status: "active", auth: "api_key", error: "" };
}

/**
 * What the slow refresh writes for a PostgreSQL credential: the last live
 * check stands while the URL and ssh host are what was checked; a changed
 * (or never checked here) one gets a check, and a broken one is retried
 * every few minutes.
 */
async function postgresState(row: CredentialRow): Promise<LiveState> {
	const url = credentialKeys(row.fields)?.url ?? "";
	const last = postgresChecks.get(row.id);
	const same = !!url && last?.fingerprint === Bun.hash(`${url}\n${str(row.fields, "ssh_host").trim()}`).toString(16);
	if (same && row.status === "active") return { status: "active", auth: row.auth, error: row.error };
	if (same && row.status === "broken" && Date.now() - (last?.at ?? 0) < POSTGRES_RETRY_MS) return { status: "broken", auth: row.auth, error: row.error };
	return postgresCheck(row);
}

/** Running `gws-as <account> auth login` processes, by credential id. */
const googleLogins = new Map<string, ChildProcess>();
const GOOGLE_LOGIN_TIMEOUT_MS = 15 * 60_000;

/** The live check, wherever it runs: does Google still take the credential's refresh token? */
async function googleCheck(row: CredentialRow): Promise<LiveState> {
	if (googleLogins.has(row.id)) return googleConnecting(row);
	if (!row.account) return { status: "broken", auth: "", error: "Set Account to the Google email address." };
	const signIn = signInOf(row.fields);
	if (!signIn) return googleSignedOut(row);
	const works = await googleSignInWorks(signIn);
	if (works === true) return { status: "active", auth: "api_key", error: "" };
	if (works === false) return { status: "needs_auth", auth: "", error: `Google no longer accepts the sign-in saved for ${row.account} (revoked or expired) - press Connect.` };
	// Google could not be asked: a working sign-in stays working until it can be.
	if (row.status === "active") return { status: "active", auth: row.auth, error: row.error };
	return { status: "broken", auth: "", error: `Could not ask Google about ${row.account} from ${hostname()}: ${works}` };
}

function googleConnecting(row: CredentialRow): LiveState {
	return { status: "connecting", auth: "", error: signInText.get(row.id) ?? `Finish signing in to Google in the browser on ${hostname()}.` };
}

function googleSignedOut(row: CredentialRow): LiveState {
	if (row.status === "active" || row.status === "needs_auth") return { status: "needs_auth", auth: "", error: "The Google sign-in is gone - press Connect." };
	// A failed Connect left its reason; keep it until the next Connect.
	if (row.status === "broken" && row.error) return { status: "broken", auth: "", error: row.error };
	return { status: "missing", auth: "", error: "" };
}

/**
 * What the slow refresh writes for a Google credential: the last live
 * check stands while the keys are there; keys that arrived without a
 * check yet (an import) get one; gone keys mean signed out.
 */
async function googleState(row: CredentialRow): Promise<LiveState> {
	if (googleLogins.has(row.id)) return googleConnecting(row);
	if (!signInOf(row.fields)) return googleSignedOut(row);
	if (row.status === "active" || row.status === "needs_auth") return { status: row.status, auth: row.auth, error: row.error };
	return googleCheck(row);
}

/**
 * Connect a Google credential: run `gws-as <account> auth login` on this
 * computer (it opens Google's consent page in the browser) - with the OAuth
 * client the credential already carries when this computer has none. The
 * process exiting 0 is the sign-in landing: its keys (client id and secret,
 * refresh token) are read back with `gws auth export` and saved on the
 * credential, then a live check sets the status. On a computer that does
 * not serve the credential the local gws sign-in is then removed: the
 * credential carries it. A failed or timed-out sign-in leaves the reason on
 * `error`.
 */
async function connectGoogle(row: CredentialRow, me: string, text: string): Promise<CredentialRow> {
	const email = row.account.trim();
	if (!/^[^\s/@]+@[^\s/@]+$/.test(email)) throw new CredentialError(400, "Set Account to the Google email address first.");
	if (googleLogins.has(row.id)) throw new CredentialError(409, "A Google sign-in for this credential is already running on this computer.");
	if (!ensureGoogleClient(email, row.fields)) throw new CredentialError(409, `gws on ${await computerName(me)} has no OAuth client to sign in with (no ~/.config/gws/client_secret.json) - run \`gws auth setup\` there, or connect on ${await computerName(row.servedBy)}.`);
	let proc: ChildProcess;
	try {
		proc = spawn("gws-as", [email, "auth", "login"], { detached: true, stdio: "ignore" });
	} catch (err) {
		throw new CredentialError(409, err instanceof Error ? err.message : String(err));
	}
	googleLogins.set(row.id, proc);
	signInText.set(row.id, text);
	const state = await publishState(row, true, googleConnecting(row));
	const timer = setTimeout(() => proc.kill(), GOOGLE_LOGIN_TIMEOUT_MS);
	const exited = new Promise<{ code: number | null; err?: Error }>((resolve) => {
		proc.once("error", (err) => resolve({ code: null, err }));
		proc.once("exit", (code) => resolve({ code }));
	});
	void (async () => {
		const { code, err } = await exited;
		clearTimeout(timer);
		const ours = googleLogins.get(row.id) === proc;
		if (!ours) return; // disconnected meanwhile
		googleLogins.delete(row.id);
		signInText.delete(row.id);
		let fail = "";
		try {
			const signIn = code === 0 ? await localSignIn(email) : null;
			if (signIn) for (const [k, v] of Object.entries(signIn)) await setField(row.id, `${KEY_PREFIX}${k}`, sv(v));
			else fail = err ? `Could not run gws-as on ${hostname()}: ${err.message}` : code === 0 ? `The Google sign-in finished but no sign-in was saved for ${email}.` : code === null ? "The Google sign-in timed out or was stopped - press Connect again." : `The Google sign-in did not finish (gws exited ${code}).`;
			if (signIn && row.servedBy !== me) removeGoogleAccount(email);
			const fresh = await credentialObject(row.id);
			await publishState(fresh, true, fail ? { status: "broken", auth: "", error: fail } : await googleCheck(fresh));
		} catch (e) {
			console.error("[credentials] finishing the Google sign-in failed:", e instanceof Error ? e.message : e);
		}
		await refreshCredentials().catch((e) => console.error("[credentials] refresh after Google sign-in failed:", e instanceof Error ? e.message : e));
	})();
	return state;
}

/**
 * Stop a sign-in running for this credential on this computer and forget
 * this computer's local Google sign-in for its account. The login saved on
 * the credential (`cookie_*`, `key_*`) stays and keeps being used until the
 * site refuses it; the computer serving it re-states its status from that.
 */
export async function disconnectCredential(id: string): Promise<CredentialRow> {
	const row = await credentialObject(id);
	const me = await machineId();
	const win = windows.get(row.id);
	windows.delete(row.id);
	signInText.delete(row.id);
	void win?.finish().catch(() => {});
	const login = googleLogins.get(row.id);
	googleLogins.delete(row.id);
	login?.kill();
	if (row.service === GOOGLE_SERVICE && /^[^\s/@]+@[^\s/@]+$/.test(row.account.trim())) removeGoogleAccount(row.account.trim());
	if (row.servedBy === me) {
		const kept = await publishState(row, true, await servedState(row, me));
		mine = [...mine.filter((c) => c.id !== kept.id), kept];
		return kept;
	}
	// A sign-in this computer was running wrote `connecting`: put back what the credential carries.
	return win || login ? publishState(row, true, row.service === GOOGLE_SERVICE ? await googleCheck(row) : undefined) : row;
}

/** A credential an agent may act with, its secrets read off the object: session cookies and pasted keys. */
export interface AgentCredential {
	row: CredentialRow;
	cookies: SessionCookie[];
	keys: Record<string, string> | null;
}

/**
 * The credential an agent may act with: one it lists in its Credentials
 * property, of the service asked for, that is active - the one `pick`
 * names (its name or id) when given, else the first active one. Any
 * computer can use it - the secret rides on the object.
 */
export async function agentCredential(agent: ObjectJSON, service: string, pick = ""): Promise<AgentCredential> {
	const linked = agentCredentialIds(agent);
	if (linked.length === 0) throw new Error("This agent lists no credentials. Add one to its Credentials property.");
	const rows = await Promise.all(linked.map((id) => credentialObject(id).catch(() => null)));
	const ofService = rows.filter((r): r is CredentialRow => !!r && r.service === service);
	if (ofService.length === 0) throw new Error(`None of this agent's credentials is for "${service}".`);
	const picked = pick ? ofService.find((r) => r.id === pick || r.name === pick) ?? ofService.find((r) => r.name.toLowerCase() === pick.toLowerCase()) : undefined;
	if (pick && !picked) throw new Error(`None of this agent's "${service}" credentials is "${pick}"; they are: ${ofService.map((r) => `"${r.name}"`).join(", ")}.`);
	const row = picked ?? ofService.find((r) => r.status === "active") ?? ofService[0];
	if (row.status !== "active") throw new CredentialNotConnected(row.name, `Credential "${row.name}" is not connected (${row.status || "missing"}${row.error ? `: ${row.error}` : ""}).`);
	return { row, cookies: credentialSession(row.fields), keys: credentialKeys(row.fields) };
}

/**
 * The model key an agent carries for `provider` ("anthropic" | "kimi"): the
 * first credential it lists of that service with its key filled in. Read
 * straight from the synced object - no computer has to vouch for it - so
 * the agent authenticates identically wherever it runs. null = it lists
 * none; the caller falls back to this computer's own login. Listing one
 * whose key is empty is an error naming it - never a silent fallback that
 * works on one computer and not another.
 */
export async function agentModelKey(agent: ObjectJSON, provider: string): Promise<string | null> {
	const empty: string[] = [];
	for (const id of agentCredentialIds(agent)) {
		const row = await credentialObject(id).catch(() => null);
		if (row?.service !== provider) continue;
		const key = credentialKeys(row.fields)?.api_key;
		if (key) return key;
		empty.push(row.name || "Anthropic");
	}
	if (empty.length > 0) throw new Error(`The "${empty[0]}" credential has no key. Open it and paste an API key or token in its "API key or token" property.`);
	return null;
}

/** Credential ids an agent lists in its Credentials property. */
export function agentCredentialIds(agent: { fields: Record<string, ValueJSON> }): string[] {
	const v = agent.fields["credentials"];
	if (!v) return [];
	const items = v.valuesValue?.items ?? [v];
	return items.map((i) => i.linkValue?.targetId || i.stringValue || "").filter(Boolean);
}

/** Pasted keys of the first active credential of a service that this computer looks after (the Discord bot token). */
export function localKeys(service: string): Record<string, string> | null {
	for (const c of mine) if (c.service === service && c.status === "active") {
		const keys = credentialKeys(c.fields);
		if (keys) return keys;
	}
	return null;
}

/** One prompt section: the credentials an agent lists, and how to use them. */
export async function credentialsPromptLine(agent: ObjectJSON): Promise<string> {
	const rows = (await Promise.all(agentCredentialIds(agent).map((id) => credentialObject(id).catch(() => null)))).filter((r): r is CredentialRow => !!r);
	if (rows.length === 0) return "";
	const lines = rows.map((c) => {
		const how = c.status !== "active" ? `not connected (${c.status || "missing"}) - tell the person to connect it` : c.service === GOOGLE_SERVICE ? `signed in: run \`gws-as ${c.account} …\` in the shell (the google skill says how)` : c.service === POSTGRES_SERVICE ? `connected: query it read-only with sql_query (credential "${c.name}"); its Skill or guide has the schema` : c.auth === "browser_profile" ? `signed in: credential_fetch reads pages, credential_action acts (service "${c.service}")` : "keys saved";
		const acts = actionsOf(c.fields);
		const doing = acts.length > 0 ? `; actions: ${acts.map((a) => `${a.key} - ${a.summary} (${a.access})`).join("; ")}` : "";
		return `- ${c.name || c.service || "Credential"}${c.account ? ` (${c.account})` : ""} - service "${c.service}": ${how}${doing}`;
	});
	return `Your credentials (browserless/web_fetch are deliberately logged out):\n${lines.join("\n")}`;
}

/**
 * One-time move from service-keyed login rows to Credential objects, for
 * THIS computer's rows only (each computer migrates its own when it
 * updates). A login that works here becomes a Credential looked after here,
 * carrying its secret (the legacy Chrome profile's cookies, or the saved
 * keys). Rows that never worked are vanished and their local leftovers
 * deleted; capabilities pointing at sign-in keys go in migrateCapabilities.
 * Idempotent: afterwards there are no rows to move.
 */
export async function migrateLoginInstalls(): Promise<{ credentials: number; vanished: number }> {
	const me = await machineId();
	const rows = (await legacyInstalls()).filter((r) => r.machineId === me && !!seedFor(r.key));
	let credentials = 0;
	for (const row of rows) {
		const seed = seedFor(row.key)!;
		const recipe = recipeOf({ name: sv(seed.label), ...seedRecipeFields(seed) });
		const cookies = legacyProfileExists(row.key) ? serviceCookies(await profileCookies(legacyProfileDir(row.key)).catch(() => []), recipe) : [];
		const session = sessionSignedIn(cookies, recipe) ? cookies : [];
		const keys = legacyKeys(row.key);
		if (session.length === 0 && !keys) continue;
		await createObject(seed.label, CREDENTIAL_TYPE, {
			...seedRecipeFields(seed),
			...(row.account ? { account: sv(row.account) } : {}),
			served_by: sv(me),
			...(session.length ? sessionFields(session, me) : {}),
			...Object.fromEntries(Object.entries(keys ?? {}).map(([k, v]) => [`${KEY_PREFIX}${legacyKeyName(k)}`, sv(v)])),
			status: sv("active"),
			auth: sv(session.length ? "browser_profile" : "api_key"),
			...(row.channel ? { channel: sv(row.channel) } : {}),
		});
		credentials += 1;
	}
	for (const row of rows) dropLegacySecrets(row.key);
	if (rows.length > 0) await mutate("vanish", { object_ids: rows.map((r) => r.id) });
	return { credentials, vanished: rows.length };
}
