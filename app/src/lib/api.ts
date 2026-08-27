/** Client API helpers: reads via GET, mutations via POST {API}/api/mutate. */

import type { ObjectJSON, ObjectSummary, ChannelJSON, RelationDefJSON, BlockJSON, ValueJSON } from "$lib/types";

export const API = import.meta.env.VITE_GLON_API ?? "http://127.0.0.1:7333";

async function getJSON<T>(path: string): Promise<T> {
	const res = await fetch(`${API}${path}`);
	if (!res.ok) throw new Error(`${path}: ${res.status}`);
	return res.json();
}

export const fetchObject = (id: string) => getJSON<ObjectJSON>(`/api/objects/${id}`);
export const fetchObjects = () => getJSON<ObjectSummary[]>("/api/objects");
export const fetchChannels = () => getJSON<ChannelJSON[]>("/api/channels");
export const fetchRelations = () => getJSON<RelationDefJSON[]>("/api/relations");

export interface QueryResultRow {
	id: string;
	typeKey: string;
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
	del: (objectId: string) => mutate("delete", { object_id: objectId }),
};

export const channel = {
	create: (name: string, icon?: string) =>
		mutate("channel_create", { name, icon }) as Promise<{ id: string; key_id: number }>,
	memberAdd: (channelId: string, npub: string, role?: string) =>
		mutate("channel_member_add", { channel_id: channelId, npub, role }),
	memberRemove: (channelId: string, npub: string) =>
		mutate("channel_member_remove", { channel_id: channelId, npub }),
	invitePayload: async (channelId: string, npub: string) => {
		const out = await mutate("channel_invite_payload", { channel_id: channelId, npub });
		return out.payload as Record<string, unknown>;
	},
	keyRotate: (channelId: string) => mutate("channel_key_rotate", { channel_id: channelId }),
};

export interface NostrSettings {
	hasKey: boolean;
	relays: string[];
}

export const settings = {
	fetch: async (): Promise<NostrSettings> => {
		const res = await fetch(`${API}/api/settings`);
		if (!res.ok) throw new Error(`settings: ${res.status}`);
		return res.json();
	},
	exportKey: () => mutate("nostr_key_export", {}) as Promise<{ nsec: string; hex: string }>,
	setRelays: (relays: string[]) => mutate("nostr_relays_set", { relays }) as Promise<{ relays: string[] }>,
};
