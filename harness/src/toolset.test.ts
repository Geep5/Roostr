/**
 * An agent's Tools property decides shell, web and its custom tools: a
 * gated built-in its Tools don't list is neither offered nor runnable, and
 * a custom Tool it lists is offered and runs (in its own process) with the
 * model's input.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentHash, type ObjectTool } from "./tool-runtime";
import { dispatchTool, toolDefs, type Toolset } from "./tools";

let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-toolset-"));
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const toolset = (granted: string[], custom: ObjectTool[] = []): Toolset => ({ granted: new Set(granted), objects: new Map(custom.map((t) => [t.def.name, t])) });
const names = (t: Toolset, template = "") => new Set(toolDefs(template, 0, true, t).map((d) => d.name));

const code = "return { got: input.word, on: roostr.context.objectId };";
// Not a Tool object (no id): just its code, with nothing to fall back to.
const echo: ObjectTool = {
	id: "",
	def: { name: "echo_input", description: "echo", input_schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } },
	builtin: false,
	code,
	hash: contentHash(code),
	version: 1,
	broken: "",
	error: "",
};

test("an agent whose Tools list neither is offered neither shell nor web", () => {
	const none = names(toolset([]));
	expect(none.has("shell_exec")).toBe(false);
	expect(none.has("web_fetch")).toBe(false);
	// Everything else is still there - taking two tools away, not the agent.
	expect(none.has("object_get")).toBe(true);
	expect(none.has("chat_reply_on")).toBe(true);
});

test("each listed built-in unlocks only itself", () => {
	const shellOnly = names(toolset(["shell_exec"]));
	expect(shellOnly.has("shell_exec")).toBe(true);
	expect(shellOnly.has("web_fetch")).toBe(false);
});

test("a gated tool called without being listed is refused before it runs", async () => {
	const ctx = { agentId: "a", channelId: "s", depth: 0, touched: new Set<string>(), toolset: toolset([]) };
	const res = await dispatchTool("shell_exec", { command: "touch /tmp/should-not-exist-grant-test" }, ctx);
	expect(res.content).toContain("not one of your tools");
	expect(await Bun.file("/tmp/should-not-exist-grant-test").exists()).toBe(false);
});

test("a custom tool is offered to the agent and its helpers, but not to read-only explorers", () => {
	const t = toolset([], [echo]);
	expect(names(t).has("echo_input")).toBe(true);
	expect(names(t, "task").has("echo_input")).toBe(true);
	expect(names(t, "explore").has("echo_input")).toBe(false);
});

test("calling a custom tool runs its code with the model's input and the turn's object", async () => {
	const ctx = { agentId: "a", channelId: "s", boundObject: "obj-9", depth: 0, touched: new Set<string>(), toolset: toolset([], [echo]) };
	const res = await dispatchTool("echo_input", { word: "hello" }, ctx);
	expect(res.isError).toBe(false);
	expect(JSON.parse(res.content)).toEqual({ got: "hello", on: "obj-9" });
});
