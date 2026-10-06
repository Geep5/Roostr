/**
 * Credentials: the sign-in recipe a Credential object carries, the seeds
 * that start them, and reading the secret it holds.
 *
 * A Credential (typeKey `credential`, credential-objects.ts) is a synced
 * object that describes itself, so an agent on ANY computer can use it and
 * a new login needs no code:
 *
 * - recipe (plain fields, each an ordinary property of the space):
 *   `service` (stable key bespoke code looks up - discord-bot, anthropic,
 *   kimi), `description`, `login_url`, `session_host` + `session_cookie`
 *   (the cookie that proves a sign-in).
 * - keys: every field named `key_<name>` is one pasted key (`key_token`,
 *   `key_api_key`, ...). Its property is the key's label; the credential
 *   needs exactly the key fields present on it (templates carry them empty).
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
	/** Plain settings beside the keys (not secret), each seeded empty on the template under its own key: postgres's `ssh_host`. */
	options?: Array<{ key: string; label: string }>;
	/** What the signed-in account can do; seeds one `action_*` field each. */
	actions?: CredentialAction[];
}

/** One thing a signed-in credential can do, declared as data on the object. */
export interface CredentialAction {
	key: string;
	/** What it does and what it takes, read by the agent (params like `ids`, `url`). */
	summary: string;
	/** read leaves the world alone; write changes something on the service. */
	access: "read" | "write";
}

/** The built-in presets; private extensions (extensions.ts) append their own at load. */
export const CREDENTIAL_SEEDS: CredentialSeed[] = [
	{
		key: "x",
		label: "X (Twitter)",
		note: "Log in with Chrome to let agents read and post as you; or enter API app keys for twurl-style clients.",
		loginUrl: "https://x.com/login",
		sessionCookie: { host: "x.com", name: "auth_token" },
		passwordFields: [
			{ key: "api_key", label: "API key", secret: false },
			{ key: "api_secret", label: "API secret", secret: true },
			{ key: "access_token", label: "Access token", secret: false },
			{ key: "access_token_secret", label: "Access token secret", secret: true },
		],
		actions: [
			{ key: "read_mentions", summary: "the account's recent mentions as a JSON list of posts {url, author, time, text, reposted}", access: "read" },
			{ key: "retweet_post", summary: "repost the post at `url` (a post URL from read_mentions); ok:true only once the page shows it reposted; already:true when it was reposted before", access: "write" },
		],
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
		note: "Bot token for a Discord application; agents with Discord channel settings poll and answer their channels with it.",
		passwordFields: [{ key: "token", label: "Bot token", secret: true }],
	},
	// A Google account for the gws CLI. The sign-in itself lives on the
	// object (an OAuth client + refresh token, what `gws auth export`
	// prints), so it works on whichever computer runs the agent: that
	// computer's harness writes it where `gws-as <account>` finds it.
	// Not "google": that key is the gws skill, and a seed sharing a skill's
	// key reads as an old login row to the migrations (which vanished the
	// skill's install rows on every boot).
	{
		key: "google-account",
		label: "Google Workspace",
		note: "A Google account (Gmail, Calendar, Drive) for agents, through `gws-as <account> …`. Account is the email. Set Served by to the computer that should open the Google sign-in, then press Connect in the credential's Status; Roostr stores the sign-in here and every computer uses it.",
		passwordFields: [
			{ key: "client_id", label: "OAuth client ID", secret: false },
			{ key: "client_secret", label: "OAuth client secret", secret: true },
			{ key: "refresh_token", label: "Refresh token", secret: true },
		],
	},
	// Model logins: the agent's Model picks the provider, its Credentials
	// carry the key - so the agent runs the same on any computer.
	{
		key: "anthropic",
		label: "Anthropic",
		note: "Key for Claude models: an Anthropic API key (sk-ant-api…) or a long-lived Claude subscription token from `claude setup-token` (sk-ant-oat…). Agents whose Model is a Claude model use it on any computer.",
		passwordFields: [{ key: "api_key", label: "API key or token", secret: true }],
	},
	{
		key: "kimi",
		label: "Kimi (Moonshot)",
		note: "Moonshot API key for Kimi models. Agents whose Model is a kimi model use it on any computer.",
		passwordFields: [{ key: "api_key", label: "API key", secret: true }],
	},
	// Judges (judges.ts) ask TypeSafe's Jev; a Judge's Credentials carry the key.
	{
		key: "typesafe",
		label: "TypeSafe (Jev)",
		note: "TypeSafe API key (apikey_…) for Jev, the fast typed-decision model Judges use to fill in properties.",
		passwordFields: [{ key: "api_key", label: "API key", secret: true }],
	},
	// A database agents read through sql_query: the harness connects (through
	// an SSH tunnel it opens when ssh_host is set - sql.ts), the model never
	// sees the URL. Connect/Check runs `select 1` to set the status.
	{
		key: "postgres",
		label: "PostgreSQL (read-only)",
		note: "A PostgreSQL database agents query read-only with sql_query. Database URL: postgres://user:password@host:port/database - use a read-only database role. SSH host (optional, e.g. root@1.2.3.4): the computer running the agent reaches the URL's host:port through an SSH tunnel to it, with that computer's own SSH keys. Press Connect to check it.",
		passwordFields: [{ key: "url", label: "Database URL", secret: true }],
		options: [{ key: "ssh_host", label: "SSH host" }],
	},
];

