/**
 * Working notes: text a model writes alongside a tool call is stored on the
 * call, not as a chat message. The model's history must still read as it
 * answered - its words, then the call - and nothing else in the thread may
 * count it as something the agent said in chat.
 */

import { expect, test } from "bun:test";
import type { BlockJSON, ObjectJSON } from "./api";
import { classifyBlocks, groupIntoTurns, repairToolPairs } from "./conversation";
import { BLOCK_TOOL_RESULT, BLOCK_TOOL_USE } from "./types";

const AGENT = "agent-1";
const THREAD = "__thread__t";

function thread(children: BlockJSON[]): ObjectJSON {
	return {
		id: "obj",
		typeKey: "task",
		fields: {},
		blocks: [{ id: THREAD, childrenIds: children.map((b) => b.id), content: {} }, ...children],
		deleted: false,
		createdAt: 0,
		updatedAt: 0,
		mailbox: [],
	} as ObjectJSON;
}

const block = (id: string, contentType: string, meta: Record<string, string>): BlockJSON => ({ id, childrenIds: [], content: { custom: { contentType, meta } } });

test("a tool call's note reads back as the model's own words before the call", () => {
	const obj = thread([
		block("u", "chat", { author: "person", text: "feature them" }),
		block("c", BLOCK_TOOL_USE, { tool_use_id: "t1", tool_name: "credential_action", input: "{}", note: "Let me check the list." }),
		block("r", BLOCK_TOOL_RESULT, { tool_use_id: "t1", content: "[]", is_error: "false" }),
	]);
	const items = classifyBlocks(obj, AGENT, THREAD);
	// Not a chat block: nothing that reads chat messages sees it.
	expect(obj.blocks.filter((b) => b.content.custom?.contentType === "chat")).toHaveLength(1);
	const turns = groupIntoTurns(repairToolPairs(items));
	expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
	expect(turns[1].content).toEqual([
		{ type: "text", text: "Let me check the list." },
		{ type: "tool_use", id: "t1", name: "credential_action", input: {} },
	]);
	// The note shares the call's block id, so a compaction boundary on the call keeps both.
	expect(items.filter((i) => i.blockId === "c").map((i) => i.kind)).toEqual(["assistant_text", "tool_use"]);
});

test("a call with no note is just the call", () => {
	const obj = thread([block("c", BLOCK_TOOL_USE, { tool_use_id: "t1", tool_name: "object_get", input: "{}" })]);
	expect(classifyBlocks(obj, AGENT, THREAD).map((i) => i.kind)).toEqual(["tool_use"]);
});
