import { fetchObject, mutate, queryAll, setField, str, sv, iv, type AgentEndpoint, type AgentMessage, type MailboxEntry, type ObjectJSON } from "./api";
import { claimMessage, deliverOutbox, finishMessage, replyRecipients, sendMessage } from "./mailbox";
import { machineId } from "./roster";
import { CATALOG, disableSkill, enableSkill, recheckSkill, republishCapabilities, skillOperationState, uninstallSkill } from "./skillmgr";
import { CREDENTIALS, credentialStatus, finishBrowserLogin, removeCredential, setPasswordCredential, startBrowserLogin } from "./credentials";
import { addGoogleAccount, googleAccountStatus, removeGoogleAccount } from "./google";
import { INSTALL_TYPE, type InstallationState } from "./descriptors";

export type CapabilityOperation = "skill.install" | "skill.enable" | "skill.disable" | "skill.uninstall" | "auth.login" | "auth.check" | "auth.revoke" | "auth.save";
const OPERATIONS: Record<string, true> = { "skill.install": true, "skill.enable": true, "skill.disable": true, "skill.uninstall": true, "auth.login": true, "auth.check": true, "auth.revoke": true, "auth.save": true };
const INTERRUPTED = "Operation interrupted. Its effects are unknown; inspect this machine before explicitly retrying.";
const WAITING_LOGIN = "Finish signing in on this machine, then confirm login completion.";
let requestOwner = `capability:${crypto.randomUUID()}`;
export function setCapabilityRequestOwner(owner: string): void { requestOwner = owner; }

interface Target { key: string; account: string }
interface Execution extends Target { messageId: string; starting: boolean; outcome?: { state: InstallationState; error: string } }
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

export function capabilityTarget(object: ObjectJSON, operation: string, localMachine: string): Target {
	if (object.deleted) throw new Error("This installation has been deleted.");
	if (object.typeKey !== INSTALL_TYPE || str(object.fields, "machine_id") !== localMachine) throw new Error("This installation belongs to another machine.");
	if (!Object.hasOwn(OPERATIONS, operation)) throw new Error("Unsupported capability operation.");
	const key = str(object.fields, "key");
	const account = str(object.fields, "account");
	const skill = CATALOG.find((entry) => entry.key === key);
	const credential = CREDENTIALS.find((entry) => entry.key === key);
	if (!skill && !credential) throw new Error("This installation is not in the local catalog.");
	if (account && (key !== "google" || !/^[^\s/\\]+@[^\s/\\]+$/.test(account))) throw new Error("Invalid installation account.");
	if (operation.startsWith("skill.") && (!skill || account)) throw new Error("This installation does not accept skill operations.");
	if (operation === "auth.save" && !credential?.passwordFields) throw new Error("This installation does not accept saved credentials.");
	if (operation === "auth.login" && !credential?.loginUrl && key !== "google") throw new Error("This installation has no login workflow.");
	if (operation === "auth.revoke" && !credential && !(key === "google" && account)) throw new Error("Choose an account installation to revoke.");
	return { key, account };
}

function incoming(object: ObjectJSON, messageId?: string): MailboxEntry[] {
	return (object.mailbox ?? []).filter((entry) => entry.incoming && !entry.message.historical && !!entry.message.operation && (!messageId || entry.message.id === messageId) && entry.message.recipients.some((endpoint) => endpoint.objectId === object.id && endpoint.agentId === ""));
}

async function canonical(objectId: string, messageId: string): Promise<{ object: ObjectJSON; entry: MailboxEntry; target: Target }> {
	const object = await fetchObject(objectId);
	const entry = incoming(object, messageId)[0];
	if (!entry) throw new Error("Capability request is not in this installation's inbox.");
	const target = capabilityTarget(object, entry.message.operation, await machineId());
	return { object, entry, target };
}

async function publish(object: ObjectJSON, state: InstallationState): Promise<void> {
	const key = str(object.fields, "key");
	const account = str(object.fields, "account");
	object = await fetchObject(object.id);
	if (str(object.fields, "machine_id") !== await machineId()) throw new Error("Installation ownership changed.");
	if (object.deleted || object.typeKey !== INSTALL_TYPE || str(object.fields, "key") !== key || str(object.fields, "account") !== account) throw new Error("Installation identity changed.");
	const fields = { status: state.status, error: state.error ?? "", ...(state.auth ? { auth: state.auth } : {}) };
	let changed = false;
	for (const [key, value] of Object.entries(fields)) {
		if (str(object.fields, key) === value) continue;
		await setField(object.id, key, sv(value));
		changed = true;
	}
	if (changed) await setField(object.id, "checked_at", iv(Date.now()));
}

