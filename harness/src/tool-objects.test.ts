/**
 * Tool objects: the Inputs property becomes the schema the model gets; a
 * built-in's object is rewritten only by a newer harness, so computers on
 * different versions never take turns, and only while nobody edited it - an
 * older harness's photo of its own handler becomes the shipped code; and a
 * Tool's version counts changes to its code alone.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockJSON, ObjectJSON, ValueJSON } from "./api";
import { SHIPPED_NOTE, builtinSpecs, objectToolFrom, syncBuiltinTools, type BuiltinSpec } from "./tool-objects";
import { parseToolInputs, renderToolInputs } from "./tool-runtime";

test("inputs become a schema: types, choices, descriptions, and ? for optional", () => {
	const parsed = parseToolInputs("mailbox: string - the inbox address\n\nmax?: number - how many threads\nlabels?: string[]\nraw: object - anything\nforce?: boolean\nunit?: day|week|skill.install - how often");
	expect(parsed).toEqual({
		schema: {
			type: "object",
			properties: {
				mailbox: { type: "string", description: "the inbox address" },
				max: { type: "number", description: "how many threads" },
				labels: { type: "array", items: { type: "string" } },
				raw: { type: "object", description: "anything" },
				force: { type: "boolean" },
				unit: { type: "string", enum: ["day", "week", "skill.install"], description: "how often" },
			},
			required: ["mailbox", "raw"],
		},
	});
	expect(parseToolInputs("")).toEqual({ schema: { type: "object", properties: {} } });
});

test("a malformed or unknown-type line, or an input listed twice, is an error naming it", () => {
	for (const [text, needle] of [
		["mailbox - the inbox", '"mailbox - the inbox"'],
		["when: date - a day", '"when: date - a day"'],
		["toString: string", ""],
		["a: string\na?: number", 'input "a" is listed twice'],
		["unit: day|", '"unit: day|"'],
	] as const) {
		const parsed = parseToolInputs(text);
		if (!needle) {
			expect("schema" in parsed).toBe(true);
			continue;
		}
		expect(parsed).toEqual({ error: expect.stringContaining(needle) });
	}
	expect(parseToolInputs("x: valueOf")).toEqual({ error: expect.stringContaining("type of") });
});

test("every built-in's inputs render in the Inputs format and read back to the same names and required set", () => {
	for (const spec of builtinSpecs()) {
		const parsed = parseToolInputs(spec.inputs);
		if (!("schema" in parsed)) throw new Error(`${spec.name}: ${parsed.error}`);
		expect(Object.keys(parsed.schema.properties as Record<string, unknown>).length).toBe(spec.inputs ? spec.inputs.split("\n").length : 0);
	}
	expect(renderToolInputs({ type: "object", properties: { id: { type: "string", description: "object id" }, unit: { type: "string", enum: ["day", "week"] }, ids: { type: "array", items: { type: "string" } }, bounties: { type: "array", items: { type: "number" } }, filters: { type: "array", items: { type: "object" } } }, required: ["unit"] })).toBe(
		"id?: string - object id\nunit: day|week\nids?: string[]\nbounties?: number[]\nfilters?: object[]",
	);
	expect(parseToolInputs("filters?: object[]\nbounties: number[]")).toEqual({ schema: { type: "object", properties: { filters: { type: "array", items: { type: "object" } }, bounties: { type: "array", items: { type: "number" } } }, required: ["bounties"] } });
});

// ── Built-in sync against a fake daemon ──

const originalFetch = globalThis.fetch;
let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-tools-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const spec: BuiltinSpec = { name: "space_activity", description: "Recent life of this space.", inputs: "limit?: number", code: "return input.limit;" };

/** A built-in Tool object as an older harness wrote it, showing its own handler's source (no `tool_runtime`): `shows` = what its fields and body hold, `at` its source time. */
function handlerPhoto(shows: BuiltinSpec, at: number): ObjectJSON {
	const fields: Record<string, ValueJSON> = {
		channel: { stringValue: "space" },
		name: { stringValue: shows.name },
		description: { stringValue: shows.description },
		tool_inputs: { stringValue: shows.inputs },
		tool_builtin: { boolValue: true },
		tool_source_at: { intValue: at },
	};
	const blocks = [
		{ id: "note", childrenIds: [], content: { text: { text: "Built-in: runs the harness's own code (harness/src/tools.ts). Edits here don't change what runs.", style: 0 } } },
		{ id: "code", childrenIds: [], content: { text: { text: "async (input) => input.limit", style: 5 } } },
	];
	return { id: "tool-object", typeKey: "tool", fields, blocks, deleted: false, createdAt: 1, updatedAt: 1 };
}

/** A daemon holding these Tool objects; returns the mutations the sync made. */
function daemon(objects: ObjectJSON[]): Array<Record<string, unknown>> {
	const mutations: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/api/query") return Response.json({ records: objects, total: objects.length });
		const hit = objects.find((o) => url.pathname === `/api/objects/${o.id}`);
		if (hit) return Response.json(hit);
		if (url.pathname === "/api/mutate") {
			mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ ok: true, id: "new-tool" });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return mutations;
}

