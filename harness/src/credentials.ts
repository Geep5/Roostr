/**
 * Credentials: the catalog of services a Credential object can be for,
 * and reading the secret a Credential carries.
 *
 * A Credential (typeKey `credential`, credential-objects.ts) is a synced
 * object and carries its secret in properties, so an agent on ANY computer
 * can use it:
 *
 * - `secret`: the pasted keys (API keys, a bot token) as a JSON object.
 * - `session`: a browser sign-in's cookies as a JSON array. The computer in
 *   `served_by` opens the headed sign-in window and exports them; every
 *   later action injects them into a throwaway headless Chrome (browser.ts).
 *
 * Everyone in the credential's space can read these properties.
 */
import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { str, type ValueJSON } from "./api";
import type { SessionCookie } from "./browser";

export interface PasswordField {
	key: string;
	label: string;
	secret: boolean;
}

export interface CredentialEntry {
	key: string;
	label: string;
	/** Shown on the Credential page so the person picks the right path. */
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
		sessionCookie: { host: "matcherino.com", name: "credentials" },
	},
	{
		key: "linkedin",
		label: "LinkedIn",
		note: "LinkedIn has no write API for people; a logged-in Chrome session is the only way agents can act here.",
		loginUrl: "https://www.linkedin.com/login",
		sessionCookie: { host: "www.linkedin.com", name: "li_at" },
	},
	{
		key: "discord-bot",
		label: "Discord bot",
		note: "Bot token for a Discord application; agents of the Marco kind poll and answer their channels with it.",
		passwordFields: [{ key: "token", label: "Bot token", secret: true }],
	},
	// Model logins: the agent's Model picks the provider, its Credentials
	// carry the key - so the agent runs the same on any computer.
	{
		key: "anthropic",
		label: "Anthropic",
		note: "Key for Claude models: an Anthropic API key (sk-ant-api…) or a long-lived Claude subscription token from `claude setup-token` (sk-ant-oat…). Agents whose Model is a Claude model use it on any computer.",
		passwordFields: [{ key: "apiKey", label: "API key or token", secret: true }],
	},
	{
		key: "kimi",
		label: "Kimi (Moonshot)",
		note: "Moonshot API key for Kimi models. Agents whose Model is a kimi model use it on any computer.",
		passwordFields: [{ key: "apiKey", label: "API key", secret: true }],
	},
];

export function serviceEntry(service: string): CredentialEntry | undefined {
	return CREDENTIALS.find((c) => c.key === service);
}

/** A credential's pasted keys, when every field its service asks for is filled. */
export function credentialKeys(fields: Record<string, ValueJSON>): Record<string, string> | null {
	const specs = serviceEntry(str(fields, "service"))?.passwordFields;
	if (!specs) return null;
	try {
		const parsed = JSON.parse(str(fields, "secret") || "{}") as Record<string, unknown>;
		const out: Record<string, string> = {};
		for (const spec of specs) {
			const v = parsed[spec.key];
			if (typeof v !== "string" || !v.trim()) return null;
			out[spec.key] = v.trim();
		}
		return out;
	} catch {
		return null;
	}
}

/** A credential's browser session cookies, or [] when it has none. */
export function credentialSession(fields: Record<string, ValueJSON>): SessionCookie[] {
	try {
		const parsed = JSON.parse(str(fields, "session") || "[]") as unknown;
		return Array.isArray(parsed) ? (parsed as SessionCookie[]) : [];
	} catch {
		return [];
	}
}

/**
 * Whether cookies hold a real, unexpired login for the service: guest
 * cookies (x.com's gt, linkedin's li_rm) appear on first load, so only the
 * service's session cookie counts.
 */
export function sessionSignedIn(cookies: SessionCookie[], service: string): boolean {
	const want = serviceEntry(service)?.sessionCookie;
	if (!want) return false;
	const now = Date.now() / 1000;
	return cookies.some((c) => c.name === want.name && c.domain.replace(/^\./, "").endsWith(want.host.replace(/^www\./, "")) && (c.expires <= 0 || c.expires > now));
}

/** The cookies worth keeping from a sign-in window: the service's own domain. */
export function serviceCookies(cookies: SessionCookie[], service: string): SessionCookie[] {
	const host = serviceEntry(service)?.sessionCookie?.host.replace(/^www\./, "");
	return host ? cookies.filter((c) => c.domain.replace(/^\./, "").endsWith(host)) : [];
}

// Before Credential objects, each machine kept secrets locally, keyed by
// service: ~/.glon/credentials.json and ~/.glon/browser-profiles/<service>.
// Only the one-time migration (credential-objects.ts) reads them.

function dataDir(): string {
	return process.env.GLON_DATA ?? join(homedir(), ".glon");
}

export function legacyProfileDir(service: string): string {
	return join(dataDir(), "browser-profiles", service);
}

interface LegacyStore {
	version: number;
	credentials: Record<string, { fields: Record<string, string> }>;
}

function legacyStore(): LegacyStore | null {
	try {
		const parsed = JSON.parse(readFileSync(join(dataDir(), "credentials.json"), "utf8")) as LegacyStore;
		return parsed?.credentials ? parsed : null;
	} catch {
		return null;
	}
}

export function legacyKeys(service: string): Record<string, string> | null {
	return legacyStore()?.credentials[service]?.fields ?? null;
}

/** Delete a service's legacy local secrets once migrated (or never used). */
export function dropLegacySecrets(service: string): void {
	rmSync(legacyProfileDir(service), { recursive: true, force: true });
	const store = legacyStore();
	if (!store?.credentials[service]) return;
	delete store.credentials[service];
	const path = join(dataDir(), "credentials.json");
	if (Object.keys(store.credentials).length === 0) rmSync(path, { force: true });
	else {
		writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
		chmodSync(path, 0o600);
	}
}

export function legacyProfileExists(service: string): boolean {
	return existsSync(join(legacyProfileDir(service), "Default"));
}
