import type { Roostr } from "../tool-sdk";

export const description = "Read one object: fields plus full text content. Protected from output pruning — reads stay in context.";
export const inputs = "id: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = String(input.id ?? "");
	roostr.touch(id);
	const obj = await roostr.getInSpace(id);
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj.fields)) fields[key] = roostr.plain(value);
	const body = roostr.body(obj);
	const shown = body.slice(0, 400);
	// A link card reads as the linked object's name on the page, so the agent sees that too (plus the id to open it).
	const lines = await Promise.all(
		shown.map(async (b) => {
			const target = b.block.content.custom?.contentType === "link" ? (b.block.content.custom.meta?.["target"] ?? "") : "";
			if (!target) return b.line;
			const linked = await roostr.get(target).catch(() => null);
			return linked && !linked.deleted ? `[link] "${linked.fields.name?.stringValue || "Untitled"}" (${linked.typeKey}, object ${target})` : `[link to a deleted object ${target}]`;
		}),
	);
	return JSON.stringify(
		{
			id: obj.id,
			typeKey: obj.typeKey,
			fields,
			// Body, one entry per block: pass `block` to the object_*_block tools to change it.
			body: shown.map((b, i) => ({ block: b.id, depth: b.depth, line: lines[i].slice(0, 300) })),
			...(body.length > shown.length ? { bodyTruncated: body.length - shown.length } : {}),
		},
		null,
		1,
	);
}