test("an older harness never rewrites what a newer one wrote", async () => {
	const mutations = daemon([handlerPhoto(spec, 3000)]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(mutations).toEqual([]);
	expect(res.ids.get("space_activity")).toBe("tool-object");
});

test("a newer harness turns an older one's photo of its handler into the shipped code, which is then what runs", async () => {
	const mutations = daemon([handlerPhoto(spec, 1000)]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(res.rewritten).toEqual(["space_activity"]);
	expect(mutations.filter((m) => m.action === "block_remove").map((m) => m.block_id)).toEqual(["note", "code"]);
	expect(mutations.filter((m) => m.action === "block_add").map((m) => (m.block as BlockLike).content.text.text)).toEqual([SHIPPED_NOTE, spec.code]);
	expect(mutations).toContainEqual(expect.objectContaining({ action: "set_field", key: "tool_runtime", value: { stringValue: "object" } }));
	expect(mutations.at(-1)).toMatchObject({ action: "set_field", key: "tool_source_at", value: { intValue: 2000 } });
});

test("a missing built-in is created in the space, marked built-in, with its code", async () => {
	const mutations = daemon([]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(res.created).toEqual(["space_activity"]);
	expect(mutations[0]).toMatchObject({
		action: "create",
		type_key: "tool",
		fields: { channel: { stringValue: "space" }, name: { stringValue: "space_activity" }, tool_builtin: { boolValue: true }, tool_runtime: { stringValue: "object" }, tool_source_at: { intValue: 2000 } },
	});
	expect(mutations.filter((m) => m.action === "block_add").map((m) => (m.block as BlockLike).content.text)).toEqual([
		{ text: SHIPPED_NOTE, style: 0 },
		{ text: spec.code, style: 5 },
	]);
});

interface BlockLike {
	content: { text: { text: string; style: number } };
}

// ── Built-ins whose code is their object's ──

const shipped: BuiltinSpec = { name: "object_get", description: "Read one object.", inputs: "id: string", code: "return await roostr.get(String(input.id));" };

/** The Tool object a harness at `at` creates for `spec`, as the daemon then holds it. */
async function seededObject(spec: BuiltinSpec, at: number): Promise<ObjectJSON> {
	const mutations = daemon([]);
	await syncBuiltinTools("space", [spec], at);
	const create = mutations.find((m) => m.action === "create");
	const blocks = mutations.filter((m) => m.action === "block_add").map((m) => m.block as BlockJSON);
	return { id: "tool-object", typeKey: "tool", fields: (create?.fields ?? {}) as Record<string, ValueJSON>, blocks, deleted: false, createdAt: 1, updatedAt: 1 };
}

test("a built-in still holding the code it was seeded with is left alone by a newer harness shipping the same", async () => {
	const mutations = daemon([await seededObject(shipped, 1000)]);
	const res = await syncBuiltinTools("space", [shipped], 2000);
	expect(mutations).toEqual([]);
	expect(res.rewritten).toEqual([]);
});

test("a newer harness replaces the shipped code it seeded while nobody edited it", async () => {
	const obj = await seededObject(shipped, 1000);
	expect(obj.fields.tool_runtime).toEqual({ stringValue: "object" });
	expect(obj.blocks.map((b) => b.content.text?.text)).toEqual([SHIPPED_NOTE, shipped.code]);
	const newer = { ...shipped, code: "return JSON.stringify(await roostr.get(String(input.id)));" };
	const mutations = daemon([obj]);
	const res = await syncBuiltinTools("space", [newer], 2000);
	expect(res.rewritten).toEqual(["object_get"]);
	expect(mutations.filter((m) => m.action === "block_add").map((m) => (m.block as BlockLike).content.text.text)).toEqual([SHIPPED_NOTE, newer.code]);
	expect(mutations.at(-1)).toMatchObject({ action: "set_field", key: "tool_source_at", value: { intValue: 2000 } });
});

test("a person's edit to shipped code is kept by a newer harness, which only notes that another version ships", async () => {
	const obj = await seededObject(shipped, 1000);
	obj.blocks[1] = { ...obj.blocks[1], content: { text: { text: "return 'mine';", style: 5 } } };
	const mutations = daemon([obj]);
	const res = await syncBuiltinTools("space", [{ ...shipped, code: "return 'shipped v2';" }], 2000);
	expect(res.kept).toEqual(["object_get"]);
	expect(mutations.filter((m) => m.action !== "set_field")).toEqual([]);
	expect(mutations).toContainEqual(expect.objectContaining({ action: "set_field", key: "tool_update_available", value: { intValue: 2000 } }));
	// A newer harness shipping what it seeded has nothing to say about the edit.
	const quiet = daemon([obj]);
	expect((await syncBuiltinTools("space", [shipped], 3000)).kept).toEqual([]);
	expect(quiet).toEqual([]);
});

test("a Tool's version counts changes to its code, never to anything else", async () => {
	const obj = await seededObject(shipped, 1000);
	let mutations = daemon([obj]);
	const first = await objectToolFrom(obj);
	expect(first.tool?.version).toBe(1);
	expect(mutations.map((m) => m.key)).toEqual(["tool_code_hash", "tool_version"]);
	obj.fields.tool_code_hash = mutations[0].value as ValueJSON;
	obj.fields.tool_version = { intValue: 1 };
	obj.fields.description = { stringValue: "Read one object, in other words." };
	mutations = daemon([obj]);
	expect((await objectToolFrom(obj)).tool?.version).toBe(1);
	expect(mutations).toEqual([]);
	obj.blocks[1] = { ...obj.blocks[1], content: { text: { text: "return 'v2';", style: 5 } } };
	mutations = daemon([obj]);
	expect((await objectToolFrom(obj)).tool?.version).toBe(2);
	expect(mutations.at(-1)).toMatchObject({ key: "tool_version", value: { intValue: 2 } });
});
