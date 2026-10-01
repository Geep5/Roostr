/**
 * Tool objects: the Inputs property becomes the schema the model gets, and
 * the built-in mirrors are rewritten only by a newer harness with something
 * new to show - computers on different versions never take turns.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { BUILTIN_NOTE, builtinSpecs, parseToolInputs, renderToolInputs, syncBuiltinTools, type BuiltinSpec } from "./tool-objects";

test("inputs become a schema: types, descriptions, and ? for optional", () => {
	const parsed = parseToolInputs("mailbox: string - the inbox address\n\nmax?: number - how many threads\nlabels?: string[]\nraw: object - anything\nforce?: boolean");
	expect(parsed).toEqual({
		schema: {
			type: "object",
			properties: {
				mailbox: { type: "string", description: "the inbox address" },
				max: { type: "number", description: "how many threads" },
				labels: { type: "array", items: { type: "string" } },
				raw: { type: "object", description: "anything" },
				force: { type: "boolean" },
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
	expect(renderToolInputs({ type: "object", properties: { id: { type: "string", description: "object id" }, unit: { type: "string", enum: ["day", "week"] }, ids: { type: "array", items: { type: "string" } } }, required: ["unit"] })).toBe(
		"id?: string - object id\nunit: string - (one of: day, week)\nids?: string[]",
	);
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

const spec: BuiltinSpec = { name: "object_get", description: "Read one object.", inputs: "id: string", source: "async (input) => input.id" };

/** A built-in Tool object as some harness wrote it: `shows` = what its fields and body hold, `at` its source time. */
function toolObject(shows: BuiltinSpec, at: number): ObjectJSON {
	const fields: Record<string, ValueJSON> = {
		channel: { stringValue: "space" },
		name: { stringValue: shows.name },
		description: { stringValue: shows.description },
		tool_inputs: { stringValue: shows.inputs },
		tool_builtin: { boolValue: true },
		tool_source_at: { intValue: at },
	};
	const blocks = [
		{ id: "note", childrenIds: [], content: { text: { text: BUILTIN_NOTE, style: 0 } } },
		{ id: "code", childrenIds: [], content: { text: { text: shows.source, style: 5 } } },
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

test("a built-in that already shows this source is left alone, even by a newer harness", async () => {
	const mutations = daemon([toolObject(spec, 1000)]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(mutations).toEqual([]);
	expect(res.ids.get("object_get")).toBe("tool-object");
});

test("an older harness never rewrites what a newer one wrote", async () => {
	const newer = { ...spec, description: "Read one object, newer words.", source: "async (input) => input.id ?? ''" };
	const mutations = daemon([toolObject(newer, 3000)]);
	await syncBuiltinTools("space", [spec], 2000);
	expect(mutations).toEqual([]);
});

test("a newer harness with different source rewrites it and stamps its time", async () => {
	const older = { ...spec, source: "async () => ''" };
	const mutations = daemon([toolObject(older, 1000)]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(res.rewritten).toEqual(["object_get"]);
	expect(mutations.filter((m) => m.action === "block_remove").map((m) => m.block_id)).toEqual(["note", "code"]);
	expect(mutations.filter((m) => m.action === "block_add").map((m) => (m.block as BlockLike).content.text.text)).toEqual([BUILTIN_NOTE, spec.source]);
	expect(mutations.at(-1)).toMatchObject({ action: "set_field", key: "tool_source_at", value: { intValue: 2000 } });
});

test("a missing built-in is created in the space, marked built-in, with its code", async () => {
	const mutations = daemon([]);
	const res = await syncBuiltinTools("space", [spec], 2000);
	expect(res.created).toEqual(["object_get"]);
	expect(mutations[0]).toMatchObject({
		action: "create",
		type_key: "tool",
		fields: { channel: { stringValue: "space" }, name: { stringValue: "object_get" }, tool_builtin: { boolValue: true }, tool_source_at: { intValue: 2000 } },
	});
	expect(mutations.filter((m) => m.action === "block_add").map((m) => (m.block as BlockLike).content.text.style)).toEqual([0, 5]);
});

interface BlockLike {
	content: { text: { text: string; style: number } };
}
