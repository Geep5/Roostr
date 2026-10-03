/**
 * Message addressing rules worth keeping: a request is stored on the object
 * the turn is about, falling back to the agent's home only when the turn has
 * no subject object. Otherwise the requesting object loses the record of
 * work done for it. The sender is the harness's to say, and only a
 * top-level turn sends - whatever agent_ask's code does. agent_ask runs its
 * shipped code (tool-code/) in-process, its harness calls answered as a
 * turn's are (tool-harness.ts).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AgentMessage, ObjectJSON, ValueJSON } from "./api";
import { join } from "node:path";
import agentAsk from "./tool-code/agent_ask";
import { harnessFor } from "./tool-harness";
import { createRoostr, harnessCalls } from "./tool-sdk";
import type { ToolContext } from "./tools";

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

/** agent_ask's shipped code for one turn: its result as the model reads it, or the error it throws. */
async function ask(input: Record<string, unknown>, turn: ToolContext): Promise<string> {
	const serve = harnessFor(turn);
	const run = new AbortController();
	const roostr = createRoostr({ agentId: turn.agentId, objectId: turn.boundObject ?? "", channelId: turn.channelId, machineId: "m" }, new Set(), harnessCalls((method, args) => serve(method, args, run.signal)));
	try {
		return JSON.stringify(await agentAsk(input, roostr));
	} catch (err) {
		return `error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

test("agent_ask stores the exchange on the object this turn is about", async () => {
	const task = object("task", "task", { channel: { stringValue: "space" } });
	const agentHome = object("home", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const recipientHome = object("other", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	let sent: AgentMessage | undefined;
	server([task, agentHome, recipientHome], { mutate: (body) => { if (body.action === "message_send") sent = body.message as AgentMessage; } });

	const result = await ask({ object_ids: ["other"], text: "What changed?" }, { agentId: "home", channelId: "space", boundObject: "task", depth: 0, touched: new Set() });
	expect(JSON.parse(result).recipients).toEqual([{ objectId: "other", agentId: "other" }]);
	expect(sent?.sender).toEqual({ objectId: "task", agentId: "home" });
	expect(sent?.requestReply).toBe(true);
});

test("agent_ask on the agent's own page is sent from its home", async () => {
	const agentHome = object("home", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const recipientHome = object("other", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	let sent: AgentMessage | undefined;
	server([agentHome, recipientHome], { mutate: (body) => { if (body.action === "message_send") sent = body.message as AgentMessage; } });

	const result = await ask({ object_ids: ["other"], text: "What changed?" }, { agentId: "home", channelId: "space", depth: 0, touched: new Set() });
	expect(result).not.toStartWith("error:");
	expect(sent?.sender).toEqual({ objectId: "home", agentId: "home" });
});

test("a subagent's question is refused by the harness, and a sender the tool names is ignored", async () => {
	const agentHome = object("home", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const recipientHome = object("other", "agent", { space_default: { stringValue: "" }, channel: { stringValue: "space" } });
	const sent: AgentMessage[] = [];
	server([agentHome, recipientHome], { mutate: (body) => { if (body.action === "message_send") sent.push(body.message as AgentMessage); } });

	expect(await ask({ object_ids: ["other"], text: "What changed?" }, { agentId: "home", channelId: "space", depth: 1, touched: new Set() })).toBe("error: agent_ask is only available to top-level turns, not sub-agents");
	// A tool's own call, naming someone else as the sender.
	const forged = { recipients: [{ objectId: "other", agentId: "other" }], text: "hi", sender: { objectId: "other", agentId: "other" }, author: "other" };
	await harnessFor({ agentId: "home", channelId: "space", depth: 0, touched: new Set() })("ask", [forged], new AbortController().signal);
	expect(sent.map((m) => [m.sender, m.author])).toEqual([[{ objectId: "home", agentId: "home" }, "home"]]);
});
