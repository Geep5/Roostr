import { isDeepStrictEqual } from "node:util";
import { fetchObject, mutate, queryAll, str, type AgentEndpoint, type AgentMessage, type BlockJSON, type ObjectJSON, type QueryRow } from "./api";
import { sendMessage } from "./mailbox";

interface LegacyConversation {
	id: string;
	kind: string;
	title: string;
	participants: string[];
}

type DescribedObject = ObjectJSON & { conversations?: LegacyConversation[] };

export interface ExchangeMigrationIssue {
	objectId: string;
	threadId: string;
	messageId?: string;
	reason: string;
}

export interface ExchangeMigrationStats {
	apply: boolean;
	scannedObjects: number;
	exchanges: number;
	messages: number;
	copiedMessages: number;
	retiredMessages: number;
	retiredRoots: number;
	privateRoots: number;
	privateBlocks: number;
	copiedPrivateBlocks: number;
	retiredPrivateRoots: number;
	blocked: ExchangeMigrationIssue[];
	errors: ExchangeMigrationIssue[];
}

interface ImportMessage {
	message: AgentMessage;
	legacy?: BlockJSON;
}

const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const sameMeta = (a: Record<string, string> = {}, b: Record<string, string> = {}): boolean =>
	Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => a[key] === b[key]);

function sameMessage(a: AgentMessage, b: AgentMessage): boolean {
	return a.id === b.id && a.exchangeId === b.exchangeId && a.sender.objectId === b.sender.objectId &&
		a.sender.agentId === b.sender.agentId && a.recipients.length === b.recipients.length &&
		a.recipients.every((endpoint, index) => endpoint.objectId === b.recipients[index].objectId && endpoint.agentId === b.recipients[index].agentId) &&
		a.text === b.text && a.replyTo === b.replyTo && a.sentAt === b.sentAt && a.title === b.title &&
		a.requestReply === b.requestReply && a.historical === b.historical && a.operation === b.operation &&
		a.author === b.author && (a.unknown ?? "") === (b.unknown ?? "");
}

function checkedCopy(object: ObjectJSON, message: AgentMessage): BlockJSON {
	const threadId = `__thread__${message.exchangeId}`;
	const entry = object.mailbox?.find((candidate) => candidate.message.id === message.id);
	const block = object.blocks.find((candidate) => candidate.id === message.id);
	const root = object.blocks.find((candidate) => candidate.id === threadId);
	if (!entry || !sameMessage(entry.message, message) || !root?.childrenIds.includes(message.id) ||
		block?.content.custom?.contentType !== "agent_message" || !block.content.custom.data) {
		throw new Error(`Historical copy ${message.id} not verified on ${object.id}; source retained`);
	}
	return block;
}

/** Reactions and other legacy chat metadata stay outside the immutable envelope. */
async function preserveMeta(objectId: string, item: ImportMessage): Promise<void> {
	if (!item.legacy?.content.custom?.meta) return;
	const object = await fetchObject(objectId);
	const block = checkedCopy(object, item.message);
	const custom = block.content.custom!;
	const meta = { ...custom.meta, ...item.legacy.content.custom.meta };
	if (sameMeta(custom.meta, meta)) return;
	await mutate("block_update", {
		object_id: objectId,
		block_id: block.id,
		content: { ...block.content, custom: { ...custom, meta } },
	});
}

async function verifyCopies(item: ImportMessage): Promise<void> {
	const message = item.message;
	const sender = checkedCopy(await fetchObject(message.sender.objectId), message);
	const originalMeta = item.legacy?.content.custom?.meta ?? {};
	for (const objectId of new Set([message.sender.objectId, ...message.recipients.map((recipient) => recipient.objectId)])) {
		const block = checkedCopy(await fetchObject(objectId), message);
		if (block.content.custom!.data !== sender.content.custom!.data ||
			Object.keys(originalMeta).some((key) => block.content.custom!.meta?.[key] !== originalMeta[key])) {
			throw new Error(`Historical payload or metadata ${message.id} differs on ${objectId}; source retained`);
		}
	}
}

async function endpointFor(agent: QueryRow): Promise<AgentEndpoint> {
	const objectId = str(agent.fields, "bound_object") || str(agent.fields, "space_default") || agent.id;
	const object = await fetchObject(objectId);
	if (object.deleted) throw new Error(`Participant ${agent.id} owns deleted object ${objectId}`);
	return { objectId, agentId: agent.id };
}

