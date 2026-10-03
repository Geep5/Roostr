import type { Roostr } from "../tool-sdk";

export const description = "Append NEW text to an object's body. Markdown lines become real blocks: '- [ ] x' checkboxes, '- x' bullets, '1. x' numbered, '# x' headings, '> x' quotes; plain lines become paragraphs. Indent a line to nest it under the one above; **bold**, *italic*, `code` and [text](url) become formatting. When the object already has a matching list or section, pass 'under' with that block's text (e.g. under: \"Walmart\") so new items join it as children instead of landing at the page root. To change what is already there, use object_edit_block / object_check / object_set_block_style / object_move_block / object_remove_blocks; to link another object, object_add_link (never write '🔗 Name' text).";
export const inputs = "id: string\ntext: string\nunder?: string - text of an existing block to nest the new blocks under";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = typeof input.id === "string" ? input.id : "";
	const under = (typeof input.under === "string" ? input.under : "").trim();
	roostr.touch(id);
	const obj = await roostr.writable(id);
	// "under" is how new lines join an existing list or section (under: "Walmart") instead of landing at the page root:
	// the block whose text is exactly that (any case), else the first that starts with it.
	let parent = "";
	if (under) {
		const needle = under.toLowerCase();
		const hit =
			obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase() === needle) ??
			obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase().startsWith(needle));
		if (!hit) return `error: no block matching "${under}" - blocks were NOT added; re-check the text or omit "under"`;
		parent = hit.id;
	}
	const added = await roostr.addText(obj.id, typeof input.text === "string" ? input.text : "", parent);
	return `ok: ${added} block(s) added${parent ? ` under "${under}"` : ""}`;
}
