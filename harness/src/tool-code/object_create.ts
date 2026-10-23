import type { Roostr } from "../tool-sdk";

export const description = "Create an object (default type note). Returns its id and a chat link to it.";
export const inputs = "name: string\ntype_key?: string\ntext?: string - optional body text";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	// Lands in this agent's space; a Tool is refused - people make tools.
	const { id } = await roostr.create(asText(input.name), asText(input.type_key) || "note");
	roostr.touch(id);
	if (asText(input.text)) await roostr.addText(id, asText(input.text));
	// The chip a chat reply pastes as is: `[Name](/app/object/<id>)`.
	const name = asText(input.name).replace(/[[\]]/g, "") || "Untitled";
	return JSON.stringify({ id, link: `[${name}](/app/object/${id})` });
}