async function importPlan(object: DescribedObject, conversation: LegacyConversation, agents: Map<string, QueryRow>): Promise<ImportMessage[]> {
	const root = object.blocks.find((block) => block.id === conversation.id);
	if (!root) throw new Error("Conversation root is missing");
	const byId = new Map(object.blocks.map((block) => [block.id, block]));
	const children = root.childrenIds.map((id) => {
		const block = byId.get(id);
		if (!block) throw new Error(`Missing legacy child ${id}; root retained`);
		return block;
	});
	const legacy = children.filter((block) => block.content.custom?.contentType === "chat");
	const exchangeId = conversation.id.startsWith("__thread__") ? conversation.id.slice("__thread__".length) : conversation.id;
	if (!exchangeId) throw new Error("Empty exchange identity");
	const existing = (object.mailbox ?? []).filter((entry) => entry.threadId === conversation.id && entry.message.historical);
	const plan: ImportMessage[] = existing.map((entry) => ({ message: entry.message }));
	if (legacy.length === 0) return plan;
	if (conversation.participants.length === 0) throw new Error("Legacy exchange has no resolvable participants");
	const participants: AgentEndpoint[] = [];
	for (const participantId of conversation.participants) {
		const agent = agents.get(participantId);
		if (!agent) throw new Error(`Unresolved participant ${participantId}; legacy exchange retained`);
		const endpoint = await endpointFor(agent);
		if (!participants.some((candidate) => candidate.objectId === endpoint.objectId)) participants.push(endpoint);
	}
	for (const block of legacy) {
		const meta = block.content.custom!.meta ?? {};
		if (!meta.author || !meta.text || !meta.ts || !Number.isSafeInteger(Number(meta.ts)) || Number(meta.ts) < 0) {
			throw new Error(`Legacy message ${block.id} lacks valid author, text or timestamp; source retained`);
		}
		if (block.childrenIds.length > 0) throw new Error(`Legacy message ${block.id} has unrecognized descendants; source retained`);
		const author = agents.get(meta.author);
		const sender = author ? await endpointFor(author) : { objectId: object.id, agentId: "" };
		const recipients = participants.filter((endpoint) => !sender.agentId || endpoint.objectId !== sender.objectId);
		if (recipients.length === 0) throw new Error(`Legacy message ${block.id} has no distinct recipient; source retained`);
		plan.push({
			legacy: block,
			message: {
				id: block.id,
				exchangeId,
				sender,
				recipients,
				text: meta.text,
				replyTo: meta.replyTo ?? "",
				sentAt: Number(meta.ts),
				title: conversation.title,
				requestReply: false,
				historical: true,
				operation: "",
				author: meta.author,
			},
		});
	}
	return plan;
}

async function applyPlan(objectId: string, threadId: string, plan: ImportMessage[], stats: ExchangeMigrationStats): Promise<void> {
	for (const item of plan) {
		await sendMessage(item.message);
		await preserveMeta(item.message.sender.objectId, item);
		for (const recipient of item.message.recipients) {
			await mutate("message_deliver", {
				sender_object_id: item.message.sender.objectId,
				message_id: item.message.id,
				recipient_object_id: recipient.objectId,
			});
			await preserveMeta(recipient.objectId, item);
		}
		await verifyCopies(item);
		stats.copiedMessages++;
	}
	// Verify the whole exchange again before retiring even its first source
	// block. A partially completed import is safe to repeat after restart.
	for (const item of plan) await verifyCopies(item);
	for (const item of plan) {
		if (!item.legacy) continue;
		const current = await fetchObject(objectId);
		const block = current.blocks.find((candidate) => candidate.id === item.message.id);
		if (!block) continue; // another safe migration already retired it
		if (block.content.custom?.contentType === "agent_message") {
			checkedCopy(current, item.message); // in-place migration: this IS a destination copy
			continue;
		}
		const original = item.legacy.content.custom!;
		if (block.content.custom?.contentType !== "chat" || block.childrenIds.length > 0 ||
			!current.blocks.find((candidate) => candidate.id === threadId)?.childrenIds.includes(block.id) ||
			block.content.custom.data !== original.data || !sameMeta(block.content.custom.meta, original.meta)) {
			throw new Error(`Legacy message ${block.id} changed during migration; source retained`);
		}
		await mutate("block_remove", { object_id: objectId, block_id: block.id });
		stats.retiredMessages++;
	}
	const after = await fetchObject(objectId);
	const root = after.blocks.find((block) => block.id === threadId);
	// A shared root may now hold the object's own imported messages, or
	// unknown/tool blocks. Neither belongs to this migration's delete set.
	if (root && root.childrenIds.length === 0) {
		await mutate("block_remove", { object_id: objectId, block_id: threadId });
		stats.retiredRoots++;
	}
}