async function complete(object: ObjectJSON, entry: MailboxEntry, state: InstallationState, error = ""): Promise<void> {
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
			await sendMessage({ id: replyId, exchangeId: entry.message.exchangeId, sender, recipients, text: `${entry.message.operation}: ${state.status}${error ? `. ${error}` : "."}`, replyTo: entry.message.id, sentAt: entry.processing.at, title: entry.message.title, requestReply: false, historical: false, operation: "", author: str(object.fields, "machine_id") });
		}
	}
	await finishMessage(object.id, entry.message.id, entry.processing.owner || requestOwner, error || undefined);
	executions.delete(object.id);
	await deliverOutbox(await fetchObject(object.id));
}

async function skillOutcome(key: string, operation: string): Promise<{ state: InstallationState; error: string } | null> {
	const local = await skillOperationState(key);
	if (local.phase === "installing" || local.phase === "uninstalling") return null;
	if (local.phase === "failed") return { state: { status: "broken" }, error: "The local skill operation failed. Inspect its local installer log." };
	if (local.phase === "needs-auth") return { state: { status: "needs_auth" }, error: operation === "skill.install" ? "" : "Authentication is required on this machine." };
	return { state: { status: local.phase === "on" ? "active" : local.installed ? "disabled" : "missing", auth: "none" }, error: "" };
}

