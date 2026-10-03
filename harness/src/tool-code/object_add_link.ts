import type { Roostr } from "../tool-sdk";

export const description = "Add a link to another object in this object's body - a real, clickable link card, never text that merely looks like one. Place it at the end of the body, inside a line (`under`) or right after one (`after`); those ids come from object_get's body.";
export const inputs = "id?: string - object id; omit for the object of this conversation\ntarget: string - id of the object to link to\nunder?: string - body line to nest the link inside\nafter?: string - body line to place the link after";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	const id = asText(input.id) || roostr.context.objectId;
	if (!id) return "error: nothing added. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const target = await roostr.get(asText(input.target)).catch(() => null);
	if (!target || target.deleted) return `error: nothing added. No object "${asText(input.target)}" - find it with object_search first.`;
	await roostr.getInSpace(target.id);
	const under = asText(input.under);
	const anchor = under || asText(input.after);
	if (anchor && !roostr.body(obj).some((e) => e.id === anchor)) return `error: nothing added. "${anchor}" is not a line of this object's body.`;
	await roostr.mutate("block_add", {
		object_id: obj.id,
		block: { id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: "link", meta: { target: target.id, style: "text" } } } },
		// glon.Position: Inner 5 (the line's last child), After 2.
		...(anchor ? { target_id: anchor, position: under ? 5 : 2 } : {}),
	});
	return `Linked to "${target.fields.name?.stringValue || "Untitled"}" (${target.typeKey}) - a clickable link in the body.`;
}
