import type { Roostr } from "../tool-sdk";

export const description = "List this space's recent objects, optionally by type (note, task, query, collection, skill, …).";
export const inputs = "type?: string\nlimit?: number";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const rows = await roostr.query({ type: String(input.type ?? "") || undefined, filters: [await roostr.spaceFilter()], limit: typeof input.limit === "number" ? input.limit : 20 });
	return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? r.fields.name?.stringValue ?? "" })));
}
