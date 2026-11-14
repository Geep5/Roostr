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
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressableAgents, chatBlocks, mentions, pendingMessages, reactionWake, setMark } from "./surfaces";
import { humanRef, HUMAN_THREAD } from "./conv";
import * as api from "./api";
import * as spacemap from "./spacemap";
import type { BlockJSON, ObjectJSON, QueryRow } from "./api";

const AGENT = "9b08be05-ed4b-4417-a976-1efead0cb561";
/** The name AGENT answers to: every message it takes @-mentions it. */
const NAME = "Agent";
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
		order: [msg("m1", HUMAN, 100, "@Agent first question"), msg("m3", HUMAN, 300, "@Agent from the phone"), msg("m2", AGENT, 200, "answer to the first")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).map((p) => p.text)).toEqual(["@Agent from the phone"]);
});

test("messages older than the watermark stay answered", async () => {
	const obj = objectWith("all-answered", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "@Agent first question"), msg("m2", AGENT, 200, "answer to the first")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect(await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).toEqual([]);
});

test("a same-millisecond tie falls back to block order", async () => {
	const obj = objectWith("tied", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "@Agent before the mark"), msg("m2", AGENT, 100, "the mark itself"), msg("m3", HUMAN, 100, "@Agent after the mark")],
	});
	await setMark(humanRef(obj.id), "m2");
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).map((p) => p.text)).toEqual(["@Agent after the mark"]);
});

test("pending is chronological, so the caller's watermark only moves forward", async () => {
	// Merge order puts the newest message in the middle; the caller marks
	// pending[last], which must be the newest by time or an already-handled
	// message becomes pending again on the next pass.
	const obj = objectWith("out-of-order", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "@Agent oldest"), msg("m3", HUMAN, 300, "@Agent newest"), msg("m2", HUMAN, 200, "@Agent middle")],
	});
	await setMark(humanRef(obj.id), "m1");
	const pending = await pendingMessages(obj, humanRef(obj.id), AGENT, NAME);
	expect(pending.map((p) => p.text)).toEqual(["@Agent middle", "@Agent newest"]);
	expect(pending[pending.length - 1].blockId).toBe("m3");
});

test("a mark written before conversations were addressed still holds", async () => {
	// The agent never spoke here, so ignoring the old object-only key would
	// fall back to the never-spoken seed and only the newest message would
	// be live - the question before it silently answered on upgrade.
	const obj = objectWith("pre-migration", {
		threadId: HUMAN_THREAD,
		order: [msg("m1", HUMAN, 100, "@Agent answered before the upgrade"), msg("m2", HUMAN, 200, "@Agent second question"), msg("m3", HUMAN, 300, "@Agent asked since")],
	});
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).map((p) => p.text)).toEqual(["@Agent second question", "@Agent asked since"]);
});

test("a pending message carries the files pasted with it", async () => {
	const pasted = {
		id: "f1",
		childrenIds: [],
		content: { custom: { contentType: "chat", meta: { author: HUMAN, ts: "100", text: "@Agent what's in this screenshot?", files: "file-a,file-b" } } },
	} as unknown as BlockJSON;
	const obj = objectWith("pasted", { threadId: HUMAN_THREAD, order: [pasted] });
	expect((await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).map((p) => p.files)).toEqual([["file-a", "file-b"]]);
});

test("a watermark belongs to one conversation, not the whole object", async () => {
	// The transcript and the discussion live on the same object. Keying the
	// mark on the object id alone would let a turn in either one silence the
	// other's unanswered message.
	const obj = objectWith(
		"two-threads",
		{ threadId: HUMAN_THREAD, order: [msg("h1", HUMAN, 100, "@Agent human asks"), msg("h2", AGENT, 200, "agent answers"), msg("h3", HUMAN, 300, "@Agent human asks again")] },
		{ threadId: PRIVATE, order: [msg("t1", HUMAN, 400, "@Agent in the transcript"), msg("t2", AGENT, 500, "worked on it"), msg("t3", OTHER_AGENT, 600, "peer chimes in")] },
	);
	const discussion = humanRef(obj.id);
	const transcript = { objectId: obj.id, threadId: PRIVATE };

	await setMark(transcript, "t3");
	expect((await pendingMessages(obj, discussion, AGENT, NAME)).map((p) => p.text)).toEqual(["@Agent human asks again"]);

	await setMark(discussion, "h3");
	expect(await pendingMessages(obj, discussion, AGENT, NAME)).toEqual([]);
	// The transcript's own mark survived the discussion's advance.
	expect(await pendingMessages(obj, transcript, AGENT, NAME)).toEqual([]);
});

