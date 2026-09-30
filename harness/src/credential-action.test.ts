/**
 * credential_action runs only the actions its credential's service has:
 * anything else is refused with the real keys named, before any network call.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { dispatchTool } from "./tools";

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

/** A signed-in credential for `service`. */
function credential(service: string): ObjectJSON {
	return object("cred", "credential", {
		name: { stringValue: "Matcherino - Test" },
		service: { stringValue: service },
		channel: { stringValue: "space" },
		login_url: { stringValue: "https://matcherino.com/login" },
		session_host: { stringValue: "matcherino.com" },
		session_cookie: { stringValue: "credentials" },
		session: { stringValue: JSON.stringify([{ name: "credentials", value: "%7B%7D", domain: "matcherino.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true }]) },
		status: { stringValue: "active" },
	});
}

function server(objects: ObjectJSON[]) {
	globalThis.fetch = (async (input) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((candidate) => candidate.id === url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

const ctx = { agentId: "agent", channelId: "space", depth: 0, allowAsk: false, touched: new Set<string>() };

const agent = object("agent", "agent", {
	channel: { stringValue: "space" },
	credentials: { valuesValue: { items: [{ linkValue: { relationKey: "credentials", targetId: "cred" } }] } },
});

test("an action the service does not have is refused, naming the real keys", async () => {
	server([agent, credential("matcherino")]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "delete_event" }, ctx);
	expect(result.isError).toBe(false); // soft error: the model reads it, the turn continues
	expect(result.content).toContain('has no action "delete_event"');
	expect(result.content).toContain("its actions are list_featured, feature_events");
});

test("another service's action name does not carry over", async () => {
	server([agent, credential("matcherino")]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "retweet_post" }, ctx);
	expect(result.content).toContain('has no action "retweet_post"');
});
