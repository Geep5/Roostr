/**
 * Tool registry: what an agent is offered, and how a call runs. In glon,
 * tools were data (ToolSpec rows dispatching to daemon programs via
 * dispatchProgram); in Roostr every built-in is data again - its code is its
 * Tool object's (tool-code.ts ships it, tool-objects.ts seeds it), run in its
 * own process (tool-runtime.ts) and asking the harness for what only the
 * harness can do (tool-harness.ts). The owner binding holds: the agent id is
 * bound here, never taken from model input. The harness runs no tool's code
 * of its own but the recovery core below.
 */

import { bv, fetchObject, fv, guestAgents, iv, lv, mutate, plainValue, str, sv, type ObjectJSON, type ValueJSON } from "./api";
import { HUMAN_THREAD, humanRef, postTo } from "./conv";
import { hideCredentialSecrets } from "./credentials";
import { appendMarkdown, inlineMarks } from "./markdown";
import { describeRepeat, localClock } from "./repeat";
import { machineId } from "./roster";
import { assertInSpace, defaultSpaceId, relationDefs } from "./spacemap";
import { bodyBlocks } from "./surfaces";
import { harnessFor } from "./tool-harness";
import type { ToolRun } from "./tool-host";
import { coerceToolInput } from "./tool-input";
import { SHIPPED_TOOLS, runObjectTool, type ObjectTool } from "./tool-runtime";
import { TOOL_EDIT_REFUSAL, TOOL_TYPE } from "./tool-sdk";
import { TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

export interface ToolContext {
	agentId: string;
	channelId: string;
	/** The object this turn's transcript lives on (unset on the agent's own page). */
	boundObject?: string;
	/** Only human-rooted top-level turns may initiate another agent exchange. */
	allowAsk?: boolean;
	depth: number;
	/** Wired by spawn.ts; declared here to break the import cycle. */
	spawn?: (task: string, template: string, ctx: ToolContext) => Promise<string>;
	/** Subagent-only: capture the structured result. */
	submitResult?: (content: string) => void;
	/** Compaction carryover: object ids touched by tools this run. */
	touched: Set<string>;
	/** What the agent runs from Tool objects and what its Tools property unlocks (tool-objects.ts); unset = every built-in running its shipped code, no custom tools (tests, internal callers). */
	toolset?: Toolset;
	/** The agent's Project folder (`repo_path`) on this machine - shell_exec's cwd when set. */
	workspacePath?: string;
}

type Handler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

/**
 * Built-ins only an agent's Tools property unlocks: running commands on
 * the serving computer and fetching the web are the two powers an agent
 * could turn against that computer or use to send data out, so an agent
 * has them only while its Tools list them (a support agent that reads mail
 * from strangers simply doesn't). Everything else is always on. Both
 * checks are the harness's: an unlisted one is refused here before its code
 * runs, and the power itself (roostr.shell, roostr.webPage) is refused by
 * the harness to any tool of an agent without it (tool-harness.ts).
 */
const GATED_TOOLS: Readonly<Record<string, true>> = { shell_exec: true, web_fetch: true };

/** What an agent runs from Tool objects (tool-objects.ts): the gated built-ins its Tools list, and every tool whose code is a Tool object's - its space's built-ins and its custom tools - by name. */
export interface Toolset {
	granted: ReadonlySet<string>;
	objects: ReadonlyMap<string, ObjectTool>;
}

const S = (v: unknown): string => (typeof v === "string" ? v : "");

// ── Space containment ────────────────────────────────────────────
//
// Agents are citizens of exactly one space. Reads list/search only that
// space; every id-taking tool verifies the target lives there (spacemap.ts
// assertInSpace). Bundled definitions (relations/types with no space stamp)
// are global infrastructure and stay readable. Objects with no stamp belong
// to the default space (the display fallback), so the default space
// includes them.

async function agentSpace(ctx: ToolContext): Promise<string> {
	return ctx.channelId || (await defaultSpaceId());
}

// ── Recovery core ────────────────────────────────────────────────

/**
 * The object a write acts on: in the agent's space, and never a Tool -
 * people edit tools, agents only call them (the SDK refuses the same,
 * tool-sdk.ts).
 */
async function writable(id: string, ctx: ToolContext): Promise<ObjectJSON> {
	const obj = await assertInSpace(await fetchObject(id), ctx.channelId);
	if (obj.typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
	return obj;
}

/**
 * A field value in the relation's own type, or why the input can't be one.
 * Agents speak strings; the store does not - a checkbox written as "true"
 * text is unchecked, a date as text never sorts. A value that would not
 * read back as what was meant is refused, never stored as text.
 */
function typedValue(format: string, raw: string): ValueJSON | { error: string } {
	const t = raw.trim();
	const n = t === "" ? NaN : Number(t);
	switch (format) {
		case "checkbox":
			if (t.toLowerCase() === "true") return bv(true);
			if (t.toLowerCase() === "false") return bv(false);
			return { error: `a checkbox takes true or false, not "${raw}"` };
		case "number":
			if (!Number.isFinite(n)) return { error: `a number property takes a number, not "${raw}"` };
			return Number.isInteger(n) ? iv(n) : fv(n);
		case "date": {
			if (Number.isFinite(n)) return iv(n);
			const parsed = Date.parse(t);
			return Number.isNaN(parsed) ? { error: `a date property takes an ISO date or epoch milliseconds, not "${raw}"` } : iv(parsed);
		}
		case "status":
			return lv(t ? [t] : []);
		// Tag and object relations are lists in the store (and in the UI):
		// a bare string here would render as an empty cell.
		case "tag":
		case "object":
			return lv(t.split(",").map((s) => s.trim()).filter(Boolean));
		default:
			return sv(raw);
	}
}

/** A stored value as the Properties pane shows it - what the human now sees. */
function renderValue(format: string, v: ValueJSON | undefined): string {
	if (!v) return "(empty)";
	if (v.boolValue !== undefined) return v.boolValue ? "checked" : "unchecked";
	const ms = v.intValue ?? v.floatValue;
	if (format === "date" && ms !== undefined) return new Date(ms).toLocaleString();
	if (ms !== undefined) return String(ms);
	const items = v.valuesValue?.items ?? [];
	if (v.valuesValue) return items.length ? items.map((i) => i.stringValue ?? i.linkValue?.targetId ?? "").join(", ") : "(empty)";
	return v.stringValue || "(empty)";
}

/** Field keys agents reach for when they mean a schedule: only object_set_repeat makes an object recur. */
const SCHEDULE_KEYS = new Set(["repeat", "repeats", "recurrence", "recurring", "recurs", "schedule", "frequency", "cadence"]);

/** object_get as the harness keeps it, frozen: what object_get's Tool object falls back to (RECOVERY_CORE). */
const objectGetCopy: Handler = async (input, ctx) => {
	ctx.touched.add(S(input.id));
	const obj = hideCredentialSecrets(await assertInSpace(await fetchObject(S(input.id)), ctx.channelId));
	const fields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj.fields)) fields[k] = plainValue(v);
	const body = bodyBlocks(obj);
	const shown = body.slice(0, 400);
	// A link card reads as the linked object's name on the page, so the agent sees that too (plus the id to open it).
	const lines = await Promise.all(
		shown.map(async (b) => {
			const target = b.block.content.custom?.contentType === "link" ? (b.block.content.custom.meta?.["target"] ?? "") : "";
			if (!target) return b.line;
			const o = await fetchObject(target).catch(() => null);
			return o && !o.deleted ? `[link] "${str(o.fields, "name") || "Untitled"}" (${o.typeKey}, object ${target})` : `[link to a deleted object ${target}]`;
		}),
	);
	return JSON.stringify(
		{
			id: obj.id,
			typeKey: obj.typeKey,
			fields,
			// Body, one entry per block: pass `block` to the object_*_block tools to change it.
			body: shown.map((b, i) => ({ block: b.id, depth: b.depth, line: lines[i].slice(0, 300) })),
			...(body.length > shown.length ? { bodyTruncated: body.length - shown.length } : {}),
		},
		null,
		1,
	);
};

