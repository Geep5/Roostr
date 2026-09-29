/**
 * Matcherino actions through a Matcherino credential, over Matcherino's own
 * API - the calls its admin "Featured Events" table makes
 * (apiserver changelog v5.25.6; server/models/events.go SetFeaturedEvents).
 *
 * Sign-in: the `credentials` cookie holds {appName, refreshToken}. The web
 * app gives the cookie a 60-minute browser life and re-sets it on every
 * visit, but the refresh token itself is valid on the server for 24 hours
 * from sign-in (auth.RefreshTokenTTLMilliseconds). So the cookie's clock is
 * not the truth: exchanging the refresh token at /auth/token is. A
 * successful exchange re-stamps the cookie for another hour, exactly as a
 * browser visit would, so the credential's Status reads what is true.
 */
import { fetchObject, setField, str, sv } from "./api";
import { agentCredentialIds } from "./credential-objects";
import { credentialSession } from "./credentials";

const API = "https://api.matcherino.com/__api";
const SESSION_COOKIE = "credentials";
const COOKIE_LIFE_S = 60 * 60;

export interface FeaturedEvent {
	id: number;
	title: string;
}

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

/**
 * An access token for the agent's Matcherino credential, or why not.
 * The exchange is the sign-in check; its outcome is written back onto the
 * credential (status, error, cookie stamp).
 */
export async function matcherinoAccess(agentId: string): Promise<{ token: string; name: string }> {
	const agent = await fetchObject(agentId);
	const creds = (await Promise.all(agentCredentialIds(agent).map((id) => fetchObject(id).catch(() => null)))).filter(
		(o) => o && !o.deleted && str(o.fields, "service") === "matcherino",
	);
	const cred = creds[0];
	if (!cred) throw new Error("None of this agent's credentials is for \"matcherino\". Add one to its Credentials property.");
	const name = str(cred.fields, "name") || "Matcherino";
	const session = credentialSession(cred.fields);
	const cookie = session.find((c) => c.name === SESSION_COOKIE);
	if (!cookie) throw new Error(`Credential "${name}" has no Matcherino sign-in. Press Connect on it.`);
	let login: unknown;
	try {
		login = JSON.parse(decodeURIComponent(cookie.value));
	} catch {
		throw new Error(`Credential "${name}" holds an unreadable Matcherino sign-in. Press Reconnect on it.`);
	}
	let token: string;
	try {
		token = (await call<{ accessToken: string }>("/auth/token", { method: "POST", body: JSON.stringify(login) })).accessToken;
		if (!token) throw new Error("no access token returned");
	} catch (error) {
		const message = `The ${name} sign-in expired or was signed out - press Reconnect.`;
		await setField(cred.id, "status", sv("needs_auth"));
		await setField(cred.id, "error", sv(message));
		throw new Error(`${message} (${error instanceof Error ? error.message : String(error)})`);
	}
	// Signed in: stamp the cookie as a visit would, and say so on the credential.
	const stamped = session.map((c) => (c.name === SESSION_COOKIE ? { ...c, expires: Math.floor(Date.now() / 1000) + COOKIE_LIFE_S } : c));
	await setField(cred.id, "session", sv(JSON.stringify(stamped)));
	return { token, name };
}

/** What the homepage features now (public list; the API may serve it from a short cache). */
export async function featuredEvents(): Promise<FeaturedEvent[]> {
	const page = await call<{ contents?: Array<{ id: number; title: string }> }>("/events/featured?page=0&pageSize=100");
	return (page.contents ?? []).map((e) => ({ id: e.id, title: e.title }));
}

/** Feature (or unfeature) one event as the signed-in admin. */
export async function setFeatured(token: string, bountyId: number, feature: boolean): Promise<void> {
	await call("/users/admin/events/setFeatured", {
		method: "POST",
		headers: { "x-mno-auth": `Bearer ${token}` },
		body: JSON.stringify({ bountyId, feature }),
	});
}
