/**
 * Matcherino through a Matcherino credential, over Matcherino's own API -
 * the calls its admin "Featured Events" table makes (apiserver changelog
 * v5.25.6; server/models/events.go SetFeaturedEvents) are credential_action's
 * (tool-code/credential_action.ts); the harness only signs them in
 * (`matcherinoApi`), so the token never leaves it.
 *
 * Sign-in: the `credentials` cookie holds {appName, refreshToken}. The web
 * app gives the cookie a 60-minute browser life and re-sets it on every
 * visit, but the refresh token itself is valid on the server for 24 hours
 * from sign-in (auth.RefreshTokenTTLMilliseconds). So the cookie's clock is
 * not the truth: exchanging the refresh token at /auth/token is. A
 * successful exchange re-stamps the cookie for another hour, exactly as a
 * browser visit would - `renewMatcherinoSession` is that visit, and the
 * credential refresh calls it before the cookie's hour runs out.
 */
import { str, type ValueJSON } from "./api";
import type { SessionCookie } from "./browser";
import { credentialSession } from "./credentials";

const API = "https://api.matcherino.com/__api";
const SESSION_COOKIE = "credentials";
const COOKIE_LIFE_S = 60 * 60;

interface Envelope<T> {
	status?: number;
	body?: T;
	error?: { message?: string };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${API}${path}`, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
	const text = await res.text();
	let json: Envelope<T>;
	try {
		json = JSON.parse(text) as Envelope<T>;
	} catch {
		throw new Error(`Matcherino ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
	}
	const status = json.status ?? res.status;
	if (!res.ok || status < 200 || status > 299) throw new Error(`Matcherino ${path}: ${json.error?.message || `HTTP ${status}`}`);
	return json.body as T;
}

/** Exchange the credential's refresh token for an access token; throws when the sign-in is gone. */
export async function matcherinoToken(fields: Record<string, ValueJSON>): Promise<string> {
	const name = str(fields, "name") || "Matcherino";
	const cookie = credentialSession(fields).find((c) => c.name === SESSION_COOKIE);
	if (!cookie) throw new Error(`Credential "${name}" has no Matcherino sign-in. Press Connect on it.`);
	let login: unknown;
	try {
		login = JSON.parse(decodeURIComponent(cookie.value));
	} catch {
		throw new Error(`Credential "${name}" holds an unreadable Matcherino sign-in. Press Reconnect on it.`);
	}
	const token = (await call<{ accessToken: string }>("/auth/token", { method: "POST", body: JSON.stringify(login) })).accessToken;
	if (!token) throw new Error("Matcherino /auth/token: no access token returned");
	return token;
}

/**
 * The browser visit: when the sign-in still works, its cookies with the
 * session cookie good for another hour; null when it no longer works.
 */
export async function renewMatcherinoSession(fields: Record<string, ValueJSON>): Promise<SessionCookie[] | null> {
	try {
		await matcherinoToken(fields);
	} catch {
		return null;
	}
	const until = Math.floor(Date.now() / 1000) + COOKIE_LIFE_S;
	return credentialSession(fields).map((c) => (c.name === SESSION_COOKIE ? { ...c, expires: until } : c));
}

/** One request to Matcherino's API (`path` on it, e.g. "/events/featured?page=0"), signed in with `token`: the envelope's body. */
export async function matcherinoApi(token: string, path: string, method: string, body: unknown): Promise<unknown> {
	if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`"${path}" is not a path on Matcherino's API`);
	return call<unknown>(path, { method, headers: { "x-mno-auth": `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
