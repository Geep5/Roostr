import type { Roostr } from "../tool-sdk";

export const description = "Pin a durable atomic fact. One row per `key` — upsert replaces by key.";
export const inputs = "key: string\nvalue: string\nconfidence?: low|med|high\nsourced_from_block_id?: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	const id = await roostr.memory.upsertFact(asText(input.key), asText(input.value), asText(input.confidence) || "med", asText(input.sourced_from_block_id));
	return JSON.stringify({ id });
}