const objectSetFieldCopy: Handler = async (input, ctx) => {
	ctx.touched.add(S(input.id));
	const obj = await writable(S(input.id), ctx);
	const key = S(input.key);
	if (SCHEDULE_KEYS.has(key.toLowerCase())) {
		return `error: nothing written. "${key}" does not make an object repeat - call object_set_repeat (every N days/weeks/months/years, weekdays, time).`;
	}
	const defs = await relationDefs(await agentSpace(ctx));
	const def = defs.get(key);
	if (!def) {
		const known = [...defs.values()].filter((d) => !d.readOnly).map((d) => `${d.key} (${d.name}, ${d.format})`).join(", ");
		return `error: nothing written. This space has no "${key}" property, so a value there would be invisible to everyone. Properties here: ${known}. If none fits, create one with object_add_property (it shows in everyone's Properties list), then set it - never report it as done before that.`;
	}
	if (def.readOnly) return `error: nothing written. ${def.name} is computed by the store and cannot be set.`;
	let value: ValueJSON;
	if (key === "agent") {
		const adding = S(input.value).split(",").map((s) => s.trim()).filter(Boolean);
		for (const aid of adding) {
			const agent = await fetchObject(aid).catch(() => null);
			if (agent?.typeKey !== "agent") return `error: nothing written. "${aid}" is not an agent object.`;
		}
		value = lv([...new Set([...guestAgents(obj.fields), ...adding])]);
	} else {
		const typed = typedValue(def.format, S(input.value));
		if ("error" in typed) return `error: nothing written. ${def.name}: ${typed.error}.`;
		value = typed;
	}
	// The clock rides along for the one case the engine needs it: done
	// on a recurring object advances the occurrence in local time.
	await mutate("set_field", { object_id: obj.id, key, value, ...localClock() });
	const after = await fetchObject(obj.id);
	if (key === "done" && after.fields["repeat"]) return `This object repeats, so the current occurrence was completed instead: ${describeRepeat(after.fields["repeat"])}.`;
	return `${def.name} is now: ${renderValue(def.format, after.fields[key])}`;
};

