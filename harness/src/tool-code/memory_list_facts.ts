import type { Roostr } from "../tool-sdk";

export const description = "List pinned facts. Inspect before writing to avoid duplicates.";
export const inputs = "key?: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const rows = await roostr.memory.listFacts((typeof input.key === "string" ? input.key : "") || undefined);
	return JSON.stringify(rows.map((r) => ({ id: r.id, key: r.fields.key?.stringValue ?? "", value: r.fields.value?.stringValue ?? "", confidence: r.fields.confidence?.stringValue ?? "" })));
}