test("legacy shared threads and private transcripts never wake the human-discussion path", async () => {
	// Exchanges now have explicit mailbox claims. Reading a legacy shared
	// thread as pending would replay historical agent work after migration.
	const obj = objectWith(
		"peer-post",
		{ threadId: HUMAN_THREAD, order: [msg("h1", AGENT, 100, "my own reply"), msg("h2", OTHER_AGENT, 200, "peer chatter")] },
		{ threadId: PRIVATE, order: [msg("t1", AGENT, 100, "my own reply"), msg("t2", OTHER_AGENT, 200, "@Agent peer asks me something")] },
	);
	expect(await pendingMessages(obj, humanRef(obj.id), AGENT, NAME)).toEqual([]);
	expect(await pendingMessages(obj, { objectId: obj.id, threadId: PRIVATE }, AGENT, NAME)).toEqual([]);
});

test("a guest answers only what @-mentions it, including another agent's tag", async () => {
	// The task chat: a person asks Sharky to ask Marco; Sharky tags Marco.
	// Marco must take Sharky's question, not the person's instruction to Sharky.
	const obj = objectWith("guests", {
		threadId: HUMAN_THREAD,
		order: [
			msg("g0", HUMAN, 50, "earlier, already answered"),
			msg("g1", HUMAN, 100, "@Sharky Test tag marco in this chat and ask him what he'd feature"),
			msg("g2", AGENT, 200, "@Marco Dev Bot - which tournaments would you feature?"),
		],
	});
	const chat = humanRef(obj.id);
	await setMark(chat, "g0");
	expect((await pendingMessages(obj, chat, OTHER_AGENT, "Marco Dev Bot")).map((p) => p.blockId)).toEqual(["g2"]);
	expect((await pendingMessages(obj, chat, AGENT, "Sharky Test")).map((p) => p.blockId)).toEqual(["g1"]);
	// Saying a name without the @ addresses nobody.
	expect(mentions("tag marco in this chat", "Marco Dev Bot")).toBe(false);
	expect(mentions("hey @marco dev bot!", "Marco Dev Bot")).toBe(true);
});


test("an agent's answer to a guest's question is that guest's to read, once", async () => {
	// Support tags Marco for account data; Marco answers without tagging back.
	// Support must pick the answer up to finish its draft - and nothing else
	// Marco says later, and nothing a person says untagged.
	const names: Record<string, string> = { [AGENT]: "Support Helper", [OTHER_AGENT]: "Marco Dev Bot" };
	const fetchSpy = spyOn(api, "fetchObject").mockImplementation(async (id: string) => ({ id, typeKey: "agent", fields: { name: { stringValue: names[id] ?? "" } }, blocks: [] }) as unknown as ObjectJSON);
	const obj = objectWith("asked", {
		threadId: HUMAN_THREAD,
		order: [
			msg("a0", HUMAN, 100, "@Support Helper please handle this email"),
			msg("a1", AGENT, 200, "Not in the knowledge base. @Marco Dev Bot what is user 1431402's account status?"),
			msg("a2", OTHER_AGENT, 300, "Status pending, fraud flag 99."),
			msg("a3", OTHER_AGENT, 400, "Also: last cashout completed."),
			msg("a4", HUMAN, 500, "thanks all"),
		],
	});
	const chat = humanRef(obj.id);
	await setMark(chat, "a1");
	expect((await pendingMessages(obj, chat, AGENT, "Support Helper")).map((p) => p.blockId)).toEqual(["a2"]);
	// A question that tagged nobody gets no answer routed back.
	const untagged = objectWith("untagged", {
		threadId: HUMAN_THREAD,
		order: [msg("u1", AGENT, 100, "I'll check with the team."), msg("u2", OTHER_AGENT, 200, "Status pending.")],
	});
	await setMark(humanRef(untagged.id), "u1");
	expect(await pendingMessages(untagged, humanRef(untagged.id), AGENT, "Support Helper")).toEqual([]);
	fetchSpy.mockRestore();
});