/**
 * What a credential can do: every action its service has. The actions and
 * their descriptions are code (the seed); having the credential in its
 * Credentials property is an agent's permission to use them, and which one
 * a task wants is said in that task's body.
 */
export function actionsOf(fields: Record<string, ValueJSON>): CredentialAction[] {
	return seedFor(str(fields, "service"))?.actions ?? [];
}

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

/** Fields named `key_<name>` hold one pasted key each. */
export const KEY_PREFIX = "key_";

/**
 * `key_fields` is the pre-property list of key names, kept on credentials
 * for computers still running the previous harness: it shares the prefix
 * but is not a key.
 */
export const LEGACY_KEY_LIST = "key_fields";

/** The key fields a credential carries, in field order: `key_api_key` → `api_key`. */
function keyFieldNames(fields: Record<string, ValueJSON>): string[] {
	return Object.keys(fields).filter((k) => k.startsWith(KEY_PREFIX) && k.length > KEY_PREFIX.length && k !== LEGACY_KEY_LIST).map((k) => k.slice(KEY_PREFIX.length));
}

export function recipeOf(fields: Record<string, ValueJSON>): Recipe {
	const host = str(fields, "session_host").trim();
	const name = str(fields, "session_cookie").trim();
	return {
		service: str(fields, "service"),
		label: str(fields, "name") || str(fields, "service"),
		note: str(fields, "description"),
		loginUrl: str(fields, "login_url").trim(),
		sessionCookie: host && name ? { host, name } : undefined,
		passwordFields: keyFieldNames(fields).map((key) => ({ key, label: key, secret: true })),
	};
}

/** A credential that still has no recipe of its own: nothing says how it signs in. */
export function recipeMissing(fields: Record<string, ValueJSON>): boolean {
	return !fields["login_url"] && !fields["session_cookie"] && keyFieldNames(fields).length === 0;
}

/** A seed as the plain fields a Credential template carries: its recipe, each key empty. */
export function seedRecipeFields(seed: CredentialSeed): Record<string, ValueJSON> {
	const out: Record<string, ValueJSON> = {
		service: { stringValue: seed.key },
		description: { stringValue: seed.note },
	};
	if (seed.loginUrl) out.login_url = { stringValue: seed.loginUrl };
	if (seed.sessionCookie) {
		out.session_host = { stringValue: seed.sessionCookie.host };
		out.session_cookie = { stringValue: seed.sessionCookie.name };
	}
	for (const f of seed.passwordFields ?? []) out[`${KEY_PREFIX}${f.key}`] = { stringValue: "" };
	for (const o of seed.options ?? []) out[o.key] = { stringValue: "" };
	return out;
}

export const RECIPE_KEYS = ["service", "description", "login_url", "session_host", "session_cookie"] as const;

/** Every seed's plain option keys (`ssh_host`), from the seeds as they are now - extensions add theirs at load. */
export function optionKeys(): string[] {
	return [...new Set(CREDENTIAL_SEEDS.flatMap((s) => s.options ?? []).map((o) => o.key))];
}

/** The recipe's field keys on this object: the fixed ones, its key fields, and the option fields it carries. */
export function recipeFieldKeys(fields: Record<string, ValueJSON>): string[] {
	return [...RECIPE_KEYS, ...keyFieldNames(fields).map((k) => `${KEY_PREFIX}${k}`), ...optionKeys().filter((k) => fields[k])];
}

/**
 * A fingerprint of the recipe, so a template nobody edited can be told apart
 * from one someone did. Key and option fields count by name only - a value
 * typed into one never makes a template look edited. (Option names join
 * only when there are some, so templates without any keep their hash.)
 */
