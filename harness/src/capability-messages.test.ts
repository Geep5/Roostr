import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Module mocks live in a separate process: these boundary tests must not replace
// the catalogs or mailbox helpers used by another test in the same Bun worker.
const fixture = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const objects = new Map();
const sent = [];
let opened = 0;
let authenticated = false;
let saveFails = false;
let skillStarts = 0;
let skillState = { phase: "off", installed: false };
let clock = 100;
// Load the real local credential store before replacing only the browser boundary.
const realCredentials = await import("./credentials");
const saveLocal = realCredentials.setPasswordCredential;
mock.module("./credentials", () => ({ ...realCredentials, setPasswordCredential: (key, fields) => { if (saveFails) throw new Error(fields.apiSecret); saveLocal(key, fields); }, startBrowserLogin: () => { opened++; return { pid: 1 }; }, finishBrowserLogin: () => authenticated }));
mock.module("./roster", () => ({ machineId: async () => "owner-machine" }));
mock.module("./descriptors", () => ({ INSTALL_TYPE: "install" }));
mock.module("./skillmgr", () => ({ CATALOG: [{ key: "browserless" }, { key: "google" }], republishCapabilities: async () => {}, skillOperationState: async () => skillState, enableSkill: async () => { skillStarts++; skillState = { phase: "installing", installed: false }; return "installing"; }, disableSkill: async () => { throw new Error("unexpected disable"); }, uninstallSkill: async () => { throw new Error("unexpected uninstall"); }, recheckSkill: async () => "on" }));
mock.module("./google", () => ({ addGoogleAccount: async () => {}, removeGoogleAccount: () => {}, googleAccountStatus: async () => ({ authMethod: "none" }) }));
const object = { id: "install-x", typeKey: "install", fields: { key: { stringValue: "x" }, machine_id: { stringValue: "owner-machine" }, status: { stringValue: "missing" } }, mailbox: [], blocks: [], deleted: false, createdAt: 0, updatedAt: 0 };
objects.set(object.id, object);
const source = { ...object, id: "requester", typeKey: "note", fields: {}, mailbox: [] };
objects.set(source.id, source);
function addRequest(operation, extra = {}) {
 const message = { id: "request-" + (++clock), exchangeId: "exchange", sender: { objectId: source.id, agentId: "requester-agent" }, recipients: [{ objectId: object.id, agentId: "" }], text: "Please set up this installation.", replyTo: "", sentAt: clock, title: "Setup", requestReply: true, historical: false, operation, author: "requester-agent", ...extra };
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
const entry = addRequest("auth.save");
const historical = addRequest("auth.login", { historical: true });
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(entry.processing.status, "awaiting_approval");
assert.equal(historical.processing.status, "pending");
assert.equal(object.fields.status.stringValue, "needs_approval");
assert.equal(existsSync(process.env.GLON_DATA + "/credentials.json"), false);
assert.equal(opened, 0);
assert.equal(sent.length, 0);
object.fields.machine_id.stringValue = "another-machine";
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
await assert.rejects(() => capability.approveCapabilityRequest(object.id, entry.message.id, {}), /another machine/);
assert.throws(() => capability.capabilityTarget({ ...object, fields: { ...object.fields, machine_id: { stringValue: "owner-machine" } } }, "constructor", "owner-machine"), /Unsupported/);
assert.equal(opened, 0);
`);
});

test("approved secret save stays local and cannot replay after completion", async () => {
	await scenario(String.raw`
const entry = addRequest("auth.save");
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
const fields = { apiKey: "private-one", apiSecret: "private-two", accessToken: "private-three", accessTokenSecret: "private-four" };
await assert.rejects(() => capability.approveCapabilityRequest(object.id, entry.message.id, { ...fields, command: "bad" }), /exactly/);
assert.equal(entry.processing.status, "awaiting_approval");
await capability.approveCapabilityRequest(object.id, entry.message.id, fields);
assert.equal(entry.processing.status, "processed");
assert.equal(object.fields.status.stringValue, "active");
assert.equal(object.fields.error.stringValue, "");
const local = JSON.parse(readFileSync(process.env.GLON_DATA + "/credentials.json", "utf8"));
assert.deepEqual(local.credentials.x.fields, fields);
const durable = JSON.stringify([...objects.values()]);
for (const secret of Object.values(fields)) assert.equal(durable.includes(secret), false);
assert.equal(sent.length, 1);
assert.equal(sent[0].requestReply, false);
assert.deepEqual(sent[0].recipients, [entry.message.sender]);
await assert.rejects(() => capability.approveCapabilityRequest(object.id, entry.message.id, fields), /not awaiting/);
assert.equal(sent.length, 1);
`);
});

test("browser login stays pending until actual authentication and competing approvals claim once", async () => {
	await scenario(String.raw`
const entry = addRequest("auth.login");
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
await assert.rejects(() => capability.approveCapabilityRequest(object.id, entry.message.id, { token: "private" }), /Only auth.save/);
const results = await Promise.allSettled([capability.approveCapabilityRequest(object.id, entry.message.id), capability.approveCapabilityRequest(object.id, entry.message.id)]);
assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(opened, 1);
assert.equal(entry.processing.status, "processing");
assert.equal(sent.length, 0);
await capability.receiveCapabilityRequests(structuredClone(object), "live-owner");
assert.equal(entry.processing.status, "processing");
assert.deepEqual(await capability.finishCapabilityLogin(object.id, entry.message.id), { active: false });
assert.equal(entry.processing.status, "processing");
authenticated = true;
assert.deepEqual(await capability.finishCapabilityLogin(object.id, entry.message.id), { active: true });
assert.equal(entry.processing.status, "processed");
assert.equal(object.fields.auth.stringValue, "browser_profile");
assert.equal(sent.length, 1);
`);
});

test("recovery reports interruption and never relaunches a previously approved operation", async () => {
	await scenario(String.raw`
const entry = addRequest("auth.login");
await capability.approveCapabilityRequest(object.id, entry.message.id);
const claimTime = entry.processing.at;
await capability.receiveCapabilityRequests(structuredClone(object), "new-process-owner");
assert.equal(opened, 1);
assert.equal(entry.processing.status, "failed");
assert.match(entry.processing.error, /interrupted/);
assert.equal(sent[0].id, "reply:" + entry.message.id + ":" + object.id + ":" + claimTime);
assert.equal(sent[0].sentAt, claimTime);
await capability.receiveCapabilityRequests(structuredClone(object), "new-process-owner");
assert.equal(opened, 1);
assert.equal(sent.length, 1);
`);
});

test("credential storage errors cannot put submitted values into results or installation history", async () => {
	await scenario(String.raw`
const entry = addRequest("auth.save");
saveFails = true;
await capability.approveCapabilityRequest(object.id, entry.message.id, { apiKey: "private-key", apiSecret: "sensitive-storage-error", accessToken: "private-token", accessTokenSecret: "private-secret" });
assert.equal(entry.processing.status, "failed");
assert.equal(object.fields.status.stringValue, "broken");
assert.equal(JSON.stringify([...objects.values()]).includes("sensitive-storage-error"), false);
assert.equal(JSON.stringify(await capability.listCapabilityRequests()).includes("sensitive-storage-error"), false);
assert.equal(existsSync(process.env.GLON_DATA + "/credentials.json"), false);
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