test("an agent's answer to a person who asked it since is not the earlier guest's", async () => {
	// Matcherino Space suggested "we could ask @Marco Dev Bot"; later a person
	// asked @Marco Dev Bot for stats. Marco's answer is the person's - it woke
	// Matcherino Space, which picked up an old task unasked.
	const names: Record<string, string> = { [AGENT]: "Matcherino Space", [OTHER_AGENT]: "Marco Dev Bot" };
	const fetchSpy = spyOn(api, "fetchObject").mockImplementation(async (id: string) => ({ id, typeKey: "agent", fields: { name: { stringValue: names[id] ?? "" } }, blocks: [] }) as unknown as ObjectJSON);
	const obj = objectWith("person-asked", {
		threadId: HUMAN_THREAD,
		order: [
			msg("p0", HUMAN, 100, "@Matcherino Space can you clone this?"),
			msg("p1", AGENT, 200, "I can't. We could ask @Marco Dev Bot who has shell access."),
			msg("p2", HUMAN, 300, "@Marco Dev Bot stats for October please"),
			msg("p3", OTHER_AGENT, 400, "October: 10 tournaments."),
		],
	});
	const chat = humanRef(obj.id);
	await setMark(chat, "p1");
	expect(await pendingMessages(obj, chat, AGENT, "Matcherino Space")).toEqual([]);
	fetchSpy.mockRestore();
});

test("an @-mention on an object can wake any agent of its space, default agents first", () => {
	const SPACE = "space-a";
	const link = (id: string) => ({ linkValue: { targetId: id, relationKey: "agent" } });
	const agent = (id: string, channel: string, extra: Record<string, api.ValueJSON> = {}) => ({ id, typeKey: "agent", fields: { channel: { stringValue: channel }, ...extra } });
	const task = { id: "task-1", typeKey: "task", fields: { channel: { stringValue: SPACE }, agent: { valuesValue: { items: [link("default-1")] } } } };
	const roster = [
		agent("unlisted", SPACE),
		agent("default-1", SPACE),
		agent("other-space", "space-b"),
		agent("helper", SPACE, { spawn_parent: { stringValue: "unlisted" } }),
	];
	expect(addressableAgents(task, roster, "space-dflt")).toEqual(["default-1", "unlisted"]);
	// The space page itself: its own id is its space.
	expect(addressableAgents({ id: SPACE, typeKey: "channel", fields: {} }, roster, "space-dflt")).toEqual(["unlisted", "default-1"]);
	// An unstamped object belongs to the default space.
	expect(addressableAgents({ id: "n", typeKey: "note", fields: {} }, [agent("d", ""), ...roster], "space-dflt")).toEqual(["d"]);
});

// ── Reactions ─────────────────────────────────────────────────────

const R_SPACE = "space-r";
/** Wrote the message reacted to. */
const TRIAGE = "1f2e3d4c-5b6a-4789-8abc-def012345678";
/** The ✅ Reaction's agent. */
const PICKED = "2a3b4c5d-6e7f-4a1b-9c2d-3e4f5a6b7c8d";
/** Runs the object's Repeat. */
const RUNNER = "3b4c5d6e-7f8a-4b2c-8d3e-4f5a6b7c8d9e";
const SPACE_AGENT = `space-agent-${R_SPACE}`;
/** A space's own agent made before the fixed id: known only by its name. */
const LEGACY_SPACE_AGENT = "4c5d6e7f-8a9b-4c3d-8e4f-5a6b7c8d9e0f";
const sv = (s: string): api.ValueJSON => ({ stringValue: s });
const linkTo = (id: string): api.ValueJSON => ({ linkValue: { targetId: id, relationKey: "agent" } });

function reaction(id: string, author: string, ts: number, replyTo: string, emoji: string, removed = false): BlockJSON {
	const meta: Record<string, string> = { author, ts: String(ts), text: "", replyTo, kind: "reaction", emoji, ...(removed ? { removed: "1" } : {}) };
	return { id, childrenIds: [], content: { custom: { contentType: "chat", meta } } } as unknown as BlockJSON;
}

