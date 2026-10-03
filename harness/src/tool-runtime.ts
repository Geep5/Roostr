/**
 * Tools whose code lives in their Tool objects - custom tools, and the
 * built-ins shipped that way (tool-code.ts) - as this computer loads and
 * runs them (each call in its own process, tool-host.ts), with three rails:
 *
 * - Versions. A harness numbers each new version of a Tool's code as it
 *   loads it: `tool_code_hash` holds the hash of the code it last saw and
 *   `tool_version` counts the changes. Edits to anything but the code never
 *   bump it, and neither do the saves of someone still typing - only code a
 *   harness picked up to run.
 * - Last known good. Each computer keeps, in GLON_DATA/tools/, the last
 *   version of each Tool that loaded and ran here. When the current code
 *   won't compile or crashes (tool-host.ts: a JavaScript error of its own,
 *   not an error it reports on purpose), the call runs that version instead
 *   and the Tool's Error says so; the computer clears what it wrote once the
 *   current version works. A human's Error text is never overwritten.
 * - Recovery copies. The harness keeps frozen copies of a few core tools
 *   (tools.ts RECOVERY_CORE), so a broken tool can always be repaired from
 *   anywhere; a copy runs only when its Tool has nothing else that works here.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteField, iv, num, setField, str, sv, type ObjectJSON } from "./api";
import { machines } from "./machine";
import { machineId } from "./roster";
import { bodyBlocks } from "./surfaces";
import { SHIPPED_CODE } from "./tool-code";
import { runToolCode, toolModule, type ToolRun } from "./tool-host";
import type { ToolRunContext } from "./tool-sdk";
import type { ToolDef } from "./types";

export const INPUTS_KEY = "tool_inputs";
export const VERSION_KEY = "tool_version";
export const CODE_HASH_KEY = "tool_code_hash";
/** The editor's Style.CODE. */
export const CODE_STYLE = 5;
/** Marks the Error text automation writes when a Tool can't be read at all (tool-objects.ts). */
export const NOT_LOADED = "Not loaded: ";
/** Marks this module's Error text: a version that failed on a computer, and what runs instead. */
const VERSION_FAILED = /^Version \d+ failed on /;

// ── The Tool format ─────────────────────────────────────────────

