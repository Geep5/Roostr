/**
 * Agent tools as Roostr objects (type `tool`).
 *
 * A Tool object's `name` is what the model calls, `description` what it is
 * told, `tool_inputs` its inputs - one per line, `name: type - description`,
 * `name?` optional, a type of choices written `day|week|month` - and its
 * body's Code blocks are the code: TypeScript, an async function body
 * given `input` and `roostr` (tool-sdk.ts), run in its
 * own process (tool-host.ts), versioned and with a fallback to the last
 * version that worked on this computer (tool-runtime.ts). A Tool that can't
 * be read at all (a bad name or inputs) says so on its Error property and
 * is left out until fixed.
 *
 * Every built-in tool is a Tool object too (`tool_builtin`), one per space
 * this computer serves an agent in, marked shipped-with-Roostr, and its
 * object's code is what runs (`tool_runtime: "object"`, tool-code.ts), so a
 * person may edit it. The harness seeds it and replaces it with a newer
 * shipped version only while it is exactly what was seeded
 * (`tool_seeded_hash`); an edited one is kept, and `tool_update_available`
 * (the newer harness's time) says Roostr now ships something else. A
 * built-in an older harness wrote as a photo of its own handler (no
 * `tool_runtime`) is rewritten to the shipped code: nobody could edit it.
 *
 * Several computers on different harness versions share those objects, so
 * each carries the commit time of the harness that last wrote it
 * (`tool_source_at`) and only a newer harness touches it.
 *
 * An agent's Tools property (`tools`) links the Tool objects it may call
 * beyond the always-on core: its custom tools, and the gated built-ins
 * (shell_exec, web_fetch - tools.ts GATED_TOOLS). A spawned helper carries
 * its top-level agent's.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createObject, deleteField, fetchObject, mutate, queryAll, setField, str, sv, vanishedEntries, wasDeleted, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { bodyBlocks } from "./surfaces";
import { TOOL_TYPE } from "./tool-sdk";
import { CODE_STYLE, INPUTS_KEY, NOT_LOADED, SHIPPED_TOOLS, automatedError, compileProblem, contentHash, fallbackVersion, numberVersion, parseToolInputs, renderToolInputs, toolCode, type ObjectTool } from "./tool-runtime";
import { dispatchTool, runObjectToolFor, type ToolContext, type Toolset } from "./tools";

export const TOOLS_KEY = "tools";
const BUILTIN_KEY = "tool_builtin";
const SOURCE_AT_KEY = "tool_source_at";
/** "object": a built-in whose object's code is what runs (every built-in a current harness writes). */
const RUNTIME_KEY = "tool_runtime";
/** The hash of the description, inputs and code the harness last seeded a built-in with. */
const SEEDED_KEY = "tool_seeded_hash";
/** On an edited built-in: the time of a harness that ships a different version. */
const UPDATE_KEY = "tool_update_available";
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const SHIPPED_NOTE = "Built-in, shipped with Roostr: the code below is what runs, so editing it changes this tool for every agent in the space. A newer Roostr replaces it only while it is unedited.";

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

/** A built-in whose Tool object's code is what runs. */
function runsObjectCode(fields: Record<string, ValueJSON>): boolean {
	return isBuiltin(fields) && str(fields, RUNTIME_KEY) === "object" && SHIPPED_TOOLS.has(str(fields, "name"));
}

// ── Built-ins ───────────────────────────────────────────────────

/** A built-in tool as its Tool object starts out: `code` is what runs. */
export interface BuiltinSpec {
	name: string;
	description: string;
	inputs: string;
	code: string;
}

export function builtinSpecs(): BuiltinSpec[] {
	return [...SHIPPED_TOOLS.values()].map((t) => ({ name: t.def.name, description: t.def.description, inputs: renderToolInputs(t.def.input_schema), code: t.code }));
}

const BUILTIN_NAMES: ReadonlySet<string> = new Set(builtinSpecs().map((s) => s.name));

let sourceAt: Promise<number> | undefined;

/**
 * When this harness's built-in tools last changed: the commit time of the
 * files that make up what their Tool objects hold, else (no git checkout)
 * the newest file time.
 */
