import type { Roostr } from "../tool-sdk";

export const description = "Bring an object back from the space's bin (the bin's Restore): its text, properties and history return with it.";
export const inputs = "id: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = typeof input.id === "string" ? input.id : "";
	roostr.touch(id);
	const obj = await roostr.writable(id);
	if (!obj.deleted) return `error: nothing restored. "${obj.fields.name?.stringValue || "Untitled"}" is not in the bin.`;
	await roostr.mutate("restore", { object_id: obj.id });
	const after = await roostr.get(obj.id);
	return after.deleted ? "error: the restore did not take - it is still in the bin." : `Restored "${after.fields.name?.stringValue || "Untitled"}" (${after.typeKey}) from the bin.`;
}
