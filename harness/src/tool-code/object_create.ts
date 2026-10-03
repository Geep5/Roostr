import type { Roostr } from "../tool-sdk";

export const description = "Create an object (default type note). Returns its id.";
export const inputs = "name: string\ntype_key?: string\ntext?: string - optional body text";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	// Lands in this agent's space; a Tool is refused - people make tools.
	const { id } = await roostr.create(asText(input.name), asText(input.type_key) || "note");
	roostr.touch(id);
	if (asText(input.text)) await roostr.addText(id, asText(input.text));
	return JSON.stringify({ id });
}
