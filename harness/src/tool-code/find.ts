import type { Roostr } from "../tool-sdk";

export const description = "Structured query over this space - the same engine the human's views run on. filters: [{key, condition, value}], conditions equal/notEqual/in/notIn/greater/less/empty/notEmpty. Free and unlimited: query until you know who to ask and what to ask.";
export const inputs = "type?: string - type key (person, task, ...)\ntext?: string - full-text query\nfilters?: object[] - engine filters\nlimit?: number";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	// The space filter always applies, so a filter on channel can't reach past it.
	const filters = Array.isArray(input.filters) ? input.filters.filter((f: unknown) => typeof f === "object" && f !== null && "key" in f && typeof f.key === "string" && f.key !== "channel") : [];
	const rows = await roostr.query({
		type: String(input.type ?? "") || undefined,
		textQuery: String(input.text ?? "") || undefined,
		filters: [...filters, await roostr.spaceFilter()],
		limit: Math.min(100, typeof input.limit === "number" ? input.limit : 25),
	});
	return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? r.fields.name?.stringValue ?? "" })));
}
