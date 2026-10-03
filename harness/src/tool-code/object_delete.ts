import type { Roostr } from "../tool-sdk";

export const description = "Move an object to the space's bin (recoverable: object_restore brings it back, with its text, properties and history).";
export const inputs = "id: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = typeof input.id === "string" ? input.id : "";
	roostr.touch(id);
	const obj = await roostr.writable(id);
	const name = obj.fields.name?.stringValue || "Untitled";
	if (obj.deleted) return `Nothing deleted: "${name}" is already in the bin.`;
	await roostr.mutate("delete", { object_id: obj.id });
	return `Moved "${name}" (${obj.typeKey}) to the bin; object_restore brings it back.`;
}
