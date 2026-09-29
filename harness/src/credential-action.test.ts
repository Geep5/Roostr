/**
 * credential_action runs only the actions a credential's Allowed actions
 * property lists: anything else is refused with the allowed keys named,
 * before any network call.
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

/** A signed-in Matcherino credential with the given Allowed actions. */
function matcherinoCredential(allowed: string[] | null): ObjectJSON {
	return object("cred", "credential", {
		name: { stringValue: "Matcherino - Test" },
		service: { stringValue: "matcherino" },
		channel: { stringValue: "space" },
		login_url: { stringValue: "https://matcherino.com/login" },
		session_host: { stringValue: "matcherino.com" },
		session_cookie: { stringValue: "credentials" },
		session: { stringValue: JSON.stringify([{ name: "credentials", value: "%7B%7D", domain: "matcherino.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true }]) },
		status: { stringValue: "active" },
		...(allowed ? { actions: { valuesValue: { items: allowed.map((stringValue) => ({ stringValue })) } } } : {}),
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

test("an action the credential does not allow is refused, naming the allowed keys", async () => {
	server([agent, matcherinoCredential(["list_featured"])]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "feature_events" }, ctx);
	expect(result.isError).toBe(false); // soft error: the model reads it, the turn continues
	expect(result.content).toContain('does not allow action "feature_events"');
	expect(result.content).toContain("it allows list_featured");
});

test("a credential that allows nothing sends the agent to the property, not to guesses", async () => {
	server([agent, matcherinoCredential(null)]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "list_featured" }, ctx);
	expect(result.isError).toBe(false);
	expect(result.content).toContain("it allows none");
	expect(result.content).toContain("Allowed actions");
});