/** A task in R_SPACE whose discussion is `order` (chronological), with extra fields. */
function taskWith(id: string, order: BlockJSON[], fields: Record<string, api.ValueJSON> = {}): ObjectJSON {
	const obj = objectWith(id, { threadId: HUMAN_THREAD, order });
	obj.fields = { channel: sv(R_SPACE), ...fields };
	return obj;
}

const row = (id: string, typeKey: string, fields: Record<string, api.ValueJSON>): QueryRow => ({ id, typeKey, createdAt: 1, updatedAt: 1, fields });

/** The ✅ Reaction "Approve", its agent PICKED, its page the instructions. */
const APPROVE = row("reaction-approve", "reaction", { channel: sv(R_SPACE), name: sv("Approve"), emoji: sv("✅"), reaction_agent: linkTo(PICKED) });

/**
 * The daemon as the resolver reads it: the space's `agents`, `reactions`,
 * the space and the Reaction pages. Returns the restore.
 */
function reactionWorld(reactions: QueryRow[], agents = [TRIAGE, PICKED, RUNNER, SPACE_AGENT]): () => void {
	const names: Record<string, string> = { [TRIAGE]: "Inbox Triage", [PICKED]: "Approver", [RUNNER]: "Runner", [SPACE_AGENT]: "Garden Space", [LEGACY_SPACE_AGENT]: "Garden Space" };
	const roster = agents.map((id) => row(id, "agent", { channel: sv(R_SPACE), name: sv(names[id]) }));
	const page = { id: "p1", childrenIds: [], content: { text: { text: "Send the drafted reply, then mark the email done.", style: 0 } } };
	const objects: Record<string, ObjectJSON> = {
		[R_SPACE]: { id: R_SPACE, typeKey: "channel", fields: { name: sv("Garden") }, blocks: [] } as unknown as ObjectJSON,
		[APPROVE.id]: { ...APPROVE, blocks: [page] } as unknown as ObjectJSON,
	};
	const spies = [
		spyOn(spacemap, "defaultSpaceId").mockImplementation(async () => "space-dflt"),
		spyOn(api, "queryAll").mockImplementation(async (body: Record<string, unknown>) => (body.type === "agent" ? roster : body.type === "reaction" ? reactions : [])),
		spyOn(api, "fetchObject").mockImplementation(async (id: string) => {
			const found = objects[id];
			if (!found) throw new Error(`objects/${id}: 404`);
			return found;
		}),
	];
	return () => {
		for (const spy of spies) spy.mockRestore();
	};
}

const TARGET_TEXT = "Found 1 new message from Ada: can we move Friday's call?";