function builtinSourceAt(): Promise<number> {
	sourceAt ??= (async () => {
		const files = [join(import.meta.dir, "tool-objects.ts"), join(import.meta.dir, "tool-runtime.ts"), ...[...SHIPPED_TOOLS.keys()].map((name) => join(import.meta.dir, "tool-code", `${name}.ts`))];
		const proc = Bun.spawn(["git", "log", "-1", "--format=%ct", "--", ...files], { cwd: import.meta.dir, stdout: "pipe", stderr: "ignore" });
		const out = (await new Response(proc.stdout).text()).trim();
		if ((await proc.exited) === 0 && /^\d+$/.test(out)) return Number(out) * 1000;
		return Math.floor(Math.max(...(await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs)))));
	})();
	return sourceAt;
}

/** What a built-in's object holds that a person may change, as one hash. */
const specHash = (description: string, inputs: string, code: string): string => contentHash(JSON.stringify([description, inputs, code]));

/** Make the object hold `spec`: its description, inputs, and a body of the note and the code. */
async function writeSpec(obj: ObjectJSON, spec: BuiltinSpec): Promise<void> {
	if (str(obj.fields, "description") !== spec.description) await setField(obj.id, "description", sv(spec.description));
	if (str(obj.fields, INPUTS_KEY) !== spec.inputs) await (spec.inputs ? setField(obj.id, INPUTS_KEY, sv(spec.inputs)) : deleteField(obj.id, INPUTS_KEY));
	for (const e of bodyBlocks(obj)) if (e.depth === 0) await mutate("block_remove", { object_id: obj.id, block_id: e.id });
	await writeBody(obj.id, spec);
}

async function writeBody(id: string, spec: BuiltinSpec): Promise<void> {
	for (const [text, style] of [[SHIPPED_NOTE, 0], [spec.code, CODE_STYLE]] as const) {
		await mutate("block_add", { object_id: id, block: { id: crypto.randomUUID(), childrenIds: [], content: { text: { text, style } } } });
	}
}

/**
 * Bring a built-in to `spec` (a newer harness's), unless a person edited
 * it: what the harness seeded (or an older harness's photo of its handler,
 * which nobody could edit) is replaced; an edit is kept, flagged when
 * Roostr now ships something else. Returns what happened, null for nothing.
 */
async function syncShippedCode(obj: ObjectJSON, spec: BuiltinSpec, at: number): Promise<"rewritten" | "kept" | null> {
	const shipped = specHash(spec.description, spec.inputs, spec.code);
	const current = specHash(str(obj.fields, "description"), str(obj.fields, INPUTS_KEY), toolCode(obj));
	const seeded = str(obj.fields, SEEDED_KEY);
	if (str(obj.fields, RUNTIME_KEY) !== "object" || current === seeded) {
		if (current === shipped && seeded === shipped) return null;
		await writeSpec(obj, spec);
		await setField(obj.id, RUNTIME_KEY, sv("object"));
		await setField(obj.id, SEEDED_KEY, sv(shipped));
		if (obj.fields[UPDATE_KEY]) await deleteField(obj.id, UPDATE_KEY);
		await setField(obj.id, SOURCE_AT_KEY, { intValue: at });
		return "rewritten";
	}
	// A person's edit. It now matches what ships: nothing is behind any more.
	if (current === shipped) {
		await setField(obj.id, SEEDED_KEY, sv(shipped));
		if (obj.fields[UPDATE_KEY]) await deleteField(obj.id, UPDATE_KEY);
		return null;
	}
	if (shipped === seeded) return null;
	if (obj.fields[UPDATE_KEY]?.intValue !== at) await setField(obj.id, UPDATE_KEY, { intValue: at });
	await setField(obj.id, SOURCE_AT_KEY, { intValue: at });
	return "kept";
}

/**
 * Make `space`'s built-in Tool objects hold `specs`: create the missing
 * ones; bring one up to date only when `at` (the harness's time) is newer
 * than the one it holds - an older or equal harness never touches it, so
 * two computers can't take turns rewriting it. Returns the Tool object id
 * per built-in name, and what changed.
 */
