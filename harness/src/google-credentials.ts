/**
 * Google accounts as Roostr Credentials (service "google-account").
 *
 * A gws sign-in is three strings - the OAuth client id and secret and a
 * refresh token, what `gws auth export --unmasked` prints - so it lives on
 * the Credential object like any pasted key (`key_client_id`,
 * `key_client_secret`, `key_refresh_token`), and any computer can use it:
 *
 *  - connect (credential-objects.ts) runs `gws-as <email> auth login` on
 *    whichever computer the person pressed Connect on and copies the export
 *    onto the credential. A computer with no OAuth client of its own signs in
 *    with the one the credential carries (ensureGoogleClient).
 *  - import: an account signed in locally (~/.config/gws/accounts/<email>)
 *    is copied onto that account's Credential when this computer serves it
 *    and the credential has no working sign-in (importReplaces), or onto a
 *    new one in the default space when there is none.
 *  - check: Google is asked to exchange the refresh token for an access
 *    token (googleSignInWorks) - nothing local needed.
 *  - materialize: for every Google credential an agent served here lists,
 *    write `<GLON_DATA>/google/<email>.json` (0600, authorized_user) and
 *    remove files for accounts no longer listed. `gws-as <email>` prefers
 *    that file (harness/bin/gws-as) - so the credential is the permission,
 *    as for every other login, and the computer needs no local sign-in.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API, apiFetch, createObject, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { agentServedHere } from "./machine";
import { machineId } from "./roster";
import { pinOf } from "./credential-objects";

export const GOOGLE_SERVICE = "google-account";
const KEYS = ["client_id", "client_secret", "refresh_token"] as const;
export type SignIn = Record<(typeof KEYS)[number], string>;

const accountsDir = (): string => process.env.GOOGLE_WORKSPACE_ACCOUNTS_DIR ?? join(homedir(), ".config", "gws", "accounts");
export const googleFilesDir = (): string => join(process.env.GLON_DATA ?? join(homedir(), ".glon"), "google");

const emailOk = (s: string): boolean => /^[^\s/@]+@[^\s/@]+$/.test(s);

/** A local account's sign-in (`gws-as <email> auth login`), read with its own config dir; null when it has none. */
export async function localSignIn(email: string): Promise<SignIn | null> {
	const dir = join(accountsDir(), email);
	if (!existsSync(join(dir, "credentials.enc"))) return null;
	const proc = Bun.spawn(["gws", "auth", "export", "--unmasked"], {
		env: { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: dir, GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: "file" },
		stdout: "pipe",
		stderr: "ignore",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return null;
	try {
		const j = JSON.parse(out) as Partial<SignIn>;
		return KEYS.every((k) => typeof j[k] === "string" && j[k]) ? (j as SignIn) : null;
	} catch {
		return null;
	}
}

export function signInOf(fields: Record<string, ValueJSON>): SignIn | null {
	const out = Object.fromEntries(KEYS.map((k) => [k, str(fields, `key_${k}`)])) as SignIn;
	return KEYS.every((k) => out[k]) ? out : null;
}

async function defaultSpace(): Promise<string> {
	const channels = (await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	return channels[0]?.id ?? "";
}

/**
 * Whether a local sign-in replaces the one a credential carries: always
 * when it carries none; never when they are the same; otherwise only while
 * the credential's is not working (`status` not active, no sign-in under
 * way) - a sign-in made on another computer is never overwritten by an
 * older local one.
 */
export function importReplaces(stored: SignIn | null, local: SignIn, status: string): boolean {
	if (!stored) return true;
	if (KEYS.every((k) => stored[k] === local[k])) return false;
	return status !== "active" && status !== "connecting";
}

/**
 * Make sure `gws-as <email> auth login` has an OAuth client on this
 * computer: the account's own client_secret.json, the shared one gws-as
 * copies (~/.config/gws/client_secret.json or the accounts root's), or -
 * when there is none - one written from the client id and secret the
 * credential carries from its last sign-in. Returns false when there is
 * no client to sign in with.
 */
export function ensureGoogleClient(email: string, fields: Record<string, ValueJSON>, sharedClient = join(homedir(), ".config", "gws", "client_secret.json")): boolean {
	const dir = join(accountsDir(), email);
	if ([join(dir, "client_secret.json"), sharedClient, join(accountsDir(), "client_secret.json")].some((p) => existsSync(p))) return true;
	const id = str(fields, "key_client_id").trim();
	const secret = str(fields, "key_client_secret").trim();
	if (!id || !secret) return false;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const installed = { client_id: id, client_secret: secret, auth_uri: "https://accounts.google.com/o/oauth2/auth", token_uri: "https://oauth2.googleapis.com/token", redirect_uris: ["http://localhost"] };
	writeFileSync(join(dir, "client_secret.json"), JSON.stringify({ installed }), { mode: 0o600 });
	return true;
}

/**
 * Ask Google whether a sign-in still works, the way gws uses it: exchange
 * its refresh token for an access token. true: it works; false: Google
 * refused it (revoked, expired, wrong client); a string: Google could not
 * be asked (why).
 */
export async function googleSignInWorks(signIn: SignIn, fetchImpl: typeof fetch = fetch): Promise<boolean | string> {
	try {
		const res = await fetchImpl("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: signIn.client_id, client_secret: signIn.client_secret, refresh_token: signIn.refresh_token, grant_type: "refresh_token" }).toString(),
			signal: AbortSignal.timeout(15_000),
		});
		if (res.ok) return true;
		if (res.status === 400 || res.status === 401) return false;
		return `Google answered HTTP ${res.status}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/**
 * Copy this computer's local gws sign-ins onto Google Credentials. Returns
 * the emails written. Idempotent: an unchanged sign-in writes nothing.
 */
export async function importLocalGoogleAccounts(creds: QueryRow[]): Promise<string[]> {
	if (!existsSync(accountsDir())) return [];
	const emails = readdirSync(accountsDir()).filter(emailOk);
	const google = creds.filter((c) => str(c.fields, "service") === GOOGLE_SERVICE);
	const wrote: string[] = [];
	const me = await machineId();
	for (const email of emails) {
		const signIn = await localSignIn(email);
		if (!signIn) continue;
		const existing = google.find((c) => str(c.fields, "account").toLowerCase() === email.toLowerCase());
		if (existing) {
			// Only the computer serving the credential writes it, and never
			// over a working sign-in (one made on another computer).
			if ((await pinOf(existing.fields)) !== me) continue;
			if (!importReplaces(signInOf(existing.fields), signIn, str(existing.fields, "status"))) continue;
			for (const k of KEYS) await setField(existing.id, `key_${k}`, sv(signIn[k]));
		} else {
			await createObject(`Google - ${email}`, "credential", {
				channel: sv(await defaultSpace()),
				service: sv(GOOGLE_SERVICE),
				account: sv(email),
				served_by: sv(me),
				...Object.fromEntries(KEYS.map((k) => [`key_${k}`, sv(signIn[k])])),
			});
		}
		wrote.push(email);
	}
	return wrote;
}

/** Google credential ids listed by agents this computer serves. */
async function listedHere(): Promise<Set<string>> {
	const ids = new Set<string>();
	for (const agent of await queryAll({ type: "agent" })) {
		if (!(await agentServedHere(agent))) continue;
		const v = agent.fields["credentials"];
		for (const item of v?.valuesValue?.items ?? (v ? [v] : [])) {
			const id = item.linkValue?.targetId ?? item.stringValue ?? "";
			if (id) ids.add(id);
		}
	}
	return ids;
}

/**
 * Write the sign-in files for the Google credentials agents here list, and
 * remove the rest. Returns the emails available on this computer.
 */
export async function materializeGoogleCredentials(creds: QueryRow[]): Promise<string[]> {
	const listed = await listedHere();
	const want = new Map<string, SignIn>();
	for (const c of creds) {
		if (str(c.fields, "service") !== GOOGLE_SERVICE || !listed.has(c.id)) continue;
		const email = str(c.fields, "account").trim().toLowerCase();
		const signIn = signInOf(c.fields);
		if (emailOk(email) && signIn) want.set(email, signIn);
	}
	const dir = googleFilesDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [email, signIn] of want) {
		const path = join(dir, `${email}.json`);
		const body = JSON.stringify({ type: "authorized_user", ...signIn });
		if (existsSync(path) && readFileSync(path, "utf8") === body) continue;
		writeFileSync(path, body, { mode: 0o600 });
		chmodSync(path, 0o600);
	}
	for (const file of readdirSync(dir)) {
		if (file.endsWith(".json") && !want.has(file.slice(0, -5))) rmSync(join(dir, file), { force: true });
	}
	return [...want.keys()];
}

/** Both steps, as the credential refresh runs them. */
export async function syncGoogleCredentials(): Promise<void> {
	const creds = await queryAll({ type: "credential" });
	const imported = await importLocalGoogleAccounts(creds);
	if (imported.length > 0) console.log(`[google] stored sign-ins on Roostr for ${imported.join(", ")}`);
	await materializeGoogleCredentials(imported.length > 0 ? await queryAll({ type: "credential" }) : creds);
}


const OLD_WRAPPER_MARK = "Run gws against one explicitly selected Google account.";

/**
 * Put the harness's `gws-as` on this computer's PATH (~/.local/bin, where
 * the first one lived), as a link so a pull updates it. A file there that
 * isn't a gws-as we shipped is someone's own and is left alone.
 */
export function installGwsAs(): void {
	const shipped = join(import.meta.dir, "..", "bin", "gws-as");
	const target = join(homedir(), ".local", "bin", "gws-as");
	try {
		if (existsSync(target)) {
			const current = readFileSync(target, "utf8");
			if (current === readFileSync(shipped, "utf8")) return;
			if (!current.includes(OLD_WRAPPER_MARK)) return;
			rmSync(target);
		}
		mkdirSync(join(homedir(), ".local", "bin"), { recursive: true });
		symlinkSync(shipped, target);
		console.log(`[google] gws-as → ${shipped}`);
	} catch (error) {
		console.error("[google] could not install gws-as:", error instanceof Error ? error.message : error);
	}
}
