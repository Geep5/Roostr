/**
 * credential_action takes its catalog from the credential object's action_*
 * fields, not from the harness: an action the credential does not declare
 * is refused with the valid keys named, before any network call.
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

/** A signed-in Matcherino credential declaring the two seeded actions. */
function matcherinoCredential(actionFields: Record<string, ValueJSON>): ObjectJSON {
	return object("cred", "credential", {
		name: { stringValue: "Matcherino - Test" },
		service: { stringValue: "matcherino" },
		channel: { stringValue: "space" },
		login_url: { stringValue: "https://matcherino.com/login" },
		session_host: { stringValue: "matcherino.com" },
		session_cookie: { stringValue: "credentials" },
		session: { stringValue: JSON.stringify([{ name: "credentials", value: "%7B%7D", domain: "matcherino.com", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: true }]) },
		status: { stringValue: "active" },
		...actionFields,
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

test("an action the credential does not declare is refused, naming the valid keys", async () => {
	const credObj = matcherinoCredential({
		action_list_featured: { stringValue: JSON.stringify({ summary: "what the homepage features", access: "read" }) },
		action_feature_events: { stringValue: JSON.stringify({ summary: "feature bounty ids", access: "write" }) },
	});
	server([agent, credObj]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "delete_event" }, ctx);
	expect(result.isError).toBe(false); // soft error: the model reads it, the turn continues
	expect(result.content).toContain('declares no action "delete_event"');
	expect(result.content).toContain("list_featured, feature_events");
});

test("a credential with no action fields sends the agent to the properties, not to guesses", async () => {
	server([agent, matcherinoCredential({})]);
	const result = await dispatchTool("credential_action", { service: "matcherino", action: "list_featured" }, ctx);
	expect(result.isError).toBe(false); // soft error: the model reads it, the turn continues
	expect(result.content).toContain("action_* properties");
});
