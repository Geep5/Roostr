/**
 * Object creation helpers, channel-aware — shared by the home page, the
 * sidebar create button (Anytype's typeSuggest analog), and the search
 * modal's "Create object" row.
 */

import { goto } from "$app/navigation";
import { note } from "$lib/api";
import type { ValueJSON } from "$lib/types";
import { TYPE_GLYPHS } from "$lib/icons";

const channelField = (channelId: string): Record<string, ValueJSON> =>
	channelId ? { channel: { stringValue: channelId } } : {};

/** Creatable types for the sidebar dropdown (plus Collection and Query). */
export const CREATABLE_TYPES = ["note", "task", "person", "project", "bookmark", "skill"] as const;

export function typeGlyph(typeKey: string): string {
	return (TYPE_GLYPHS as Record<string, string>)[typeKey] ?? "▨";
}

export async function createTyped(typeKey: string, channelId: string, name = "Untitled"): Promise<string> {
	const { id } = await note.create(name, typeKey.trim().toLowerCase(), channelField(channelId));
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

export async function createQuery(channelId: string, source = "note"): Promise<string> {
	const { id } = await note.create(`${source} query`, "query", {
		...channelField(channelId),
		setOf: { valuesValue: { items: [{ stringValue: source.trim().toLowerCase() }] } },
	});
	await goto(`/object/${id}`);
	return id;
}
