import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const API = process.env.GLON_API ?? "http://127.0.0.1:7333";

/** Loaded only by native services, never imported into the browser bundle. */
export async function serviceToken(): Promise<string> {
	const path = join(process.env.GLON_DATA || join(homedir(), ".glon"), "api-token");
	const info = await stat(path);
	if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("api-token must be an owner-only file");
	const token = (await readFile(path, "utf8")).trim();
	if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("invalid api-token");
	return token;
}

/** Service-authenticated requests, confined to the configured local API. */
export async function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const base = new URL(API);
	if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
		throw new Error("GLON_API must be a loopback HTTP origin");
	}
	const url = new URL(input instanceof Request ? input.url : String(input), base);
	if (url.origin !== base.origin || url.username || url.password) throw new Error("refusing service token outside GLON_API");
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	headers.set("Authorization", `Bearer ${await serviceToken()}`);
	return fetch(input instanceof Request ? input : url, { ...init, headers, redirect: "error" });
}

export function validLocalHost(host: string | null, port: number): boolean {
	return host !== null && ["127.0.0.1", "localhost", "[::1]"].some((name) => host === `${name}:${port}`);
}

export type LocalAuthorization = { role: "service" | "ui"; origin: string };

/** The exact origins serving the hosted app, www and Fly host included (src/local_auth.odin keeps the same list as LOCAL_APP_ORIGINS). */
export const APP_ORIGINS: readonly string[] = ["https://roostr.space", "https://www.roostr.space", "https://getroostr.fly.dev"];

/** A UI served from this machine: http(s)://localhost or 127.0.0.1, any port. */
export function loopbackOrigin(origin: string): boolean {
	return /^https?:\/\/(localhost|127\.0\.0\.1)(:[1-9][0-9]{0,4})?$/.test(origin) && Number(origin.split(":")[2] ?? "1") <= 65535;
}

/** Origins that may hold a UI session (and so pair or preflight): loopback UIs and the app origins, nothing else. */
export function sessionOrigin(origin: string): boolean {
	return loopbackOrigin(origin) || APP_ORIGINS.includes(origin);
}

/** The native daemon is the single authority for service and origin-bound UI tokens. */
export async function authorizeLocalRequest(req: Request, port: number): Promise<LocalAuthorization | null> {
	if (!validLocalHost(req.headers.get("Host"), port)) return null;
	const match = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get("Authorization") ?? "");
	if (!match) return null;
	const origin = req.headers.get("Origin") ?? "";
	const response = await apiFetch("/api/local-auth/validate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token: match[1], origin }),
	});
	if (!response.ok) return null;
	const result = await response.json() as { ok?: boolean; role?: string };
	if (!result.ok || (result.role !== "service" && result.role !== "ui")) return null;
	if (result.role === "service" && origin || result.role === "ui" && !origin) return null;
	return { role: result.role, origin };
}

export function localCors(origin: string): Record<string, string> {
	return origin ? {
		"Access-Control-Allow-Origin": origin,
		"Vary": "Origin",
		"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
		"Access-Control-Allow-Headers": "Authorization, Content-Type",
		"Access-Control-Allow-Private-Network": "true",
	} : {};
}

/**
 * Preflight grants no authority (every real request still carries a token
 * the daemon validates), so it answers every session origin - an expired
 * pairing then surfaces as a readable 401 the tab can re-pair from, not as
 * an opaque CORS failure.
 */
export function localPreflight(req: Request, port: number): Response {
	const origin = req.headers.get("Origin") ?? "";
	const method = req.headers.get("Access-Control-Request-Method");
	const headers = (req.headers.get("Access-Control-Request-Headers") ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
	if (!validLocalHost(req.headers.get("Host"), port) || !sessionOrigin(origin) || !["GET", "POST"].includes(method ?? "") || headers.some((h) => h !== "authorization" && h !== "content-type")) {
		return new Response(null, { status: 403 });
	}
	return new Response(null, { status: 204, headers: localCors(origin) });
}
