/**
 * A reaction is an event on a message, never words: an agent reads it as one
 * line saying who reacted with what to whose message - or took it back.
 */
import { expect, test } from "bun:test";
import type { BlockJSON, ObjectJSON } from "./api";
import { classifyBlocks } from "./conversation";
import { reactionLine, reactionSuperseded } from "./reactions";

const AGENT = "9b08be05-ed4b-4417-a976-1efead0cb561";
const HUMAN = "816854963a03323d";
const THREAD = "__thread__reactions";

const reactionMeta = (emoji: string, removed = false): Record<string, string> => ({ author: HUMAN, ts: "200", text: "", replyTo: "m1", kind: "reaction", emoji, ...(removed ? { removed: "1" } : {}) });

test("a reaction reads as one line: who, the emoji, whose message and what it said", () => {
	const target = { author: "Inbox Triage", text: "Found 1 new message from Ada:\n\ncan we move Friday's call?" };
	expect(reactionLine("Grant", reactionMeta("✅"), target)).toBe(`Grant reacted ✅ to Inbox Triage's message: "Found 1 new message from Ada: can we move Friday's call?"`);
	expect(reactionLine("Grant", reactionMeta("✅", true), target)).toBe(`Grant removed their ✅ reaction from Inbox Triage's message: "Found 1 new message from Ada: can we move Friday's call?"`);
	// The reader's own message, and one that is gone.
	expect(reactionLine("user", reactionMeta("👍"), { author: "you", text: "Done." })).toBe(`user reacted 👍 to your message: "Done."`);
	expect(reactionLine("user", reactionMeta("👍"), null)).toBe("user reacted 👍 to a message that is no longer there");
	// A long message is cut, so one reaction stays one line.
	const long = reactionLine("user", reactionMeta("👀"), { author: "you", text: "x".repeat(500) });
	expect(long).toBe(`user reacted 👀 to your message: "${"x".repeat(200)}…"`);
});

test("a later line by the same person, emoji and message is the reaction's state", () => {
	const metas = [reactionMeta("👍"), reactionMeta("❤️"), reactionMeta("👍", true)];
	expect(reactionSuperseded(metas, 0)).toBe(true);
	expect(reactionSuperseded(metas, 1)).toBe(false);
	expect(reactionSuperseded(metas, 2)).toBe(false);
	// ❤ and ❤️ are one reaction.
	expect(reactionSuperseded([reactionMeta("❤️"), reactionMeta("❤", true)], 0)).toBe(true);
});

test("in a transcript a reaction is a line of its own, never an empty message", () => {
	const chat = (id: string, meta: Record<string, string>): BlockJSON => ({ id, childrenIds: [], content: { custom: { contentType: "chat", meta } } });
	const blocks: BlockJSON[] = [
		{ id: THREAD, childrenIds: ["m1", "r1", "r2"], content: { custom: { contentType: "discussion", meta: {} } } },
		chat("m1", { author: AGENT, ts: "100", text: "Drafted the reply." }),
		chat("r1", reactionMeta("✅")),
		chat("r2", reactionMeta("✅", true)),
	];
	const obj = { id: "task", typeKey: "task", fields: {}, blocks } as unknown as ObjectJSON;
	expect(classifyBlocks(obj, AGENT, THREAD).map((item) => (item.kind === "user_text" || item.kind === "assistant_text" ? [item.kind, item.text] : [item.kind]))).toEqual([
		["assistant_text", "Drafted the reply."],
		["user_text", `someone reacted ✅ to your message: "Drafted the reply."`],
		["user_text", `someone removed their ✅ reaction from your message: "Drafted the reply."`],
	]);
});