interface PrivateBlock {
	block: BlockJSON;
	parentId: string;
}

function privateSubtree(object: ObjectJSON, rootId: string): PrivateBlock[] {
	const byId = new Map(object.blocks.map((block) => [block.id, block]));
	const seen = new Set<string>();
	const blocks: PrivateBlock[] = [];
	const visit = (id: string, parentId: string): void => {
		if (seen.has(id)) throw new Error(`Private transcript has repeated child ${id}; source retained`);
		const block = byId.get(id);
		if (!block) throw new Error(`Private transcript is missing child ${id}; source retained`);
		seen.add(id);
		blocks.push({ block, parentId });
		for (const childId of block.childrenIds) visit(childId, id);
	};
	visit(rootId, "");
	for (const block of object.blocks) {
		if (!seen.has(block.id) && block.childrenIds.some((id) => id !== rootId && seen.has(id))) {
			throw new Error(`Private transcript shares descendants with ${block.id}; source retained`);
		}
	}
	return blocks;
}

function checkPrivateTarget(target: ObjectJSON, blocks: PrivateBlock[], complete: boolean): void {
	const byId = new Map(target.blocks.map((block) => [block.id, block]));
	const parents = new Map<string, string[]>();
	for (const block of target.blocks) for (const child of block.childrenIds) {
		const owners = parents.get(child) ?? [];
		owners.push(block.id);
		parents.set(child, owners);
	}
	for (const { block, parentId } of blocks) {
		const existing = byId.get(block.id);
		if (!existing) {
			if (complete) throw new Error(`Private copy ${block.id} missing on ${target.id}; source retained`);
			continue;
		}
		// A restart can find a copied root with only a prefix of its children.
		// Never merge into an unrelated block or overwrite destination edits.
		const contentMatches = isDeepStrictEqual({ ...existing, childrenIds: [] }, { ...block, childrenIds: [] });
		const childrenMatch = complete ? isDeepStrictEqual(existing.childrenIds, block.childrenIds) :
			existing.childrenIds.length <= block.childrenIds.length && existing.childrenIds.every((id, index) => id === block.childrenIds[index]);
		const actualParents = parents.get(block.id) ?? [];
		const parentMatches = parentId ? actualParents.length === 1 && actualParents[0] === parentId : actualParents.length === 0;
		if (!contentMatches || !childrenMatch || !parentMatches) {
			throw new Error(`Private transcript collision ${block.id} on ${target.id}; source retained`);
		}
	}
}

async function migrateSpacePrivate(object: DescribedObject, stats: ExchangeMigrationStats): Promise<void> {
	const spaceId = str(object.fields, "space_default");
	if (object.typeKey !== "agent" || !spaceId || spaceId === object.id) return;
	for (const conversation of object.conversations ?? []) {
		if (conversation.kind !== "agent_private") continue;
		if (conversation.participants.length > 0 && !conversation.participants.includes(object.id)) continue;
		stats.privateRoots++;
		let blocks: PrivateBlock[];
		let destination: ObjectJSON;
		try {
			const bound = str(object.fields, "bound_object");
			if (bound && bound !== spaceId) throw new Error("Space-default agent is bound elsewhere; private transcript retained");
			blocks = privateSubtree(object, conversation.id);
			destination = await fetchObject(spaceId);
			if (destination.deleted || destination.typeKey !== "channel") throw new Error(`Owning space ${spaceId} is unavailable; private transcript retained`);
			checkPrivateTarget(destination, blocks, false);
		} catch (error) {
			stats.blocked.push({ objectId: object.id, threadId: conversation.id, reason: reasonOf(error) });
			continue;
		}
		stats.privateBlocks += blocks.length;
		if (!stats.apply) continue;
		try {
			const present = new Set(destination.blocks.map((block) => block.id));
			for (const { block, parentId } of blocks) {
				if (present.has(block.id)) continue;
				await mutate("block_add", {
					object_id: spaceId,
					// Add parents before children without dangling child refs.
					// Each add restores the original ordered parent relationship.
					block: { ...block, childrenIds: [] },
					target_id: parentId,
					position: parentId ? 5 : 0,
				});
				stats.copiedPrivateBlocks++;
			}
			checkPrivateTarget(await fetchObject(spaceId), blocks, true);
			const source = await fetchObject(object.id);
			if (!source.blocks.some((block) => block.id === conversation.id)) continue;
			if (!isDeepStrictEqual(privateSubtree(source, conversation.id), blocks)) {
				throw new Error("Private transcript changed during migration; source retained");
			}
			// Block_Remove removes the subtree. Its complete byte-for-byte
			// destination was verified above; no other source roots are touched.
			await mutate("block_remove", { object_id: object.id, block_id: conversation.id });
			stats.retiredPrivateRoots++;
		} catch (error) {
			stats.errors.push({ objectId: object.id, threadId: conversation.id, reason: reasonOf(error) });
		}
	}
}

