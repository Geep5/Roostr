/**
 * Agent tools as Roostr objects (type `tool`).
 *
 * A Tool object's `name` is what the model calls, `description` what it is
 * told, `tool_inputs` its inputs - one per line, `name: type - description`,
 * `name?` optional - and its body's Code blocks are the code: TypeScript, an
 * async function body given `input` and `roostr` (tool-sdk.ts), run in its
 * own process (tool-host.ts). Problems with one (a bad name, no code, ...)
 * go on its Error property, and it is left out until fixed.
 *
 * Every built-in tool is mirrored as a Tool object too (`tool_builtin`), one
 * per space this computer serves an agent in: its real handler source in a
 * Code block, kept current by the harness - editing it changes nothing.
 * Several computers on different harness versions share those objects, so
 * each carries the commit time of the source it shows (`tool_source_at`)
 * and only a newer harness rewrites it.
 *
 * An agent's Tools property (`tools`) links the Tool objects it may call
 * beyond the always-on core: its custom tools, and the gated built-ins
 * (shell_exec, web_fetch - tools.ts GATED_TOOLS). A spawned helper carries
 * its top-level agent's.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createObject, deleteField, fetchObject, mutate, queryAll, setField, str, sv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { machineId } from "./roster";
import { toolModule, runToolCode } from "./tool-host";
import { BUILTIN_TOOLS, bodyBlocks, dispatchTool, type RegisteredTool, type ToolContext, type Toolset } from "./tools";
import type { CustomTool } from "./types";

const TOOL_TYPE = "tool";
export const TOOLS_KEY = "tools";
const INPUTS_KEY = "tool_inputs";
const BUILTIN_KEY = "tool_builtin";
const SOURCE_AT_KEY = "tool_source_at";
/** The editor's Style.CODE. */
const CODE_STYLE = 5;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** Marks the Error messages this module writes, so it only ever clears its own. */
const PROBLEM = "Not loaded: ";
export const BUILTIN_NOTE = "Built-in: runs the harness's own code (harness/src/tools.ts). Edits here don't change what runs.";

/** Object ids a link property lists: one link, a list of links, or plain id strings. */
export function linkIds(fields: Record<string, ValueJSON>, key: string): string[] {
	const v = fields[key];
	if (!v) return [];
	const items = v.valuesValue?.items ?? [v];
	return items.map((i) => i.linkValue?.targetId || i.stringValue || "").filter(Boolean);
}

/** A link list value for `key`. */
export function linkList(key: string, ids: string[]): ValueJSON {
	return { valuesValue: { items: ids.map((targetId) => ({ linkValue: { relationKey: key, targetId } })) } };
}

const isBuiltin = (fields: Record<string, ValueJSON>): boolean => fields[BUILTIN_KEY]?.boolValue === true;

// ── Inputs ──────────────────────────────────────────────────────

/** The input types a line may name, as JSON schema. */
const INPUT_TYPES: Record<string, Record<string, unknown>> = {
	string: { type: "string" },
	number: { type: "number" },
	boolean: { type: "boolean" },
	"string[]": { type: "array", items: { type: "string" } },
	object: { type: "object" },
};
const INPUT_LINE = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*(\S+)\s*(?:-\s*(.*))?$/;

/** `tool_inputs` text as the JSON schema the model gets, or what is wrong with it. */
export function parseToolInputs(text: string): { schema: Record<string, unknown> } | { error: string } {
	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const m = INPUT_LINE.exec(line);
		if (!m || !Object.hasOwn(INPUT_TYPES, m[3])) {
			return { error: `the input line "${line}" isn't "name: type - description" with a type of ${Object.keys(INPUT_TYPES).join(", ")}` };
		}
		const [, name, optional, type, description] = m;
		if (Object.hasOwn(properties, name)) return { error: `the input "${name}" is listed twice` };
		properties[name] = { ...INPUT_TYPES[type], ...(description?.trim() ? { description: description.trim() } : {}) };
		if (!optional) required.push(name);
	}
	return { schema: { type: "object", properties, ...(required.length ? { required } : {}) } };
}

