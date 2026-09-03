/**
 * Object creation helpers, channel-aware — shared by the home page, the
 * sidebar create button (Anytype's typeSuggest analog), and the search
 * modal's "Create object" row.
 */

import { goto } from "$app/navigation";
import { fetchObject, note } from "$lib/api";
import type { ValueJSON } from "$lib/types";
import { TYPE_GLYPHS } from "$lib/icons";
import { store } from "$lib/data.svelte";
import { activeSpace } from "$lib/space.svelte";

const channelField = (channelId: string): Record<string, ValueJSON> =>
	channelId ? { channel: { stringValue: channelId } } : {};

/** Legacy fallback until the type objects have loaded. */
export const CREATABLE_TYPES = ["page", "note", "task", "person", "project", "bookmark", "chat"] as const;

/** Creatable types for the sidebar dropdown: bundled types plus the
 *  active space's own — spaces are self-contained. */
export function creatableTypes(): Array<{ key: string; name: string; icon: string }> {
	if (store.types.length === 0) return CREATABLE_TYPES.map((k) => ({ key: k, name: k[0].toUpperCase() + k.slice(1), icon: typeGlyph(k) }));
	const sid = activeSpace.id || store.channels[0]?.id || "";
	return store.types.filter((t) => !t.space || t.space === sid).map((t) => ({ key: t.key, name: t.name || t.key, icon: t.icon || typeGlyph(t.key) }));
}

export function typeGlyph(typeKey: string): string {
	return (TYPE_GLYPHS as Record<string, string>)[typeKey] ?? "▨";
}

/**
 * Copy a template's content blocks into a fresh object (Anytype: ObjectCreate
 * with type.defaultTemplateId). Ids are remapped; the discussion subtree and
 * template-identity fields stay behind.
 */
async function applyTemplate(objectId: string, templateId: string): Promise<void> {
	const tpl = await fetchObject(templateId);
	// Everything reachable from __discussion__ is conversation, not content.
	const byId = new Map(tpl.blocks.map((b) => [b.id, b]));
	const skip = new Set<string>();
	const markSkip = (id: string) => {
		if (skip.has(id)) return;
		skip.add(id);
		for (const c of byId.get(id)?.childrenIds ?? []) markSkip(c);
	};
	markSkip("__discussion__");

	const idMap = new Map<string, string>();
	for (const b of tpl.blocks) if (!skip.has(b.id)) idMap.set(b.id, crypto.randomUUID());
	for (const b of tpl.blocks) {
		if (skip.has(b.id)) continue;
		await note.blockAdd(objectId, {
			id: idMap.get(b.id)!,
			childrenIds: b.childrenIds.map((c) => idMap.get(c)).filter((c): c is string => !!c),
			content: b.content,
		});
	}
}

export async function createTyped(typeKey: string, channelId: string, name = ""): Promise<string> {
	const key = typeKey.trim().toLowerCase();
	const { id } = await note.create(name, key, channelField(channelId));
	const tplId = store.types.find((t) => t.key === key)?.defaultTemplateId;
	if (tplId) await applyTemplate(id, tplId).catch(() => {}); // a deleted default template is a no-op
	await goto(`/object/${id}`);
	return id;
}

export async function createCollection(channelId: string): Promise<string> {
	const { id } = await note.create("New collection", "collection", {
		...channelField(channelId),
		collectionIds: { valuesValue: { items: [] } },
	});
	await goto(`/object/${id}`);
	return id;
}

/** Create a sourceless query; the query page opens the type suggest (Anytype: a new set asks for its source). */
/**
 * Default content every fresh space starts with: a "Chats" query over
 * the chat type, so conversations are reachable the moment the space
 * exists. No navigation - the caller decides where to land.
 */
export async function seedSpaceDefaults(channelId: string): Promise<void> {
	await note.create("Chats", "query", {
		...channelField(channelId),
		setOf: { valuesValue: { items: [{ stringValue: "chat" }] } },
	});
}

export async function createQuery(channelId: string): Promise<string> {
	const { id } = await note.create("New query", "query", {
		...channelField(channelId),
		setOf: { valuesValue: { items: [] } },
	});
	await goto(`/object/${id}`);
	return id;
}
