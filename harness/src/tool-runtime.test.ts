/**
 * A Tool whose current code can't run - it won't compile, or it crashes -
 * falls back to the last version that worked on this computer, and the
 * Tool's Error says so (never over a human's words); the computer takes its
 * note back once the current version works. An error a tool reports on
 * purpose is its answer, not a broken version.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessServe } from "./tool-host";
import { compileProblem, contentHash, runObjectTool, type ObjectTool } from "./tool-runtime";

const originalFetch = globalThis.fetch;
let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-runtime-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "mac-1" }));
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

/** A daemon knowing this computer as "Test Mac"; returns the mutations made. */
function daemon(): Array<Record<string, unknown>> {
	const mutations: Array<Record<string, unknown>> = [];
	const mac = { id: "mac-object", typeKey: "machine", fields: { machine_id: { stringValue: "mac-1" }, name: { stringValue: "Test Mac" } }, createdAt: 1, updatedAt: 1 };
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === "/api/query") return Response.json({ records: [mac], total: 1 });
		if (url.pathname === "/api/mutate") {
			mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return mutations;
}

const tool = (version: number, code: string, error = ""): ObjectTool => ({
	id: "tool-1",
	def: { name: "greet", description: "greet", input_schema: { type: "object", properties: {} } },
	builtin: false,
	code,
	hash: contentHash(code),
	version,
	broken: compileProblem(code),
	error,
});
const context = { agentId: "agent", objectId: "", channelId: "space", machineId: "mac-1" };
/** These tools never ask the harness anything. */
const noHarness: HarnessServe = async (method) => {
	throw new Error(`unexpected harness call ${method}`);
};

/** The Error texts written to the Tool, in order (null: cleared). */
function notes(mutations: Array<Record<string, unknown>>): Array<string | null> {
	return mutations
		.filter((m) => m.key === "error")
		.map((m) => {
			const value = m.value;
			return typeof value === "object" && value !== null && "stringValue" in value ? String(value.stringValue) : null;
		});
}

test("a version that crashes or won't compile runs the last one that worked here, and the Tool says so", async () => {
	const mutations = daemon();
	expect(await runObjectTool(tool(1, 'return "v1";'), {}, context, noHarness)).toMatchObject({ ok: true, value: "v1" });
	expect(notes(mutations)).toEqual([]);
	expect(await runObjectTool(tool(2, "return input.missing.field;"), {}, context, noHarness)).toMatchObject({ ok: true, value: "v1" });
	expect(notes(mutations)).toEqual([expect.stringMatching(/^Version 2 failed on Test Mac: TypeError: .+ - running version 1$/)]);
	const unparsable = tool(3, "return {");
	expect(unparsable.broken).toContain("doesn't compile");
	expect(await runObjectTool(unparsable, {}, context, noHarness)).toMatchObject({ ok: true, value: "v1" });
	expect(notes(mutations).at(-1)).toMatch(/^Version 3 failed on Test Mac: its code doesn't compile: .+ - running version 1$/);
});

test("an error a tool reports on purpose is its answer, not a broken version", async () => {
	const mutations = daemon();
	await runObjectTool(tool(1, 'return "v1";'), {}, context, noHarness);
	expect(await runObjectTool(tool(2, 'throw new Error("no such mailbox");'), {}, context, noHarness)).toMatchObject({ ok: false, error: "no such mailbox", crashed: false });
	expect(notes(mutations)).toEqual([]);
});

test("once the current version works the computer takes back its own note, and never writes over a human's", async () => {
	const mutations = daemon();
	await runObjectTool(tool(1, 'return "v1";'), {}, context, noHarness);
	expect(await runObjectTool(tool(3, 'return "v3";', "Version 2 failed on Test Mac: TypeError: x - running version 1"), {}, context, noHarness)).toMatchObject({ ok: true, value: "v3" });
	expect(notes(mutations)).toEqual([null]);
	// Another computer's note is that computer's to take back.
	await runObjectTool(tool(3, 'return "v3";', "Version 2 failed on Lou's PC: TypeError: x - running version 1"), {}, context, noHarness);
	expect(notes(mutations)).toEqual([null]);
	expect(await runObjectTool(tool(4, "return input.missing.field;", "Waiting on Lou's API key"), {}, context, noHarness)).toMatchObject({ ok: true, value: "v3" });
	expect(notes(mutations)).toEqual([null]);
});

test("with no version that worked here, a recovery copy answers when the harness keeps one; else the crash is the answer", async () => {
	const mutations = daemon();
	expect(await runObjectTool(tool(1, "return input.missing.field;"), {}, context, noHarness, async () => "the frozen copy")).toMatchObject({ ok: true, value: "the frozen copy" });
	expect(notes(mutations).at(-1)).toMatch(/ - running the harness's recovery copy$/);
	const run = await runObjectTool(tool(1, "return input.missing.field;", String(notes(mutations).at(-1))), {}, context, noHarness);
	expect(run.ok).toBe(false);
	expect(notes(mutations).at(-1)).toMatch(/ - no working version on this computer$/);
});