/** The parts of a built-in's JSON schema property the Inputs line shows. */
interface SchemaProperty {
	type?: string;
	items?: { type?: string };
	description?: string;
	enum?: string[];
}

/** A built-in's input schema in the `tool_inputs` line format. */
export function renderToolInputs(schema: Record<string, unknown>): string {
	// Built-in schemas are this harness's own literals (tools.ts).
	const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
	const required = Array.isArray(schema.required) ? schema.required : [];
	return Object.entries(properties)
		.map(([name, p]) => {
			const list = p.type === "array";
			const type = p.type === "integer" ? "number" : list ? (p.items?.type === "string" ? "string[]" : "object") : p.type && Object.hasOwn(INPUT_TYPES, p.type) ? p.type : "object";
			const notes = [p.description?.replace(/\s+/g, " ").trim() ?? "", list && type === "object" ? "(a JSON list)" : "", p.enum ? `(one of: ${p.enum.join(", ")})` : ""].filter(Boolean).join(" ");
			return `${name}${required.includes(name) ? "" : "?"}: ${type}${notes ? ` - ${notes}` : ""}`;
		})
		.join("\n");
}

/** The tool's code: its Code blocks' text, in reading order. */
export function toolCode(obj: ObjectJSON): string {
	return bodyBlocks(obj)
		.flatMap((e) => (e.block.content.text?.style === CODE_STYLE ? [e.block.content.text.text] : []))
		.join("\n");
}

// ── Built-ins ───────────────────────────────────────────────────

/** A built-in tool as its Tool object shows it. */
export interface BuiltinSpec {
	name: string;
	description: string;
	inputs: string;
	source: string;
}

export function builtinSpecs(tools: readonly RegisteredTool[] = BUILTIN_TOOLS): BuiltinSpec[] {
	return tools.map((t) => ({ name: t.def.name, description: t.def.description, inputs: renderToolInputs(t.def.input_schema), source: t.handler.toString() }));
}

const BUILTIN_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS.map((t) => t.def.name));

let sourceAt: Promise<number> | undefined;

/**
 * When this harness's built-in tools last changed: the commit time of the
 * files that make up what their Tool objects show, else (no git checkout)
 * the newest file time.
 */
function builtinSourceAt(): Promise<number> {
	sourceAt ??= (async () => {
		const files = [join(import.meta.dir, "tools.ts"), join(import.meta.dir, "tool-objects.ts")];
		const proc = Bun.spawn(["git", "log", "-1", "--format=%ct", "--", ...files], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) === 0 && /^\d+$/.test(out)) return Number(out) * 1000;
		return Math.floor(Math.max(...(await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs)))));
	})();
	return sourceAt;
}

/** Does the Tool object already show `spec` exactly? */
function showsSpec(obj: ObjectJSON, spec: BuiltinSpec): boolean {
	const body = bodyBlocks(obj);
	return (
		str(obj.fields, "description") === spec.description &&
		str(obj.fields, INPUTS_KEY) === spec.inputs &&
		body.length === 2 &&
		body[0].block.content.text?.text === BUILTIN_NOTE &&
		body[1].block.content.text?.style === CODE_STYLE &&
		body[1].block.content.text.text === spec.source
	);
}

async function writeBuiltinBody(id: string, source: string): Promise<void> {
	for (const [text, style] of [[BUILTIN_NOTE, 0], [source, CODE_STYLE]] as const) {
		await mutate("block_add", { object_id: id, block: { id: crypto.randomUUID(), childrenIds: [], content: { text: { text, style } } } });
	}
}

/**
 * Make `space`'s built-in Tool objects show `specs`: create the missing
 * ones; rewrite one only when `at` (the source's time) is newer than the
 * one it shows and something differs - an older or equal harness never
 * touches it, so two computers can't take turns rewriting it. Returns the
 * Tool object id per built-in name.
 */
