/**
 * Service credentials the agents on THIS machine may use.
 *
 * Two kinds, matching how services actually admit automation:
 *
 * - "password": fields typed by the human (API keys, username/password),
 *   stored in `~/.glon/credentials.json` (mode 0600, like `api-token`).
 * - "browser": a persistent Chrome profile at
 *   `~/.glon/browser-profiles/<key>/`. Setup launches a HEADED Chrome on
 *   that profile at the service's login page; the human logs in (2FA and
 *   all) and clicks Done. Agents later drive Chrome with
 *   `--user-data-dir` pointing at the same profile and act logged in.
 *
 * Secrets never leave the machine and never enter the DAG. What syncs is
 * only the FACT of capability: an active credential's key joins the
 * machine's published `capabilities` (skillmgr), so an object that
 * `requires: ["x"]` resolves to a machine that can actually auth.
 */
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export interface PasswordField {
	key: string;
	label: string;
	secret: boolean;
}

export interface CredentialEntry {
	key: string;
	label: string;
	/** Shown in the Machine panel so the human picks the right path. */
	note: string;
	/** Browser-login setup: the page the headed Chrome opens. */
	loginUrl?: string;
	/**
	 * The cookie that proves a real login, not a visit: Chrome writes guest
	 * cookies (x.com's gt, linkedin's li_rm) on first load, so the profile
	 * only counts when this one is present. Names are plaintext in the
	 * Cookies db even though values are Keychain-encrypted.
	 */
	sessionCookie?: { host: string; name: string };
	/** Password setup: the fields the form asks for. */
	passwordFields?: PasswordField[];
}

export const CREDENTIALS: CredentialEntry[] = [
	{
		key: "x",
		label: "X (Twitter)",
		note: "Log in with Chrome to let agents read and post as you; or enter API app keys for twurl-style clients.",
		loginUrl: "https://x.com/login",
		sessionCookie: { host: "x.com", name: "auth_token" },
		passwordFields: [
			{ key: "apiKey", label: "API key", secret: false },
			{ key: "apiSecret", label: "API secret", secret: true },
			{ key: "accessToken", label: "Access token", secret: false },
			{ key: "accessTokenSecret", label: "Access token secret", secret: true },
		],
	},
	{
		key: "matcherino",
		label: "Matcherino",
		note: "Log in with Chrome to let agents administer Matcherino featured content through this machine.",
		loginUrl: "https://matcherino.com/login",
		sessionCookie: { host: "matcherino.com", name: "_matcherino_session" },
	},
	{
		key: "linkedin",
		label: "LinkedIn",
		note: "LinkedIn has no write API for people; a logged-in Chrome session is the only way agents can act here.",
		loginUrl: "https://www.linkedin.com/login",
		sessionCookie: { host: "www.linkedin.com", name: "li_at" },
	},
];

const STORE_VERSION = 1;

interface PasswordRecord {
	kind: "password";
	fields: Record<string, string>;
	updatedAt: number;
}

interface StoreFile {
	version: number;
	credentials: Record<string, PasswordRecord>;
}

function dataDir(): string {
	return process.env.GLON_DATA ?? join(homedir(), ".glon");
}

function storePath(): string {
	return join(dataDir(), "credentials.json");
}

export function browserProfileDir(key: string): string {
	return join(dataDir(), "browser-profiles", key);
}

function readStore(): StoreFile {
	try {
		const parsed = JSON.parse(readFileSync(storePath(), "utf8")) as StoreFile;
		if (parsed?.version === STORE_VERSION && parsed.credentials) return parsed;
	} catch {
		/* missing or corrupt → empty */
	}
	return { version: STORE_VERSION, credentials: {} };
}

function writeStore(store: StoreFile): void {
	const path = storePath();
	writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
	chmodSync(path, 0o600);
}

/** A browser profile counts as logged in only when the service's session cookie is present. */
function browserActive(key: string): boolean {
	const entry = CREDENTIALS.find((c) => c.key === key);
	if (!entry?.sessionCookie) return false;
	const dir = browserProfileDir(key);
	const db = [join(dir, "Default", "Network", "Cookies"), join(dir, "Default", "Cookies")].find((p) => existsSync(p));
	if (!db) return false;
	// Chrome holds the db; read a snapshot so a running login window never blocks us.
	const snap = join(tmpdir(), `roostr-cookies-${key}-${process.pid}`);
	try {
		copyFileSync(db, snap);
		const sqlite = new Database(snap, { readonly: true });
		const row = sqlite.query("SELECT 1 FROM cookies WHERE name = ? AND host_key LIKE ? LIMIT 1").get(entry.sessionCookie.name, `%${entry.sessionCookie.host}`) as unknown;
		sqlite.close();
		return row !== null;
	} catch {
		return false;
	} finally {
		rmSync(snap, { force: true });
	}
}

