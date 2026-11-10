/**
 * An image pasted into an object's chat reaches the agent as an image.
 *
 * The person's message names File objects in its meta `files`; ingestion
 * copies them onto the transcript copy, and the turn's model request carries
 * each image as an image block beside that message's text, read from this
 * computer's blob store. What cannot be shown (too large, not an image)
 * becomes a short note the agent can repeat.
 */
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as api from "./api";
import type { BlockJSON, ObjectJSON } from "./api";
import * as conv from "./conv";
import { humanRef, HUMAN_THREAD } from "./conv";
import { loadAttachments, MAX_IMAGE_BYTES } from "./attachments";
import { buildConversationView } from "./conversation";
import { callLLM } from "./llm";
import { frameMessage, ingestIntoChat, type PendingMessage } from "./surfaces";

const AGENT = "9b08be05-ed4b-4417-a976-1efead0cb561";
const HUMAN = "816854963a03323d";
const TRANSCRIPT = "__thread__a9e1";

const root = mkdtempSync(join(tmpdir(), "attachments-"));
process.env.GLON_DATA = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

/** A stored blob and the File object naming it. */
function storedFile(id: string, name: string, mime: string, bytes: Uint8Array, size = bytes.length): ObjectJSON {
	const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	mkdirSync(join(root, "blobs"), { recursive: true });
	writeFileSync(join(root, "blobs", hash), bytes);
	return {
		id,
		typeKey: "file",
		fields: { name: { stringValue: name }, file_hash: { stringValue: hash }, file_mime: { stringValue: mime }, file_size: { intValue: size } },
		blocks: [],
	} as unknown as ObjectJSON;
}

function objectWith(id: string, threadId: string, order: BlockJSON[]): ObjectJSON {
	const thread = { id: threadId, childrenIds: order.map((b) => b.id), content: { custom: { contentType: "discussion", meta: {} } } } as unknown as BlockJSON;
	return { id, typeKey: "note", fields: { name: { stringValue: "Screens" } }, blocks: [thread, ...order] } as unknown as ObjectJSON;
}

/** Ingest one human message with `files` into a transcript, then build the turn's model request; returns the request body. */
async function requestFor(files: Record<string, ObjectJSON>, model = "claude-sonnet-4-5"): Promise<{ framed: string; body: { messages: Array<{ role: string; content: unknown }> } }> {
	// Other test files point GLON_DATA elsewhere; the blobs read here are ours.
	process.env.GLON_DATA = root;
	const fetchSpy = spyOn(api, "fetchObject").mockImplementation(async (id: string) => {
		const file = files[id];
		if (!file) throw new Error("not found");
		return file;
	});
	let copied: Partial<BlockJSON> | undefined;
	const addSpy = spyOn(conv, "addConvBlock").mockImplementation(async (_ref, block) => {
		copied = block;
		return {};
	});
	try {
		// What pendingMessages picks up from that message (its `files` meta: surfaces.test.ts).
		const surface = objectWith(`surface-${crypto.randomUUID()}`, HUMAN_THREAD, []);
		const pending: PendingMessage[] = [{ blockId: "m1", author: HUMAN, text: "@Agent what's wrong here?", files: Object.keys(files) }];
		const names = new Map(Object.values(files).map((f) => [f.id, api.str(f.fields, "name")]));
		const framed = frameMessage(surface, humanRef(surface.id), pending, names);
		await ingestIntoChat({ objectId: "home", threadId: TRANSCRIPT }, humanRef(surface.id), HUMAN, framed, "m1", pending[0].files);
		expect(copied).toBeDefined();
		const transcript = objectWith("home", TRANSCRIPT, [copied as BlockJSON]);
		const attachments = await loadAttachments(transcript, TRANSCRIPT, AGENT);
		const view = buildConversationView(transcript, AGENT, 1, TRANSCRIPT, attachments);
		let sent = "";
		globalThis.fetch = Object.assign(
			async (_url: string | URL | Request, init?: RequestInit) => {
				sent = String(init?.body ?? "");
				if (model.startsWith("kimi")) return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
				// Claude answers as a stream (llm.ts readAnthropicStream).
				const events = [
					{ type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				];
				return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });
			},
			{ preconnect: originalFetch.preconnect },
		);
		await callLLM({ model, system: "", turns: view.turns, tools: [], apiKey: "sk-test" });
		return { framed, body: JSON.parse(sent) as { messages: Array<{ role: string; content: unknown }> } };
	} finally {
		fetchSpy.mockRestore();
		addSpy.mockRestore();
	}
}

test("an image pasted with a message reaches the model as an image block in that user turn", async () => {
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
	const { framed, body } = await requestFor({ img1: storedFile("img1", "screenshot.png", "image/png", bytes) });
	// The text names the file, so the agent can link it.
	expect(framed).toContain("[attached: screenshot.png (img1)]");
	const user = body.messages.find((m) => m.role === "user");
	expect(user?.content).toContainEqual(expect.objectContaining({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(bytes).toString("base64") } }));
	expect(JSON.stringify(user?.content)).toContain("what's wrong here?");
});

test("an image over the size cap becomes a note, and a non-image file a note naming it", async () => {
	const { body } = await requestFor({
		big: storedFile("big", "huge.png", "image/png", new Uint8Array([1, 2, 3]), MAX_IMAGE_BYTES + 1),
		doc: storedFile("doc", "notes.pdf", "application/pdf", new Uint8Array([4, 5, 6])),
	});
	const content = body.messages.find((m) => m.role === "user")?.content as Array<{ type: string; text?: string }>;
	expect(content.some((c) => c.type === "image")).toBe(false);
	expect(content).toContainEqual(expect.objectContaining({ type: "text", text: "[image huge.png too large to show]" }));
	expect(content).toContainEqual(expect.objectContaining({ type: "text", text: "[file notes.pdf (doc)]" }));
});

test("at most five images of one message are shown", async () => {
	const files: Record<string, ObjectJSON> = {};
	for (let i = 0; i < 6; i++) files[`i${i}`] = storedFile(`i${i}`, `shot${i}.png`, "image/png", new Uint8Array([i, 9, 9]));
	const { body } = await requestFor(files);
	const content = body.messages.find((m) => m.role === "user")?.content as Array<{ type: string; text?: string }>;
	expect(content.filter((c) => c.type === "image")).toHaveLength(5);
	expect(content).toContainEqual(expect.objectContaining({ type: "text", text: "[image shot5.png not shown: at most 5 images per message]" }));
});

test("Kimi gets the image as a data-URL image part", async () => {
	const bytes = new Uint8Array([0xff, 0xd8, 0xff, 7]);
	const { body } = await requestFor({ jpg: storedFile("jpg", "photo.jpg", "image/jpeg", bytes) }, "kimi-k2.5");
	const user = body.messages.find((m) => m.role === "user");
	expect(user?.content).toContainEqual({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` } });
});
