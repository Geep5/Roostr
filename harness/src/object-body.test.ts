/**
 * Body editing tools act only on lines a human reads on the page, and
 * refuse (writing nothing) when the request can't land as asked: a
 * conversation message is not a body line, a paragraph is not a checkbox,
 * and a line can't move into its own nested lines. The tools run their
 * shipped code (tool-code/) in-process against a fake daemon.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockJSON, ObjectJSON } from "./api";
import objectAddText from "./tool-code/object_add_text";
import objectCheck from "./tool-code/object_check";
import objectDelete from "./tool-code/object_delete";
import objectEditBlock from "./tool-code/object_edit_block";
import objectGet from "./tool-code/object_get";
import objectMoveBlock from "./tool-code/object_move_block";
import objectRemoveBlocks from "./tool-code/object_remove_blocks";
import objectSetField from "./tool-code/object_set_field";
import { TOOL_EDIT_REFUSAL, createRoostr, harnessCalls, type Roostr } from "./tool-sdk";

/** These tools never ask the harness anything. */
const noHarness = harnessCalls(async (method) => {
	throw new Error(`unexpected harness call ${method}`);
});

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-body-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const text = (id: string, body: string, style = 0, children: string[] = []): BlockJSON => ({ id, childrenIds: children, content: { text: { text: body, style } } });

/** "# Plan" holding a checkbox; a note; and a discussion with one message. */
const page = (): ObjectJSON => ({
	id: "page",
	typeKey: "task",
	fields: { channel: { stringValue: "space" } },
	blocks: [
		text("plan", "Plan", 1, ["todo"]),
		text("todo", "Review with Brian", 8),
		text("note", "Notes"),
		{ id: "__discussion__", childrenIds: ["msg"], content: { custom: { contentType: "discussion" } } },
		{ id: "msg", childrenIds: [], content: { custom: { contentType: "chat", meta: { text: "hello" } } } },
	],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
	mailbox: [],
});

function daemon(obj: ObjectJSON) {
	const mutations: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === `/api/objects/${obj.id}`) return Response.json(obj);
		if (url.pathname === "/api/channels") return Response.json([{ id: "space" }]);
		if (url.pathname === "/api/mutate") {
			mutations.push(JSON.parse(String(init?.body)));
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return mutations;
}

const SHIPPED: Record<string, (input: Record<string, unknown>, roostr: Roostr) => Promise<string>> = {
	object_add_text: objectAddText,
	object_check: objectCheck,
	object_delete: objectDelete,
	object_edit_block: objectEditBlock,
	object_move_block: objectMoveBlock,
	object_remove_blocks: objectRemoveBlocks,
	object_set_field: objectSetField,
};

/** One call of a shipped tool in a turn on "page", its refusal read as the agent reads it. */
async function call(name: string, input: Record<string, unknown>): Promise<string> {
	try {
		return await SHIPPED[name](input, createRoostr({ agentId: "agent", objectId: "page", channelId: "space", machineId: "m" }, new Set(), noHarness));
	} catch (err) {
		return `error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

test("object_get (its shipped code) lists body lines with their ids and never the conversation", async () => {
	daemon(page());
	const touched = new Set<string>();
	const got = JSON.parse(await objectGet({ id: "page" }, createRoostr({ agentId: "agent", objectId: "page", channelId: "space", machineId: "m" }, touched, noHarness)));
	expect(touched).toEqual(new Set(["page"]));
	expect(got.body).toEqual([
		{ block: "plan", depth: 0, line: "# Plan" },
		{ block: "todo", depth: 1, line: "- [ ] Review with Brian" },
		{ block: "note", depth: 0, line: "Notes" },
	]);
});

test("a conversation message is not a body line: editing it is refused", async () => {
	const mutations = daemon(page());
	for (const [tool, input] of [
		["object_edit_block", { block: "msg", text: "rewritten" }],
		["object_remove_blocks", { blocks: ["msg"] }],
		["object_move_block", { block: "msg", to: "note", where: "after" }],
	] as const) {
		expect(await call(tool, input)).toStartWith("error: nothing");
	}
	expect(mutations).toEqual([]);
});

test("only a checkbox line can be ticked", async () => {
	const mutations = daemon(page());
	expect(await call("object_check", { block: "note", checked: true })).toStartWith("error: nothing written");
	expect(mutations).toEqual([]);
});

test("a line cannot move into its own nested lines", async () => {
	const mutations = daemon(page());
	expect(await call("object_move_block", { block: "plan", to: "todo", where: "after" })).toStartWith("error: nothing moved");
	expect(mutations).toEqual([]);
});

test("removing a mix of real and unknown ids removes nothing", async () => {
	const mutations = daemon(page());
	expect(await call("object_remove_blocks", { blocks: ["note", "nope"] })).toStartWith("error: nothing removed");
	expect(mutations).toEqual([]);
});

test("editing a line keeps its style and says when inline formatting is cleared", async () => {
	const obj = page();
	(obj.blocks[1].content.text as NonNullable<BlockJSON["content"]["text"]>).marks = [{ from: 0, to: 6, type: 1 }];
	const mutations = daemon(obj);
	const reply = await call("object_edit_block", { block: "todo", text: "Review with Brian and Lou" });
	expect(mutations[0]).toMatchObject({ action: "block_update", block_id: "todo", content: { text: { text: "Review with Brian and Lou", style: 8, marks: [] } } });
	expect(reply).toContain("formatting");
});

test("agents can't change a Tool object - its fields, its code lines, or by deleting it - and tools written as objects can't either", async () => {
	const tool = { ...page(), typeKey: "tool" };
	const mutations = daemon(tool);
	for (const [name, input] of [
		["object_set_field", { id: "page", key: "description", value: "rewritten" }],
		["object_edit_block", { block: "note", text: "return 1;" }],
		["object_add_text", { id: "page", text: "return 2;" }],
		["object_delete", { id: "page" }],
	] as const) {
		expect(await call(name, input)).toStartWith(`error: ${TOOL_EDIT_REFUSAL}`);
	}
	const roostr = createRoostr({ agentId: "agent", objectId: "", channelId: "space", machineId: "m" }, new Set(), noHarness);
	await expect(roostr.setField("page", "description", { stringValue: "rewritten" })).rejects.toThrow(TOOL_EDIT_REFUSAL);
	await expect(roostr.mutate("block_add", { object_id: "page", block: {} })).rejects.toThrow(TOOL_EDIT_REFUSAL);
	await expect(roostr.create("sneaky", "tool")).rejects.toThrow(TOOL_EDIT_REFUSAL);
	expect(mutations).toEqual([]);
});
