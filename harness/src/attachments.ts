/**
 * Files attached to chat messages (images pasted into an object's chat), as
 * model input. A chat block's meta `files` lists File object ids
 * comma-joined (mutate.odin chat_post); the human's message is copied into
 * the agent's transcript with the same `files` (surfaces.ts ingestIntoChat),
 * and here each image becomes an image block beside that user turn's text,
 * read from this computer's blob store (fetched from a holder when missing).
 * Anything that cannot be shown becomes a one-line note, so the agent knows
 * the file is there and can say what it cannot see.
 */

import { fetchObject, num, str, type ObjectJSON } from "./api";
import { convBlocks } from "./conv";
import { blobDir, ensureBlob } from "./files";
import type { AnthropicContent } from "./types";

export const MAX_IMAGES_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The image types the model accepts. */
const IMAGE_MIMES: Record<string, true> = { "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true };

/** A chat message's attached File ids, from its meta. */
export function messageFiles(meta: Record<string, string>): string[] {
	return (meta["files"] ?? "").split(",").filter(Boolean);
}

/** Attached Files' names by id, for naming them in the framed message; a File that cannot be read is left out. */
export async function fileNames(ids: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const id of ids) {
		const file = await fetchObject(id).catch(() => null);
		if (file) out.set(id, str(file.fields, "name"));
	}
	return out;
}

const note = (text: string): AnthropicContent => ({ type: "text", text });

/** What the model gets for one message's files: images as image blocks, everything else as a note. */
export async function attachmentContent(fileIds: string[]): Promise<AnthropicContent[]> {
	const out: AnthropicContent[] = [];
	let images = 0;
	for (const id of fileIds) {
		const file = await fetchObject(id).catch(() => null);
		if (!file) {
			out.push(note(`[file ${id} not found]`));
			continue;
		}
		const name = str(file.fields, "name") || id;
		const mime = str(file.fields, "file_mime");
		if (!IMAGE_MIMES[mime]) {
			out.push(note(`[file ${name} (${id})]`));
			continue;
		}
		if (images >= MAX_IMAGES_PER_MESSAGE) {
			out.push(note(`[image ${name} not shown: at most ${MAX_IMAGES_PER_MESSAGE} images per message]`));
			continue;
		}
		if ((num(file.fields, "file_size") ?? 0) > MAX_IMAGE_BYTES) {
			out.push(note(`[image ${name} too large to show]`));
			continue;
		}
		const hash = str(file.fields, "file_hash");
		try {
			await ensureBlob(hash);
		} catch (err) {
			out.push(note(`[image ${name} (${id}) could not be loaded: ${err instanceof Error ? err.message : String(err)}]`));
			continue;
		}
		const bytes = await Bun.file(`${blobDir()}/${hash}`).bytes();
		if (bytes.length > MAX_IMAGE_BYTES) {
			out.push(note(`[image ${name} too large to show]`));
			continue;
		}
		out.push({ type: "image", source: { type: "base64", media_type: mime, data: Buffer.from(bytes).toString("base64") } });
		images++;
	}
	return out;
}

/**
 * Each user message's attachments in one conversation, by block id.
 * `cache` holds what earlier iterations of the same turn already loaded:
 * messages and blobs never change, so one turn reads each at most once.
 */
export async function loadAttachments(obj: ObjectJSON, threadId: string, agentId: string, cache = new Map<string, AnthropicContent[]>()): Promise<Map<string, AnthropicContent[]>> {
	const out = new Map<string, AnthropicContent[]>();
	for (const { id, block } of convBlocks(obj, threadId)) {
		const custom = block.content.custom;
		if (custom?.contentType !== "chat") continue;
		const meta = custom.meta ?? {};
		if (meta["author"] === agentId) continue;
		const files = messageFiles(meta);
		if (files.length === 0) continue;
		let content = cache.get(id);
		if (!content) {
			content = await attachmentContent(files);
			cache.set(id, content);
		}
		out.set(id, content);
	}
	return out;
}
