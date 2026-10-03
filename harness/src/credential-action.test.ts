/**
 * The credential tools run their shipped code (tool-code/) in-process,
 * their harness calls answered as a turn's are (tool-harness.ts), against a
 * fake daemon. credential_action runs only the actions its credential's
 * service has: anything else is refused with the real keys named, before
 * any network call. And whatever a page or an API sends back, the
 * credential's secrets never reach the tool.
 */

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
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
});

afterEach(async () => {
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

/** A signed-in credential for `service` carrying `cookies` (Matcherino's sign-in cookie by default). */
function credential(service: string, cookies = [{ name: "credentials", value: encodeURIComponent(JSON.stringify({ appName: "web", refreshToken: REFRESH_TOKEN })), domain: "matcherino.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true }]): ObjectJSON {
	return object("cred", "credential", {
		name: { stringValue: "Matcherino - Test" },
		service: { stringValue: service },
		channel: { stringValue: "space" },
		login_url: { stringValue: "https://matcherino.com/login" },
		session_host: { stringValue: "matcherino.com" },
		session_cookie: { stringValue: "credentials" },
		session: { stringValue: JSON.stringify(cookies) },
		status: { stringValue: "active" },
	});
}

/** The daemon serving `objects`; Matcherino's API answered by `matcherino` (path → body); anything else goes out for real (a test's own page, Chrome's DevTools). */
function server(objects: ObjectJSON[], matcherino: Record<string, unknown> = {}) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.host === "api.matcherino.com") {
			const path = url.pathname.replace(/^\/__api/, "") + url.search;
			return Object.hasOwn(matcherino, path) ? Response.json({ status: 200, body: matcherino[path] }) : Response.json({ status: 404, error: { message: `no ${path}` } }, { status: 404 });
		}
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
	server([agent, credential("matcherino")]);
	const result = await credentialAction({ service: "matcherino", action: "delete_event" }, roostrFor(ctx));
	expect(result).toContain('has no action "delete_event"');
	expect(result).toContain("its actions are list_featured, feature_events");
});

test("another service's action name does not carry over", async () => {
	server([agent, credential("matcherino")]);
	expect(await credentialAction({ service: "matcherino", action: "retweet_post" }, roostrFor(ctx))).toContain('has no action "retweet_post"');
});

test("the credential's tokens never reach the tool, even when the service's API sends them back", async () => {
	server([agent, credential("matcherino")], {
		"/auth/token": { accessToken: ACCESS_TOKEN },
		"/events/featured?page=0&pageSize=100": { contents: [{ id: 7, title: `Cup (sent ${ACCESS_TOKEN} / ${REFRESH_TOKEN})` }] },
	});
	const roostr = roostrFor(ctx);
	const listed = JSON.stringify(await credentialAction({ service: "matcherino", action: "list_featured" }, roostr));
	expect(listed).toContain('"id":7');
	expect(listed).toContain("[secret]");
	expect(listed).not.toContain(ACCESS_TOKEN);
	expect(listed).not.toContain(REFRESH_TOKEN);
	// What the tool learns of the credential itself is what it shows.
	const info = JSON.stringify(await roostr.credentials.get("matcherino"));
	expect(info).not.toContain(REFRESH_TOKEN);
	expect(info).toContain("list_featured");
});

// Real Chrome, as browser.test.ts: the page script is the tool's, and it reads the session's own cookies.
const page = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<!doctype html><title>Account</title><body>Signed in</body>", { headers: { "Content-Type": "text/html" } }) });
afterAll(() => page.stop(true));

test("a page script that reads the signed-in session gets its secrets blanked out", async () => {
	const session = "sess-1f2e3d4c5b6a7980";
	server([agent, credential("matcherino", [{ name: "sid", value: session, domain: "127.0.0.1", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: false, secure: false }])]);
	const roostr = roostrFor(ctx);
	const read = await roostr.credentials.page("matcherino", `http://127.0.0.1:${page.port}/account`, "return document.cookie;");
	expect(read).toMatchObject({ ok: true, arrived: true, result: "sid=[secret]" });
	const fetched = await credentialFetch({ service: "matcherino", url: `http://127.0.0.1:${page.port}/account` }, roostr);
	expect(fetched).toContain("Signed in");
	expect(JSON.stringify([read, fetched])).not.toContain(session);
}, 60_000);
