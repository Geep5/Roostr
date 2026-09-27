import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, apiFetch, authorizeLocalRequest, localPreflight, serviceToken, validLocalHost } from "./local-api-auth";

const token = "a".repeat(64);
const uiToken = "b".repeat(64);
let root: string;
let previousRoot: string | undefined;
let previousFetch: typeof fetch;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	previousFetch = globalThis.fetch;
	root = await mkdtemp(join(tmpdir(), "glon-auth-test-"));
	process.env.GLON_DATA = root;
	await writeFile(join(root, "api-token"), token, { mode: 0o600 });
});
afterEach(async () => {
	globalThis.fetch = previousFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

test("service token requires owner-only permissions and valid content", async () => {
	expect(await serviceToken()).toBe(token);
	await chmod(join(root, "api-token"), 0o644);
	await expect(serviceToken()).rejects.toThrow("owner-only");
	await chmod(join(root, "api-token"), 0o600);
	await writeFile(join(root, "api-token"), "not-a-token");
	await expect(serviceToken()).rejects.toThrow("invalid api-token");
});

test("apiFetch authenticates JSON and SSE and refuses credential leakage", async () => {
	const calls: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		expect(init?.redirect).toBe("error");
		calls.push(input instanceof Request ? new Request(input, init) : new Request(input.toString(), init));
		return new Response("{}");
	}) as typeof fetch;
	await apiFetch("/api/mutate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	await apiFetch(new Request(`${API}/api/events`));
	expect(calls.map((req) => req.headers.get("Authorization"))).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
	expect(calls[0].headers.get("Content-Type")).toBe("application/json");
	await expect(apiFetch("https://attacker.example/api/events")).rejects.toThrow("outside GLON_API");
	expect(calls).toHaveLength(2);
});

test("harness checks Host, bearer syntax and actual Origin before authority validation", async () => {
	let calls = 0;
	globalThis.fetch = (async (_input, init) => {
		calls++;
		expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
		const body = JSON.parse(String(init?.body));
		if (body.token === token) return Response.json({ ok: body.origin === "", role: "service" });
		return Response.json({ ok: body.token === uiToken && body.origin === "https://roostr.example", role: "ui" });
	}) as typeof fetch;
	const request = (headers: Record<string, string>) => new Request("http://127.0.0.1:7334/identity", { headers });
	expect(await authorizeLocalRequest(request({ Host: "attacker.example:7334", Authorization: `Bearer ${uiToken}` }), 7334)).toBeNull();
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${uiToken}, Bearer ${token}` }), 7334)).toBeNull();
	expect(calls).toBe(0);
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${uiToken}`, Origin: "https://evil.example", UIOrigin: "https://roostr.example" }), 7334)).toBeNull();
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${uiToken}`, Origin: "https://roostr.example" }), 7334)).toEqual({ role: "ui", origin: "https://roostr.example" });
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${token}` }), 7334)).toEqual({ role: "service", origin: "" });
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${token}`, Origin: "https://roostr.example" }), 7334)).toBeNull();
	expect(await authorizeLocalRequest(request({ Host: "localhost:7334", Authorization: `Bearer ${uiToken}` }), 7334)).toBeNull();
	expect(validLocalHost("127.0.0.1:7334", 7334)).toBe(true);
	expect(validLocalHost("localhost:7333", 7334)).toBe(false);
});

test("preflight only echoes an origin authorized by native paired sessions", async () => {
	globalThis.fetch = (async (_input, init) => {
		const origin = new Headers(init?.headers).get("Origin");
		return origin === "https://roostr.example"
			? new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": origin } })
			: new Response(null, { status: 403 });
	}) as typeof fetch;
	const request = (origin: string) => new Request("http://127.0.0.1:7334/identity", { method: "OPTIONS", headers: { Host: "127.0.0.1:7334", Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
	expect((await localPreflight(request("https://roostr.example"), 7334)).headers.get("Access-Control-Allow-Origin")).toBe("https://roostr.example");
	const denied = await localPreflight(request("https://evil.example"), 7334);
	expect(denied.status).toBe(403);
	expect(denied.headers.has("Access-Control-Allow-Origin")).toBe(false);
});