export async function syncBuiltinTools(space: string, specs: BuiltinSpec[], at: number): Promise<{ ids: Map<string, string>; created: string[]; rewritten: string[]; kept: string[] }> {
	const rows = await queryAll({ type: TOOL_TYPE, filters: [{ key: "channel", condition: "equal", value: space }] });
	// Find-or-create by (space, name, built-in); the oldest wins should two computers have raced.
	const existing = new Map<string, QueryRow>();
	for (const r of rows) {
		if (!isBuiltin(r.fields)) continue;
		const have = existing.get(str(r.fields, "name"));
		if (!have || r.createdAt < have.createdAt) existing.set(str(r.fields, "name"), r);
	}
	await dropRacedCopies(space, rows.filter((r) => isBuiltin(r.fields) && existing.get(str(r.fields, "name"))?.id !== r.id));
	const ids = new Map<string, string>();
	const created: string[] = [];
	const rewritten: string[] = [];
	const kept: string[] = [];
	for (const spec of specs) {
		const row = existing.get(spec.name);
		if (!row) {
			const { id } = await createObject(spec.name, TOOL_TYPE, {
				channel: sv(space),
				name: sv(spec.name),
				description: sv(spec.description),
				...(spec.inputs ? { [INPUTS_KEY]: sv(spec.inputs) } : {}),
				[BUILTIN_KEY]: { boolValue: true },
				[RUNTIME_KEY]: sv("object"),
				[SEEDED_KEY]: sv(specHash(spec.description, spec.inputs, spec.code)),
				[SOURCE_AT_KEY]: { intValue: at },
			});
			await writeBody(id, spec);
			ids.set(spec.name, id);
			created.push(spec.name);
			continue;
		}
		ids.set(spec.name, row.id);
		if ((row.fields[SOURCE_AT_KEY]?.intValue ?? 0) >= at) continue;
		const done = await syncShippedCode(await fetchObject(row.id), spec, at);
		if (done === "rewritten") rewritten.push(spec.name);
		if (done === "kept") kept.push(spec.name);
	}
	return { ids, created, rewritten, kept };
}

/**
 * Built-in copies a second computer created while seeding the same space
 * (the oldest is the one kept). Only a copy nobody edited and nothing links
 * - no agent's Tools, no repeat's Check first - is deleted; anything else
 * stays rather than break a link or lose an edit.
 */
async function dropRacedCopies(space: string, copies: QueryRow[]): Promise<void> {
	if (copies.length === 0) return;
	const linking = [
		...(await queryAll({ type: "agent", filters: [{ key: "channel", condition: "equal", value: space }] })).flatMap((r) => linkIds(r.fields, TOOLS_KEY)),
		...(await queryAll({ filters: [{ key: "check_first", condition: "notEmpty" }, { key: "channel", condition: "equal", value: space }] })).flatMap((r) => linkIds(r.fields, "check_first")),
	];
	const linked = new Set(linking);
	for (const copy of copies) {
		if (linked.has(copy.id)) continue;
		const obj = await fetchObject(copy.id);
		const current = specHash(str(obj.fields, "description"), str(obj.fields, INPUTS_KEY), toolCode(obj));
		if (current !== str(obj.fields, SEEDED_KEY)) continue;
		await mutate("delete", { object_id: copy.id });
		console.log(`[tools] removed a duplicate built-in ${str(obj.fields, "name")} in ${space.slice(0, 8)}`);
	}
}

const synced = new Map<string, Promise<Map<string, string>>>();

/** Up to this long, a computer finding a space with no built-ins yet waits before creating them, so two computers seeing a new space at once rarely both do. */
const FRESH_SPACE_SETTLE_MS = 12_000;

/**
 * This harness's built-ins as Tool objects in `space`, synced once per
 * process. Every space gets them - at boot and when a new space appears -
 * so its agents can be given tools and people can read and edit them.
 * Resolves to the Tool object id per built-in name; none in a space that
 * was deleted (vanished or left), which is never written to.
 */