export function recipeHash(fields: Record<string, ValueJSON>): string {
	const options = optionKeys().filter((k) => fields[k]).sort();
	const shape: unknown[] = [RECIPE_KEYS.map((k) => fields[k] ?? null), keyFieldNames(fields).sort()];
	if (options.length > 0) shape.push(options);
	return Bun.hash(JSON.stringify(shape)).toString(16);
}

/** A credential's pasted keys, when it lists some and every one is filled. */
export function credentialKeys(fields: Record<string, ValueJSON>): Record<string, string> | null {
	const names = keyFieldNames(fields);
	if (names.length === 0) return null;
	const out: Record<string, string> = {};
	for (const name of names) {
		const v = str(fields, `${KEY_PREFIX}${name}`).trim();
		if (!v) return null;
		out[name] = v;
	}
	return out;
}

/** The properties a credential's fields are shown and edited through, seeded in every space; from the seeds as they are now. */
export function credentialProperties(): Array<{ key: string; name: string; format: string; emoji: string }> {
	const unique = <T extends { key: string }>(items: T[]): T[] => items.filter((f, i, all) => all.findIndex((g) => g.key === f.key) === i);
	return [
		{ key: "account", name: "Account", format: "shorttext", emoji: "🪪" },
		{ key: "service", name: "Service", format: "shorttext", emoji: "🧩" },
		{ key: "login_url", name: "Login page", format: "url", emoji: "🔗" },
		{ key: "session_host", name: "Signed-in host", format: "shorttext", emoji: "🌐" },
		{ key: "session_cookie", name: "Signed-in cookie", format: "shorttext", emoji: "🍪" },
		// One per distinct seed key; the first seed's label names it ("API key").
		...unique(CREDENTIAL_SEEDS.flatMap((s) => s.passwordFields ?? [])).map((f) => ({ key: `${KEY_PREFIX}${f.key}`, name: f.label, format: "shorttext", emoji: "🔑" })),
		...unique(CREDENTIAL_SEEDS.flatMap((s) => s.options ?? [])).map((o) => ({ key: o.key, name: o.label, format: "shorttext", emoji: "⚙️" })),
	];
}

// ── Keeping secrets from the model ──────────────────────────────

/** What a secret reads as wherever a tool or the model would otherwise see it. */
export const SECRET_SHOWN = "[secret]";
/** Secret values shorter than this aren't blanked out of text: they would match ordinary words. */
const SECRET_MIN_LENGTH = 8;

/** Secret values worth blanking out of text: long enough, once each, longest first (so a secret inside another goes with it). */
export function secretList(values: string[]): string[] {
	return [...new Set(values.filter((v) => v.length >= SECRET_MIN_LENGTH))].sort((a, b) => b.length - a.length);
}

/** `text` with every secret blanked out. */
export function blankSecrets(text: string, secrets: string[]): string {
	return secrets.reduce((out, secret) => out.replaceAll(secret, SECRET_SHOWN), text);
}

/** Any JSON value with every secret blanked out of its strings, at any depth. */
export function blankSecretsDeep(value: unknown, secrets: string[]): unknown {
	if (typeof value === "string") return blankSecrets(value, secrets);
	if (Array.isArray(value)) return value.map((v: unknown) => blankSecretsDeep(v, secrets));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankSecretsDeep(v, secrets)]));
	return value;
}

/**
 * An object as tool code and the model may see it: a Credential's secret
 * fields - its keys (`key_*`), its browser `session`, the pre-property
 * `secret` - read "[secret]" when they hold anything (an empty one stays
 * empty, so an unfilled key still shows as unfilled). Any other object is
 * returned as it is. The daemon and the website keep the real values.
 */
export function hideCredentialSecrets<T extends { typeKey: string; fields: Record<string, ValueJSON> }>(obj: T): T {
	if (obj.typeKey !== "credential") return obj;
	const secret = Object.entries(obj.fields)
		.filter(([k, v]) => (k === "session" || k === "secret" || (k.startsWith(KEY_PREFIX) && k.length > KEY_PREFIX.length && k !== LEGACY_KEY_LIST)) && v.stringValue !== "" && Object.keys(v).length > 0)
		.map(([k]) => k);
	if (secret.length === 0) return obj;
	return { ...obj, fields: { ...obj.fields, ...Object.fromEntries(secret.map((k) => [k, { stringValue: SECRET_SHOWN }])) } };
}

/** Keys as the pre-property shapes stored them (camelCase JSON in `secret`), as key field names. */
export function legacyKeyName(key: string): string {
	return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
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
