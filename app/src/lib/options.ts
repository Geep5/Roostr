/**
 * Select/multi-select option management — Anytype's option system
 * (menu/dataview/option/list.tsx + edit.tsx). Options live on the RELATION
 * object as {id, text, color, orderId}; color is a palette NAME from their
 * Constant.textColor list, mapped here to the dark-theme tag values
 * (scss/theme/dark + _vars).
 *
 * Unlike Anytype (options are objects referenced by id), our field values
 * store the option TEXT — so rename/delete propagate through every object
 * carrying the value.
 */

import { fetchQuery, note } from "$lib/api";
import { refreshAll } from "$lib/data.svelte";
import type { RelationDefJSON, ValueJSON } from "$lib/types";

export interface TagOption {
	id: string;
	text: string;
	color: string;
	orderId: string;
}

/**
 * Anytype Constant.textColor palette, dark-theme values. `hex` is the vivid
 * tone (scss/_vars --color-tag-*, used for swatches); `bg`/`text` are the
 * tagItem pill pair (theme/dark --color-light-* background with
 * --color-dark-* text - filled pill, pale label).
 */
export const TAG_COLORS: Array<{ name: string; hex: string; bg: string; text: string }> = [
	{ name: "grey", hex: "#8c9ea5", bg: "#414141", text: "#c8c8c8" },
	{ name: "yellow", hex: "#b2a616", bg: "#6c630f", text: "#fbf29a" },
	{ name: "orange", hex: "#d3720d", bg: "#5c2a06", text: "#fbcf7a" },
	{ name: "red", hex: "#e2400c", bg: "#4a0a08", text: "#f5a090" },
	{ name: "pink", hex: "#ca1b8e", bg: "#4a0828", text: "#f9a0c8" },
	{ name: "purple", hex: "#9e30c4", bg: "#3d0e68", text: "#d090f0" },
	{ name: "blue", hex: "#6878ee", bg: "#162060", text: "#a0b0f8" },
	{ name: "ice", hex: "#1c8bca", bg: "#023a58", text: "#90deff" },
	{ name: "teal", hex: "#0caaa3", bg: "#0b4f4a", text: "#7eeedd" },
	{ name: "lime", hex: "#64b90f", bg: "#1a3a0a", text: "#80ee80" },
];

export function colorHex(name: string): string {
	return TAG_COLORS.find((c) => c.name === name)?.hex ?? (name || TAG_COLORS[0].hex);
}

/** Inline style for an Anytype tagItem pill (filled bg, pale text). */
export function tagStyle(name: string): string {
	const c = TAG_COLORS.find((x) => x.name === name);
	// Unknown/default: their shape-tertiary pill with primary text.
	if (!c) return "background: rgba(255, 255, 255, 0.09)";
	return `background:${c.bg}; color:${c.text}`;
}

function serialize(options: TagOption[]): ValueJSON {
	return {
		valuesValue: {
			items: options.map((o) => ({
				mapValue: {
					entries: {
						id: { stringValue: o.id },
						text: { stringValue: o.text },
						color: { stringValue: o.color },
						orderId: { stringValue: o.orderId },
					},
				},
			})),
		},
	};
}

async function save(rel: RelationDefJSON, options: TagOption[]): Promise<void> {
	await note.setField(rel.id, "options", serialize(options));
	await refreshAll();
}

/** Create an option; Anytype assigns a random palette color. */
export async function addOption(rel: RelationDefJSON, text: string): Promise<TagOption> {
	const opt: TagOption = {
		id: crypto.randomUUID(),
		text: text.trim(),
		color: TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)].name,
		orderId: String(rel.options.length).padStart(6, "0"),
	};
	await save(rel, [...rel.options, opt]);
	return opt;
}

export async function setOptionColor(rel: RelationDefJSON, id: string, color: string): Promise<void> {
	await save(rel, rel.options.map((o) => (o.id === id ? { ...o, color } : o)));
}

/** Every object whose `rel.key` value contains `text`. */
async function carriers(rel: RelationDefJSON, text: string) {
	// "in" = value-list intersects filter set (query.odin); "equal" on lists
	// demands whole-list equality and would miss multi-tag objects.
	const res = await fetchQuery({ filters: [{ key: rel.key, condition: "in", value: [text] }], limit: 500 });
	return res.records;
}

/** Rename an option and rewrite the value on every carrying object. */
export async function renameOption(rel: RelationDefJSON, id: string, next: string): Promise<void> {
	const prev = rel.options.find((o) => o.id === id);
	const clean = next.trim();
	if (!prev || !clean || prev.text === clean) return;
	for (const r of await carriers(rel, prev.text)) {
		const items = (r.fields[rel.key]?.valuesValue?.items ?? []).map((i) =>
			i.stringValue === prev.text ? { stringValue: clean } : i,
		);
		await note.setField(r.id, rel.key, { valuesValue: { items } });
	}
	await save(rel, rel.options.map((o) => (o.id === id ? { ...o, text: clean } : o)));
}

/** Delete an option and strip it from every carrying object. */
export async function deleteOption(rel: RelationDefJSON, id: string): Promise<void> {
	const prev = rel.options.find((o) => o.id === id);
	if (!prev) return;
	for (const r of await carriers(rel, prev.text)) {
		const items = (r.fields[rel.key]?.valuesValue?.items ?? []).filter((i) => i.stringValue !== prev.text);
		await note.setField(r.id, rel.key, { valuesValue: { items } });
	}
	await save(rel, rel.options.filter((o) => o.id !== id));
}