const objectAddTextCopy: Handler = async (input, ctx) => {
	const id = S(input.id);
	const under = S(input.under).trim();
	ctx.touched.add(id);
	const obj = await writable(id, ctx);
	// "under" nests the new lines in an existing block, matched by its text (case-insensitive).
	let parent = "";
	if (under) {
		const needle = under.toLowerCase();
		const hit =
			obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase() === needle) ??
			obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase().startsWith(needle));
		if (!hit) return `error: no block matching "${under}" - blocks were NOT added; re-check the text or omit "under"`;
		parent = hit.id;
	}
	const added = await appendMarkdown(obj.id, S(input.text), parent);
	return `ok: ${added} block(s) added${parent ? ` under "${under}"` : ""}`;
};

const objectEditBlockCopy: Handler = async (input, ctx) => {
	const id = S(input.id) || ctx.boundObject || "";
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await writable(id, ctx);
	ctx.touched.add(obj.id);
	const entry = bodyBlocks(obj).find((e) => e.id === S(input.block));
	if (!entry) return `error: nothing written. "${S(input.block)}" is not a line of this object's body. Read object_get's body for the ids.`;
	const t = entry.block.content.text;
	if (!t) return `error: nothing written. That line is a ${entry.block.content.custom?.contentType ?? "non-text"} block, not text.`;
	// Inline markdown in the new text (**bold**, [link](url), `code`) becomes real formatting.
	const { text, marks } = inlineMarks(S(input.text));
	const cleared = (t.marks ?? []).length > 0 && marks.length === 0;
	await mutate("block_update", { object_id: obj.id, block_id: entry.id, content: { ...entry.block.content, text: { ...t, text, marks } } });
	const now = bodyBlocks(await fetchObject(obj.id)).find((e) => e.id === entry.id);
	return `${now ? `Line is now: ${now.line}` : "The line is no longer in the body."}${cleared ? "\n(Its inline formatting - bold, links, mentions - was cleared with the old text.)" : ""}`;
};

const chatReplyOnCopy: Handler = async (input, ctx) => {
	await assertInSpace(await fetchObject(S(input.object_id)), ctx.channelId);
	// An object id alone addresses its human discussion; agent-to-agent
	// talk has its own thread (agent_ask) and never lands here.
	await postTo(humanRef(S(input.object_id)), S(input.text), ctx.agentId);
	return "ok";
};

/**
 * The recovery core: the harness's own frozen copies of what anyone needs
 * to repair things from anywhere - read an object, set a property, write
 * and edit its text, reply in its chat. Each of these tools' code is its
 * Tool object's; it falls back to its copy here only when that code is
 * broken and this computer has no earlier version of it that worked
 * (tool-runtime.ts).
 */
const RECOVERY_CORE: Readonly<Record<string, Handler>> = {
	object_get: objectGetCopy,
	object_set_field: objectSetFieldCopy,
	object_add_text: objectAddTextCopy,
	object_edit_block: objectEditBlockCopy,
	chat_reply_on: chatReplyOnCopy,
};

