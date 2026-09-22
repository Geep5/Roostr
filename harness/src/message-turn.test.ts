/**
 * Message addressing rules worth keeping: a request is stored on the object
 * the turn is about, falling back to the agent's home only when the turn has
 * no subject object. Otherwise the requesting object loses the record of
 * work done for it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentMessage, ObjectJSON, ValueJSON } from "./api";
import { join } from "node:path";
import { dispatchTool } from "./tools";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-message-"));
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


function server(objects: ObjectJSON[], hooks: {
	mutate?: (body: Record<string, unknown>) => void;
} = {}) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((candidate) => candidate.id === url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (url.pathname === "/api/channels") return Response.json([{ id: "space" }]);
		if (url.pathname === "/api/query") return Response.json({ records: [], total: 0 });
		if (url.pathname === "/api/mutate") {
			const body = JSON.parse(String(init?.body));
			hooks.mutate?.(body);
			if (body.action === "message_send") return Response.json({ ok: true, id: body.message.id, exchangeId: body.message.exchangeId, threadId: "__thread__exchange" });
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

test("agent_ask stores the exchange on the object this turn is about", async () => {
	const task = object("task", "task", { channel: { stringValue: "space" } });
	const agentHome = object("home", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const recipientHome = object("other", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	let sent: AgentMessage | undefined;
	server([task, agentHome, recipientHome], { mutate: (body) => { if (body.action === "message_send") sent = body.message as AgentMessage; } });

	const result = await dispatchTool("agent_ask", { object_ids: ["other"], text: "What changed?" }, {
		agentId: "home", channelId: "space", boundObject: "task", depth: 0, allowAsk: true, touched: new Set(),
	});
	expect(result.isError, result.content).toBe(false);
	expect(JSON.parse(result.content).recipients).toEqual([{ objectId: "other", agentId: "other" }]);
	expect(sent?.sender).toEqual({ objectId: "task", agentId: "home" });
	expect(sent?.requestReply).toBe(true);
});

test("agent_ask on the agent's own page is sent from its home", async () => {
	const agentHome = object("home", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const recipientHome = object("other", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	let sent: AgentMessage | undefined;
	server([agentHome, recipientHome], { mutate: (body) => { if (body.action === "message_send") sent = body.message as AgentMessage; } });

	const result = await dispatchTool("agent_ask", { object_ids: ["other"], text: "What changed?" }, {
		agentId: "home", channelId: "space", depth: 0, allowAsk: true, touched: new Set(),
	});
	expect(result.isError, result.content).toBe(false);
	expect(sent?.sender).toEqual({ objectId: "home", agentId: "home" });
});
