/**
 * HTTP client for the Roostr Odin server. The harness is a pure client of
 * the DAG: every read is /api/objects | /api/query, every write is
 * /api/mutate, and wakeups arrive over /api/events SSE. Nothing here holds
 * state that the DAG doesn't.
 */

import { API, apiFetch } from "./local-api-auth";
export { API, apiFetch } from "./local-api-auth";

export interface ValueJSON {
	stringValue?: string;
	intValue?: number;
	floatValue?: number;
	boolValue?: boolean;
	valuesValue?: { items: ValueJSON[] };
	listValue?: { values: string[] };
	linkValue?: { targetId: string; relationKey?: string };
	mapValue?: { entries: Record<string, ValueJSON> };
}

export interface BlockJSON {
	id: string;
	childrenIds: string[];
	content: {
		text?: { text: string; style: number; checked?: boolean };
		/** `data` is base64 protobuf: a Conversation on a thread root, a
		 *  Descriptor on a card. The core decodes it and serves the result
		 *  alongside, so nothing here parses it. */
		custom?: { contentType: string; data?: string; meta?: Record<string, string> };
		layout?: { style: number };
	};
}

export interface AgentEndpoint {
	objectId: string;
	agentId: string;
}

export interface AgentMessage {
	id: string;
	exchangeId: string;
	sender: AgentEndpoint;
	recipients: AgentEndpoint[];
	text: string;
	replyTo: string;
	sentAt: number;
	title: string;
	requestReply: boolean;
	historical: boolean;
	operation: string;
	author: string;
	unknown?: string;
}

export interface MessageDelivery {
	recipient: AgentEndpoint;
	status: "pending" | "delivered" | "failed";
	error: string;
	at: number;
}

export interface MessageProcessing {
	status: "pending" | "awaiting_approval" | "processing" | "processed" | "failed";
	owner: string;
	error: string;
	at: number;
}

export interface MailboxEntry {
	message: AgentMessage;
	threadId: string;
	incoming: boolean;
	outgoing: boolean;
	deliveries: MessageDelivery[];
	processing: MessageProcessing;
}

export interface ObjectJSON {
	id: string;
	typeKey: string;
	fields: Record<string, ValueJSON>;
	blocks: BlockJSON[];
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
	mailbox?: MailboxEntry[];
}

export interface QueryRow {
	id: string;
	typeKey: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	fields: Record<string, ValueJSON>;
}

export async function fetchObject(id: string): Promise<ObjectJSON> {
	const res = await apiFetch(`${API}/api/objects/${id}`);
	if (!res.ok) throw new Error(`objects/${id}: ${res.status}`);
	return res.json() as Promise<ObjectJSON>;
}

export async function query(body: Record<string, unknown>): Promise<QueryRow[]> {
	const res = await apiFetch(`${API}/api/query`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`query: ${res.status}`);
	const out = (await res.json()) as { records: QueryRow[] };
	return out.records;
}

/** Which machine serves an object; `core/serving.odin` is the rule, `docs/object-serving.md` the spec. */
export interface Serving {
	/** "" when the space has no default and no machine qualifies. */
	machineId: string;
	reason: "self" | "pinned" | "pinned-uncapable" | "space" | "space-capable" | "capability" | "unsatisfied";
	/** The object's `requires`, verbatim: capability object ids where links were written, legacy catalog keys where strings remain. */
	requires: string[];
	/** Machine ids serving every required capability (capability object + active install), sorted. */
	candidates: string[];
}

/** Resolve serving for many objects in one round trip; unknown ids resolve to the space default. */
export async function servingFor(objectIds: string[]): Promise<Record<string, Serving>> {
	if (objectIds.length === 0) return {};
	const res = await apiFetch(`${API}/api/serving`, { method: "POST", body: JSON.stringify({ objectIds }) });
	if (!res.ok) throw new Error(`serving: ${res.status}`);
	return res.json() as Promise<Record<string, Serving>>;
}

/**
 * Every match, a page at a time. `total` is the unpaged count, so a
 * complete read costs one request unless the set really is larger than
 * a page. Use it wherever a partial answer is a bug — skill catalogs,
 * agent rosters — rather than guessing a cap a growing vault will
 * quietly outrun. Agent-facing tools keep their small explicit limits:
 * there the cap is the point.
 */
export async function queryAll(body: Record<string, unknown>, page = 500): Promise<QueryRow[]> {
	const fetchPage = async (offset: number): Promise<{ total: number; records: QueryRow[] }> => {
		const res = await apiFetch(`${API}/api/query`, {
			method: "POST",
			body: JSON.stringify({ ...body, offset, limit: page }),
		});
		if (!res.ok) throw new Error(`query: ${res.status}`);
		return (await res.json()) as { total: number; records: QueryRow[] };
	};
	const first = await fetchPage(0);
	if (first.records.length >= first.total) return first.records;
	const out = first.records.slice();
	while (out.length < first.total) {
		const next = await fetchPage(out.length);
		if (next.records.length === 0) break; // concurrent delete shrank the set
		out.push(...next.records);
	}
	return out;
}

