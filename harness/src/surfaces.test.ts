/**
 * A message the agent has not answered is pending, wherever the DAG merged
 * it into the block list.
 *
 * Block order is merge order: a phone whose replica was behind commits with
 * stale heads, so its message can land BEFORE the agent's watermark. The
 * old positional scan skipped exactly those - the message synced, appeared
 * on every device, and the agent never saw it.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingMessages, setMark } from "./surfaces";
import type { BlockJSON, ObjectJSON } from "./api";

const AGENT = "9b08be05-ed4b-4417-a976-1efead0cb561";
const HUMAN = "816854963a03323d";

// Marks are cached in-module, so they are written through the same API the
// harness uses; a temp root keeps the developer's real marks untouched.
const root = mkdtempSync(join(tmpdir(), "surfaces-"));
process.env.GLON_DATA = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function msg(id: string, author: string, ts: number, text: string): BlockJSON {
	return {
		id,
		childrenIds: [],
		content: { custom: { contentType: "chat", meta: { author, ts: String(ts), text } } },
	} as unknown as BlockJSON;
}

/** `order` is block (merge) order, which need not be chronological. */
function objectWith(id: string, order: BlockJSON[]): ObjectJSON {
	return {
		id,
		typeKey: "task",
		fields: {},
		blocks: [
			{ id: "__discussion__", childrenIds: order.map((b) => b.id), content: {} } as unknown as BlockJSON,
			...order,
		],
	} as unknown as ObjectJSON;
}

test("a newer message merged before the watermark is still pending", async () => {
	// The phone's message (ts 300) merged between the human's first message
	// and the agent's reply, which is the watermark.
	const obj = objectWith("merged-early", [
		msg("m1", HUMAN, 100, "first question"),
		msg("m3", HUMAN, 300, "from the phone"),
		msg("m2", AGENT, 200, "answer to the first"),
	]);
	await setMark(obj.id, "m2");
	expect((await pendingMessages(obj, AGENT)).map((p) => p.text)).toEqual(["from the phone"]);
});

test("messages older than the watermark stay answered", async () => {
	const obj = objectWith("all-answered", [
		msg("m1", HUMAN, 100, "first question"),
		msg("m2", AGENT, 200, "answer to the first"),
	]);
	await setMark(obj.id, "m2");
	expect(await pendingMessages(obj, AGENT)).toEqual([]);
});

test("a same-millisecond tie falls back to block order", async () => {
	const obj = objectWith("tied", [
		msg("m1", HUMAN, 100, "before the mark"),
		msg("m2", AGENT, 100, "the mark itself"),
		msg("m3", HUMAN, 100, "after the mark"),
	]);
	await setMark(obj.id, "m2");
	expect((await pendingMessages(obj, AGENT)).map((p) => p.text)).toEqual(["after the mark"]);
});

test("pending is chronological, so the caller's watermark only moves forward", async () => {
	// Merge order puts the newest message in the middle; the caller marks
	// pending[last], which must be the newest by time or an already-handled
	// message becomes pending again on the next pass.
	const obj = objectWith("out-of-order", [
		msg("m1", HUMAN, 100, "oldest"),
		msg("m3", HUMAN, 300, "newest"),
		msg("m2", HUMAN, 200, "middle"),
	]);
	await setMark(obj.id, "m1");
	const pending = await pendingMessages(obj, AGENT);
	expect(pending.map((p) => p.text)).toEqual(["middle", "newest"]);
	expect(pending[pending.length - 1].blockId).toBe("m3");
});
