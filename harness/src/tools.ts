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
	type ValueJSON,
	addBlock,
	API,
} from "./api";
import { objectText, readSkill } from "./skills";
import { buildNeighborhood, buildSpaceMap, relationDefs, savedViewBody, spaceFilterFor } from "./spacemap";
import * as memory from "./memory";
import { TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";

/** proto TextStyle values the editor renders. */
const STYLE = { paragraph: 0, h1: 1, h2: 2, h3: 3, quote: 4, bullet: 6, numbered: 7, checkbox: 8 } as const;

/**
 * Markdown lines -> body blocks, mirroring what the editor produces:
 * checkboxes, bullets, numbered items, headings, quotes; anything else
 * is a paragraph. One block per line - a pasted list must never end up
 * as a single paragraph blob.
 */
function mdToBlocks(text: string): Array<Record<string, unknown>> {
	const blocks: Array<Record<string, unknown>> = [];
	for (const raw of text.split("\n")) {
		const line = raw.trimEnd();
		if (!line.trim()) continue;
		let style: number = STYLE.paragraph;
		let checked = false;
		let body = line.trim();
		let m: RegExpMatchArray | null;
		if ((m = body.match(/^[-*] \[([ xX])\] (.*)$/))) {
			style = STYLE.checkbox;
			checked = m[1] !== " ";
			body = m[2];
		} else if ((m = body.match(/^[-*] (.*)$/))) {
			style = STYLE.bullet;
			body = m[1];
		} else if ((m = body.match(/^\d+[.)] (.*)$/))) {
			style = STYLE.numbered;
			body = m[1];
		} else if ((m = body.match(/^(#{1,3}) (.*)$/))) {
			style = m[1].length;
			body = m[2];
		} else if ((m = body.match(/^> (.*)$/))) {
			style = STYLE.quote;
			body = m[1];
		}
		const content: Record<string, unknown> = { text: { text: body, style, ...(style === STYLE.checkbox ? { checked } : {}) } };
		blocks.push({ id: crypto.randomUUID(), childrenIds: [], content });
	}
	return blocks;
}

const POSITION_INNER = 5; // glon.Position.Inner - append as the target's last child

/**
 * Append blocks, optionally nested under an existing block matched by
 * its text (case-insensitive). "under" is how the model joins an
 * existing list (e.g. under: "Walmart") instead of dumping new blocks
 * at the page root.
 */
async function appendBody(objectId: string, text: string, under = ""): Promise<string> {
	let targetId = "";
	if (under.trim()) {
		const obj = await fetchObject(objectId);
		const needle = under.trim().toLowerCase();
		const hit = obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase() === needle)
			?? obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase().startsWith(needle));
		if (!hit) return `error: no block matching "${under.trim()}" - blocks were NOT added; re-check the text or omit "under"`;
		targetId = hit.id;
	}
	const blocks = mdToBlocks(text);
	for (const block of blocks) {
		await mutate("block_add", {
			object_id: objectId,
			block,
			...(targetId ? { target_id: targetId, position: POSITION_INNER } : {}),
		});
	}
	return `ok: ${blocks.length} block(s) added${targetId ? ` under "${under.trim()}"` : ""}`;
}

export interface ToolContext {
	agentId: string;
	channelId: string;
	/** Set for object-bound agents: the object this agent belongs to. */
	boundObject?: string;
	/** Wired by index.ts on human-rooted turns only: wake a target
	 *  agent on a pair chat. A2A-driven turns never get this - an agent
	 *  answering an agent just answers, so cascade depth is 1 by
	 *  construction. */
	wake?: (targetAgentId: string, pairChatId: string) => Promise<string>;
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

// ── Space containment ────────────────────────────────────────────
//
// Agents are citizens of exactly one space. Reads list/search only that
// space; every id-taking tool verifies the target lives there. Bundled
// definitions (relations/types with no space stamp) are global
// infrastructure and stay readable. Objects with no stamp belong to the
// default space (the display fallback), so the default space includes
// them.


let defaultSpaceCache: string | null = null;
async function defaultSpaceId(): Promise<string> {
	if (defaultSpaceCache !== null) return defaultSpaceCache;
	const res = await fetch(`${API}/api/channels`);
	const chans = (await res.json()) as Array<{ id: string }>;
	defaultSpaceCache = chans[0]?.id ?? "";
	return defaultSpaceCache;
}

async function agentSpace(ctx: ToolContext): Promise<string> {
	return ctx.channelId || (await defaultSpaceId());
}

async function spaceFilter(ctx: ToolContext): Promise<Record<string, unknown>> {
	const own = await agentSpace(ctx);
	return own === (await defaultSpaceId())
		? { key: "channel", condition: "in", value: [own, ""] }
		: { key: "channel", condition: "equal", value: own };
}

/** Throws unless the object belongs to the agent's space. */
async function assertInSpace(obj: ObjectJSON, ctx: ToolContext): Promise<ObjectJSON> {
	const stamp = str(obj.fields, "channel");
	const own = await agentSpace(ctx);
	const objSpace = stamp || (await defaultSpaceId());
	if (objSpace !== own) throw new Error(`object ${obj.id.slice(0, 8)} is outside this agent's space`);
	return obj;
}

const TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "object_search",
			description: "Full-text search over this space's objects (names, fields, block content). Returns id/type/name rows.",
			input_schema: { type: "object", properties: { query: { type: "string" }, type: { type: "string" } }, required: ["query"] },
		},
		handler: async (input, ctx) => {
			const rows = await query({ textQuery: S(input.query), type: S(input.type) || undefined, filters: [await spaceFilter(ctx)], limit: 20 });
			return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? str(r.fields, "name") })));
		},
	},
	{
		def: {
			name: "object_list",
			description: "List this space's recent objects, optionally by type (note, task, query, collection, skill, …).",
			input_schema: { type: "object", properties: { type: { type: "string" }, limit: { type: "number" } } },
		},
		handler: async (input, ctx) => {
			const rows = await query({ type: S(input.type) || undefined, filters: [await spaceFilter(ctx)], limit: N(input.limit) ?? 20 });
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
			return summarizeObject(await assertInSpace(await fetchObject(S(input.id)), ctx));
		},
	},
	{
		def: {
			name: "discussion_read",
			description:
				"Read the discussion thread under an object (object_get shows only the body). Returns the last messages oldest-first with author names and timestamps. Use it when the current message refers to earlier conversation on that object.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string" },
					limit: { type: "number", description: "max messages, default 30" },
				},
				required: ["id"],
			},
		},
		handler: async (input, ctx) => {
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
			ctx.touched.add(obj.id);
			const byId = new Map(obj.blocks.map((b) => [b.id, b]));
			const root = byId.get("__discussion__");
			const msgs: Array<{ author: string; text: string; ts: number }> = [];
			for (const cid of root?.childrenIds ?? []) {
				const c = byId.get(cid)?.content.custom;
				if (c?.contentType !== "chat") continue;
				const meta = c.meta ?? {};
				if (!(meta["text"] ?? "").trim()) continue;
				msgs.push({ author: meta["author"] ?? "", text: meta["text"] ?? "", ts: Number(meta["ts"] ?? 0) });
			}
			if (msgs.length === 0) return "(no discussion on this object)";
			const limit = Math.max(1, Math.min(200, Number(input.limit) || 30));
			const tail = msgs.slice(-limit);
			const names = new Map<string, string>();
			for (const m of tail) {
				if (names.has(m.author)) continue;
				if (m.author === ctx.agentId) names.set(m.author, "you");
				else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(m.author)) {
					const o = await fetchObject(m.author).catch(() => null);
					names.set(m.author, (o && str(o.fields, "name")) || m.author.slice(0, 8));
				} else names.set(m.author, "user");
			}
			const lines = tail.map((m) => `${names.get(m.author)} \u00b7 ${new Date(m.ts).toISOString().slice(0, 16)}: ${m.text}`);
			return `${msgs.length} message(s) total, last ${tail.length}:\n${lines.join("\n")}`;
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
				await appendBody(id, S(input.text));
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
			await assertInSpace(await fetchObject(S(input.id)), ctx);
			await setField(S(input.id), S(input.key), sv(S(input.value)));
			return "ok";
		},
	},
	{
		def: {
			name: "object_add_text",
			description:
				"Append text to an object's body. Markdown lines become real blocks: '- [ ] x' checkboxes, '- x' bullets, '1. x' numbered, '# x' headings, '> x' quotes; plain lines become paragraphs. When the object already has a matching list or section, pass 'under' with that block's text (e.g. under: \"Walmart\") so new items join it as children instead of landing at the page root.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string" },
					text: { type: "string" },
					under: { type: "string", description: "text of an existing block to nest the new blocks under" },
				},
				required: ["id", "text"],
			},
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			await assertInSpace(await fetchObject(S(input.id)), ctx);
			return await appendBody(S(input.id), S(input.text), S(input.under));
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
			await assertInSpace(await fetchObject(S(input.id)), ctx);
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
			await assertInSpace(await fetchObject(S(input.object_id)), ctx);
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
		handler: async (input, ctx) => readSkill(S(input.name), ctx.agentId),
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