/**
 * One mutation. A refusal is a 400 with `{ok: false, error}`; the error
 * text is the contract (`"occurrence already fired"`, `"object does not
 * repeat"`, …), so it is what the thrown Error carries - not the status.
 */
export async function mutate(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await apiFetch(`${API}/api/mutate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...params }),
	});
	const out = (await res.json().catch(() => null)) as (Record<string, unknown> & { ok?: boolean; error?: string }) | null;
	if (!res.ok) throw new Error(out?.error || `mutate ${action}: ${res.status}`);
	if (!out?.ok) throw new Error(out?.error || `mutate ${action} failed`);
	return out;
}

// ── Field helpers ────────────────────────────────────────────────

export const str = (fields: Record<string, ValueJSON>, key: string): string =>
	fields[key]?.stringValue ?? "";

export const num = (fields: Record<string, ValueJSON>, key: string): number | undefined => {
	const v = fields[key];
	return v?.intValue ?? v?.floatValue;
};

export const flag = (fields: Record<string, ValueJSON>, key: string): boolean =>
	fields[key]?.boolValue === true;

export const list = (fields: Record<string, ValueJSON>, key: string): string[] =>
	(fields[key]?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean);

/**
 * The object's guest list: agent ids its `agent` property names. Reads the
 * link list, and the single string the field held before it became one.
 */
export const guestAgents = (fields: Record<string, ValueJSON>): string[] => {
	const v = fields["agent"];
	if (!v) return [];
	if (v.stringValue) return [v.stringValue];
	if (v.linkValue?.targetId) return [v.linkValue.targetId];
	return (v.valuesValue?.items ?? []).flatMap((i) => (i.stringValue ? [i.stringValue] : i.linkValue?.targetId ? [i.linkValue.targetId] : []));
};

export const sv = (s: string): ValueJSON => ({ stringValue: s });
export const iv = (n: number): ValueJSON => ({ intValue: Math.round(n) });
export const fv = (n: number): ValueJSON => ({ floatValue: n });
export const bv = (b: boolean): ValueJSON => ({ boolValue: b });
export const lv = (items: string[]): ValueJSON => ({ valuesValue: { items: items.map(sv) } });

export const setField = (id: string, key: string, value: ValueJSON) =>
	mutate("set_field", { object_id: id, key, value });

export const deleteField = (id: string, key: string) => mutate("delete_field", { object_id: id, key });

export const createObject = async (name: string, typeKey: string, fields?: Record<string, ValueJSON>) =>
	(await mutate("create", { name, type_key: typeKey, fields })) as { id: string };

/**
 * Append a chat message block; `asAuthor` attributes it to the agent.
 *
 * `threadId` empty = the object's human discussion, which is what every
 * human-facing caller wants; an agent's own transcript and an A2A exchange
 * pass the thread they live in (`$lib/conv`).
 */
export const chatPost = async (objectId: string, text: string, asAuthor = "", replyTo = "", threadId = "") =>
	(await mutate("chat_post", { object_id: objectId, text, as_author: asAuthor, reply_to: replyTo, thread_id: threadId })) as {
		id: string;
		threadId: string;
	};

/** Append an arbitrary block (used for tool_use / tool_result / compaction). */
export const addBlock = (objectId: string, block: Partial<BlockJSON>, targetId = "", position = 0) =>
	mutate("block_add", { object_id: objectId, block, target_id: targetId, position });

/** Subscribe to commits; onConnected also runs after every reconnection. */
export function subscribe(onObject: (objectId: string) => void, onConnected?: () => void): void {
	void (async () => {
		for (;;) {
			try {
				const res = await apiFetch(`${API}/api/events`);
				if (!res.ok) throw new Error(`events: ${res.status}`);
				const reader = res.body?.getReader();
				if (!reader) throw new Error("no SSE body");
				onConnected?.();
				const decoder = new TextDecoder();
				let buf = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let idx: number;
					while ((idx = buf.indexOf("\n\n")) >= 0) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const m = frame.match(/^data: (.+)$/m);
						if (!m) continue;
						try {
							const parsed = JSON.parse(m[1]) as { objectId?: string };
							if (parsed.objectId) onObject(parsed.objectId);
						} catch {
							/* hello frame etc. */
						}
					}
				}
			} catch {
				/* server restart — retry */
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 1000);
			await promise;
		}
	})();
}
