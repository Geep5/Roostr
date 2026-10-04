/**
 * Google accounts as Roostr Credentials (service "google-account").
 *
 * A gws sign-in is three strings - the OAuth client id and secret and a
 * refresh token, what `gws auth export --unmasked` prints - so it can live on
 * the Credential object like any pasted key, and any computer can use it:
 *
 *  - import: an account signed in locally (`gws-as <email> auth login`, run
 *    by the credential's Connect, ~/.config/gws/accounts/<email>) is copied
 *    onto that account's Credential when this computer serves it, or onto a
 *    new one in the default space when there is none.
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
type SignIn = Record<(typeof KEYS)[number], string>;

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
			// Only the computer serving the credential writes it - and a
			// disconnect removed the local sign-in it would come from.
			if ((await pinOf(existing.fields)) !== me) continue;
			const stored = signInOf(existing.fields);
			if (stored && KEYS.every((k) => stored[k] === signIn[k])) continue;
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