/** Sync can stage approval or observe an already-approved job; never execute an operation. */
export async function receiveCapabilityRequests(object: ObjectJSON, owner: string): Promise<void> {
	if (object.deleted || object.typeKey !== INSTALL_TYPE || str(object.fields, "machine_id") !== await machineId()) return;
	await locked(object.id, async () => {
		object = await fetchObject(object.id);
		for (const entry of incoming(object)) {
			if (entry.processing.status === "processing") {
				const execution = executions.get(object.id);
				if (entry.processing.owner !== owner || !execution || execution.messageId !== entry.message.id) {
					await complete(object, entry, { status: "broken", error: INTERRUPTED }, INTERRUPTED);
					continue;
				}
				if (execution.key !== str(object.fields, "key") || execution.account !== str(object.fields, "account")) {
					await complete(object, entry, { status: "broken", error: INTERRUPTED }, INTERRUPTED);
					continue;
				}
				if (execution.outcome) {
					await complete(object, entry, execution.outcome.state, execution.outcome.error);
					continue;
				}
				if (!execution.starting && entry.message.operation.startsWith("skill.")) {
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
			if (!executions.has(object.id)) await publish(object, { status: "needs_approval", error: valid ? "A capability request is waiting for approval on this machine." : "This request is not supported by the local catalog. Reject it on this machine." });
		}
	});
}

export interface CapabilityRequestView {
	objectId: string; messageId: string; key: string; account: string; operation: string; sender: AgentEndpoint;
	status: string; error: string; sentAt: number; canApprove: boolean;
	fields?: Array<{ key: string; label: string; secret: boolean }>;
}
export async function listCapabilityRequests(): Promise<CapabilityRequestView[]> {
	const local = await machineId();
	const requests: CapabilityRequestView[] = [];
	for (const row of await queryAll({ type: INSTALL_TYPE })) {
		if (str(row.fields, "machine_id") !== local) continue;
		const object = await fetchObject(row.id);
		for (const entry of incoming(object)) {
			if (entry.processing.status === "processed") continue;
			let canApprove = true;
			try { capabilityTarget(object, entry.message.operation, local); } catch { canApprove = false; }
			requests.push({ objectId: object.id, messageId: entry.message.id, key: str(object.fields, "key"), account: str(object.fields, "account"), operation: entry.message.operation, sender: entry.message.sender, status: entry.processing.status, error: entry.processing.error || str(object.fields, "error"), sentAt: entry.message.sentAt, canApprove, ...(entry.message.operation === "auth.save" ? { fields: CREDENTIALS.find((c) => c.key === str(object.fields, "key"))?.passwordFields } : {}) });
		}
	}
	return requests.sort((a, b) => a.sentAt - b.sentAt || a.messageId.localeCompare(b.messageId));
}

export async function approveCapabilityRequest(objectId: string, messageId: string, fields?: unknown): Promise<{ pending: boolean }> {
	const initial = await canonical(objectId, messageId);
	return locked(`catalog:${initial.target.key}:${initial.target.account}`, () => locked(objectId, async () => {
		let { object, entry, target } = await canonical(objectId, messageId);
		if (target.key !== initial.target.key || target.account !== initial.target.account) throw new Error("Installation identity changed before approval.");
		if (!["pending", "awaiting_approval"].includes(entry.processing.status)) throw new Error("This request is not awaiting approval.");
		if (fields !== undefined && entry.message.operation !== "auth.save") throw new Error("Only auth.save accepts local credential fields.");
		let secrets: Record<string, string> | undefined;
		if (entry.message.operation === "auth.save") {
			const specs = CREDENTIALS.find((c) => c.key === target.key)!.passwordFields!;
			if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Credential fields are required in this paired approval.");
			const values = fields as Record<string, unknown>;
			if (Object.keys(values).some((key) => !specs.some((spec) => spec.key === key)) || specs.some((spec) => typeof values[spec.key] !== "string" || !(values[spec.key] as string).trim())) throw new Error("Complete exactly the credential fields shown for this installation.");
			secrets = values as Record<string, string>;
		}
		if ([...executions.values()].some((run) => run.key === target.key && run.account === target.account)) throw new Error("Another operation is in progress for this installation.");
		if (!(await claimMessage(objectId, messageId, requestOwner))) throw new Error("This request has already been claimed.");
		({ object, entry, target } = await canonical(objectId, messageId));
		if (target.key !== initial.target.key || target.account !== initial.target.account) throw new Error("Installation identity changed while claiming approval.");
		const execution: Execution = { ...target, messageId, starting: true };
		executions.set(objectId, execution);
		try {
			await publish(object, { status: "processing", error: "Approved operation in progress on this machine." });
			const operation = entry.message.operation;
			if (operation === "auth.save") {
				// Never copy fields or caught storage exceptions into a message, object,
				// log, or HTTP error. Only the paired request and local store see them.
				setPasswordCredential(target.key, secrets!);
				secrets = undefined;
				await republishCapabilities();
				await complete(object, entry, { status: "active", auth: "api_key" });
			} else if (operation === "auth.revoke") {
				if (target.key === "google") removeGoogleAccount(target.account);
				else removeCredential(target.key);
				await republishCapabilities();
				await complete(object, entry, { status: "missing", auth: "none" });
			} else if (operation === "auth.login") {
				if (target.key === "google") {
					if (target.account) await addGoogleAccount(target.account);
					const proc = Bun.spawn(target.account ? ["gws-as", target.account, "auth", "login"] : ["gws", "auth", "login"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
					void proc.exited.then(async (code) => {
						if (code === 0) return;
						await locked(objectId, async () => {
							if (executions.get(objectId) !== execution) return;
							const current = await canonical(objectId, messageId);
							const error = "Google login exited without completing. Check the local gws setup and start a new request.";
							await complete(current.object, current.entry, { status: "needs_auth", error }, error);
						});
					}).catch(() => {});
				} else startBrowserLogin(target.key);
				await publish(await fetchObject(objectId), { status: "processing", error: WAITING_LOGIN });
				execution.starting = false;
				return { pending: true };
			} else if (operation === "auth.check") {
				const ready = await authenticationReady(target);
				const error = ready ? "" : "Authentication is not ready on this machine.";
				const credential = credentialStatus().find((row) => row.key === target.key);
				const auth = !ready ? "none" : target.key === "google" ? "oauth" : credential ? credential.active.browser ? "browser_profile" : "api_key" : "none";
				await complete(object, entry, { status: ready ? "active" : "needs_auth", auth, error }, error);
			} else {
				if (operation === "skill.install" || operation === "skill.enable") await enableSkill(target.key);
				else if (operation === "skill.disable") await disableSkill(target.key);
				else if (operation === "skill.uninstall") await uninstallSkill(target.key);
				const outcome = await skillOutcome(target.key, operation);
				execution.starting = false;
				if (!outcome) return { pending: true };
				await complete(object, entry, { ...outcome.state, error: outcome.error }, outcome.error);
			}
			return { pending: false };
		} catch {
			secrets = undefined;
			if (execution.outcome) throw new Error("The operation finished locally; its durable result is awaiting publication.");
			const error = "The approved local operation failed. Check the installation on this machine before retrying.";
			await complete(await fetchObject(objectId), entry, { status: "broken", error }, error);
			return { pending: false };
		}
	}));
}

async function authenticationReady(target: Target, browserOnly = false): Promise<boolean> {
	if (target.key === "google" && target.account) {
		const status = await googleAccountStatus(target.account);
		return !status.error && !!status.authMethod && status.authMethod !== "none" && status.credentialsExists;
	}
	if (CATALOG.some((entry) => entry.key === target.key)) return await recheckSkill(target.key) === "on";
	if (browserOnly) return finishBrowserLogin(target.key);
	const status = credentialStatus().find((entry) => entry.key === target.key);
	return !!status && (status.active.password || status.active.browser);
}

export async function finishCapabilityLogin(objectId: string, messageId: string): Promise<{ active: boolean }> {
	return locked(objectId, async () => {
		const { object, entry, target } = await canonical(objectId, messageId);
		const execution = executions.get(objectId);
		if (entry.message.operation !== "auth.login" || entry.processing.status !== "processing" || entry.processing.owner !== requestOwner || execution?.messageId !== messageId || execution.key !== target.key || execution.account !== target.account) throw new Error("This login is not pending in this harness process.");
		if (!(await authenticationReady(target, true))) {
			await publish(object, { status: "processing", error: WAITING_LOGIN });
			return { active: false };
		}
		await republishCapabilities();
		await complete(object, entry, { status: "active", auth: target.key === "google" ? "oauth" : "browser_profile" });
		return { active: true };
	});
}

export async function rejectCapabilityRequest(objectId: string, messageId: string): Promise<void> {
	await locked(objectId, async () => {
		const object = await fetchObject(objectId);
		if (object.deleted) throw new Error("This installation has been deleted.");
		if (object.typeKey !== INSTALL_TYPE || str(object.fields, "machine_id") !== await machineId()) throw new Error("This installation belongs to another machine.");
		let entry = incoming(object, messageId)[0];
		if (!entry || !["pending", "awaiting_approval"].includes(entry.processing.status)) throw new Error("This request is not awaiting approval.");
		if (!(await claimMessage(objectId, messageId, requestOwner))) throw new Error("This request has already been claimed.");
		entry = incoming(await fetchObject(objectId), messageId)[0]!;
		const error = "Request rejected by the human on the owning machine.";
		await complete(object, entry, { status: "broken", error }, error);
	});
}

/** Commit an intent to the requester's own object before attempting delivery. */
export async function requestCapability(input: { sender: AgentEndpoint; installationObjectId: string; operation: CapabilityOperation; author?: string; text?: string }): Promise<{ id: string; exchangeId: string; threadId: string }> {
	const target = await fetchObject(input.installationObjectId);
	capabilityTarget(target, input.operation, str(target.fields, "machine_id"));
	if (!str(target.fields, "machine_id")) throw new Error("Installation has no owning machine.");
	// Include the sender outbox: its request may not have reached the owner yet.
	const source = await fetchObject(input.sender.objectId);
	const previous = [...(target.mailbox ?? []), ...(source.mailbox ?? [])].find((entry) => !entry.message.historical && entry.message.operation === input.operation && entry.message.sender.objectId === input.sender.objectId && entry.message.sender.agentId === input.sender.agentId && entry.message.recipients.some((endpoint) => endpoint.objectId === target.id) && ["pending", "awaiting_approval", "processing"].includes(entry.processing.status) && !target.mailbox?.some((received) => received.message.id === entry.message.id && ["processed", "failed"].includes(received.processing.status)));
	if (previous) return { id: previous.message.id, exchangeId: previous.message.exchangeId, threadId: previous.threadId };
	const message: AgentMessage = { id: crypto.randomUUID(), exchangeId: crypto.randomUUID(), sender: input.sender, recipients: [{ objectId: target.id, agentId: "" }], text: input.text || `Request ${input.operation} for ${str(target.fields, "key")}.`, replyTo: "", sentAt: Date.now(), title: "Capability request", requestReply: true, historical: false, operation: input.operation, author: input.author ?? input.sender.agentId };
	const sent = await sendMessage(message);
	await deliverOutbox(await fetchObject(input.sender.objectId));
	return sent;
}
