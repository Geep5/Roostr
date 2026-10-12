import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValueJSON } from "./api";
import { ensureGoogleClient, googleSignInWorks, importReplaces, signInOf, type SignIn } from "./google-credentials";

const root = mkdtempSync(join(tmpdir(), "roostr-gws-test-"));
const accounts = join(root, "accounts");
process.env.GOOGLE_WORKSPACE_ACCOUNTS_DIR = accounts;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const signIn: SignIn = { client_id: "id-1.apps.googleusercontent.com", client_secret: "secret-1", refresh_token: "1//refresh-1" };
const keyFields = (s: Partial<SignIn>): Record<string, ValueJSON> => Object.fromEntries(Object.entries(s).map(([k, v]) => [`key_${k}`, { stringValue: v }]));

test("the sign-in a credential carries is its three gws keys", () => {
	expect(signInOf(keyFields(signIn))).toEqual(signIn);
	expect(signInOf(keyFields({ ...signIn, refresh_token: "" }))).toBeNull();
});

test("a local sign-in never overwrites a working one made on another computer", () => {
	const local = { ...signIn, refresh_token: "1//older-local" };
	expect(importReplaces(null, local, "")).toBe(true);
	expect(importReplaces(signIn, signIn, "needs_auth")).toBe(false);
	expect(importReplaces(signIn, local, "active")).toBe(false);
	expect(importReplaces(signIn, local, "connecting")).toBe(false);
	expect(importReplaces(signIn, local, "needs_auth")).toBe(true);
	expect(importReplaces(signIn, local, "broken")).toBe(true);
});

test("a computer with no OAuth client signs in with the one the credential carries", () => {
	const shared = join(root, "no-shared-client.json");
	const dir = join(accounts, "me@example.com");
	// Nothing on the computer, nothing on the credential: no sign-in possible.
	expect(ensureGoogleClient("me@example.com", {}, shared)).toBe(false);
	expect(existsSync(join(dir, "client_secret.json"))).toBe(false);
	// The credential's client is written where gws-as finds it, owner-only.
	expect(ensureGoogleClient("me@example.com", keyFields(signIn), shared)).toBe(true);
	const written = JSON.parse(readFileSync(join(dir, "client_secret.json"), "utf8")) as { installed: Record<string, unknown> };
	expect(written.installed.client_id).toBe(signIn.client_id);
	expect(written.installed.client_secret).toBe(signIn.client_secret);
	expect(written.installed.token_uri).toBe("https://oauth2.googleapis.com/token");
	expect(statSync(join(dir, "client_secret.json")).mode & 0o777).toBe(0o600);
	// A computer with its own client keeps it.
	writeFileSync(shared, "{}");
	expect(ensureGoogleClient("other@example.com", {}, shared)).toBe(true);
	expect(existsSync(join(accounts, "other@example.com"))).toBe(false);
});

test("the check asks Google to exchange the refresh token", async () => {
	let sent: { url: string; body: string } | null = null;
	const google = (status: number): typeof fetch =>
		(async (input: string | URL | Request, init?: RequestInit) => {
			sent = { url: String(input), body: String(init?.body) };
			return new Response(status === 200 ? '{"access_token":"a"}' : '{"error":"invalid_grant"}', { status });
		}) as typeof fetch;
	expect(await googleSignInWorks(signIn, google(200))).toBe(true);
	expect(sent!.url).toBe("https://oauth2.googleapis.com/token");
	const body = new URLSearchParams(sent!.body);
	expect(body.get("grant_type")).toBe("refresh_token");
	expect(body.get("refresh_token")).toBe(signIn.refresh_token);
	expect(body.get("client_id")).toBe(signIn.client_id);
	expect(await googleSignInWorks(signIn, google(400))).toBe(false);
	expect(await googleSignInWorks(signIn, google(503))).toBe("Google answered HTTP 503");
	const offline = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	expect(await googleSignInWorks(signIn, offline)).toBe("network down");
});
