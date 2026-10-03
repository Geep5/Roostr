import type { Roostr } from "../tool-sdk";

export const description = "Full-text search over this space's objects (names, fields, block content). Returns id/type/name rows.";
export const inputs = "query: string\ntype?: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const rows = await roostr.query({ textQuery: String(input.query ?? ""), type: String(input.type ?? "") || undefined, filters: [await roostr.spaceFilter()], limit: 20 });
	return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? r.fields.name?.stringValue ?? "" })));
}