/**
 * Tool set for a template ("" = principal agent: everything).
 *
 * Principal agents always carry shell_exec - an agent that cannot run
 * commands on its serving machine is useless, and CLI-backed skills
 * (google's gws, browserless) depend on it. Subagents never inherit it:
 * a spawned child runs on its parent's instructions, not the owner's,
 * so the shell stops at depth 0 (installer template excepted).
 */
// ── Evaluation toolkit: reads are free; query before you ever ask ──

const EVAL_TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "space_map",
			description: "The space census: every type (with the human's definition and count), every saved view, every agent alive. Free - use it to orient.",
			input_schema: { type: "object", properties: {} },
		},
		handler: async (_input, ctx) => await buildSpaceMap(ctx.channelId),
	},
	{
		def: {
			name: "neighborhood",
			description: "Typed connections of an object - links in/out with property names, collection memberships, saved views matching it, and which neighbors have agents. Defaults to your own object. Free - hop the graph with this instead of waking anyone.",
			input_schema: { type: "object", properties: { id: { type: "string", description: "object id; omit for your bound object" } } },
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) throw new Error("no id given and this agent is not bound to an object");
			await assertInSpace(await fetchObject(id), ctx);
			return await buildNeighborhood(id, ctx.channelId);
		},
	},
	{
		def: {
			name: "find",
			description: "Structured query over this space - the same engine the human's views run on. filters: [{key, condition, value}], conditions equal/notEqual/in/notIn/greater/less/empty/notEmpty. Free and unlimited: query until you know who to ask and what to ask.",
			input_schema: {
				type: "object",
				properties: {
					type: { type: "string", description: "type key (person, task, ...)" },
					text: { type: "string", description: "full-text query" },
					filters: { type: "array", description: "engine filters", items: { type: "object" } },
					limit: { type: "number" },
				},
			},
		},
		handler: async (input, ctx) => {
			const sf = await spaceFilterFor(ctx.channelId);
			const extra = Array.isArray(input.filters)
				? (input.filters as Array<Record<string, unknown>>).filter((f) => typeof f?.key === "string" && f.key !== "channel")
				: [];
			const rows = await query({
				type: S(input.type) || undefined,
				textQuery: S(input.text) || undefined,
				filters: [...extra, sf],
				limit: Math.min(100, N(input.limit) ?? 25),
			});
			return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? str(r.fields, "name") })));
		},
	},
	{
		def: {
			name: "query_run",
			description: "Run one of the human's saved views (a query or collection) exactly as their UI runs it - the views are the human's own semantic map of the space. Free.",
			input_schema: { type: "object", properties: { query_id: { type: "string" } }, required: ["query_id"] },
		},
		handler: async (input, ctx) => {
			const view = await assertInSpace(await fetchObject(S(input.query_id)), ctx);
			if (!["query", "set", "collection"].includes(view.typeKey)) throw new Error(`${view.id.slice(0, 8)} is a ${view.typeKey}, not a saved view`);
			const rels = await relationDefs(ctx.channelId);
			const body = await savedViewBody(view, ctx.channelId, rels);
			if (!body) return "[] (empty view)";
			const rows = await query({ ...body, limit: 100 });
			return JSON.stringify(rows.map((r) => ({ id: r.id, type: r.typeKey, name: r.name ?? str(r.fields, "name") })));
		},
	},
];