export function ensureBuiltinTools(space: string): Promise<Map<string, string>> {
	const known = synced.get(space);
	if (known) return known;
	const run = (async () => {
		const before = await queryAll({ type: TOOL_TYPE, filters: [{ key: "channel", condition: "equal", value: space }] });
		if (!before.some((r) => isBuiltin(r.fields))) await Bun.sleep(Math.floor(Math.random() * FRESH_SPACE_SETTLE_MS));
		// Checked after the settle: the space may have been deleted while this computer waited.
		if ((await vanishedEntries()).some((entry) => entry.objectId === space)) return new Map<string, string>();
		try {
			const res = await syncBuiltinTools(space, builtinSpecs(), await builtinSourceAt());
			if (res.created.length || res.rewritten.length) console.log(`[tools] built-in Tool objects in ${space.slice(0, 8)}: ${res.created.length} created, ${res.rewritten.length} updated`);
			if (res.kept.length) console.log(`[tools] edited built-ins kept in ${space.slice(0, 8)} (a newer version ships): ${res.kept.join(", ")}`);
			return res.ids;
		} catch (err) {
			if (!wasDeleted(err)) throw err;
			// Deleted mid-sync: settled for good, so this stays the cached answer.
			console.log(`[tools] space ${space.slice(0, 8)} was deleted while its built-ins were written; skipped`);
			return new Map<string, string>();
		}
	})();
	synced.set(space, run);
	// A failed sync is retried by the next caller.
	run.catch(() => synced.delete(space));
	return run;
}

