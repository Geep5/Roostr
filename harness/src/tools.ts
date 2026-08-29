/**
 * Tool registry. In glon, tools were data (ToolSpec rows dispatching to
 * daemon programs via dispatchProgram); Roostr's sidecar IS the dispatcher,
 * so tools are code with the same owner-binding guarantee: the agent id is
 * bound here, never taken from model input.
 */

import {
	chatPost,
	createObject,
	fetchObject,
	mutate,
	query,
	str,
	sv,
	setField,
	type ObjectJSON,
} from "./api";
import { objectText, readSkill } from "./skills";
import * as memory from "./memory";
import { TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

export interface ToolContext {
	agentId: string;
	channelId: string;
	depth: number;
	/** Wired by spawn.ts; declared here to break the import cycle. */
	spawn?: (task: string, template: string, ctx: ToolContext) => Promise<string>;
	/** Subagent-only: capture the structured result. */
	submitResult?: (content: string) => void;
	/** Compaction carryover: object ids touched by tools this run. */
	touched: Set<string>;
}

type Handler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

interface RegisteredTool {
	def: ToolDef;
	handler: Handler;
}

const S = (v: unknown): string => (typeof v === "string" ? v : "");
const N = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const A = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function summarizeObject(obj: ObjectJSON): string {
	const fields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj.fields)) {
		fields[k] = v.stringValue ?? v.intValue ?? v.floatValue ?? v.boolValue ?? (v.valuesValue ? v.valuesValue.items.map((i) => i.stringValue) : undefined);
	}
	return JSON.stringify({ id: obj.id, typeKey: obj.typeKey, fields, text: objectText(obj).slice(0, 4000) }, null, 1);
}

const TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "object_search",
			description: "Full-text search over all objects (names, fields, block content). Returns id/type/name rows.",
			input_schema: { type: "object", properties: { query: { type: "string" }, type: { type: "string" } }, required: ["query"] },
		},
		handler: async (input) => {
			const rows = await query({ textQuery: S(input.query), type: S(input.type) || undefined, limit: 20 });
			return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? str(r.fields, "name") })));
		},
	},
	{
		def: {
			name: "object_list",
			description: "List recent objects, optionally by type (note, task, query, collection, skill, …).",
			input_schema: { type: "object", properties: { type: { type: "string" }, limit: { type: "number" } } },
		},
		handler: async (input) => {
			const rows = await query({ type: S(input.type) || undefined, limit: N(input.limit) ?? 20 });
			return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? str(r.fields, "name") })));
		},
	},
	{
		def: {
			name: "object_get",
			description: "Read one object: fields plus full text content. Protected from output pruning — reads stay in context.",
			input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			return summarizeObject(await fetchObject(S(input.id)));
		},
	},
	{
		def: {
			name: "object_create",
			description: "Create an object (default type note). Returns its id.",
			input_schema: {
				type: "object",
				properties: { name: { type: "string" }, type_key: { type: "string" }, text: { type: "string", description: "optional body text" } },
				required: ["name"],
			},
		},
		handler: async (input, ctx) => {
			const { id } = await createObject(S(input.name), S(input.type_key) || "note", ctx.channelId ? { channel: sv(ctx.channelId) } : undefined);
			ctx.touched.add(id);
			if (S(input.text)) {
				await mutate("block_add", { object_id: id, block: { id: crypto.randomUUID(), childrenIds: [], content: { text: { text: S(input.text), style: 0 } } } });
			}
			return JSON.stringify({ id });
		},
	},
	{
		def: {
			name: "object_set_field",
			description: "Set a string field on an object (e.g. name, status, description).",
			input_schema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["id", "key", "value"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			await setField(S(input.id), S(input.key), sv(S(input.value)));
			return "ok";
		},
	},
	{
		def: {
			name: "object_add_text",
			description: "Append a paragraph of text to an object's body.",
			input_schema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			await mutate("block_add", { object_id: S(input.id), block: { id: crypto.randomUUID(), childrenIds: [], content: { text: { text: S(input.text), style: 0 } } } });
			return "ok";
		},
	},
	{
		def: {
			name: "object_delete",
			description: "Soft-delete an object (recoverable tombstone in the DAG).",
			input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			await mutate("delete", { object_id: S(input.id) });
			return "ok";
		},
	},
	{
		def: {
			name: "chat_reply_on",
			description: "Post an UNPROMPTED chat message on some object's discussion. NEVER use this to answer the message you are currently replying to — your final reply text is delivered to the asking surface automatically.",
			input_schema: { type: "object", properties: { object_id: { type: "string" }, text: { type: "string" } }, required: ["object_id", "text"] },
		},
		handler: async (input, ctx) => {
			await chatPost(S(input.object_id), S(input.text), ctx.agentId);
			return "ok";
		},
	},
	// ── Memory (owner bound server-side equivalent: bound here) ──
	{
		def: {
			name: "memory_upsert_fact",
			description: "Pin a durable atomic fact. One row per `key` — upsert replaces by key.",
			input_schema: {
				type: "object",
				properties: {
					key: { type: "string" },
					value: { type: "string" },
					confidence: { type: "string", enum: ["low", "med", "high"] },
					sourced_from_block_id: { type: "string" },
				},
				required: ["key", "value"],
			},
		},
		handler: async (input, ctx) => {
			const id = await memory.upsertFact(ctx.agentId, S(input.key), S(input.value), S(input.confidence) || "med", S(input.sourced_from_block_id));
			return JSON.stringify({ id });
		},
	},
	{
		def: {
			name: "memory_upsert_milestone",
			description: "Record a narrative arc. Pass supersedes=[id,...] to replace older milestones.",
			input_schema: {
				type: "object",
				properties: {
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					supersedes: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
					confidence: { type: "string", enum: ["low", "med", "high"] },
				},
				required: ["title", "narrative"],
			},
		},
		handler: async (input, ctx) => {
			const id = await memory.upsertMilestone(ctx.agentId, {
				title: S(input.title),
				narrative: S(input.narrative),
				topics: A(input.topics),
				supersedes: A(input.supersedes),
				status: S(input.status) || "active",
				confidence: S(input.confidence) || "med",
			});
			return JSON.stringify({ id });
		},
	},
	{
		def: {
			name: "memory_amend_milestone",
			description: "Correct an existing milestone in place — prefer over supersedes for small changes.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string" },
					title: { type: "string" },
					narrative: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					status: { type: "string", enum: ["active", "completed", "superseded"] },
				},
				required: ["id"],
			},
		},
		handler: async (input, ctx) => {
			const ok = await memory.amendMilestone(ctx.agentId, S(input.id), {
				title: input.title === undefined ? undefined : S(input.title),
				narrative: input.narrative === undefined ? undefined : S(input.narrative),
				topics: input.topics === undefined ? undefined : A(input.topics),
				status: input.status === undefined ? undefined : S(input.status),
			});
			return ok ? "ok" : "milestone not found (or not yours)";
		},
	},
	{
		def: {
			name: "memory_list_facts",
			description: "List pinned facts. Inspect before writing to avoid duplicates.",
			input_schema: { type: "object", properties: { key: { type: "string" } } },
		},
		handler: async (input, ctx) => {
			const rows = await memory.listFacts(ctx.agentId, S(input.key) || undefined);
			return JSON.stringify(rows.map((r) => ({ id: r.id, key: str(r.fields, "key"), value: str(r.fields, "value"), confidence: str(r.fields, "confidence") })));
		},
	},
	{
		def: {
			name: "memory_list_milestones",
			description: "List milestones, optionally by status.",
			input_schema: { type: "object", properties: { status: { type: "string", enum: ["active", "completed", "superseded"] } } },
		},
		handler: async (input, ctx) => {
			const rows = await memory.listMilestones(ctx.agentId, S(input.status) || undefined);
			return JSON.stringify(rows.map((r) => ({ id: r.id, title: str(r.fields, "title"), status: str(r.fields, "status"), narrative: str(r.fields, "narrative").slice(0, 200) })));
		},
	},
	{
		def: {
			name: "memory_recall",
			description: "Search facts + milestones by substring query and/or topics.",
			input_schema: {
				type: "object",
				properties: {
					query: { type: "string" },
					topics: { type: "array", items: { type: "string" } },
					limit_facts: { type: "number" },
					limit_milestones: { type: "number" },
					include_superseded: { type: "boolean" },
				},
			},
		},
		handler: async (input, ctx) => {
			const out = await memory.recall(ctx.agentId, {
				query: S(input.query),
				topics: A(input.topics),
				limit_facts: N(input.limit_facts),
				limit_milestones: N(input.limit_milestones),
				include_superseded: input.include_superseded === true,
			});
			return JSON.stringify({
				facts: out.facts.map((r) => ({ key: str(r.fields, "key"), value: str(r.fields, "value") })),
				milestones: out.milestones.map((r) => ({ id: r.id, title: str(r.fields, "title"), narrative: str(r.fields, "narrative").slice(0, 300) })),
			});
		},
	},
	// ── Skills (progressive disclosure read path) ──
	{
		def: {
			name: "skill_read",
			description: "Load a skill's full instructions by name. Call BEFORE starting any task that matches a listed skill.",
			input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		},
		handler: async (input) => readSkill(S(input.name)),
	},
];

