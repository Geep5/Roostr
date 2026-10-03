import type { Roostr } from "../tool-sdk";

export const description = "Stop an object repeating - the Repeat cell's \"Turn off repeating\". Its history stays in the DAG.";
export const inputs = "id?: string - object id; omit for the object of this conversation";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	if (!obj.fields["repeat"]) return "error: nothing written. This object does not repeat.";
	await roostr.mutate("repeat_clear", { object_id: obj.id });
	return "This object no longer repeats.";
}
