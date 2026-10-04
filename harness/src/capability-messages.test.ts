import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module mocks live in a separate process: these boundary tests must not replace
// the catalogs or mailbox helpers used by another test in the same Bun worker.
const fixture = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
const objects = new Map();
const sent = [];
let authenticated = false;
let skillStarts = 0;
let skillState = { phase: "off", installed: false };
let clock = 100;
mock.module("./roster", () => ({ machineId: async () => "owner-machine" }));
mock.module("./capabilities", () => ({ CAPABILITY_TYPE: "capability", linkTarget: (fields, key) => fields[key]?.linkValue?.targetId || fields[key]?.stringValue || "" }));
mock.module("./skillmgr", () => ({ CATALOG: [{ key: "browserless" }, { key: "google" }], skillOperationState: async () => skillState, enableSkill: async () => { skillStarts++; skillState = { phase: "installing", installed: false }; return "installing"; }, disableSkill: async () => { throw new Error("unexpected disable"); }, uninstallSkill: async () => { throw new Error("unexpected uninstall"); }, recheckSkill: async () => authenticated ? "on" : "needs-auth" }));
const object = { id: "capability-google", typeKey: "capability", fields: { key: { stringValue: "google" }, served_by: { stringValue: "owner-machine" }, status: { stringValue: "missing" } }, mailbox: [], blocks: [], deleted: false, createdAt: 0, updatedAt: 0 };
objects.set(object.id, object);
const source = { ...object, id: "requester", typeKey: "note", fields: {}, mailbox: [] };
objects.set(source.id, source);
function addRequest(operation, extra = {}) {
 const message = { id: "request-" + (++clock), exchangeId: "exchange", sender: { objectId: source.id, agentId: "requester-agent" }, recipients: [{ objectId: object.id, agentId: "" }], text: "Please set up this capability.", replyTo: "", sentAt: clock, title: "Setup", requestReply: true, historical: false, operation, author: "requester-agent", ...extra };
 const entry = { message, incoming: true, outgoing: false, threadId: "__thread__exchange", deliveries: [], processing: { status: "pending", owner: "", error: "", at: 0 } };
 object.mailbox.push(entry);
 return entry;
}
mock.module("./api", () => ({
 str: (fields, key) => fields[key]?.stringValue ?? "", sv: (value) => ({ stringValue: value }), iv: (value) => ({ intValue: value }),
 fetchObject: async (id) => structuredClone(objects.get(id)), queryAll: async () => [structuredClone(object)],
 setField: async (id, key, value) => { objects.get(id).fields[key] = structuredClone(value); },
 mutate: async (action, args) => {
  assert.equal(action, "message_processing");
  const entry = objects.get(args.object_id).mailbox.find((item) => item.message.id === args.message_id);
  entry.processing = { status: args.status, owner: args.owner, error: "", at: ++clock };
  return {};
 }
}));
mock.module("./mailbox", () => ({
 claimMessage: async (id, messageId, owner) => { const entry = objects.get(id).mailbox.find((item) => item.message.id === messageId); if (!["pending", "awaiting_approval"].includes(entry.processing.status)) return false; entry.processing = { status: "processing", owner, error: "", at: ++clock }; return true; },
 finishMessage: async (id, messageId, owner, error) => { const entry = objects.get(id).mailbox.find((item) => item.message.id === messageId); assert.equal(entry.processing.owner, owner); entry.processing = { status: error ? "failed" : "processed", owner, error: error ?? "", at: ++clock }; },
 replyRecipients: (message, responder) => [message.sender, ...message.recipients].filter((endpoint) => endpoint.objectId !== responder.objectId),
 deliverOutbox: async () => {},
 sendMessage: async (message) => { sent.push(structuredClone(message)); objects.get(message.sender.objectId).mailbox.push({ message: structuredClone(message), incoming: false, outgoing: true, processing: { status: "processed", owner: "", error: "", at: 0 }, deliveries: [], threadId: "__thread__" + message.exchangeId }); return { id: message.id, exchangeId: message.exchangeId, threadId: "__thread__" + message.exchangeId }; }
}));
const capability = await import("./capability-messages");
capability.setCapabilityRequestOwner("live-owner");
`;

async function scenario(body: string): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "roostr-capability-test-"));
	try {
		const child = Bun.spawn([process.execPath, "-e", fixture + body], { cwd: import.meta.dir, env: { ...process.env, GLON_DATA: dir }, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("sync only stages approval; historical and foreign-machine requests never execute", async () => {
	await scenario(String.raw`
const entry = addRequest("skill.install");
const historical = addRequest("skill.install", { historical: true });
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(entry.processing.status, "awaiting_approval");
assert.equal(historical.processing.status, "pending");
assert.equal(object.fields.status.stringValue, "needs_approval");
assert.equal(skillStarts, 0);
assert.equal(sent.length, 0);
object.fields.served_by.stringValue = "another-machine";
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
await assert.rejects(() => capability.approveCapabilityRequest(object.id, entry.message.id), /another machine/);
assert.throws(() => capability.capabilityTarget({ ...object, fields: { ...object.fields, served_by: { stringValue: "owner-machine" } } }, "constructor", "owner-machine"), /Unsupported/);
assert.throws(() => capability.capabilityTarget({ ...object, fields: { ...object.fields, served_by: { stringValue: "owner-machine" } } }, "auth.login", "owner-machine"), /Unsupported/);
assert.equal(skillStarts, 0);
`);
});

test("a check runs once per approval and replies with the live result", async () => {
	await scenario(String.raw`
const entry = addRequest("skill.check");
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
const results = await Promise.allSettled([capability.approveCapabilityRequest(object.id, entry.message.id), capability.approveCapabilityRequest(object.id, entry.message.id)]);
assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(entry.processing.status, "failed");
assert.equal(object.fields.status.stringValue, "needs_auth");
assert.equal(sent.length, 1);
authenticated = true;
const again = addRequest("skill.check");
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.deepEqual(await capability.approveCapabilityRequest(object.id, again.message.id), { pending: false });
assert.equal(again.processing.status, "processed");
assert.equal(object.fields.status.stringValue, "active");
assert.equal(object.fields.error.stringValue, "");
assert.equal(sent.length, 2);
`);
});

test("recovery reports interruption and never relaunches a previously approved operation", async () => {
	await scenario(String.raw`
object.fields.key.stringValue = "browserless";
const entry = addRequest("skill.install");
await capability.approveCapabilityRequest(object.id, entry.message.id);
const claimTime = entry.processing.at;
await capability.receiveCapabilityRequests(structuredClone(object), "new-process-owner");
assert.equal(skillStarts, 1);
assert.equal(entry.processing.status, "failed");
assert.match(entry.processing.error, /interrupted/);
assert.equal(sent[0].id, "reply:" + entry.message.id + ":" + object.id + ":" + claimTime);
assert.equal(sent[0].sentAt, claimTime);
await capability.receiveCapabilityRequests(structuredClone(object), "new-process-owner");
assert.equal(skillStarts, 1);
assert.equal(sent.length, 1);
`);
});

test("skill approval remains processing until the real installer state settles", async () => {
	await scenario(String.raw`
object.fields.key.stringValue = "browserless";
const entry = addRequest("skill.install");
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(skillStarts, 0);
assert.deepEqual(await capability.approveCapabilityRequest(object.id, entry.message.id), { pending: true });
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(entry.processing.status, "processing");
assert.equal(sent.length, 0);
skillState = { phase: "on", installed: true };
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(entry.processing.status, "processed");
assert.equal(object.fields.status.stringValue, "active");
assert.equal(skillStarts, 1);
assert.equal(sent.length, 1);
`);
});