const SPAWN_TOOL: ToolDef = {
	name: "spawn",
	description:
		"Delegate a self-contained task to a subagent. Templates: task (full tools), explore (read-only research), quick_task (fast, no delegation). Returns the subagent's submitted result.",
	input_schema: {
		type: "object",
		properties: {
			task: { type: "string", description: "complete, self-contained instructions" },
			template: { type: "string", enum: ["task", "explore", "quick_task"] },
		},
		required: ["task"],
	},
};

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const SHELL_OUTPUT_CAP = 16_000;

/**
 * shell_exec — installer-template only (not in TOOLS): install agents must
 * run brew/npm/etc. Principals and ordinary subagents never receive it.
 */
const SHELL_TOOL: RegisteredTool = {
	def: {
		name: "shell_exec",
		description: "Run a shell command on this machine (sh -lc, cwd=home, 5min timeout). Use for installs and verification commands.",
		input_schema: {
			type: "object",
			properties: { command: { type: "string", description: "the shell command to run" } },
			required: ["command"],
		},
	},
	handler: async (input) => {
		const command = S(input.command);
		if (!command) return "error: command required";
		const proc = Bun.spawn(["sh", "-lc", command], { cwd: process.env.HOME, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), SHELL_TIMEOUT_MS);
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		clearTimeout(timer);
		const body = (out + (err ? `\n[stderr]\n${err}` : "")).trim();
		return `exit ${code}\n${body.slice(-SHELL_OUTPUT_CAP) || "(no output)"}`;
	},
};

const SUBMIT_TOOL: ToolDef = {
	name: "submit_result",
	description: "Submit your final result to the parent agent. Call exactly once when done.",
	input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
};

/** Tool set for a template ("" = principal agent: everything). */
export function toolDefs(template: string, depth: number): ToolDef[] {
	const READ_ONLY = new Set(["object_search", "object_list", "object_get", "memory_recall", "memory_list_facts", "memory_list_milestones", "skill_read"]);
	let defs = TOOLS.map((t) => t.def);
	if (template === "explore") defs = defs.filter((d) => READ_ONLY.has(d.name));
	const out = [...defs];
	if (template === "installer") {
		// Least privilege: installs need only the shell and the result channel.
		return [SHELL_TOOL.def, SUBMIT_TOOL];
	}
	if (template === "") out.push(SPAWN_TOOL);
	else out.push(SUBMIT_TOOL);
	if (template === "task" && depth < 2) out.push(SPAWN_TOOL);
	return out;
}

export async function dispatchTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
	try {
		if (name === "spawn") {
			if (!ctx.spawn) throw new Error("spawn unavailable at this depth");
			const content = await ctx.spawn(S(input.task), S(input.template) || "task", ctx);
			return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
		}
		if (name === "submit_result") {
			if (!ctx.submitResult) throw new Error("submit_result is subagent-only");
			ctx.submitResult(S(input.content));
			return { content: "result submitted", isError: false };
		}
		const tool = name === SHELL_TOOL.def.name ? SHELL_TOOL : TOOLS.find((t) => t.def.name === name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const content = await tool.handler(input, ctx);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
