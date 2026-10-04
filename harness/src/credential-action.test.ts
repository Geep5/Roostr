/**
 * The credential tools run their shipped code (tool-code/) in-process,
 * their harness calls answered as a turn's are (tool-harness.ts), against a
 * fake daemon. credential_action runs only the actions its credential's
 * service has: anything else is refused with the real keys named, before
 * any network call. And whatever a page or an API sends back, the
 * credential's secrets never reach the tool. The service here is a fake
 * one, registered as a private extension would register it (extensions.ts).
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { credentialSession } from "./credentials";
import { registerExtension, type Extension } from "./extensions";
import credentialAction from "./tool-code/credential_action";
import credentialFetch from "./tool-code/credential_fetch";
import { harnessFor } from "./tool-harness";
import { createRoostr, harnessCalls, type Roostr } from "./tool-sdk";
import type { ToolContext } from "./tools";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-credential-action-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
	unregister = registerExtension(ACME);
});

afterEach(async () => {
	unregister();
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function object(id: string, typeKey = "task", fields: Record<string, ValueJSON> = {}): ObjectJSON {
	return { id, typeKey, fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0, mailbox: [] };
}

const REFRESH_TOKEN = "refresh-9f8e7d6c5b4a";
const ACCESS_TOKEN = "access-0a1b2c3d4e5f";

/** A fake service: its sign-in cookie holds a refresh token, its API answers with whatever it is handed - tokens included. */
const ACME: Extension = {
	credentialSeeds: [
		{
			key: "acme",
			label: "Acme",
			note: "A test service.",
			loginUrl: "https://acme.example/login",
			sessionCookie: { host: "acme.example", name: "credentials" },
			actions: [
				{ key: "list_things", summary: "the account's things as JSON [{id, title}]", access: "read" },
				{ key: "break_things", summary: "fails, naming the token it used", access: "write" },
				{ key: "unshipped", summary: "declared, but no computer has code for it", access: "read" },
			],
		},
	],
	credentialApis: {
		acme: {
			token: async (fields) => {
				const cookie = credentialSession(fields).find((c) => c.name === "credentials");
				if (!cookie || !decodeURIComponent(cookie.value).includes(REFRESH_TOKEN)) throw new Error("signed out");
				return ACCESS_TOKEN;
			},
			call: async (token, path) => ({ path, items: [{ id: 7, title: `Cup (sent ${token} / ${REFRESH_TOKEN})` }] }),
		},
	},
	credentialActions: {
		acme: {
			list_things: async (_input, api) => {
				const res = await api("/things");
				return res.ok ? res.body : `failed: ${res.error}`;
			},
			break_things: async (_input, api) => {
				await api("/things");
				throw new Error(`refused with ${ACCESS_TOKEN} (refresh ${REFRESH_TOKEN})`);
			},
		},
	},
};
let unregister = () => {};

/** A signed-in credential for `service` carrying `cookies` (the fake service's sign-in cookie by default). */
function credential(service: string, cookies = [{ name: "credentials", value: encodeURIComponent(JSON.stringify({ appName: "web", refreshToken: REFRESH_TOKEN })), domain: "acme.example", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true }]): ObjectJSON {
	return object("cred", "credential", {
		name: { stringValue: "Acme - Test" },
		service: { stringValue: service },
		channel: { stringValue: "space" },
		login_url: { stringValue: "https://acme.example/login" },
		session_host: { stringValue: "acme.example" },
		session_cookie: { stringValue: "credentials" },
		session: { stringValue: JSON.stringify(cookies) },
		status: { stringValue: "active" },
	});
}

