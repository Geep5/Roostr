import type { Roostr } from "../tool-sdk";

export const description = "Move one body line (with what's nested under it) before or after another line, or inside it as its last child. Ids come from object_get's body.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nblock: string\nto: string - the line to move next to\nwhere: before|after|inside";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	// Both lines must be lines of the body - never conversation messages.
	const body = roostr.body(obj);
	const block = typeof input.block === "string" ? input.block : "";
	const entry = body.find((e) => e.id === block);
	if (!entry) return `error: nothing written. "${block}" is not a line of this object's body. Read object_get's body for the ids.`;
	const toId = typeof input.to === "string" ? input.to : "";
	const to = body.find((e) => e.id === toId);
	if (!to) return `error: nothing moved. "${toId}" is not a line of this object's body.`;
	// The moved line's own subtree, in reading order right after it.
	const at = body.indexOf(entry);
	let end = at + 1;
	while (end < body.length && body[end].depth > entry.depth) end++;
	if (body.slice(at, end).includes(to)) return "error: nothing moved. A line cannot move next to or into itself or its own nested lines.";
	const where = typeof input.where === "string" ? input.where : "";
	// glon.Position: Before 1, After 2, Inner 5 (as the line's last child).
	const position = where === "before" ? 1 : where === "after" ? 2 : where === "inside" ? 5 : 0;
	if (!position) return "error: nothing moved. where must be before, after or inside.";
	await roostr.mutate("block_move", { object_id: obj.id, block_id: entry.id, target_id: to.id, position });
	const now = roostr.body(await roostr.get(obj.id));
	const i = now.findIndex((e) => e.id === entry.id);
	const prev = now.slice(0, i).reverse().find((e) => e.depth <= now[i].depth);
	return `${now[i].line}\n${prev ? `now ${prev.depth < now[i].depth ? "inside" : "after"}: ${prev.line}` : "now first in the body"}`;
}
