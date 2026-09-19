import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutate, type AgentMessage, type MailboxEntry, type ObjectJSON } from "./api";
import { claimMessage, deliverOutbox, finishMessage, pendingInbox, recoverInbox, replyRecipients, sendMessage } from "./mailbox";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-mailbox-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
	return {
		id: "question", exchangeId: "group", sender: { objectId: "a", agentId: "agent-a" },
		recipients: [{ objectId: "b", agentId: "agent-b" }, { objectId: "c", agentId: "agent-c" }],
		text: "Review the plan", replyTo: "", sentAt: 10, title: "Plan", requestReply: true,
		historical: false, operation: "", author: "agent-a", ...overrides,
	};
}

function entry(message: AgentMessage, objectId: string): MailboxEntry {
	return {
		message: structuredClone(message), threadId: `__thread__${message.exchangeId}`,
		incoming: message.recipients.some((recipient) => recipient.objectId === objectId),
		outgoing: message.sender.objectId === objectId,
		deliveries: message.sender.objectId === objectId ? message.recipients.map((recipient) => ({ recipient, status: "pending", error: "", at: 0 })) : [],
		processing: { status: message.historical ? "processed" : "pending", owner: "", error: "", at: 0 },
	};
}

function object(id: string): ObjectJSON {
	return { id, typeKey: "task", fields: {}, blocks: [], deleted: false, createdAt: 0, updatedAt: 0, mailbox: [] };
}

function mailboxServer() {
	const objects = new Map(["a", "b", "c"].map((id) => [id, object(id)]));
	const failing = new Set<string>();
	const loseResponse = new Set<string>();
	const deliveryAttempts: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
		if (path.startsWith("/api/objects/")) {
			const found = objects.get(path.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (path !== "/api/mutate") return Response.json({ error: "unexpected request" }, { status: 404 });
		const body = JSON.parse(String(init?.body));
		const source = objects.get(body.object_id ?? body.sender_object_id)!;
		const found = source.mailbox!.find((candidate) => candidate.message.id === body.message_id);
		const refuse = (error: string) => Response.json({ ok: false, error }, { status: 400 });
		switch (body.action) {
			case "message_send": {
				const sent = body.message as AgentMessage;
				const previous = source.mailbox!.find((candidate) => candidate.message.id === sent.id);
				if (previous && JSON.stringify(previous.message) !== JSON.stringify(sent)) return refuse("message collision");
				if (!previous) source.mailbox!.push(entry(sent, source.id));
				return Response.json({ ok: true, id: sent.id, exchangeId: sent.exchangeId, threadId: `__thread__${sent.exchangeId}` });
			}
			case "message_deliver": {
				const target = objects.get(body.recipient_object_id)!;
				deliveryAttempts.push(target.id);
				if (failing.has(target.id)) return refuse("recipient unavailable");
				if (!target.mailbox!.some((candidate) => candidate.message.id === found!.message.id)) target.mailbox!.push(entry(found!.message, target.id));
				found!.deliveries.find((delivery) => delivery.recipient.objectId === target.id)!.status = "delivered";
				if (loseResponse.delete(target.id)) throw new Error("connection lost after commit");
				break;
			}
			case "message_delivery_error": {
				const delivery = found!.deliveries.find((candidate) => candidate.recipient.objectId === body.recipient_object_id)!;
				if (delivery.status !== "delivered") { delivery.status = "failed"; delivery.error = body.error; }
				break;
			}
			case "message_processing": {
				if (body.status === "processing") {
					if (!["pending", "awaiting_approval"].includes(found!.processing.status)) return Response.json({ ok: true, claimed: false });
					found!.processing = { status: "processing", owner: body.owner, error: "", at: 20 };
					return Response.json({ ok: true, claimed: true });
				}
				if (found!.processing.owner !== body.owner) return refuse("processing owner mismatch");
				if (found!.processing.status !== "processed") found!.processing = { status: body.status, owner: body.owner, error: body.error, at: 21 };
				break;
			}
			case "message_retry":
				if (found!.processing.status === "failed") found!.processing = { status: "pending", owner: "", error: "", at: 22 };
				break;
			case "set_field":
				source.fields[body.key] = body.value;
				break;
			default: return refuse(`unexpected mutation ${body.action}`);
		}
		return Response.json({ ok: true });
	}) as typeof fetch;
	return { objects, failing, loseResponse, deliveryAttempts };
}

test("an interrupted group delivery retains the source and resumes from durable state after restart", async () => {
	const server = mailboxServer();
	server.failing.add("b");
	const stale = structuredClone(server.objects.get("a")!);
	await sendMessage(message());
	await deliverOutbox(stale);
	expect(server.objects.get("a")!.mailbox![0].deliveries.map((delivery) => delivery.status)).toEqual(["failed", "delivered"]);
	expect(server.objects.get("c")!.mailbox!.map((entry) => entry.message.id)).toEqual(["question"]);
	expect(server.objects.get("a")!.mailbox![0].message.text).toBe("Review the plan");
	server.failing.clear();
	// No in-memory pending queue or updated caller snapshot survives a restart.
	await deliverOutbox(stale);
	await deliverOutbox(stale);
	expect(server.objects.get("b")!.mailbox!.map((entry) => entry.message.id)).toEqual(["question"]);
	expect(server.objects.get("c")!.mailbox!.map((entry) => entry.message.id)).toEqual(["question"]);
	expect(server.objects.get("a")!.mailbox![0].deliveries.map((delivery) => delivery.status)).toEqual(["delivered", "delivered"]);
	expect(server.deliveryAttempts).toEqual(["b", "c", "b"]);
});