/** Built-ins not offered to every agent: the rules in builtinDefs place them. */
const PLACED: Readonly<Record<string, true>> = { agent_ask: true, spawn: true, shell_exec: true, submit_result: true };
/** What a read-only explorer may call. */
const READ_ONLY: Readonly<Record<string, true>> = { object_search: true, object_list: true, object_get: true, memory_recall: true, memory_list_facts: true, memory_list_milestones: true, skill_read: true, capability_list: true };

/**
 * The tools an agent is offered for a template ("" = a top-level agent).
 * `toolset`: what its Tools property adds - a gated built-in it doesn't
 * list is not offered at all, and its custom tools follow the built-ins
 * (not for explore, which is read-only, nor the installer). Omitted =
 * every built-in, for callers that only inspect the catalog.
 */
export function toolDefs(template: string, depth: number, allowAsk = false, toolset?: Toolset): ToolDef[] {
	const builtins = builtinDefs(template, depth, allowAsk)
		.filter((d) => !toolset || GATED_TOOLS[d.name] !== true || toolset.granted.has(d.name))
		// A built-in is offered as its space's Tool object describes it.
		.map((d) => toolset?.objects.get(d.name)?.def ?? d);
	const custom = toolset && template !== "explore" && template !== "installer" ? [...toolset.objects.values()].filter((t) => !t.builtin).map((t) => t.def) : [];
	return [...builtins, ...custom];
}

/**
 * Subagents never get the shell: a spawned child runs on its parent's
 * instructions, not the owner's, so it stops at depth 0 (installer
 * template excepted).
 */
function builtinDefs(template: string, depth: number, allowAsk: boolean): ToolDef[] {
	const def = (name: string): ToolDef[] => {
		const tool = SHIPPED_TOOLS.get(name);
		return tool ? [tool.def] : [];
	};
	// Least privilege: installs need only the shell and the result channel.
	if (template === "installer") return [...def("shell_exec"), ...def("submit_result")];
	let defs = [...SHIPPED_TOOLS.values()].map((t) => t.def).filter((d) => !Object.hasOwn(PLACED, d.name));
	if (template === "" && depth === 0) defs.push(...def("agent_ask"));
	if (template === "explore") defs = defs.filter((d) => Object.hasOwn(READ_ONLY, d.name));
	if (template === "") {
		defs.push(...def("spawn"));
		if (depth === 0) defs.push(...def("shell_exec"));
	} else defs.push(...def("submit_result"));
	if (template === "task" && depth < 2) defs.push(...def("spawn"));
	return defs;
}

/**
 * Run a tool whose code is a Tool object's (tool-runtime.ts) for this turn,
 * its calls to the harness answered for this turn (tool-harness.ts): a
 * built-in in the recovery core falls back to its frozen copy.
 */
export async function runObjectToolFor(tool: ObjectTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRun> {
	const copy = tool.builtin && Object.hasOwn(RECOVERY_CORE, tool.def.name) ? RECOVERY_CORE[tool.def.name] : undefined;
	const context = { agentId: ctx.agentId, objectId: ctx.boundObject ?? "", channelId: ctx.channelId, machineId: await machineId() };
	const run = await runObjectTool(tool, input, context, harnessFor(ctx), copy && (() => copy(input, ctx)));
	for (const id of run.touched) ctx.touched.add(id);
	if (run.log.trim()) console.log(`[tool] ${tool.def.name}: ${run.log.trim().slice(-500)}`);
	return run;
}

export async function dispatchTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
	try {
		if (ctx.toolset && GATED_TOOLS[name] === true && !ctx.toolset.granted.has(name)) {
			return { content: `error: ${name} is not one of your tools - your Tools don't list it. Do the task without it, or tell the person what you'd need.`, isError: false };
		}
		// A space without its Tool object for a built-in (none synced yet): the built-in's shipped code.
		const tool = ctx.toolset?.objects.get(name) ?? SHIPPED_TOOLS.get(name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const run = await runObjectToolFor(tool, coerceToolInput(tool.def, input), ctx);
		if (!run.ok) return { content: `error: ${tool.builtin ? run.error : `${name} failed: ${run.error}`}`, isError: true };
		const content = typeof run.value === "string" ? run.value : JSON.stringify(run.value);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