export async function syncBuiltinTools(space: string, specs: BuiltinSpec[], at: number): Promise<{ ids: Map<string, string>; created: string[]; rewritten: string[] }> {
	const rows = await queryAll({ type: TOOL_TYPE, filters: [{ key: "channel", condition: "equal", value: space }] });
	// Find-or-create by (space, name, built-in); the oldest wins should two computers have raced.
	const existing = new Map<string, QueryRow>();
	for (const r of rows) {
		if (!isBuiltin(r.fields)) continue;
		const have = existing.get(str(r.fields, "name"));
		if (!have || r.createdAt < have.createdAt) existing.set(str(r.fields, "name"), r);
	}
	const ids = new Map<string, string>();
	const created: string[] = [];
	const rewritten: string[] = [];
	for (const spec of specs) {
		const row = existing.get(spec.name);
		if (!row) {
			const { id } = await createObject(spec.name, TOOL_TYPE, {
				channel: sv(space),
				name: sv(spec.name),
				description: sv(spec.description),
				...(spec.inputs ? { [INPUTS_KEY]: sv(spec.inputs) } : {}),
				[BUILTIN_KEY]: { boolValue: true },
				[SOURCE_AT_KEY]: { intValue: at },
			});
			await writeBuiltinBody(id, spec.source);
			ids.set(spec.name, id);
			created.push(spec.name);
			continue;
		}
		ids.set(spec.name, row.id);
		if ((row.fields[SOURCE_AT_KEY]?.intValue ?? 0) >= at) continue;
		const obj = await fetchObject(row.id);
		if (showsSpec(obj, spec)) continue;
		if (str(obj.fields, "description") !== spec.description) await setField(obj.id, "description", sv(spec.description));
		if (str(obj.fields, INPUTS_KEY) !== spec.inputs) await (spec.inputs ? setField(obj.id, INPUTS_KEY, sv(spec.inputs)) : deleteField(obj.id, INPUTS_KEY));
		for (const e of bodyBlocks(obj)) if (e.depth === 0) await mutate("block_remove", { object_id: obj.id, block_id: e.id });
		await writeBuiltinBody(obj.id, spec.source);
		await setField(obj.id, SOURCE_AT_KEY, { intValue: at });
		rewritten.push(spec.name);
	}
	return { ids, created, rewritten };
}

const synced = new Map<string, Promise<Map<string, string>>>();

/**
 * This harness's built-ins as Tool objects in `space`, synced once per
 * process (boot, and the first time an agent of a newly served space is
 * taken in). Resolves to the Tool object id per built-in name.
 */
export function ensureBuiltinTools(space: string): Promise<Map<string, string>> {
	const known = synced.get(space);
	if (known) return known;
	const run = (async () => {
		const res = await syncBuiltinTools(space, builtinSpecs(), await builtinSourceAt());
		if (res.created.length || res.rewritten.length) console.log(`[tools] built-in Tool objects in ${space.slice(0, 8)}: ${res.created.length} created, ${res.rewritten.length} updated`);
		return res.ids;
	})();
	synced.set(space, run);
	// A failed sync is retried by the next caller.
	run.catch(() => synced.delete(space));
	return run;
}

// ── Custom tools ────────────────────────────────────────────────

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** A custom Tool object as a tool the model can call, or what keeps it from being one. */
export function customToolFrom(obj: ObjectJSON): CustomTool | string {
	const name = str(obj.fields, "name").trim();
	if (!TOOL_NAME.test(name)) return `its name "${name}" must be lowercase letters, digits and _ (starting with a letter, at most 64) - it is what the model calls`;
	if (BUILTIN_NAMES.has(name)) return `"${name}" is a built-in tool's name; pick another`;
	const inputs = parseToolInputs(str(obj.fields, INPUTS_KEY));
	if ("error" in inputs) return inputs.error;
	const code = toolCode(obj);
	if (!code.trim()) return "its body has no code - write the TypeScript in a Code block";
	try {
		transpiler.transformSync(toolModule(code));
	} catch (err) {
		return `its code doesn't compile: ${err instanceof Error ? err.message : String(err)}`;
	}
	return { id: obj.id, def: { name, description: str(obj.fields, "description") || name, input_schema: inputs.schema }, code };
}

/** Parsed custom tools by object id, valid while the object's `updatedAt` is. */
const parsed = new Map<string, { at: number; tool: CustomTool | string }>();