/** Active credential keys - the part that joins the machine's published capabilities. */
export function activeCredentialKeys(): string[] {
	const store = readStore();
	return CREDENTIALS.filter((c) => store.credentials[c.key] !== undefined || browserActive(c.key)).map((c) => c.key);
}

export interface CredentialStatus {
	key: string;
	label: string;
	note: string;
	loginUrl?: string;
	passwordFields?: PasswordField[];
	active: { password: boolean; browser: boolean };
	updatedAt?: number;
}

export function credentialStatus(): CredentialStatus[] {
	const store = readStore();
	return CREDENTIALS.map((c) => ({
		key: c.key,
		label: c.label,
		note: c.note,
		...(c.loginUrl ? { loginUrl: c.loginUrl } : {}),
		...(c.passwordFields ? { passwordFields: c.passwordFields } : {}),
		active: { password: store.credentials[c.key] !== undefined, browser: browserActive(c.key) },
		...(store.credentials[c.key] ? { updatedAt: store.credentials[c.key].updatedAt } : {}),
	}));
}

/** One line for the agent prompt: what is usable here and how to reach it. */
export function credentialsPromptLine(): string {
	const store = readStore();
	const parts: string[] = [];
	for (const c of CREDENTIALS) {
		const ways: string[] = [];
		if (browserActive(c.key)) ways.push(`logged-in Chrome profile ${browserProfileDir(c.key)}; call credential_fetch to read pages or the local x-retweet <status-url> command to retweet through the profile headlessly`);
		if (store.credentials[c.key]) ways.push(`keys in ${storePath()} under "${c.key}"`);
		if (ways.length > 0) parts.push(`${c.label}: ${ways.join("; ")}`);
	}
	return parts.length === 0 ? "" : `Credentials available on this machine. browserless/web_fetch is deliberately logged out; use credential_fetch for logged-in reads or x-retweet for X retweets:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

/** Save password-kind fields; every catalog field is required. */
export function setPasswordCredential(key: string, fields: Record<string, string>): void {
	const entry = CREDENTIALS.find((c) => c.key === key);
	if (!entry) throw new Error(`unknown credential "${key}"`);
	if (!entry.passwordFields) throw new Error(`"${key}" does not take password fields`);
	const clean: Record<string, string> = {};
	for (const f of entry.passwordFields) {
		const v = (fields[f.key] ?? "").trim();
		if (!v) throw new Error(`${f.label} is required`);
		clean[f.key] = v;
	}
	const store = readStore();
	store.credentials[key] = { kind: "password", fields: clean, updatedAt: Date.now() };
	writeStore(store);
}

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

const openSessions = new Map<string, { pid: number; startedAt: number }>();

/**
 * Open a headed Chrome on the service's own profile at its login page.
 * The human logs in there; `finishBrowserLogin` confirms cookies landed.
 */
export function startBrowserLogin(key: string): { pid: number } {
	const entry = CREDENTIALS.find((c) => c.key === key);
	if (!entry?.loginUrl) throw new Error(`"${key}" has no browser login`);
	const running = openSessions.get(key);
	if (running) {
		try {
			process.kill(running.pid, 0);
			throw new Error("a login window for this service is already open");
		} catch (err) {
			if (err instanceof Error && err.message.includes("already open")) throw err;
			openSessions.delete(key); // stale pid
		}
	}
	const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
	if (!bin) throw new Error("no Chrome/Chromium/Brave binary found on this machine");
	const dir = browserProfileDir(key);
	mkdirSync(dir, { recursive: true });
	const proc = Bun.spawn([bin, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--new-window", entry.loginUrl], {
		// Setup is deliberately headed: the human may need 2FA and site
		// challenge UI. Scheduled work must instead launch headlessly.
		stdout: "ignore",
		stderr: "ignore",
		stdin: "ignore",
	});
	openSessions.set(key, { pid: proc.pid, startedAt: Date.now() });
	proc.exited.then(() => openSessions.delete(key));
	return { pid: proc.pid };
}

/** True when the login left cookies behind; also the post-state for the UI. */
export function finishBrowserLogin(key: string): boolean {
	return browserActive(key);
}

/** Remove both kinds and the browser profile directory. */
export function removeCredential(key: string): void {
	const store = readStore();
	if (store.credentials[key]) {
		delete store.credentials[key];
		writeStore(store);
	}
	rmSync(browserProfileDir(key), { recursive: true, force: true });
}