/** The daemon serving `objects`; anything else goes out for real (a test's own page, Chrome's DevTools). */
function server(objects: ObjectJSON[]) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.port !== "7333") return originalFetch(input, init);
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((candidate) => candidate.id === url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

const ctx: ToolContext = { agentId: "agent", channelId: "space", depth: 0, touched: new Set<string>() };

/** The SDK for one run of `ctx`'s turn, its harness calls answered here as the harness answers a tool's process. */
function roostrFor(turn: ToolContext): Roostr {
	const serve = harnessFor(turn);
	const run = new AbortController();
	return createRoostr({ agentId: turn.agentId, objectId: turn.boundObject ?? "", channelId: turn.channelId, machineId: "m" }, new Set(), harnessCalls((method, args) => serve(method, args, run.signal)));
}

const agent = object("agent", "agent", {
	channel: { stringValue: "space" },
	credentials: { valuesValue: { items: [{ linkValue: { relationKey: "credentials", targetId: "cred" } }] } },
});

test("an action the service does not have is refused, naming the real keys", async () => {
	server([agent, credential("acme")]);
	const result = await credentialAction({ service: "acme", action: "delete_event" }, roostrFor(ctx));
	expect(result).toContain('has no action "delete_event"');
	expect(result).toContain("its actions are list_things, break_things, unshipped");
});

test("another service's action name does not carry over", async () => {
	server([agent, credential("acme")]);
	expect(await credentialAction({ service: "acme", action: "retweet_post" }, roostrFor(ctx))).toContain('has no action "retweet_post"');
});

test("the credential's tokens never reach the tool, even when the service's API sends them back", async () => {
	server([agent, credential("acme")]);
	const roostr = roostrFor(ctx);
	const listed = JSON.stringify(await credentialAction({ service: "acme", action: "list_things" }, roostr));
	expect(listed).toContain('"id":7');
	expect(listed).toContain("[secret]");
	expect(listed).not.toContain(ACCESS_TOKEN);
	expect(listed).not.toContain(REFRESH_TOKEN);
	// The same through the signed API directly.
	const direct = JSON.stringify(await roostr.credentials.api("acme", "/things"));
	expect(direct).toContain('"id":7');
	expect(direct).not.toContain(ACCESS_TOKEN);
	expect(direct).not.toContain(REFRESH_TOKEN);
	// What the tool learns of the credential itself is what it shows.
	const info = JSON.stringify(await roostr.credentials.get("acme"));
	expect(info).not.toContain(REFRESH_TOKEN);
	expect(info).toContain("list_things");
});

test("an action's failure reaches the tool with the tokens blanked out", async () => {
	server([agent, credential("acme")]);
	const result = String(await credentialAction({ service: "acme", action: "break_things" }, roostrFor(ctx)));
	expect(result).toContain("Credential action failed: refused with [secret]");
	expect(result).not.toContain(ACCESS_TOKEN);
	expect(result).not.toContain(REFRESH_TOKEN);
});

test("a declared action no extension has code for says so", async () => {
	server([agent, credential("acme")]);
	expect(await credentialAction({ service: "acme", action: "unshipped" }, roostrFor(ctx))).toContain("has no code for it");
});

test("a service without a signed API is refused", async () => {
	server([agent, credential("x")]);
	expect(await roostrFor(ctx).credentials.api("x", "/2/users/me")).toMatchObject({ ok: false, error: 'the harness signs no API requests for "x" credentials' });
});

// Real Chrome, as browser.test.ts: the page script is the tool's, and it reads the session's own cookies.
const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>Account</title><body>Signed in</body>", { headers: { "Content-Type": "text/html" } }) });
afterAll(() => page.stop(true));

test("a page script that reads the signed-in session gets its secrets blanked out", async () => {
	const session = "sess-1f2e3d4c5b6a7980";
	server([agent, credential("acme", [{ name: "sid", value: session, domain: "127.0.0.1", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: false, secure: false }])]);
	const roostr = roostrFor(ctx);
	const read = await roostr.credentials.page("acme", `http://127.0.0.1:${page.port}/account`, "return document.cookie;");
	expect(read).toMatchObject({ ok: true, arrived: true, result: "sid=[secret]" });
	const fetched = await credentialFetch({ service: "acme", url: `http://127.0.0.1:${page.port}/account` }, roostr);
	expect(fetched).toContain("Signed in");
	expect(JSON.stringify([read, fetched])).not.toContain(session);
}, 60_000);