/** Put a problem on the Tool's Error property, or clear the one this module wrote; never a human's. */
async function noteProblem(row: QueryRow, problem: string): Promise<void> {
	const current = str(row.fields, "error");
	const ours = current === "" || current.startsWith(PROBLEM);
	const next = problem ? `${PROBLEM}${problem}`.slice(0, 300) : "";
	if (next && ours && current !== next) await setField(row.id, "error", sv(next));
	else if (!next && current.startsWith(PROBLEM)) await deleteField(row.id, "error");
}

/** One linked custom Tool, or null when it has a problem (noted on it). `rows`: the space's Tool objects. */
async function customTool(row: QueryRow, rows: QueryRow[]): Promise<CustomTool | null> {
	const name = str(row.fields, "name").trim();
	// Two custom Tools with one name: the older keeps it.
	const first = rows
		.filter((r) => !isBuiltin(r.fields) && str(r.fields, "name").trim() === name)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
	let tool: CustomTool | string;
	if (first && first.id !== row.id && TOOL_NAME.test(name)) tool = `another Tool here is already named "${name}"`;
	else {
		const hit = parsed.get(row.id);
		if (hit && hit.at === row.updatedAt) tool = hit.tool;
		else {
			tool = customToolFrom(await fetchObject(row.id));
			parsed.set(row.id, { at: row.updatedAt, tool });
		}
	}
	await noteProblem(row, typeof tool === "string" ? tool : "");
	return typeof tool === "string" ? null : tool;
}

/** The top-level agent a spawned helper works for: its Tools are the helper's. */
async function topAgent(agent: ObjectJSON): Promise<ObjectJSON> {
	let current = agent;
	for (let hops = 0; hops < 8 && str(current.fields, "spawn_parent"); hops++) {
		const parent = await fetchObject(str(current.fields, "spawn_parent")).catch(() => null);
		// A helper whose parent is gone has no Tools of its own.
		if (!parent) return current;
		current = parent;
	}
	return current;
}

/** What an agent's Tools property gives it (a helper: its top-level agent's), read fresh each call. */
export async function agentToolset(agent: ObjectJSON): Promise<Toolset> {
	const top = await topAgent(agent);
	const ids = linkIds(top.fields, TOOLS_KEY);
	const granted = new Set<string>();
	const custom = new Map<string, CustomTool>();
	if (ids.length === 0) return { granted, custom };
	const space = str(top.fields, "channel");
	const rows = await queryAll({ type: TOOL_TYPE, ...(space ? { filters: [{ key: "channel", condition: "equal", value: space }] } : {}) });
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const id of ids) {
		// Deleted, or not a Tool of the agent's space: nothing to give.
		const row = byId.get(id);
		if (!row) continue;
		if (isBuiltin(row.fields)) {
			if (BUILTIN_NAMES.has(str(row.fields, "name"))) granted.add(str(row.fields, "name"));
			continue;
		}
		const tool = await customTool(row, rows);
		if (tool) custom.set(tool.def.name, tool);
	}
	return { granted, custom };
}

/**
 * Run one Tool object without a model (a repeating object's Check first): a
 * built-in through dispatchTool, a custom one in its own process. Throws
 * when it can't run or fails.
 */
export async function runToolObject(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ name: string; value: unknown }> {
	const obj = await fetchObject(id);
	if (obj.deleted || obj.typeKey !== TOOL_TYPE) throw new Error(`${id.slice(0, 8)} is not a Tool`);
	const name = str(obj.fields, "name") || id.slice(0, 8);
	if (isBuiltin(obj.fields)) {
		const out = await dispatchTool(name, input, ctx);
		if (out.isError) throw new Error(out.content.replace(/^error: /, ""));
		return { name, value: out.content };
	}
	const tool = customToolFrom(obj);
	if (typeof tool === "string") throw new Error(tool);
	const run = await runToolCode(tool.code, input, { agentId: ctx.agentId, objectId: ctx.boundObject ?? "", channelId: ctx.channelId, machineId: await machineId() });
	if (run.log.trim()) console.log(`[tool] ${name}: ${run.log.trim().slice(-500)}`);
	if (!run.ok) throw new Error(run.error);
	return { name, value: run.value };
}
