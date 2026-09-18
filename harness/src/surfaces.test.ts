/**
 * A message the agent has not answered is pending, wherever the DAG merged
 * it into the block list.
 *
 * Block order is merge order: a phone whose replica was behind commits with
 * stale heads, so its message can land BEFORE the agent's watermark. The
 * old positional scan skipped exactly those - the message synced, appeared
 * on every device, and the agent never saw it.
 *
 * A watermark now belongs to a conversation, not an object: one object holds
 * its human discussion, the agent's own transcript and any pair thread, and
 * a message in one must never count as answered because another moved on.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingMessages, setMark } from "./surfaces";
import { humanRef, HUMAN_THREAD } from "./conv";
import type { BlockJSON, ObjectJSON } from "./api";

const AGENT = "9b08be05-ed4b-4417-a976-1efead0cb561";
const OTHER_AGENT = "4c1de8f2-7b60-4a19-8d33-5ae0c91b7f04";
const HUMAN = "816854963a03323d";
const PRIVATE = "__thread__7c1b4a02";

// Marks are cached in-module, so they are written through the same API the
// harness uses; a temp root keeps the developer's real marks untouched.
const root = mkdtempSync(join(tmpdir(), "surfaces-"));
process.env.GLON_DATA = root;
// Seeded before the first read, because loadMarks caches: this is a marks
// file written before conversations were addressed, keyed on the object id
// alone.
writeFileSync(join(root, "harness-marks.json"), JSON.stringify({ "pre-migration": "m1" }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function msg(id: string, author: string, ts: number, text: string): BlockJSON {
	return {
		id,
		childrenIds: [],
		content: { custom: { contentType: "chat", meta: { author, ts: String(ts), text } } },
	} as unknown as BlockJSON;
}

/** Each entry is one conversation on the object; `order` is block (merge)
 * order, which need not be chronological. */
function objectWith(id: string, ...threads: Array<{ threadId: string; order: BlockJSON[] }>): ObjectJSON {
	const blocks: BlockJSON[] = [];
	for (const { threadId, order } of threads) {
		blocks.push({
			id: threadId,
			childrenIds: order.map((b) => b.id),
			content: { custom: { contentType: "discussion", meta: {} } },
		} as unknown as BlockJSON);
		blocks.push(...order);
	}
	return { id, typeKey: "task", fields: {}, blocks } as unknown as ObjectJSON;
}

test("a newer message merged before the watermark is still pending", async () => {
	// The phone's message (ts 300) merged between the human's first message
	// and the agent's reply, which is the watermark.
	const obj = objectWith("merged-early", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "first question"), msg("m3", HUMAN, 300, "from the phone"), msg("m2", AGENT, 200, "answer to the first")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT)).map((p) => p.text)).toEqual(["from the phone"]);
});

test("messages older than the watermark stay answered", async () => {
	const obj = objectWith("all-answered", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "first question"), msg("m2", AGENT, 200, "answer to the first")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect(await pendingMessages(obj, humanRef(obj.id), AGENT)).toEqual([]);
});

test("a same-millisecond tie falls back to block order", async () => {
	const obj = objectWith("tied", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "before the mark"), msg("m2", AGENT, 100, "the mark itself"), msg("m3", HUMAN, 100, "after the mark")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT)).map((p) => p.text)).toEqual(["after the mark"]);
});

test("pending is chronological, so the caller's watermark only moves forward", async () => {
	// Merge order puts the newest message in the middle; the caller marks
	// pending[last], which must be the newest by time or an already-handled
	// message becomes pending again on the next pass.
	const obj = objectWith("out-of-order", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "oldest"), msg("m3", HUMAN, 300, "newest"), msg("m2", HUMAN, 200, "middle")],
	});
	await setMark(humanRef(obj.id), "m1");
	const pending = await pendingMessages(obj, humanRef(obj.id), AGENT);
	expect(pending.map((p) => p.text)).toEqual(["middle", "newest"]);
	expect(pending[pending.length - 1].blockId).toBe("m3");
});

test("a mark written before conversations were addressed still holds", async () => {
	// The agent never spoke here, so ignoring the old object-only key would
	// fall back to the never-spoken seed and only the newest message would
	// be live - the question before it silently answered on upgrade.
	const obj = objectWith("pre-migration", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "answered before the upgrade"), msg("m2", HUMAN, 200, "second question"), msg("m3", HUMAN, 300, "asked since")],
	});
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT)).map((p) => p.text)).toEqual(["second question", "asked since"]);
});

test("a watermark belongs to one conversation, not the whole object", async () => {
	// The transcript and the discussion live on the same object. Keying the
	// mark on the object id alone would let a turn in either one silence the
	// other's unanswered message.
	const obj = objectWith(
		"two-threads",
		{ threadId: HUMAN_THREAD, order: [msg("h1", HUMAN, 100, "human asks"), msg("h2", AGENT, 200, "agent answers"), msg("h3", HUMAN, 300, "human asks again")] },
		{ threadId: PRIVATE, order: [msg("t1", HUMAN, 400, "in the transcript"), msg("t2", AGENT, 500, "worked on it"), msg("t3", OTHER_AGENT, 600, "peer chimes in")] },
	);
	const discussion = humanRef(obj.id);
	const transcript = { objectId: obj.id, threadId: PRIVATE };

	await setMark(transcript, "t3");
	expect((await pendingMessages(obj, discussion, AGENT)).map((p) => p.text)).toEqual(["human asks again"]);

	await setMark(discussion, "h3");
	expect(await pendingMessages(obj, discussion, AGENT)).toEqual([]);
	// The transcript's own mark survived the discussion's advance.
	expect(await pendingMessages(obj, transcript, AGENT)).toEqual([]);
});

test("an agent's post wakes this agent in a thread but never in a human discussion", async () => {
	// Two agents on one object's discussion would otherwise answer each
	// other forever; agent-to-agent talk belongs in a pair thread, where
	// both authors count. Before threads this was decided by the object's
	// type, which no longer says anything about the conversation.
	const obj = objectWith(
		"peer-post",
		{ threadId: HUMAN_THREAD, order: [msg("h1", AGENT, 100, "my own reply"), msg("h2", OTHER_AGENT, 200, "peer chatter")] },
		{ threadId: PRIVATE, order: [msg("t1", AGENT, 100, "my own reply"), msg("t2", OTHER_AGENT, 200, "peer asks me something")] },
	);
	expect(await pendingMessages(obj, humanRef(obj.id), AGENT)).toEqual([]);
	expect((await pendingMessages(obj, { objectId: obj.id, threadId: PRIVATE }, AGENT)).map((p) => p.text)).toEqual(["peer asks me something"]);
});