test("a lost delivery response cannot turn an already durable delivery into a failure", async () => {
	const server = mailboxServer();
	server.loseResponse.add("b");
	await sendMessage(message());
	await deliverOutbox(server.objects.get("a")!);
	await deliverOutbox(server.objects.get("a")!);
	expect(server.objects.get("a")!.mailbox![0].deliveries.map((delivery) => delivery.status)).toEqual(["delivered", "delivered"]);
	expect(server.objects.get("b")!.mailbox!.map((entry) => entry.message.id)).toEqual(["question"]);
	expect(server.deliveryAttempts).toEqual(["b", "c"]);
});

test("restart recovery fails stranded work without replaying completed, historical, or current-owner turns", async () => {
	const server = mailboxServer();
	const inbox = server.objects.get("b")!;
	for (const id of ["interrupted", "finished", "active", "approval", "historical"]) {
		inbox.mailbox!.push(entry(message({ id, historical: id === "historical" }), "b"));
	}
	inbox.mailbox![0].processing = { status: "processing", owner: "old-run", error: "", at: 1 };
	inbox.mailbox![1].processing = { status: "processed", owner: "old-run", error: "", at: 2 };
	inbox.mailbox![2].processing = { status: "processing", owner: "this-run", error: "", at: 3 };
	inbox.mailbox![3].processing.status = "awaiting_approval";
	const stale = structuredClone(inbox);
	await recoverInbox(stale, "this-run");
	await recoverInbox(stale, "this-run");
	expect(inbox.mailbox!.map((entry) => entry.processing.status)).toEqual(["failed", "processed", "processing", "awaiting_approval", "processed"]);
	expect(inbox.fields.error?.stringValue).toStartWith("Message interrupted: ");
	expect(pendingInbox(inbox, "agent-b")).toEqual([]);
	await mutate("message_retry", { object_id: "b", message_id: "interrupted", stage: "processing" });
	expect(pendingInbox(inbox, "agent-b").map((entry) => entry.message.id)).toEqual(["interrupted"]);
	expect(await claimMessage("b", "interrupted", "this-run")).toBe(true);
	expect(await claimMessage("b", "interrupted", "other-run")).toBe(false);
	await finishMessage("b", "interrupted", "this-run");
	expect(pendingInbox(inbox, "agent-b")).toEqual([]);
});

test("interruption recovery preserves unrelated object errors and leaves human-only inboxes unflagged", async () => {
	const server = mailboxServer();
	const inbox = server.objects.get("b")!;
	const interrupted = entry(message(), "b");
	interrupted.processing = { status: "processing", owner: "old-run", error: "", at: 1 };
	inbox.mailbox!.push(interrupted);
	inbox.fields.error = { stringValue: "Schedule: calendar permission expired" };
	const humanInbox = server.objects.get("c")!;
	const humanMessage = entry(message({ recipients: [{ objectId: "c", agentId: "" }] }), "c");
	humanMessage.processing = { status: "processing", owner: "old-run", error: "", at: 1 };
	humanInbox.mailbox!.push(humanMessage);
	await recoverInbox(inbox, "this-run");
	await recoverInbox(humanInbox, "this-run");
	expect(interrupted.processing.status).toBe("failed");
	expect(inbox.fields.error?.stringValue).toBe("Schedule: calendar permission expired");
	expect(humanInbox.fields.error).toBeUndefined();
});

test("group replies reach the original sender and peers once, never the responder", () => {
	const incoming = message({ recipients: [
		{ objectId: "b", agentId: "agent-b" }, { objectId: "c", agentId: "agent-c" },
		{ objectId: "a", agentId: "agent-a" }, { objectId: "c", agentId: "stale-agent-c" },
	] });
	expect(replyRecipients(incoming, { objectId: "b", agentId: "agent-b" })).toEqual([
		{ objectId: "a", agentId: "agent-a" }, { objectId: "c", agentId: "agent-c" },
	]);
	const human = message({ sender: { objectId: "a", agentId: "" }, author: "human", recipients: [{ objectId: "a", agentId: "agent-a" }, { objectId: "b", agentId: "agent-b" }] });
	expect(replyRecipients(human, { objectId: "b", agentId: "agent-b" })).toEqual([{ objectId: "a", agentId: "agent-a" }]);
});

test("pending inbox respects endpoint, intent, historical state, and deterministic causal display order", () => {
	const inbox = object("b");
	inbox.mailbox = [
		entry(message({ id: "z", sentAt: 3 }), "b"), entry(message({ id: "a", sentAt: 3 }), "b"),
		entry(message({ id: "first", sentAt: 1 }), "b"), entry(message({ id: "history", historical: true }), "b"),
		entry(message({ id: "install", operation: "skill.install" }), "b"),
		entry(message({ id: "other-agent", recipients: [{ objectId: "b", agentId: "other" }] }), "b"),
		entry(message({ id: "other-object", recipients: [{ objectId: "c", agentId: "agent-b" }] }), "b"),
	];
	expect(pendingInbox(inbox, "agent-b").map((entry) => entry.message.id)).toEqual(["first", "a", "z"]);
});

test("historical outbox entries never broadcast through the normal pump", async () => {
	const server = mailboxServer();
	await sendMessage(message({ historical: true, requestReply: false }));
	await deliverOutbox(server.objects.get("a")!);
	expect(server.objects.get("b")!.mailbox).toEqual([]);
	expect(server.objects.get("c")!.mailbox).toEqual([]);
});
