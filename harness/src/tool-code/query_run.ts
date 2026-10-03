import type { Roostr } from "../tool-sdk";

export const description = "Run one of the human's saved views (a query or collection) exactly as their UI runs it - the views are the human's own semantic map of the space. Free.";
export const inputs = "query_id: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const view = await roostr.getInSpace(String(input.query_id ?? ""));
	if (!["query", "set", "collection"].includes(view.typeKey)) throw new Error(`${view.id.slice(0, 8)} is a ${view.typeKey}, not a saved view`);
	const body = await roostr.viewQuery(view);
	if (!body) return "[] (empty view)";
	const rows = await roostr.query({ ...body, limit: 100 });
	return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? r.fields.name?.stringValue ?? "" })));
}