/** Every space's built-in Tool objects (boot): one space at a time, a failure logged and the rest still done. */
export async function ensureBuiltinToolsEverywhere(): Promise<void> {
	for (const space of await queryAll({ type: "channel" })) {
		await ensureBuiltinTools(space.id).catch((err) => console.error(`[tools] built-in Tool objects for ${space.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
	}
}

// ── Loading Tool objects ────────────────────────────────────────

/**
 * A Tool object as a tool the model can call (numbering a new version of
 * its code on the way), or `problem`: what keeps it from being one, or - a
 * built-in, which is always offered - what it is offered without. Code that
 * won't compile still makes a tool (`broken`): this computer may have a
 * version that works.
 */
export async function objectToolFrom(obj: ObjectJSON): Promise<{ tool: ObjectTool | null; problem: string }> {
	const name = str(obj.fields, "name").trim();
	const shipped = runsObjectCode(obj.fields) ? SHIPPED_TOOLS.get(name) : undefined;
	if (!shipped) {
		if (!TOOL_NAME.test(name)) return { tool: null, problem: `its name "${name}" must be lowercase letters, digits and _ (starting with a letter, at most 64) - it is what the model calls` };
		if (BUILTIN_NAMES.has(name)) return { tool: null, problem: `"${name}" is a built-in tool's name; pick another` };
	}
	const inputs = parseToolInputs(str(obj.fields, INPUTS_KEY));
	if ("error" in inputs && !shipped) return { tool: null, problem: inputs.error };
	const code = toolCode(obj);
	const hash = contentHash(code);
	const tool: ObjectTool = {
		id: obj.id,
		def: { name, description: str(obj.fields, "description") || name, input_schema: "error" in inputs ? (shipped?.def.input_schema ?? {}) : inputs.schema },
		builtin: !!shipped,
		code,
		hash,
		version: code.trim() ? await numberVersion(obj, hash) : 0,
		broken: compileProblem(code),
		error: str(obj.fields, "error"),
	};
	return { tool, problem: "error" in inputs ? `${inputs.error} - offered with its shipped inputs until that's fixed` : "" };
}

/** Loaded Tool objects by id, valid while the object's `updatedAt` is. */
const loaded = new Map<string, { at: number; tool: ObjectTool | null; problem: string }>();

/** Put a problem on the Tool's Error property, or clear the one written for that; never a human's. */
async function noteProblem(row: QueryRow, problem: string): Promise<void> {
	const current = str(row.fields, "error");
	const next = problem ? `${NOT_LOADED}${problem}`.slice(0, 300) : "";
	if (next && automatedError(current) && current !== next) await setField(row.id, "error", sv(next));
	else if (!next && current.startsWith(NOT_LOADED)) await deleteField(row.id, "error");
}

/** One Tool of the agent's space as a tool, or null (why noted on it). `rows`: the space's Tool objects. */
async function loadTool(row: QueryRow, rows: QueryRow[]): Promise<ObjectTool | null> {
	const name = str(row.fields, "name").trim();
	// Two custom Tools with one name: the older keeps it.
	const first = rows
		.filter((r) => !isBuiltin(r.fields) && str(r.fields, "name").trim() === name)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
	let hit = loaded.get(row.id);
	if (!isBuiltin(row.fields) && first && first.id !== row.id && TOOL_NAME.test(name)) hit = { at: row.updatedAt, tool: null, problem: `another Tool here is already named "${name}"` };
	else if (!hit || hit.at !== row.updatedAt) {
		hit = { at: row.updatedAt, ...(await objectToolFrom(await fetchObject(row.id))) };
		loaded.set(row.id, hit);
	}
	await noteProblem(row, hit.problem);
	const tool = hit.tool;
	// A custom tool whose code can't run and has no version that worked here is left out until fixed; a built-in stays, its calls saying why.
	if (tool && tool.broken && !tool.builtin && !(await fallbackVersion(tool))) return null;
	return tool;
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

/**
 * What an agent runs from Tool objects (a helper: its top-level agent's),
 * read fresh each call: its space's built-ins, and what its
 * Tools property lists - gated built-ins and custom tools.
 */
export async function agentToolset(agent: ObjectJSON): Promise<Toolset> {
	const top = await topAgent(agent);
	const space = str(top.fields, "channel");
	// The space's built-in Tool objects exist before its tools are read.
	if (space) await ensureBuiltinTools(space).catch((err) => console.error(`[tools] built-in Tool objects for ${space.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
	const rows = await queryAll({ type: TOOL_TYPE, ...(space ? { filters: [{ key: "channel", condition: "equal", value: space }] } : {}) });
	const granted = new Set<string>();
	const objects = new Map<string, ObjectTool>();
	const shipped = new Map<string, QueryRow>();
	for (const r of rows) {
		if (!runsObjectCode(r.fields)) continue;
		const have = shipped.get(str(r.fields, "name"));
		if (!have || r.createdAt < have.createdAt) shipped.set(str(r.fields, "name"), r);
	}
	for (const row of shipped.values()) {
		const tool = await loadTool(row, rows);
		if (tool) objects.set(tool.def.name, tool);
	}
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const id of linkIds(top.fields, TOOLS_KEY)) {
		// Deleted, or not a Tool of the agent's space: nothing to give.
		const row = byId.get(id);
		if (!row) continue;
		if (isBuiltin(row.fields)) {
			if (BUILTIN_NAMES.has(str(row.fields, "name"))) granted.add(str(row.fields, "name"));
			continue;
		}
		const tool = await loadTool(row, rows);
		if (tool) objects.set(tool.def.name, tool);
	}
	return { granted, objects };
}

/**
 * Run one Tool object without a model (a repeating object's Check first):
 * from its code; a built-in whose object an older harness wrote as a photo
 * of its handler runs this harness's shipped code by name. Throws when it
 * can't run or fails.
 */
export async function runToolObject(id: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ name: string; value: unknown }> {
	const obj = await fetchObject(id);
	if (obj.deleted || obj.typeKey !== TOOL_TYPE) throw new Error(`${id.slice(0, 8)} is not a Tool`);
	const name = str(obj.fields, "name") || id.slice(0, 8);
	if (isBuiltin(obj.fields) && !runsObjectCode(obj.fields)) {
		const out = await dispatchTool(name, input, ctx);
		if (out.isError) throw new Error(out.content.replace(/^error: /, ""));
		return { name, value: out.content };
	}
	const { tool, problem } = await objectToolFrom(obj);
	if (!tool) throw new Error(problem);
	const run = await runObjectToolFor(tool, input, ctx);
	if (!run.ok) throw new Error(run.error);
	return { name, value: run.value };
}