test("a reaction wakes the space's Reaction agent, else the message's agent, else the Repeat's, else the space's own", async () => {
	const byAgent = taskWith("react-agent-msg", [msg("t1", TRIAGE, 100, TARGET_TEXT), reaction("r1", HUMAN, 200, "t1", "✅")]);
	const byPerson = taskWith("react-person-msg", [msg("t1", HUMAN, 100, "We should call Ada back."), reaction("r1", HUMAN, 200, "t1", "✅")]);
	const repeating = taskWith("react-repeat", [msg("t1", HUMAN, 100, "We should call Ada back."), reaction("r1", HUMAN, 200, "t1", "✅")], {
		repeat: { mapValue: { entries: {} } },
		assignee: linkTo(RUNNER),
		agent: { valuesValue: { items: [linkTo(TRIAGE)] } },
	});
	const wake = (obj: ObjectJSON) => reactionWake(obj, chatBlocks(obj, humanRef(obj.id)), 1);

	// 1. The space says what ✅ means: its Reaction's agent acts, told who, what, on which message, and the instructions.
	let restore = reactionWorld([APPROVE]);
	const approved = await wake(byAgent);
	expect(approved?.agentId).toBe(PICKED);
	expect(approved?.context).toBe(
		`user reacted ✅ to Inbox Triage's message: "${TARGET_TEXT}"\n` +
			`In this space ✅ means "Approve" (Reaction ${APPROVE.id}). Its instructions:\nSend the drafted reply, then mark the email done.`,
	);
	restore();

	// 2. No Reaction for ✅ here (another space's does not count): the agent that wrote the message.
	const elsewhere = row("reaction-elsewhere", "reaction", { channel: sv("space-other"), name: sv("Ship it"), emoji: sv("✅"), reaction_agent: linkTo(PICKED) });
	const heart = row("reaction-heart", "reaction", { channel: sv(R_SPACE), name: sv("Love"), emoji: sv("❤️"), reaction_agent: linkTo(PICKED) });
	restore = reactionWorld([elsewhere, heart]);
	const own = await wake(byAgent);
	expect(own?.agentId).toBe(TRIAGE);
	expect(own?.context.split("\n")).toEqual([
		`user reacted ✅ to your message: "${TARGET_TEXT}"`,
		"No Reaction in this space says what ✅ means: read it as the person's answer to that message, and act on it if it asks for something.",
	]);

	// 3. A person's message: the agent that runs the object's Repeat (its picked one before the guest list).
	expect((await wake(repeating))?.agentId).toBe(RUNNER);

	// 4. Otherwise the space's own agent.
	expect((await wake(byPerson))?.agentId).toBe(SPACE_AGENT);
	restore();

	// One made before the fixed id is found by its name.
	restore = reactionWorld([], [TRIAGE, LEGACY_SPACE_AGENT]);
	expect((await wake(byPerson))?.agentId).toBe(LEGACY_SPACE_AGENT);
	restore();
});

test("a reaction that was taken back wakes nobody", async () => {
	const restore = reactionWorld([APPROVE]);
	const removed = taskWith("react-removed", [msg("t1", TRIAGE, 100, TARGET_TEXT), reaction("r1", HUMAN, 200, "t1", "👍", true)]);
	expect(await reactionWake(removed, chatBlocks(removed, humanRef(removed.id)), 1)).toBeNull();
	expect(await pendingMessages(removed, humanRef(removed.id), TRIAGE, "Inbox Triage")).toEqual([]);
	// Reacted, then took it back before the agent got to it: nothing is asked.
	const undone = taskWith("react-undone", [msg("t1", TRIAGE, 100, TARGET_TEXT), reaction("r1", HUMAN, 200, "t1", "👍"), reaction("r2", HUMAN, 300, "t1", "👍", true)]);
	expect(await pendingMessages(undone, humanRef(undone.id), TRIAGE, "Inbox Triage")).toEqual([]);
	restore();
});

test("a reaction is pending for exactly one agent, once", async () => {
	const restore = reactionWorld([]);
	const obj = taskWith("react-once", [msg("t1", TRIAGE, 100, TARGET_TEXT), reaction("r1", HUMAN, 200, "t1", "👍")]);
	const chat = humanRef(obj.id);
	await setMark(chat, "t1");
	const pending = await pendingMessages(obj, chat, TRIAGE, "Inbox Triage");
	expect(pending.map((p) => [p.blockId, p.author])).toEqual([["r1", HUMAN]]);
	expect(pending[0].text).toStartWith(`user reacted 👍 to your message: "${TARGET_TEXT}"`);
	// Nobody else takes it: a reaction is never an @-mention or an answer.
	expect(await pendingMessages(obj, chat, PICKED, "Approver")).toEqual([]);
	expect(await pendingMessages(obj, chat, SPACE_AGENT, "Garden Space")).toEqual([]);

	// Handled: marked past it, it is never pending again.
	await setMark(chat, "r1");
	expect(await pendingMessages(obj, chat, TRIAGE, "Inbox Triage")).toEqual([]);

	// A lost mark (a restart, another computer): the agent's reply after the reaction seeds the surface.
	const replied = taskWith("react-replied", [msg("t1", TRIAGE, 100, TARGET_TEXT), reaction("r1", HUMAN, 200, "t1", "👍"), msg("t2", TRIAGE, 300, "Moved the call to Monday.")]);
	expect(await pendingMessages(replied, humanRef(replied.id), TRIAGE, "Inbox Triage")).toEqual([]);
	restore();
});
