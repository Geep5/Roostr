/** Client API helpers: reads via GET, mutations via POST {API}/api/mutate. */

import type { ObjectJSON, ObjectSummary, SpaceJSON, RelationDefJSON, BlockJSON, ValueJSON } from "$lib/types";

export const API = import.meta.env.VITE_GLON_API ?? "http://127.0.0.1:7333";

async function getJSON<T>(path: string): Promise<T> {
	const res = await fetch(`${API}${path}`);
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return res.json();
}

export const fetchObject = (id: string) => getJSON<ObjectJSON>(`/api/objects/${id}`);
export const fetchObjects = () => getJSON<ObjectSummary[]>("/api/objects");
export const fetchChannels = () => getJSON<SpaceJSON[]>("/api/channels");
export const fetchRelations = () => getJSON<RelationDefJSON[]>("/api/relations");

export interface QueryResultRow {
	id: string;
	typeKey: string;
	name?: string;
	snippet?: string;
	createdAt: number;
	updatedAt: number;
	fields: Record<string, ValueJSON>;
}

export async function fetchQuery(body: Record<string, unknown>): Promise<{ total: number; records: QueryResultRow[] }> {
	const res = await fetch(`${API}/api/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`query: ${res.status}`);
	return res.json();
}

/**
 * Every match, a page at a time.
 *
 * `total` is the unpaged match count, so a full first page is the only
 * thing that costs a second round trip — and a vault that outgrows any
 * single limit stops silently dropping the tail. Use this wherever a
 * partial answer would be wrong (definitions, rosters); a capped
 * `fetchQuery` is right only when the cap IS the intent, like a
 * top-20 search.
 */
export async function fetchAllQuery(body: Record<string, unknown>, page = 500): Promise<QueryResultRow[]> {
	const first = await fetchQuery({ ...body, offset: 0, limit: page });
	if (first.records.length >= first.total) return first.records;
	const out = first.records.slice();
	while (out.length < first.total) {
		const next = await fetchQuery({ ...body, offset: out.length, limit: page });
		if (next.records.length === 0) break; // concurrent delete shrank the set
		out.push(...next.records);
	}
	return out;
}

async function mutate(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await fetch(`${API}/api/mutate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...params }),
	});
	if (!res.ok) throw new Error(`mutate ${action}: ${res.status}`);
	const out = await res.json();
	if (!out.ok) throw new Error(out.error ?? `mutate ${action} failed`);
	return out;
}

export const note = {
	create: (name: string, typeKey?: string, fields?: Record<string, ValueJSON>) =>
		mutate("create", { name, type_key: typeKey, fields }) as Promise<{ id: string }>,
	blockAdd: (objectId: string, block: Partial<BlockJSON>, targetId = "", position = 0) =>
		mutate("block_add", { object_id: objectId, block, target_id: targetId, position }),
	blockUpdate: (objectId: string, blockId: string, content: BlockJSON["content"]) =>
		mutate("block_update", { object_id: objectId, block_id: blockId, content }),
	blockMove: (objectId: string, blockId: string, targetId: string, position: number) =>
		mutate("block_move", { object_id: objectId, block_id: blockId, target_id: targetId, position }),
	blockSetAttrs: (objectId: string, blockId: string, attrs: { align?: number; background_color?: string }) =>
		mutate("block_set_attrs", { object_id: objectId, block_id: blockId, ...attrs }),
	blockRemove: (objectId: string, blockId: string) =>
		mutate("block_remove", { object_id: objectId, block_id: blockId }),
	setField: (objectId: string, key: string, value: ValueJSON) =>
		mutate("set_field", { object_id: objectId, key, value }),
	deleteField: (objectId: string, key: string) =>
		mutate("delete_field", { object_id: objectId, key }),
	del: (objectId: string) => mutate("delete", { object_id: objectId }),
	/** Retype in place: history, blocks, and fields survive. */
	setType: (objectId: string, typeKey: string) => mutate("set_type", { object_id: objectId, type_key: typeKey }),
	vanish: (objectIds: string | string[]) =>
		mutate("vanish", Array.isArray(objectIds) ? { object_ids: objectIds } : { object_id: objectIds }),
};

export const table = {
	create: (objectId: string, targetId = "", position = 0, rows = 3, cols = 3) =>
		mutate("table_create", { object_id: objectId, target_id: targetId, position, rows, cols }) as Promise<{ id: string }>,
	rowAdd: (objectId: string, tableId: string) =>
		mutate("table_row_add", { object_id: objectId, table_id: tableId }),
	colAdd: (objectId: string, tableId: string) =>
		mutate("table_col_add", { object_id: objectId, table_id: tableId }),
	colRemove: (objectId: string, tableId: string, columnId: string) =>
		mutate("table_col_remove", { object_id: objectId, table_id: tableId, column_id: columnId }),
};

export const space = {
	create: (name: string, icon?: string) =>
		mutate("channel_create", { name, icon }) as Promise<{ id: string; key_id: number }>,
	memberAdd: (channelId: string, npub: string, role?: string) =>
		mutate("channel_member_add", { channel_id: channelId, npub, role }),
	memberRemove: (channelId: string, npub: string) =>
		mutate("channel_member_remove", { channel_id: channelId, npub }),
	keyRotate: (channelId: string) => mutate("channel_key_rotate", { channel_id: channelId }),
};

export interface NostrSettings {
	hasKey: boolean;
	relays: string[];
	authorId: string;
}

export const settings = {
	fetch: async (): Promise<NostrSettings> => {
		const res = await fetch(`${API}/api/settings`);
		if (!res.ok) throw new Error(`settings: ${res.status}`);
		return res.json();
	},
	importKey: (key: string) => mutate("nostr_key_import", { key }),
	exportKey: () => mutate("nostr_key_export", {}) as Promise<{ nsec: string; hex: string }>,
	logout: () => mutate("identity_logout", {}) as Promise<{ archived: string }>,
	setRelays: (relays: string[]) => mutate("nostr_relays_set", { relays }) as Promise<{ relays: string[] }>,
};

export const chat = {
	post: (objectId: string, text: string, replyTo = "") =>
		mutate("chat_post", { object_id: objectId, text, reply_to: replyTo }) as Promise<{ id: string }>,
	react: (objectId: string, messageId: string, emoji: string) =>
		mutate("chat_react", { object_id: objectId, message_id: messageId, emoji }),
};
