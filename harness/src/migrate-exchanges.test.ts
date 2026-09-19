import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentMessage, type BlockJSON, type MailboxEntry, type ObjectJSON } from "./api";
import { migrateExchanges } from "./migrate-exchanges";
import { pendingInbox } from "./mailbox";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-exchange-migration-"));
	await writeFile(join(root, "api-token"), "b".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

type TestObject = ObjectJSON & {
	conversations: Array<{ id: string; kind: string; title: string; participants: string[] }>;
};

const THREAD = "__thread__original-exchange";

function object(id: string, typeKey = "task"): TestObject {
	return { id, typeKey, fields: {}, blocks: [], conversations: [], mailbox: [], deleted: false, createdAt: 0, updatedAt: 0 };
}

function legacyBlock(id: string, author: string, text: string, ts: number, replyTo = ""): BlockJSON {
	return { id, childrenIds: [], content: { custom: { contentType: "chat", meta: { author, text, ts: String(ts), replyTo, reactions: "thumbs-up|human" } } } };
}

function migrationServer(sourceId = "archive") {
	const source = object(sourceId);
	source.conversations.push({ id: THREAD, kind: "a2a", title: "Legacy group", participants: ["agent-a", "agent-b"] });
	source.blocks.push(
		{ id: THREAD, childrenIds: ["original-question", "original-answer"], content: { custom: { contentType: "discussion", data: "legacy-root" } } },
		legacyBlock("original-question", "agent-a", "What changed?", 100),
		legacyBlock("original-answer", "agent-b", "The launch moved", 200, "original-question"),
	);
	const objects = new Map<string, TestObject>([[sourceId, source]]);
	for (const id of ["a", "b"]) if (!objects.has(id)) objects.set(id, object(id));
	for (const id of ["a", "b"]) {
		const agent = object(`agent-${id}`, "agent");
		agent.fields.bound_object = { stringValue: id };
		objects.set(agent.id, agent);
	}
	const mutations: Array<Record<string, any>> = [];
	const failDelivery = new Set<string>();
	const corruptDelivery = new Set<string>();
	const failAdds = new Set<string>();
	let afterMutation: ((body: Record<string, any>) => void) | undefined;

	function putCopy(target: TestObject, message: AgentMessage, sourceMeta: Record<string, string> = {}) {
		const threadId = `__thread__${message.exchangeId}`;
		let thread = target.blocks.find((block) => block.id === threadId);
		if (!thread) {
			thread = { id: threadId, childrenIds: [], content: { custom: { contentType: "discussion", data: "new-root" } } };
			target.blocks.push(thread);
			target.conversations.push({ id: threadId, kind: "a2a", title: message.title, participants: [message.sender.agentId, ...message.recipients.map((recipient) => recipient.agentId)].filter(Boolean) });
		}
		const current = target.blocks.find((block) => block.id === message.id);
		const previous = target.mailbox!.find((entry) => entry.message.id === message.id);
		if (previous && JSON.stringify(previous.message) !== JSON.stringify(message)) throw new Error("canonical collision");
		if (!previous) {
			const block: BlockJSON = {
				id: message.id, childrenIds: current?.childrenIds ?? [],
				content: { custom: { contentType: "agent_message", data: Buffer.from(JSON.stringify(message)).toString("base64"), meta: { ...sourceMeta, ...current?.content.custom?.meta } } },
			};
			if (current) target.blocks[target.blocks.indexOf(current)] = block;
			else target.blocks.push(block);
			if (!thread.childrenIds.includes(message.id)) thread.childrenIds.push(message.id);
			const entry: MailboxEntry = {
				message: structuredClone(message), threadId,
				incoming: message.recipients.some((recipient) => recipient.objectId === target.id), outgoing: message.sender.objectId === target.id,
				deliveries: message.sender.objectId === target.id ? message.recipients.map((recipient) => ({ recipient, status: "pending", error: "", at: 0 })) : [],
				processing: { status: "processed", owner: "", error: "", at: 0 },
			};
			target.mailbox!.push(entry);
		}
	}

	globalThis.fetch = (async (input, init) => {
		const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
		if (path === "/api/query") {
			const body = JSON.parse(String(init?.body));
			const rows = [...objects.values()].filter((object) => !object.deleted && (!body.type || object.typeKey === body.type));
			return Response.json({ total: rows.length, records: rows.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? rows.length)) });
		}
		if (path.startsWith("/api/objects/")) {
			const found = objects.get(path.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (path !== "/api/mutate") return Response.json({ error: "unexpected request" }, { status: 404 });
		const body = JSON.parse(String(init?.body));
		mutations.push(body);
		const target = objects.get(body.object_id ?? body.sender_object_id)!;
		switch (body.action) {
			case "message_send":
				putCopy(target, body.message);
				afterMutation?.(body);
				return Response.json({ ok: true, id: body.message.id, exchangeId: body.message.exchangeId, threadId: `__thread__${body.message.exchangeId}` });
			case "message_deliver": {
				if (failDelivery.has(body.recipient_object_id)) return Response.json({ ok: false, error: "delivery interrupted" }, { status: 503 });
				const entry = target.mailbox!.find((entry) => entry.message.id === body.message_id)!;
				const senderBlock = target.blocks.find((block) => block.id === body.message_id)!;
				const recipient = objects.get(body.recipient_object_id)!;
				putCopy(recipient, entry.message, senderBlock.content.custom!.meta);
				if (corruptDelivery.has(recipient.id)) recipient.blocks.find((block) => block.id === entry.message.id)!.content.custom!.data = "different-payload";
				entry.deliveries.find((delivery) => delivery.recipient.objectId === recipient.id)!.status = "delivered";
				break;
			}
			case "block_add": {
				if (failAdds.has(body.block.id)) return Response.json({ ok: false, error: "private copy interrupted" }, { status: 503 });
				if (!target.blocks.some((block) => block.id === body.block.id)) {
					target.blocks.push(structuredClone(body.block));
					const parent = target.blocks.find((block) => block.id === body.target_id);
					if (parent) parent.childrenIds.push(body.block.id);
					const conversation = [...objects.values()].flatMap((object) => object.conversations).find((conversation) => conversation.id === body.block.id);
					if (conversation) target.conversations.push(structuredClone(conversation));
				}
				break;
			}
			case "block_update":
				target.blocks.find((block) => block.id === body.block_id)!.content = body.content;
				break;
			case "block_remove": {
				const removed = new Set<string>();
				const visit = (id: string): void => {
					if (removed.has(id)) return;
					removed.add(id);
					for (const child of target.blocks.find((block) => block.id === id)?.childrenIds ?? []) visit(child);
				};
				visit(body.block_id);
				target.blocks = target.blocks.filter((block) => !removed.has(block.id));
				for (const block of target.blocks) block.childrenIds = block.childrenIds.filter((id) => !removed.has(id));
				target.conversations = target.conversations.filter((conversation) => !removed.has(conversation.id));
				break;
			}
			default: return Response.json({ ok: false, error: `unexpected ${body.action}` }, { status: 400 });
		}
		afterMutation?.(body);
		return Response.json({ ok: true });
	}) as typeof fetch;
	return { source, objects, mutations, failDelivery, corruptDelivery, failAdds, afterMutation: (callback: typeof afterMutation) => { afterMutation = callback; } };
}

test("dry run writes nothing; apply preserves attribution, IDs, replies, reactions and historical inbox state", async () => {
	const server = migrationServer();
	const dry = await migrateExchanges({ apply: false });
	expect(dry.messages).toBe(2);
	expect(server.mutations).toEqual([]);
	expect(server.source.blocks.map((block) => block.id)).toEqual([THREAD, "original-question", "original-answer"]);
	const applied = await migrateExchanges({ apply: true });
	expect(applied.errors).toEqual([]);
	expect(applied.blocked).toEqual([]);
	expect(applied.retiredMessages).toBe(2);
	expect(applied.retiredRoots).toBe(1);
	expect(server.source.blocks).toEqual([]);
	for (const id of ["a", "b"]) {
		const object = server.objects.get(id)!;
		expect(object.mailbox!.map((entry) => [entry.message.id, entry.message.author, entry.message.text, entry.message.sentAt, entry.message.replyTo])).toEqual([
			["original-question", "agent-a", "What changed?", 100, ""],
			["original-answer", "agent-b", "The launch moved", 200, "original-question"],
		]);
		expect(object.mailbox!.every((entry) => entry.message.historical && !entry.message.requestReply)).toBe(true);
		expect(object.blocks.filter((block) => block.content.custom?.contentType === "agent_message").map((block) => block.content.custom!.meta!.reactions)).toEqual(["thumbs-up|human", "thumbs-up|human"]);
		expect(pendingInbox(object, `agent-${id}`)).toEqual([]);
	}
	const writes = server.mutations.length;
	const repeated = await migrateExchanges({ apply: true });
	expect(repeated.exchanges).toBe(0);
	expect(server.mutations.length).toBe(writes);
});

test("interrupted in-place import resumes and never deletes the destination's shared root", async () => {
	const server = migrationServer("a");
	server.failDelivery.add("b");
	const interrupted = await migrateExchanges({ apply: true });
	expect(interrupted.errors.length).toBe(1);
	expect(server.source.blocks.find((block) => block.id === "original-question")!.content.custom!.contentType).toBe("agent_message");
	expect(server.source.blocks.find((block) => block.id === "original-answer")!.content.custom!.contentType).toBe("chat");
	expect(server.mutations.filter((mutation) => mutation.action === "block_remove")).toEqual([]);
	server.failDelivery.clear();
	const resumed = await migrateExchanges({ apply: true });
	expect(resumed.errors).toEqual([]);
	expect(server.source.blocks.find((block) => block.id === THREAD)!.childrenIds).toEqual(["original-question", "original-answer"]);
	for (const id of ["a", "b"]) expect(server.objects.get(id)!.mailbox!.map((entry) => entry.message.id)).toEqual(["original-question", "original-answer"]);
	expect((await migrateExchanges({ apply: true })).exchanges).toBe(0);
});

test("a converted last legacy message with no receipt is recovered without a remaining chat block", async () => {
	const server = migrationServer("a");
	server.source.blocks = server.source.blocks.filter((block) => block.id !== "original-answer");
	server.source.blocks[0].childrenIds = ["original-question"];
	server.failDelivery.add("b");
	await migrateExchanges({ apply: true });
	server.failDelivery.clear();
	const resumed = await migrateExchanges({ apply: true });
	expect(resumed.errors).toEqual([]);
	expect(server.objects.get("b")!.mailbox!.map((entry) => entry.message.id)).toEqual(["original-question"]);
	expect(pendingInbox(server.objects.get("b")!, "agent-b")).toEqual([]);
});

test("unresolved participants block all retirement and leave every original byte accessible", async () => {
	const server = migrationServer();
	server.source.conversations[0].participants.push("missing-agent");
	const before = structuredClone(server.source);
	const result = await migrateExchanges({ apply: true });
	expect(result.blocked).toEqual([expect.objectContaining({ objectId: "archive", threadId: THREAD, reason: expect.stringContaining("missing-agent") })]);
	expect(server.source).toEqual(before);
	expect(server.mutations).toEqual([]);
});

test("a mismatching receiver payload prevents legacy source removal", async () => {
	const server = migrationServer();
	server.corruptDelivery.add("b");
	const before = structuredClone(server.source.blocks);
	const result = await migrateExchanges({ apply: true });
	expect(result.errors).toEqual([expect.objectContaining({ reason: expect.stringContaining("differs on b") })]);
	expect(server.source.blocks).toEqual(before);
	expect(server.mutations.filter((mutation) => mutation.action === "block_remove")).toEqual([]);
});

test("only migrated legacy messages retire; unknown blocks and private transcripts never fan out", async () => {
	const server = migrationServer();
	const tool: BlockJSON = { id: "tool", childrenIds: [], content: { custom: { contentType: "tool_result", meta: { text: "private tool output" } } } };
	const privateRoot: BlockJSON = { id: "__thread__private", childrenIds: ["private-message"], content: { custom: { contentType: "discussion", data: "private" } } };
	server.source.blocks[0].childrenIds.push(tool.id);
	server.source.blocks.push(tool, privateRoot, legacyBlock("private-message", "agent-a", "private transcript", 1));
	server.source.conversations.push({ id: privateRoot.id, kind: "agent_private", title: "Private", participants: ["agent-a"] });
	const result = await migrateExchanges({ apply: true });
	expect(result.errors).toEqual([]);
	expect(server.source.blocks.find((block) => block.id === THREAD)!.childrenIds).toEqual(["tool"]);
	expect(server.source.blocks.find((block) => block.id === "tool")).toEqual(tool);
	expect(server.source.blocks.find((block) => block.id === privateRoot.id)).toEqual(privateRoot);
	for (const id of ["a", "b"]) expect(server.objects.get(id)!.blocks.some((block) => ["tool", "private-message", privateRoot.id].includes(block.id))).toBe(false);
});

test("a legacy message edited during import is preserved rather than retired from a stale snapshot", async () => {
	const server = migrationServer();
	server.afterMutation((mutation) => {
		if (mutation.action === "message_deliver" && mutation.message_id === "original-answer") {
			server.source.blocks.find((block) => block.id === "original-question")!.content.custom!.meta!.text = "New text from another device";
		}
	});
	const result = await migrateExchanges({ apply: true });
	expect(result.errors).toEqual([expect.objectContaining({ reason: expect.stringContaining("changed during migration") })]);
	expect(server.source.blocks.find((block) => block.id === "original-question")!.content.custom!.meta!.text).toBe("New text from another device");
	expect(server.mutations.filter((mutation) => mutation.action === "block_remove")).toEqual([]);
});

function spacePrivateFixture() {
	const server = migrationServer();
	server.source.blocks = [];
	server.source.conversations = [];
	const agent = object("default-agent", "agent");
	agent.fields.space_default = { stringValue: "space" };
	const privateRoot: BlockJSON = {
		id: "__thread__space-private", childrenIds: ["private-chat", "private-tool"],
		content: { custom: { contentType: "discussion", data: "original-private-root-protobuf", meta: { title: "Private history", custom: "preserved" } } },
	};
	const chat = legacyBlock("private-chat", agent.id, "Private reasoning history", 5);
	const tool: BlockJSON = { id: "private-tool", childrenIds: ["private-result"], content: { custom: { contentType: "tool_use", data: "tool-payload", meta: { name: "read" } } } };
	const result: BlockJSON = { id: "private-result", childrenIds: [], content: { custom: { contentType: "tool_result", meta: { text: "private tool result" } } } };
	agent.blocks.push(privateRoot, chat, tool, result);
	agent.conversations.push({ id: privateRoot.id, kind: "agent_private", title: "Default space agent", participants: [agent.id] });
	const space = object("space", "channel");
	server.objects.set(agent.id, agent);
	server.objects.set(space.id, space);
	return { ...server, agent, space, privateRoot };
}

test("only default-space private history moves verbatim into its space without mailbox fanout", async () => {
	const server = spacePrivateFixture();
	const original = structuredClone(server.agent.blocks);
	const dry = await migrateExchanges({ apply: false });
	expect(dry.privateRoots).toBe(1);
	expect(dry.privateBlocks).toBe(4);
	expect(server.mutations).toEqual([]);
	const applied = await migrateExchanges({ apply: true });
	expect(applied.errors).toEqual([]);
	expect(applied.blocked).toEqual([]);
	expect(applied.retiredPrivateRoots).toBe(1);
	expect(server.space.blocks).toEqual(original);
	expect(server.agent.blocks).toEqual([]);
	expect(server.space.mailbox).toEqual([]);
	expect(server.objects.get("a")!.blocks).toEqual([]);
	expect(server.objects.get("b")!.blocks).toEqual([]);
	const writes = server.mutations.length;
	expect((await migrateExchanges({ apply: true })).privateRoots).toBe(0);
	expect(server.mutations.length).toBe(writes);
});

test("interrupted default-space private copy resumes its exact subtree before retiring the source", async () => {
	const server = spacePrivateFixture();
	const original = structuredClone(server.agent.blocks);
	server.failAdds.add("private-result");
	const interrupted = await migrateExchanges({ apply: true });
	expect(interrupted.errors).toEqual([expect.objectContaining({ reason: "private copy interrupted" })]);
	expect(server.agent.blocks).toEqual(original);
	expect(server.space.blocks.find((block) => block.id === "private-tool")!.childrenIds).toEqual([]);
	server.failAdds.clear();
	const resumed = await migrateExchanges({ apply: true });
	expect(resumed.errors).toEqual([]);
	expect(resumed.blocked).toEqual([]);
	expect(server.space.blocks).toEqual(original);
	expect(server.agent.blocks).toEqual([]);
});

test("private transcript collisions preserve both histories and other agents stay untouched", async () => {
	const server = spacePrivateFixture();
	const original = structuredClone(server.agent.blocks);
	const collision: BlockJSON = { id: "private-tool", childrenIds: [], content: { custom: { contentType: "tool_use", meta: { name: "different tool" } } } };
	server.space.blocks.push(collision);
	const unrelated = server.objects.get("agent-a")!;
	unrelated.blocks = structuredClone(original);
	unrelated.conversations = [{ ...server.agent.conversations[0], participants: [unrelated.id] }];
	const result = await migrateExchanges({ apply: true });
	expect(result.blocked).toEqual([expect.objectContaining({ reason: expect.stringContaining("collision private-tool") })]);
	expect(server.agent.blocks).toEqual(original);
	expect(server.space.blocks).toEqual([collision]);
	expect(unrelated.blocks).toEqual(original);
	expect(server.mutations).toEqual([]);
});
