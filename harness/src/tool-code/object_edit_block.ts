import type { Roostr } from "../tool-sdk";

export const description = "Replace the text of one line in an object's body, keeping its style (heading, bullet, checkbox...). `block` is the id from object_get's body. The reply is the line as the human now reads it.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nblock: string\ntext: string";

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
	// Inline markdown in the new text (**bold**, [link](url), `code`) becomes real formatting.
	const { text, marks } = roostr.inlineMarks(typeof input.text === "string" ? input.text : "");
	const cleared = (t.marks ?? []).length > 0 && marks.length === 0;
	await roostr.mutate("block_update", { object_id: obj.id, block_id: entry.id, content: { ...entry.block.content, text: { ...t, text, marks } } });
	const now = roostr.body(await roostr.get(obj.id)).find((e) => e.id === entry.id);
	return `${now ? `Line is now: ${now.line}` : "The line is no longer in the body."}${cleared ? "\n(Its inline formatting - bold, links, mentions - was cleared with the old text.)" : ""}`;
}