// ── A2A: only a human-rooted turn may ask ─────────────────────────
//
// agent_ask posts into the pair's chat object ALWAYS (the durable
// message board the human reads), then wakes the target for one
// answering turn. The answering turn does NOT carry this tool, so an
// agent answering an agent just answers - cascade depth is 1 by
// construction, no counters needed. Agents can only reach objects
// whose agent ALREADY exists: minds are minted by humans alone.

const A2A_TOOL: RegisteredTool = {
	def: {
		name: "agent_ask",
		description:
			"Ask another object's agent a question. Works ONLY on objects whose agent already exists (neighborhood/space_map show 'has agent') - agents never create minds. Your message lands in the shared pair chat the human can read, and the target answers you directly; it cannot itself ask further agents. Reads are free - query first, then ask once, well.",
		input_schema: {
			type: "object",
			properties: {
				object_id: { type: "string", description: "the object whose agent you want to ask" },
				text: { type: "string", description: "your question or message" },
			},
			required: ["object_id", "text"],
		},
	},
	handler: async (input, ctx) => {
		const target = await assertInSpace(await fetchObject(S(input.object_id)), ctx);
		const holders = await query({ type: "agent", filters: [{ key: "bound_object", condition: "equal", value: target.id }], limit: 1 });
		if (holders.length === 0) {
			return `no agent lives on "${str(target.fields, "name") || target.id.slice(0, 8)}" - agents cannot create minds. Read the object yourself: object_get ${target.id}`;
		}
		const targetAgentId = holders[0].id;
		if (targetAgentId === ctx.agentId) throw new Error("that is your own object");
		const me = await fetchObject(ctx.agentId);
		const myName = str(me.fields, "name") || "agent";
		const theirName = str(holders[0].fields, "name") || "agent";

		// One durable chat per agent pair - the message board thread.
		const pairKey = [ctx.agentId, targetAgentId].sort().join(":");
		const existing = await query({ type: "chat", filters: [{ key: "a2a_pair", condition: "equal", value: pairKey }], limit: 1 });
		let chatId: string;
		if (existing.length > 0) chatId = existing[0].id;
		else {
			const created = await createObject(`${myName} ⇄ ${theirName}`, "chat", {
				channel: sv(ctx.channelId),
				a2a_pair: sv(pairKey),
				participants: { valuesValue: { items: [sv(ctx.agentId), sv(targetAgentId)] } },
				objects: { valuesValue: { items: [ctx.boundObject ? { linkValue: { targetId: ctx.boundObject, relationKey: "objects" } } : undefined, { linkValue: { targetId: target.id, relationKey: "objects" } }].filter(Boolean) as ValueJSON[] } },
			});
			chatId = created.id;
			await addBlock(chatId, { id: "__discussion__", childrenIds: [], content: { custom: { contentType: "discussion", meta: {} } } });
		}
		await addBlock(
			chatId,
			{
				id: crypto.randomUUID(),
				childrenIds: [],
				content: { custom: { contentType: "chat", meta: { author: ctx.agentId, ts: String(Date.now()), text: S(input.text) } } },
			},
			"__discussion__",
			5,
		);
		if (!ctx.wake) return `letter delivered to ${theirName}; they will read it on their next turn`;
		return await ctx.wake(targetAgentId, chatId);
	},
};

export function toolDefs(template: string, depth: number, allowAsk = false): ToolDef[] {
	const READ_ONLY = new Set(["object_search", "object_list", "object_get", "memory_recall", "memory_list_facts", "memory_list_milestones", "skill_read"]);
	let defs = [...TOOLS, ...EVAL_TOOLS].map((t) => t.def);
	if (template === "" && depth === 0 && allowAsk) defs.push(A2A_TOOL.def);
	if (template === "explore") defs = defs.filter((d) => READ_ONLY.has(d.name));
	const out = [...defs];
	if (template === "installer") {
		// Least privilege: installs need only the shell and the result channel.
		return [SHELL_TOOL.def, SUBMIT_TOOL];
	}
	if (template === "") {
		out.push(SPAWN_TOOL);
		if (depth === 0) out.push(SHELL_TOOL.def);
	} else out.push(SUBMIT_TOOL);
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
		const tool = name === SHELL_TOOL.def.name ? SHELL_TOOL : [...TOOLS, ...EVAL_TOOLS, A2A_TOOL].find((t) => t.def.name === name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const content = await tool.handler(input, ctx);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