/** Boot-safe, idempotent, and read-only unless apply is explicitly true. */
export async function migrateExchanges({ apply }: { apply: boolean }): Promise<ExchangeMigrationStats> {
	const stats: ExchangeMigrationStats = {
		apply, scannedObjects: 0, exchanges: 0, messages: 0, copiedMessages: 0,
		retiredMessages: 0, retiredRoots: 0, blocked: [], errors: [],
		privateRoots: 0, privateBlocks: 0, copiedPrivateBlocks: 0, retiredPrivateRoots: 0,
	};
	const rows = await queryAll({});
	const agents = new Map(rows.filter((row) => row.typeKey === "agent").map((row) => [row.id, row]));
	for (const row of rows) {
		let object: DescribedObject;
		try {
			object = await fetchObject(row.id) as DescribedObject;
		} catch (error) {
			stats.errors.push({ objectId: row.id, threadId: "", reason: reasonOf(error) });
			continue;
		}
		if (object.deleted) continue;
		stats.scannedObjects++;
		await migrateSpacePrivate(object, stats);
		for (const conversation of object.conversations ?? []) {
			if (conversation.kind !== "a2a") continue;
			const root = object.blocks.find((block) => block.id === conversation.id);
			if (!root) continue;
			const children = new Set(root.childrenIds);
			const hasLegacy = object.blocks.some((block) => children.has(block.id) && block.content.custom?.contentType === "chat");
			const stranded = object.mailbox?.some((entry) => entry.threadId === conversation.id && entry.outgoing &&
				entry.message.historical && entry.message.recipients.some((recipient) =>
					!entry.deliveries.some((delivery) => delivery.recipient.objectId === recipient.objectId && delivery.status === "delivered")));
			if (!hasLegacy && !stranded) continue;
			stats.exchanges++;
			let plan: ImportMessage[];
			try {
				plan = await importPlan(object, conversation, agents);
			} catch (error) {
				stats.blocked.push({ objectId: object.id, threadId: conversation.id, reason: reasonOf(error) });
				continue;
			}
			stats.messages += plan.length;
			if (!apply) continue;
			try {
				await applyPlan(object.id, conversation.id, plan, stats);
			} catch (error) {
				stats.errors.push({ objectId: object.id, threadId: conversation.id, reason: reasonOf(error) });
			}
		}
	}
	return stats;
}

if (import.meta.main) {
	const unsupported = process.argv.slice(2).filter((argument) => argument !== "--apply" && argument !== "--dry-run");
	if (unsupported.length > 0 || (process.argv.includes("--apply") && process.argv.includes("--dry-run"))) {
		console.error("Usage: bun run src/migrate-exchanges.ts [--apply | --dry-run]");
		process.exitCode = 1;
	} else {
		try {
			const stats = await migrateExchanges({ apply: process.argv.includes("--apply") });
			console.log(JSON.stringify(stats, null, 2));
			if (stats.blocked.length > 0 || stats.errors.length > 0) process.exitCode = 1;
		} catch (error) {
			console.error(reasonOf(error));
			process.exitCode = 1;
		}
	}
}
