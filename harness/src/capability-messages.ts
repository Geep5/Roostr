import { fetchObject, mutate, queryAll, setField, str, sv, iv, type AgentEndpoint, type AgentMessage, type MailboxEntry, type ObjectJSON } from "./api";
import { CAPABILITY_TYPE, linkTarget, type CapabilityState, type CapabilityStatus } from "./capabilities";
import { claimMessage, deliverOutbox, finishMessage, replyRecipients, sendMessage } from "./mailbox";
import { machineId } from "./roster";
import { CATALOG, disableSkill, enableSkill, recheckSkill, skillOperationState, uninstallSkill } from "./skillmgr";

// A capability is one catalog skill on one machine; its object is the inbox
// for these operations. Service and Google sign-ins are Credential objects
// (credential-objects.ts), not capability operations.
const OPERATIONS: Record<string, true> = { "skill.install": true, "skill.enable": true, "skill.disable": true, "skill.uninstall": true, "skill.check": true };
const INTERRUPTED = "Operation interrupted. Its effects are unknown; inspect this machine before explicitly retrying.";
let requestOwner = `capability:${crypto.randomUUID()}`;
export function setCapabilityRequestOwner(owner: string): void { requestOwner = owner; }

interface Target { key: string }
interface Execution extends Target { messageId: string; starting: boolean; outcome?: { state: CapabilityState; error: string } }
// These locks only guard live execution. The inbox claim is the durable record;
// a restarted process fails the old claim rather than replaying side effects.
const executions = new Map<string, Execution>();
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(objectId: string, work: () => Promise<T>): Promise<T> {
	const previous = locks.get(objectId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(work);
	locks.set(objectId, next);
	try { return await next; } finally { if (locks.get(objectId) === next) locks.delete(objectId); }
}

const servedBy = (object: ObjectJSON): string => linkTarget(object.fields, "served_by");

export function capabilityTarget(object: ObjectJSON, operation: string, localMachine: string): Target {
	if (object.deleted) throw new Error("This capability has been deleted.");
	if (object.typeKey !== CAPABILITY_TYPE || servedBy(object) !== localMachine) throw new Error("This capability belongs to another machine.");
	if (!Object.hasOwn(OPERATIONS, operation)) throw new Error("Unsupported capability operation.");
	const key = str(object.fields, "key");
	if (!CATALOG.some((entry) => entry.key === key)) throw new Error("This capability is not in the local catalog.");
	return { key };
}

function incoming(object: ObjectJSON, messageId?: string): MailboxEntry[] {
	return (object.mailbox ?? []).filter((entry) => entry.incoming && !entry.message.historical && !!entry.message.operation && (!messageId || entry.message.id === messageId) && entry.message.recipients.some((endpoint) => endpoint.objectId === object.id && endpoint.agentId === ""));
}

async function canonical(objectId: string, messageId: string): Promise<{ object: ObjectJSON; entry: MailboxEntry; target: Target }> {
	const object = await fetchObject(objectId);
	const entry = incoming(object, messageId)[0];
	if (!entry) throw new Error("Capability request is not in this capability's inbox.");
	const target = capabilityTarget(object, entry.message.operation, await machineId());
	return { object, entry, target };
}

async function publish(object: ObjectJSON, state: CapabilityState): Promise<void> {
	const key = str(object.fields, "key");
	object = await fetchObject(object.id);
	if (servedBy(object) !== await machineId()) throw new Error("Capability ownership changed.");
	if (object.deleted || object.typeKey !== CAPABILITY_TYPE || str(object.fields, "key") !== key) throw new Error("Capability identity changed.");
	const fields = { status: state.status, error: state.error ?? "" };
	let changed = false;
	for (const [field, value] of Object.entries(fields)) {
		if (str(object.fields, field) === value) continue;
		await setField(object.id, field, sv(value));
		changed = true;
	}
	if (changed) await setField(object.id, "checked_at", iv(Date.now()));
}

async function complete(object: ObjectJSON, entry: MailboxEntry, state: CapabilityState, error = ""): Promise<void> {
	const execution = executions.get(object.id);
	if (execution?.messageId === entry.message.id) execution.outcome = { state, error };
	await publish(object, state);
	if (entry.message.requestReply) {
		const sender = { objectId: object.id, agentId: "" };
		const recipients = replyRecipients(entry.message, sender);
		const replyId = `reply:${entry.message.id}:${object.id}:${entry.processing.at}`;
		const alreadySent = (await fetchObject(object.id)).mailbox?.some((item) => item.outgoing && item.message.id === replyId);
		if (recipients.length && !alreadySent) {
			// The claim time distinguishes explicit retry attempts, while remaining
			// stable if committing the response is retried after a network failure.
			await sendMessage({ id: replyId, exchangeId: entry.message.exchangeId, sender, recipients, text: `${entry.message.operation}: ${state.status}${error ? `. ${error}` : "."}`, replyTo: entry.message.id, sentAt: entry.processing.at, title: entry.message.title, requestReply: false, historical: false, operation: "", author: servedBy(object) });
		}
	}
	await finishMessage(object.id, entry.message.id, entry.processing.owner || requestOwner, error || undefined);
	executions.delete(object.id);
	await deliverOutbox(await fetchObject(object.id));
}

async function skillOutcome(key: string, operation: string): Promise<{ state: CapabilityState; error: string } | null> {
	const local = await skillOperationState(key);
	if (local.phase === "installing" || local.phase === "uninstalling") return null;
	if (local.phase === "failed") return { state: { status: "broken" }, error: "The local skill operation failed. Inspect its local installer log." };
	if (local.phase === "needs-auth") return { state: { status: "needs_auth" }, error: operation === "skill.install" ? "" : "Authentication is required on this machine." };
	return { state: { status: local.phase === "on" ? "active" : local.installed ? "disabled" : "missing" }, error: "" };
}

/** Sync can stage approval or observe an already-approved job; never execute an operation. */
export async function receiveCapabilityRequests(object: ObjectJSON, owner: string): Promise<void> {
	if (object.deleted || object.typeKey !== CAPABILITY_TYPE || servedBy(object) !== await machineId()) return;
	await locked(object.id, async () => {
		object = await fetchObject(object.id);
		for (const entry of incoming(object)) {
			if (entry.processing.status === "processing") {
				const execution = executions.get(object.id);
				if (entry.processing.owner !== owner || !execution || execution.messageId !== entry.message.id || execution.key !== str(object.fields, "key")) {
					await complete(object, entry, { status: "broken", error: INTERRUPTED }, INTERRUPTED);
					continue;
				}
				if (execution.outcome) {
					await complete(object, entry, execution.outcome.state, execution.outcome.error);
					continue;
				}
				if (!execution.starting) {
					const outcome = await skillOutcome(execution.key, entry.message.operation);
					if (outcome) await complete(object, entry, { ...outcome.state, error: outcome.error }, outcome.error);
				}
				continue;
			}
			if (entry.processing.status !== "pending") continue;
			// Unknown operations are not executed or reflected as raw text/errors.
			let valid = true;
			try { capabilityTarget(object, entry.message.operation, await machineId()); } catch { valid = false; }
			await mutate("message_processing", { object_id: object.id, message_id: entry.message.id, status: "awaiting_approval", owner });
			// An active capability keeps serving while a request waits; the request itself is the visible record.
			if (!executions.has(object.id) && (str(object.fields, "status") !== "active" || !valid)) await publish(object, { status: "needs_approval", error: valid ? "A capability request is waiting for approval on this machine." : "This request is not supported by the local catalog. Reject it on this machine." });
		}
	});
}

export interface CapabilityRequestView {
	objectId: string; messageId: string; key: string; operation: string; sender: AgentEndpoint;
	status: string; error: string; sentAt: number; canApprove: boolean;
}
export async function listCapabilityRequests(): Promise<CapabilityRequestView[]> {
	const local = await machineId();
	const requests: CapabilityRequestView[] = [];
	for (const row of await queryAll({ type: CAPABILITY_TYPE })) {
		if (linkTarget(row.fields, "served_by") !== local) continue;
		const object = await fetchObject(row.id);
		for (const entry of incoming(object)) {
			if (entry.processing.status === "processed") continue;
			let canApprove = true;
			try { capabilityTarget(object, entry.message.operation, local); } catch { canApprove = false; }
			requests.push({ objectId: object.id, messageId: entry.message.id, key: str(object.fields, "key"), operation: entry.message.operation, sender: entry.message.sender, status: entry.processing.status, error: entry.processing.error || str(object.fields, "error"), sentAt: entry.message.sentAt, canApprove });
		}
	}
	return requests.sort((a, b) => a.sentAt - b.sentAt || a.messageId.localeCompare(b.messageId));
}

const PHASE_STATUS: Record<string, CapabilityStatus> = { on: "active", "needs-auth": "needs_auth", failed: "broken" };

export async function approveCapabilityRequest(objectId: string, messageId: string): Promise<{ pending: boolean }> {
	const initial = await canonical(objectId, messageId);
	return locked(`catalog:${initial.target.key}`, () => locked(objectId, async () => {
		let { object, entry, target } = await canonical(objectId, messageId);
		if (target.key !== initial.target.key) throw new Error("Capability identity changed before approval.");
		if (!["pending", "awaiting_approval"].includes(entry.processing.status)) throw new Error("This request is not awaiting approval.");
		if ([...executions.values()].some((run) => run.key === target.key)) throw new Error("Another operation is in progress for this capability.");
		if (!(await claimMessage(objectId, messageId, requestOwner))) throw new Error("This request has already been claimed.");
		({ object, entry, target } = await canonical(objectId, messageId));
		if (target.key !== initial.target.key) throw new Error("Capability identity changed while claiming approval.");
		const execution: Execution = { ...target, messageId, starting: true };
		executions.set(objectId, execution);
		try {
			if (entry.message.operation !== "skill.check") await publish(object, { status: "processing", error: "Approved operation in progress on this machine." });
			const operation = entry.message.operation;
			if (operation === "skill.check") {
				// The check records its own detail (command output) on this capability.
				const status = PHASE_STATUS[await recheckSkill(target.key)] ?? "missing";
				const error = status === "active" ? "" : str((await fetchObject(objectId)).fields, "error") || "The skill check did not pass on this machine.";
				await complete(object, entry, { status, error }, error);
				return { pending: false };
			}
			if (operation === "skill.install" || operation === "skill.enable") await enableSkill(target.key);
			else if (operation === "skill.disable") await disableSkill(target.key);
			else if (operation === "skill.uninstall") await uninstallSkill(target.key);
			const outcome = await skillOutcome(target.key, operation);
			execution.starting = false;
			if (!outcome) return { pending: true };
			await complete(object, entry, { ...outcome.state, error: outcome.error }, outcome.error);
			return { pending: false };
		} catch {
			if (execution.outcome) throw new Error("The operation finished locally; its durable result is awaiting publication.");
			const error = "The approved local operation failed. Check the capability on this machine before retrying.";
			await complete(await fetchObject(objectId), entry, { status: "broken", error }, error);
			return { pending: false };
		}
	}));
}

export async function rejectCapabilityRequest(objectId: string, messageId: string): Promise<void> {
	await locked(objectId, async () => {
		const object = await fetchObject(objectId);
		if (object.deleted) throw new Error("This capability has been deleted.");
		if (object.typeKey !== CAPABILITY_TYPE || servedBy(object) !== await machineId()) throw new Error("This capability belongs to another machine.");
		let entry = incoming(object, messageId)[0];
		if (!entry || !["pending", "awaiting_approval"].includes(entry.processing.status)) throw new Error("This request is not awaiting approval.");
		if (!(await claimMessage(objectId, messageId, requestOwner))) throw new Error("This request has already been claimed.");
		entry = incoming(await fetchObject(objectId), messageId)[0]!;
		const error = "Request rejected by the human on the owning machine.";
		// Rejecting changes nothing on this machine: republish its real state, and fail only the request.
		const current = await skillOutcome(str(object.fields, "key"), entry.message.operation);
		await complete(object, entry, current ? { ...current.state, error: current.error } : { status: "broken", error }, error);
	});
}

/** Commit an intent to the requester's own object before attempting delivery. `operation` is refused unless the capability takes it (capabilityTarget). */
export async function requestCapability(input: { sender: AgentEndpoint; capabilityObjectId: string; operation: string; author?: string; text?: string }): Promise<{ id: string; exchangeId: string; threadId: string }> {
	const target = await fetchObject(input.capabilityObjectId);
	if (!servedBy(target)) throw new Error("Capability has no owning machine.");
	capabilityTarget(target, input.operation, servedBy(target));
	// Include the sender outbox: its request may not have reached the owner yet.
	const source = await fetchObject(input.sender.objectId);
	const previous = [...(target.mailbox ?? []), ...(source.mailbox ?? [])].find((entry) => !entry.message.historical && entry.message.operation === input.operation && entry.message.sender.objectId === input.sender.objectId && entry.message.sender.agentId === input.sender.agentId && entry.message.recipients.some((endpoint) => endpoint.objectId === target.id) && ["pending", "awaiting_approval", "processing"].includes(entry.processing.status) && !target.mailbox?.some((received) => received.message.id === entry.message.id && ["processed", "failed"].includes(received.processing.status)));
	if (previous) return { id: previous.message.id, exchangeId: previous.message.exchangeId, threadId: previous.threadId };
	const message: AgentMessage = { id: crypto.randomUUID(), exchangeId: crypto.randomUUID(), sender: input.sender, recipients: [{ objectId: target.id, agentId: "" }], text: input.text || `Request ${input.operation} for ${str(target.fields, "key")}.`, replyTo: "", sentAt: Date.now(), title: "Capability request", requestReply: true, historical: false, operation: input.operation, author: input.author ?? input.sender.agentId };
	const sent = await sendMessage(message);
	await deliverOutbox(await fetchObject(input.sender.objectId));
	return sent;
}
