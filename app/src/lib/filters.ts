/**
 * viewFilters → engine filter conversion, shared by the object page and
 * the pinned sidebar widget so both surfaces show the same records.
 */

import type { ObjectJSON, RelationDefJSON } from "$lib/types";
import { SYSTEM_TYPE_KEYS } from "$lib/types";

export function engineFiltersOf(object: ObjectJSON, relations: RelationDefJSON[]): Array<Record<string, unknown>> {
	const items = object.fields["viewFilters"]?.valuesValue?.items ?? [];
	const out: Array<Record<string, unknown>> = [];
	for (const item of items) {
		const e = item.mapValue?.entries;
		if (!e) continue;
		const key = e["key"]?.stringValue ?? "";
		const condition = e["condition"]?.stringValue ?? "equal";
		const values = (e["value"]?.valuesValue?.items ?? [])
			.map((i) => i.stringValue)
			.filter((s): s is string => typeof s === "string");
		if (!key) continue;
		const format = key === "createdAt" || key === "updatedAt" ? "number" : (relations.find((r) => r.key === key)?.format ?? "shorttext");
		let value: unknown;
		if (format === "checkbox") value = true; // "is checked"/"is unchecked" via equal/notEqual true
		else if (condition === "in" || condition === "notIn" || condition === "allIn" || condition === "exactIn") value = values;
		else if (format === "number" || format === "date") value = values[0] !== undefined ? Number(values[0]) : undefined;
		else value = values[0];
		if (condition !== "empty" && condition !== "notEmpty" && condition !== "exists" && format !== "checkbox" && (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
			continue; // incomplete rule - don't filter on it yet
		}
		out.push({ key, condition, value });
	}
	// Unsourced query: Anytype-style system exclusion - the substrate's
	// own objects (source files, programs, agent internals) never show
	// unless a Source explicitly targets them.
	const sources = object.fields["setOf"]?.valuesValue?.items ?? [];
	if (sources.length === 0) {
		out.push({ key: "typeKey", condition: "notIn", value: [...SYSTEM_TYPE_KEYS] });
	}
	return out;
}

/**
 * The implicit space filter: a set/query only ever matches objects of
 * its own space. Objects with no space stamp belong to the default
 * space (the daemon's display fallback), so the default space includes
 * them; every other space is exact-match.
 */
export function spaceFilterOf(object: ObjectJSON, defaultSpaceId: string): Record<string, unknown> {
	const owning = object.fields["channel"]?.stringValue || defaultSpaceId;
	return owning === defaultSpaceId
		? { key: "channel", condition: "in", value: [owning, ""] }
		: { key: "channel", condition: "equal", value: owning };
}
