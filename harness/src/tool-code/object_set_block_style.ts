import type { Roostr } from "../tool-sdk";

export const description = "Change what one body line is: paragraph, h1, h2, h3, quote, bullet, numbered or checkbox. `block` is the id from object_get's body.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nblock: string\nstyle: paragraph|h1|h2|h3|quote|bullet|numbered|checkbox";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	// Only a line of the body - never a conversation message.
	const block = typeof input.block === "string" ? input.block : "";
	const entry = roostr.body(obj).find((e) => e.id === block);
	if (!entry) return `error: nothing written. "${block}" is not a line of this object's body. Read object_get's body for the ids.`;
	const t = entry.block.content.text;
	if (!t) return `error: nothing written. That line is a ${entry.block.content.custom?.contentType ?? "non-text"} block, not text.`;
	const name = typeof input.style === "string" ? input.style : "";
	if (!Object.hasOwn(roostr.textStyles, name)) return `error: nothing written. style must be one of ${Object.keys(roostr.textStyles).join(", ")}.`;
	const style = roostr.textStyles[name];
	const checkbox = style === roostr.textStyles.checkbox;
	await roostr.mutate("block_update", { object_id: obj.id, block_id: entry.id, content: { ...entry.block.content, text: { ...t, style, checked: checkbox ? t.checked === true : false } } });
	const now = roostr.body(await roostr.get(obj.id)).find((e) => e.id === entry.id);
	return now ? `Line is now: ${now.line}` : "The line is no longer in the body.";
}
