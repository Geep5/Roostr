/**
 * Credentials: the sign-in recipe a Credential object carries, the seeds
 * that start them, and reading the secret it holds.
 *
 * A Credential (typeKey `credential`, credential-objects.ts) is a synced
 * object that describes itself, so an agent on ANY computer can use it and
 * a new login needs no code:
 *
 * - recipe (plain fields): `service` (stable key bespoke code looks up -
 *   discord-bot, anthropic, kimi), `description`, `login_url`,
 *   `session_host` + `session_cookie` (the cookie that proves a sign-in),
 *   `key_fields` (the keys a person pastes: [{key, label, secret}]).
 * - `secret`: the pasted keys as a JSON object keyed by `key_fields`.
 * - `session`: a browser sign-in's cookies as a JSON array. The computer in
 *   `served_by` opens the headed sign-in window and exports them; every
 *   later action injects them into a throwaway headless Chrome (browser.ts).
 *
 * CREDENTIAL_SEEDS only start things: the harness seeds one Credential
 * template per seed per space (credential-seeds.ts) and never overwrites a
 * template someone edited. What runs is what the object says.
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

/** A service preset: seeds a Credential template; never read at run time. */
export interface CredentialSeed {
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

export const CREDENTIAL_SEEDS: CredentialSeed[] = [
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

export function seedFor(service: string): CredentialSeed | undefined {
	return CREDENTIAL_SEEDS.find((c) => c.key === service);
}

/** How a credential signs in, read from its own fields. */
export interface Recipe {
	service: string;
	label: string;
	note: string;
	loginUrl: string;
	/** Present only when a browser sign-in can prove itself (host and cookie name both set). */
	sessionCookie?: { host: string; name: string };
	passwordFields: PasswordField[];
}

export function recipeOf(fields: Record<string, ValueJSON>): Recipe {
	const host = str(fields, "session_host").trim();
	const name = str(fields, "session_cookie").trim();
	const passwordFields = (fields["key_fields"]?.valuesValue?.items ?? []).flatMap((i) => {
		const e = i.mapValue?.entries;
		const key = e?.["key"]?.stringValue?.trim() ?? "";
		return key ? [{ key, label: e?.["label"]?.stringValue || key, secret: e?.["secret"]?.boolValue ?? true }] : [];
	});
	return {
		service: str(fields, "service"),
		label: str(fields, "name") || str(fields, "service"),
		note: str(fields, "description"),
		loginUrl: str(fields, "login_url").trim(),
		sessionCookie: host && name ? { host, name } : undefined,
		passwordFields,
	};
}

/** A credential that still has no recipe of its own (made before recipes lived on objects). */
export function recipeMissing(fields: Record<string, ValueJSON>): boolean {
	return !fields["login_url"] && !fields["key_fields"] && !fields["session_cookie"];
}

/** A seed as the plain recipe fields a Credential or template carries. */
export function seedRecipeFields(seed: CredentialSeed): Record<string, ValueJSON> {
	const out: Record<string, ValueJSON> = {
		service: { stringValue: seed.key },
		description: { stringValue: seed.note },
		key_fields: {
			valuesValue: {
				items: (seed.passwordFields ?? []).map((f) => ({
					mapValue: { entries: { key: { stringValue: f.key }, label: { stringValue: f.label }, secret: { boolValue: f.secret } } },
				})),
			},
		},
	};
	if (seed.loginUrl) out.login_url = { stringValue: seed.loginUrl };
	if (seed.sessionCookie) {
		out.session_host = { stringValue: seed.sessionCookie.host };
		out.session_cookie = { stringValue: seed.sessionCookie.name };
	}
	return out;
}

export const RECIPE_KEYS = ["service", "description", "login_url", "session_host", "session_cookie", "key_fields"] as const;

/** A fingerprint of the recipe fields, so a template nobody edited can be told apart from one someone did. */
export function recipeHash(fields: Record<string, ValueJSON>): string {
	return Bun.hash(JSON.stringify(RECIPE_KEYS.map((k) => fields[k] ?? null))).toString(16);
}

/** A credential's pasted keys, when every field its service asks for is filled. */
export function credentialKeys(fields: Record<string, ValueJSON>): Record<string, string> | null {
	const specs = recipeOf(fields).passwordFields;
	if (specs.length === 0) return null;
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
export function sessionSignedIn(cookies: SessionCookie[], recipe: Recipe): boolean {
	const want = recipe.sessionCookie;
	if (!want) return false;
	const now = Date.now() / 1000;
	return cookies.some((c) => c.name === want.name && c.domain.replace(/^\./, "").endsWith(want.host.replace(/^www\./, "")) && (c.expires <= 0 || c.expires > now));
}

/** The cookies worth keeping from a sign-in window: the service's own domain. */
export function serviceCookies(cookies: SessionCookie[], recipe: Recipe): SessionCookie[] {
	const host = recipe.sessionCookie?.host.replace(/^www\./, "");
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
