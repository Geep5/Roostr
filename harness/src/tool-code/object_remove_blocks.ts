import type { Roostr } from "../tool-sdk";

export const description = "Delete lines from an object's body - each block and everything nested under it. `blocks` are ids from object_get's body. The reply lists what was removed.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nblocks: string[]";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const ids = Array.isArray(input.blocks) ? input.blocks.filter((x): x is string => typeof x === "string") : [];
	if (ids.length === 0) return "error: nothing removed. Pass the block ids to remove.";
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing removed. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	// All or nothing: every id must be a line of the body - never a conversation message.
	const body = roostr.body(obj);
	const missing = ids.filter((b) => !body.some((e) => e.id === b));
	if (missing.length) return `error: nothing removed. Not lines of this object's body: ${missing.join(", ")}. Read object_get's body for the ids.`;
	for (const e of body.filter((line) => ids.includes(line.id))) await roostr.mutate("block_remove", { object_id: obj.id, block_id: e.id });
	// A removed line takes what's nested under it along: report every line that went.
	const after = new Set(roostr.body(await roostr.get(obj.id)).map((e) => e.id));
	const gone = body.filter((e) => !after.has(e.id));
	return `Removed ${gone.length} line(s):\n${gone.map((e) => `${"  ".repeat(e.depth)}${e.line}`).join("\n")}`;
}
