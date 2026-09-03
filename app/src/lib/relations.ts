/**
 * Shared property/relation helpers: the reserved (never user-facing) keys,
 * the creatable format list, per-format empty values, and create-from-
 * scratch — used by the featured row, the slash flow, and the suggest
 * popover so creation logic exists exactly once.
 */

import { note } from "$lib/api";
import { refreshAll, store } from "$lib/data.svelte";
import type { RelationDefJSON, ValueJSON } from "$lib/types";

export const RESERVED_KEYS: Record<string, true> = {
	name: true,
	iconEmoji: true,
	iconImage: true,
	setOf: true,
	featuredRelations: true,
	collectionIds: true,
	links: true, // derived from link blocks (Anytype system relation)
	viewFilters: true,
	viewSorts: true,
	viewRelations: true,
	channel: true,
	pinnedIds: true,
	members: true,
	keyId: true,
};

/** Creatable formats (Anytype RelationType minus File/Icon/Relations). */
export const CREATABLE_FORMATS = [
	"shorttext",
	"longtext",
	"number",
	"status",
	"tag",
	"date",
	"checkbox",
	"url",
	"email",
	"phone",
	"object",
] as const;

/** Sidebar/list glyph per relation format (Anytype's per-format icons). */
export function formatGlyph(format: string): string {
	switch (format) {
		case "number": return "#";
		case "status": return "◐";
		case "tag": return "◧";
		case "date": return "📅";
		case "checkbox": return "☑";
		case "url": return "🔗";
		case "email": return "＠";
		case "phone": return "☎";
		case "object": return "▣";
		default: return "≡";
	}
}

export function emptyValueFor(format: string): ValueJSON {
	if (format === "checkbox") return { boolValue: false };
	if (format === "tag" || format === "object") return { valuesValue: { items: [] } };
	if (format === "number" || format === "date") return { intValue: 0 };
	return { stringValue: "" };
}

export function slugKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `prop_${Date.now()}`;
}

/**
 * Create a relation object and refresh the store. Returns the def
 * (existing one when the key already exists).
 */
export async function createRelation(name: string, format: string): Promise<RelationDefJSON | undefined> {
	const key = slugKey(name);
	const existing = store.relations.find((r) => r.key === key);
	if (existing) return existing;
	await note.create(name, "relation", {
		key: { stringValue: key },
		name: { stringValue: name },
		format: { stringValue: format },
		hidden: { boolValue: false },
		readOnly: { boolValue: false },
		maxCount: { intValue: format === "status" ? 1 : 0 },
		options: { valuesValue: { items: [] } },
		bundled: { boolValue: false },
	});
	await refreshAll();
	return store.relations.find((r) => r.key === key);
}