/** The input types a line may name, as JSON schema. */
const INPUT_TYPES: Record<string, Record<string, unknown>> = {
	string: { type: "string" },
	number: { type: "number" },
	boolean: { type: "boolean" },
	"string[]": { type: "array", items: { type: "string" } },
	"object[]": { type: "array", items: { type: "object" } },
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
			const listOf = p.items?.type === "string" || p.items?.type === "object" ? `${p.items.type}[]` : "object";
			const type = p.type === "integer" ? "number" : list ? listOf : p.type && Object.hasOwn(INPUT_TYPES, p.type) ? p.type : "object";
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

/** Short content hash: what tells one version of a Tool's code (or a shipped spec) from another. */
export function contentHash(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Why this code can't run as a tool ("" when it compiles). */
export function compileProblem(code: string): string {
	if (!code.trim()) return "its body has no code - write the TypeScript in a Code block";
	try {
		transpiler.transformSync(toolModule(code));
		return "";
	} catch (err) {
		return `its code doesn't compile: ${err instanceof Error ? err.message : String(err)}`;
	}
}

// ── Object tools ────────────────────────────────────────────────

/** A tool whose code is its Tool object's, as this computer will run it. */
export interface ObjectTool {
	/** Its Tool object; "" for a built-in running its shipped code because its space has no Tool object for it. */
	id: string;
	def: ToolDef;
	builtin: boolean;
	code: string;
	/** The code's hash, and the version the object numbers that code. */
	hash: string;
	version: number;
	/** Why the current code can't run ("" when it compiles). */
	broken: string;
	/** The object's Error text as last read or written here: this computer only replaces automation's, and only clears its own. */
	error: string;
}

/** Each shipped built-in as a tool running its shipped code, by name (in the order agents are offered them). */
export const SHIPPED_TOOLS: ReadonlyMap<string, ObjectTool> = new Map(
	SHIPPED_CODE.map((s) => {
		const inputs = parseToolInputs(s.inputs);
		if ("error" in inputs) throw new Error(`shipped tool ${s.name}: ${inputs.error}`);
		const tool: ObjectTool = { id: "", def: { name: s.name, description: s.description, input_schema: inputs.schema }, builtin: true, code: s.code, hash: contentHash(s.code), version: 0, broken: "", error: "" };
		return [s.name, tool];
	}),
);

/**
 * The version the object numbers `hash` (its current code), numbering a
 * new one when the object last recorded other code. The hash is written
 * first: a computer reading between the two writes then sees the code as
 * already numbered and never bumps it a second time.
 */
export async function numberVersion(obj: ObjectJSON, hash: string): Promise<number> {
	const version = num(obj.fields, VERSION_KEY) ?? 0;
	if (str(obj.fields, CODE_HASH_KEY) === hash && version > 0) return version;
	await setField(obj.id, CODE_HASH_KEY, sv(hash));
	await setField(obj.id, VERSION_KEY, iv(version + 1));
	return version + 1;
}

// ── Last known good ─────────────────────────────────────────────

/** A version of a Tool's code that loaded and ran on this computer. */
export interface GoodVersion {
	hash: string;
	version: number;
	code: string;
}

/** Read once per file; a run that works keeps it current. */
const goodVersions = new Map<string, GoodVersion | null>();

/** Where this computer keeps a Tool's last good version; null for an id that can't be a file name. */
function goodFile(toolId: string): string | null {
	if (!/^[A-Za-z0-9-]+$/.test(toolId)) return null;
	return join(process.env.GLON_DATA ?? join(homedir(), ".glon"), "tools", `${toolId}.json`);
}

/** The last version of this Tool that worked on this computer, if any. */
export async function lastKnownGood(toolId: string): Promise<GoodVersion | null> {
	const file = goodFile(toolId);
	if (!file) return null;
	if (goodVersions.has(file)) return goodVersions.get(file) ?? null;
	let good: GoodVersion | null = null;
	try {
		// Written by rememberGood below: the shape is ours.
		good = (await Bun.file(file).json()) as GoodVersion;
	} catch {
		// None yet, or unreadable: there is no earlier version to fall back to.
	}
	goodVersions.set(file, good);
	return good;
}

async function rememberGood(tool: ObjectTool): Promise<void> {
	const file = goodFile(tool.id);
	if (!file || (await lastKnownGood(tool.id))?.hash === tool.hash) return;
	const good: GoodVersion = { hash: tool.hash, version: tool.version, code: tool.code };
	await mkdir(join(file, ".."), { recursive: true });
	await Bun.write(file, JSON.stringify(good));
	goodVersions.set(file, good);
}

// ── The Tool's Error ────────────────────────────────────────────

/** Error text automation wrote (or none), so a newer automated note may replace it; anything else is a human's. */
export function automatedError(text: string): boolean {
	return text === "" || text.startsWith(NOT_LOADED) || VERSION_FAILED.test(text);
}

/** This computer's name as its Computer object shows it. */
async function computerName(): Promise<string> {
	const me = await machineId();
	return (await machines()).find((m) => m.machineId === me)?.name || me.slice(0, 8);
}

/** Say on the Tool that its current version failed on this computer, and what runs instead. */
async function noteFailure(tool: ObjectTool, why: string, instead: string): Promise<void> {
	const text = `Version ${tool.version} failed on ${await computerName()}: ${why.replace(/\s+/g, " ").slice(0, 200)} - ${instead}`;
	if (text === tool.error || !automatedError(tool.error)) return;
	await setField(tool.id, "error", sv(text));
	tool.error = text;
}

/** The current version works here: keep it as the last good one, and take back this computer's failure note. */
async function worked(tool: ObjectTool): Promise<void> {
	await rememberGood(tool);
	if (!VERSION_FAILED.test(tool.error) || !tool.error.replace(VERSION_FAILED, "").startsWith(`${await computerName()}: `)) return;
	await deleteField(tool.id, "error");
	tool.error = "";
}

/**
 * The fallback a Tool whose current code can't run has on this computer:
 * its last good version (when that is other code), else null.
 */
export async function fallbackVersion(tool: ObjectTool): Promise<GoodVersion | null> {
	const good = tool.id ? await lastKnownGood(tool.id) : null;
	return good && good.hash !== tool.hash ? good : null;
}

/**
 * Run an object-defined tool: its current code; else - it won't compile or
 * it crashed - the last version that worked on this computer; else the
 * harness's `recovery` copy, when it keeps one. Never throws.
 */
export async function runObjectTool(tool: ObjectTool, input: Record<string, unknown>, context: ToolRunContext, recovery?: () => Promise<string>): Promise<ToolRun> {
	let why = tool.broken;
	if (!why) {
		const run = await runToolCode(tool.code, input, context);
		if (run.ok || !run.crashed) {
			if (tool.id) await worked(tool);
			return run;
		}
		why = run.error;
		if (run.log.trim()) console.log(`[tool] ${tool.def.name} v${tool.version}: ${run.log.trim().slice(-500)}`);
	}
	console.log(`[tool] ${tool.def.name} v${tool.version} can't run here: ${why.slice(0, 300)}`);
	const good = await fallbackVersion(tool);
	if (good) {
		const run = await runToolCode(good.code, input, context);
		if (run.ok || !run.crashed) {
			await noteFailure(tool, why, `running version ${good.version}`);
			return run;
		}
	}
	if (recovery) {
		if (tool.id) await noteFailure(tool, why, "running the harness's recovery copy");
		try {
			return { ok: true, value: await recovery(), log: "", touched: [] };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err), crashed: false, log: "", touched: [] };
		}
	}
	if (tool.id) await noteFailure(tool, why, "no working version on this computer");
	return { ok: false, error: `version ${tool.version} of ${tool.def.name} can't run (${why.slice(0, 300)}) and this computer has no earlier version that worked - a person can fix it on its Tool page`, crashed: true, log: "", touched: [] };
}
