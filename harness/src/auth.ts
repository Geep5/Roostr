/**
 * Anthropic credentials — port of glon auth.ts. Authorization Code + PKCE
 * against claude.ai/oauth/authorize with the public Claude Code client_id
 * (plan-based inference, no API key), plus api_key entries. Stored in
 * GLON_DATA/auth.json (glon schema, atomic 0600 write), refreshed in place
 * with a 5-minute buffer and coalesced concurrent refreshes.
 *
 * Resolution order for calls: auth.json (oauth | api_key) → env →
 * Claude Code keychain.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

const ANTHROPIC_CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf-8");
const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface OAuthCredential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
}
interface ApiKeyCredential {
	type: "api_key";
	key: string;
}
type AnthropicCredential = OAuthCredential | ApiKeyCredential;

interface AuthFile {
	version: 1;
	credentials: {
		anthropic?: AnthropicCredential;
		kimi?: ApiKeyCredential;
	};
}

function authFilePath(): string {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	return `${root}/auth.json`;
}

export async function readAuthFile(): Promise<AuthFile> {
	try {
		const parsed = (await Bun.file(authFilePath()).json()) as AuthFile;
		if (parsed?.version === 1 && typeof parsed.credentials === "object") return parsed;
	} catch {
		/* missing or corrupt — treat as empty */
	}
	return { version: 1, credentials: {} };
}

/** Atomic write: stage to .tmp, chmod 0600, rename (glon auth.ts:133-141). */
function writeAuthFile(file: AuthFile): void {
	const path = authFilePath();
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		/* best-effort */
	}
	renameSync(tmp, path);
}

// ── PKCE ─────────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

// ── Login flow ───────────────────────────────────────────────────

let pendingLogin: { verifier: string } | null = null;

/** Step 1: PKCE + the URL the user opens; claude.ai shows CODE#STATE to paste back. */
export async function startAnthropicLogin(): Promise<string> {
	const pkce = await generatePkce();
	pendingLogin = { verifier: pkce.verifier };
	const params = new URLSearchParams({
		code: "true",
		client_id: ANTHROPIC_CLIENT_ID,
		response_type: "code",
		redirect_uri: ANTHROPIC_REDIRECT_URI,
		scope: ANTHROPIC_SCOPES,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state: pkce.verifier,
	});
	return `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
}

/** Step 2: exchange the pasted code (may be CODE#STATE) and persist. */
export async function finishAnthropicLogin(rawCode: string): Promise<void> {
	if (!pendingLogin) throw new Error("no login in progress — start again");
	const [code, state] = rawCode.trim().split("#");
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: ANTHROPIC_CLIENT_ID,
			code,
			state: state ?? pendingLogin.verifier,
			redirect_uri: ANTHROPIC_REDIRECT_URI,
			code_verifier: pendingLogin.verifier,
		}),
	});
	if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as TokenResponse;
	pendingLogin = null;
	const file = await readAuthFile();
	file.credentials.anthropic = {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		expires: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
	};
	writeAuthFile(file);
}

async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredential> {
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", client_id: ANTHROPIC_CLIENT_ID, refresh_token: refreshToken }),
	});
	if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as TokenResponse;
	return {
		type: "oauth",
		access: data.access_token,
		// Anthropic rotates refresh tokens; keep the old one when absent.
		refresh: data.refresh_token || refreshToken,
		expires: Date.now() + data.expires_in * 1000 - REFRESH_BUFFER_MS,
	};
}

export async function setApiKey(provider: "anthropic" | "kimi", key: string): Promise<void> {
	const file = await readAuthFile();
	if (key) file.credentials[provider] = { type: "api_key", key };
	else delete file.credentials[provider];
	writeAuthFile(file);
}

// ── Resolver ─────────────────────────────────────────────────────

export interface ResolvedAuth {
	token: string;
	isOAuth: boolean;
}

let refreshInflight: Promise<OAuthCredential> | null = null;

// Claude Code rotates its access token in place — never cache across turns,
// or the harness 401s an hour after the app's next refresh.
async function keychainAuth(): Promise<ResolvedAuth | null> {
	try {
		const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore" });
		const raw = await new Response(proc.stdout).text();
		const parsed = JSON.parse(raw.trim()) as { claudeAiOauth?: { accessToken?: string } };
		if (parsed.claudeAiOauth?.accessToken) {
			return { token: parsed.claudeAiOauth.accessToken, isOAuth: true };
		}
	} catch {
		/* no keychain entry */
	}
	return null;
}

/** auth.json (oauth with refresh | api_key) → env → Claude Code keychain. */
export async function resolveAnthropicAuth(): Promise<ResolvedAuth> {
	const file = await readAuthFile();
	const cred = file.credentials.anthropic;
	if (cred?.type === "api_key") return { token: cred.key, isOAuth: false };
	if (cred?.type === "oauth") {
		if (cred.expires > Date.now()) return { token: cred.access, isOAuth: true };
		if (!refreshInflight) {
			refreshInflight = (async () => {
				try {
					const refreshed = await refreshAnthropicToken(cred.refresh);
					const updated = await readAuthFile();
					updated.credentials.anthropic = refreshed;
					writeAuthFile(updated);
					return refreshed;
				} finally {
					refreshInflight = null;
				}
			})();
		}
		const refreshed = await refreshInflight;
		return { token: refreshed.access, isOAuth: true };
	}
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return { token: envKey, isOAuth: false };
	const keychain = await keychainAuth();
	if (keychain) return keychain;
	throw new Error("No Anthropic credentials: sign in via Settings → Agent, set ANTHROPIC_API_KEY, or log into Claude Code.");
}

export async function resolveKimiKey(): Promise<string> {
	const file = await readAuthFile();
	if (file.credentials.kimi?.type === "api_key") return file.credentials.kimi.key;
	return process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY ?? "";
}

/** Status for the Settings UI — never leaks tokens. */
export async function authStatus(): Promise<Record<string, unknown>> {
	const file = await readAuthFile();
	const cred = file.credentials.anthropic;
	let anthropic: Record<string, unknown>;
	if (cred?.type === "oauth") anthropic = { mode: "plan", expires: cred.expires };
	else if (cred?.type === "api_key") anthropic = { mode: "api_key", masked: `…${cred.key.slice(-4)}` };
	else if (process.env.ANTHROPIC_API_KEY) anthropic = { mode: "env" };
	else if (await keychainAuth()) anthropic = { mode: "claude_code" };
	else anthropic = { mode: "none" };
	const kimi = file.credentials.kimi?.type === "api_key" ? { mode: "api_key", masked: `…${file.credentials.kimi.key.slice(-4)}` } : { mode: "none" };
	return { anthropic, kimi };
}
