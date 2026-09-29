/**
 * Credential objects: logins people create and pin to a computer.
 *
 * A Credential (typeKey `credential`) is an ordinary synced object that
 * carries its own secret (credentials.ts): pasted keys in `secret`, a
 * browser sign-in's cookies in `session`. So an agent on ANY computer can
 * use a credential it lists in its Credentials property.
 *
 * `served_by` names the computer that looks after it: that computer opens
 * the headed sign-in window and exports the session, and keeps `status` /
 * `auth` / `error` / `checked_at` true for everyone to see. One writer per
 * credential, so two computers never fight over its status.
 */

import { hostname } from "node:os";
import { createObject, deleteField, fetchObject, mutate, queryAll, setField, str, sv, iv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { linkTarget, linkValue } from "./capabilities";
import { openLoginWindow, profileCookies, type LoginWindow, type SessionCookie } from "./browser";
import { actionsOf, KEY_PREFIX, credentialKeys, credentialSession, dropLegacySecrets, legacyKeyName, legacyKeys, legacyProfileDir, legacyProfileExists, recipeOf, seedFor, seedRecipeFields, serviceCookies, sessionSignedIn } from "./credentials";
import { fetchInstallations } from "./descriptors";
import { machines } from "./machine";
import { machineId } from "./roster";

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

const windows = new Map<string, LoginWindow>();

/** What is true for a credential right now, from what it carries. */
function liveState(row: CredentialRow): { status: CredentialStatus; auth: CredentialRow["auth"]; error: string } {
	const recipe = recipeOf(row.fields);
	const label = recipe.label || "this service";
	if (!recipe.sessionCookie && recipe.passwordFields.length === 0) {
		return { status: "broken", auth: "", error: "Say how this credential signs in: a login page and signed-in cookie, or the keys to paste (or start from a template)." };
	}
	const session = credentialSession(row.fields);
	if (sessionSignedIn(session, recipe)) return { status: "active", auth: "browser_profile", error: "" };
	if (credentialKeys(row.fields)) return { status: "active", auth: "api_key", error: "" };
	if (windows.has(row.id)) return { status: "connecting", auth: "", error: `Finish signing in to ${label} in the Chrome window on ${hostname()}.` };
	// It carried a login and the login is gone (expired, signed out): say so, rather than looking never-connected.
	if (session.length > 0 || row.status === "active" || row.status === "needs_auth") return { status: "needs_auth", auth: "", error: `The ${label} sign-in expired or was signed out - press Reconnect.` };
	return { status: "missing", auth: "", error: "" };
}

/** Write a credential's live state when it changed (or always, with `stamp`); returns the new row. */
async function publishState(row: CredentialRow, stamp = false): Promise<CredentialRow> {
	const next = liveState(row);
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
 * Re-read the credentials this computer looks after and write any status
 * that changed. Boot, every credential change and a slow timer call it.
 */
export async function refreshCredentials(): Promise<CredentialRow[]> {
	const me = await machineId();
	const rows = await Promise.all((await queryAll({ type: CREDENTIAL_TYPE })).map(rowOf));
	mine = await Promise.all(rows.filter((r) => r.servedBy === me).map((r) => publishState(r)));
	return mine;
}

export class CredentialError extends Error {
	constructor(
		readonly status: number,
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
		const keeper = (await machines()).find((m) => m.machineId === row.servedBy);
		throw new CredentialError(409, row.servedBy ? `This credential is looked after by ${keeper?.name ?? row.servedBy.slice(0, 8)}.` : "Set this credential's Served by to a computer first.");
	}
	return row;
}

/**
 * Open a plain headed sign-in window for a browser-login credential. The
 * moment the service's session cookie shows up in the window's profile (or
 * the person closes the window), the window is closed, its cookies are
 * exported, and a signed-in set is saved to the credential's `session`.
 */
export async function connectCredential(id: string): Promise<CredentialRow> {
	const row = await keptHere(id);
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
	const state = await publishState(row, true);
	const deadline = Date.now() + 15 * 60_000;
	let closed = false;
	void win.exited.then(() => (closed = true));
	const cookie = recipe.sessionCookie;
	void (async () => {
		while (!closed && Date.now() < deadline && !win.hasCookie(cookie.host, cookie.name)) await Bun.sleep(2000);
		// Let the site finish setting its other cookies before closing.
		if (!closed) await Bun.sleep(3000);
		try {
			const cookies = serviceCookies(await win.finish(), recipe);
			if (windows.get(row.id) === win && sessionSignedIn(cookies, recipe)) await setField(row.id, "session", sv(JSON.stringify(cookies)));
		} catch (err) {
			console.error("[credentials] reading the sign-in window's cookies failed:", err instanceof Error ? err.message : err);
		}
		if (windows.get(row.id) === win) windows.delete(row.id);
		await refreshCredentials().catch((err) => console.error("[credentials] refresh after sign-in failed:", err instanceof Error ? err.message : err));
	})();
	return state;
}

/** Check a credential now and stamp `checked_at`. */
export async function checkCredential(id: string): Promise<CredentialRow> {
	const row = await publishState(await keptHere(id), true);
	mine = [...mine.filter((c) => c.id !== row.id), row];
	return row;
}

/** Clear a credential's secret; it stays, as never-connected. */
export async function disconnectCredential(id: string): Promise<CredentialRow> {
	const row = await keptHere(id);
	const win = windows.get(row.id);
	windows.delete(row.id);
	void win?.finish().catch(() => {});
	for (const key of ["session", "secret", "auth", "error"]) if (row.fields[key]) await deleteField(row.id, key);
	await setField(row.id, "status", sv("missing"));
	await setField(row.id, "checked_at", iv(Date.now()));
	await refreshCredentials();
	return { ...row, status: "missing", auth: "", error: "" };
}

/**
 * The credential an agent may act with: one it lists in its Credentials
 * property, of the service asked for, that is active. Any computer can use
 * it - the secret rides on the object.
 */
export async function agentCredential(agent: ObjectJSON, service: string): Promise<{ row: CredentialRow; cookies: SessionCookie[]; keys: Record<string, string> | null }> {
	const linked = agentCredentialIds(agent);
	if (linked.length === 0) throw new Error("This agent lists no credentials. Add one to its Credentials property.");
	const rows = await Promise.all(linked.map((id) => credentialObject(id).catch(() => null)));
	const ofService = rows.filter((r): r is CredentialRow => !!r && r.service === service);
	if (ofService.length === 0) throw new Error(`None of this agent's credentials is for "${service}".`);
	const row = ofService.find((r) => r.status === "active") ?? ofService[0];
	if (row.status !== "active") throw new Error(`Credential "${row.name}" is not connected (${row.status || "missing"}${row.error ? `: ${row.error}` : ""}).`);
	return { row, cookies: credentialSession(row.fields), keys: credentialKeys(row.fields) };
}

/**
 * The model key an agent carries for `provider` ("anthropic" | "kimi"): the
 * first credential it lists of that service with its key filled in. Read
 * straight from the synced object - no computer has to vouch for it - so
 * the agent authenticates identically wherever it runs. null = it lists
 * none; the caller falls back to this computer's own login.
 */
export async function agentModelKey(agent: ObjectJSON, provider: string): Promise<string | null> {
	for (const id of agentCredentialIds(agent)) {
		const row = await credentialObject(id).catch(() => null);
		if (row?.service !== provider) continue;
		const key = credentialKeys(row.fields)?.api_key;
		if (key) return key;
	}
	return null;
}

/** Credential ids an agent lists in its Credentials property. */
export function agentCredentialIds(agent: ObjectJSON): string[] {
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
		const how = c.status !== "active" ? `not connected (${c.status || "missing"}) - tell the person to connect it` : c.auth === "browser_profile" ? `signed in: credential_fetch reads pages, credential_action acts (service "${c.service}")` : "keys saved";
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
 * keys); capabilities that linked the old row link the credential. Rows
 * that never worked are vanished and their local leftovers deleted.
 * Idempotent: afterwards there are no rows to move.
 */
export async function migrateLoginInstalls(): Promise<{ credentials: number; vanished: number }> {
	const me = await machineId();
	const rows = (await fetchInstallations()).filter((r) => r.machineId === me && !!seedFor(r.key));
	let credentials = 0;
	for (const row of rows) {
		const seed = seedFor(row.key)!;
		const recipe = recipeOf({ name: sv(seed.label), ...seedRecipeFields(seed) });
		const cookies = legacyProfileExists(row.key) ? serviceCookies(await profileCookies(legacyProfileDir(row.key)).catch(() => []), recipe) : [];
		const session = sessionSignedIn(cookies, recipe) ? cookies : [];
		const keys = legacyKeys(row.key);
		if (session.length === 0 && !keys) continue;
		const { id } = await createObject(seed.label, CREDENTIAL_TYPE, {
			...seedRecipeFields(seed),
			...(row.account ? { account: sv(row.account) } : {}),
			served_by: sv(me),
			...(session.length ? { session: sv(JSON.stringify(session)) } : {}),
			...Object.fromEntries(Object.entries(keys ?? {}).map(([k, v]) => [`${KEY_PREFIX}${legacyKeyName(k)}`, sv(v)])),
			status: sv("active"),
			auth: sv(session.length ? "browser_profile" : "api_key"),
			...(row.channel ? { channel: sv(row.channel) } : {}),
		});
		for (const cap of await queryAll({ type: "capability" })) {
			if (linkTarget(cap.fields, "install") === row.id) await setField(cap.id, "install", linkValue(id));
		}
		credentials += 1;
	}
	for (const row of rows) dropLegacySecrets(row.key);
	if (rows.length > 0) await mutate("vanish", { object_ids: rows.map((r) => r.id) });
	return { credentials, vanished: rows.length };
}
