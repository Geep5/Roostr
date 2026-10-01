/**
 * Tool registry. In glon, tools were data (ToolSpec rows dispatching to
 * daemon programs via dispatchProgram); Roostr's sidecar IS the dispatcher,
 * so tools are code with the same owner-binding guarantee: the agent id is
 * bound here, never taken from model input.
 */

import {
	bv,
	createObject,
	fetchObject,
	fv,
	iv,
	lv,
	deleteField,
	mutate,
	query,
	queryAll,
	setField,
	str,
	sv,
	type ObjectJSON,
	type QueryRow,
	type ValueJSON,
	type BlockJSON,
	API,
	apiFetch,
	guestAgents,
} from "./api";
import { invalidateServing, machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { CATALOG, fileHoldup, skillReady } from "./skillmgr";
import { myInstallations, type InstallationRow } from "./descriptors";
import { agentCredential, type CredentialRow } from "./credential-objects";
import { actionsOf } from "./credentials";
import { clickThenReadJs, credentialPageAction, X_RETWEET_JS, X_TIMELINE_JS } from "./browser";
import { blockLine, isAgentAuthor, listOrdinals } from "./surfaces";
import { inlineMarks, mdToTree, STYLE, type MdBlock } from "./markdown";
import { featuredEvents, matcherinoToken, setFeatured } from "./matcherino";
import { readSkill } from "./skills";
import { buildNeighborhood, buildSpaceMap, relationDefs, savedViewBody, spaceFilterFor, typeDefs } from "./spacemap";
import * as memory from "./memory";
import { TOOL_RESULT_TRUNCATE, type CustomTool, type ToolDef } from "./types";
import { HUMAN_THREAD, agentSubject, convBlocks, humanRef, postTo } from "./conv";
import { sendMessage } from "./mailbox";
import { fetchInstallations } from "./descriptors";
import { fetchCapabilities, fullySetUp, linkValue } from "./capabilities";
import { SKILLS_KEY, machineSkillKeys, skillForKey, skillIds } from "./skills";
import { runToolCode } from "./tool-host";
import { requestCapability, type CapabilityOperation } from "./capability-messages";
import type { AgentEndpoint, AgentMessage } from "./api";

const POSITION_INNER = 5; // glon.Position.Inner - append as the target's last child

/**
 * Append markdown as blocks (markdown.ts: one block per line, indentation
 * nests, inline marks), optionally nested under an existing block matched
 * by its text (case-insensitive). "under" is how the model joins an
 * existing list (e.g. under: "Walmart") instead of dumping new blocks
 * at the page root. Parents are written before their children.
 */
export async function appendBody(objectId: string, text: string, under = ""): Promise<string> {
	let targetId = "";
	if (under.trim()) {
		const obj = await fetchObject(objectId);
		const needle = under.trim().toLowerCase();
		const hit = obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase() === needle)
			?? obj.blocks.find((b) => (b.content.text?.text ?? "").trim().toLowerCase().startsWith(needle));
		if (!hit) return `error: no block matching "${under.trim()}" - blocks were NOT added; re-check the text or omit "under"`;
		targetId = hit.id;
	}
	let added = 0;
	const add = async (blocks: MdBlock[], parent: string): Promise<void> => {
		for (const b of blocks) {
			const id = crypto.randomUUID();
			const content = { text: { text: b.text, style: b.style, ...(b.marks.length ? { marks: b.marks } : {}), ...(b.style === STYLE.checkbox ? { checked: b.checked === true } : {}) } };
			await mutate("block_add", { object_id: objectId, block: { id, childrenIds: [], content }, ...(parent ? { target_id: parent, position: POSITION_INNER } : {}) });
			added += 1;
			await add(b.children, id);
		}
	};
	await add(mdToTree(text), targetId);
	return `ok: ${added} block(s) added${targetId ? ` under "${under.trim()}"` : ""}`;
}

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
	/** What the agent's Tools property adds (shell/web, its custom tools); unset = every built-in, no custom tools (tests, internal callers). */
	toolset?: Toolset;
	/** The agent's Project folder (`repo_path`) on this machine - shell_exec's cwd when set. */
	workspacePath?: string;
}

type Handler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

export interface RegisteredTool {
	def: ToolDef;
	handler: Handler;
}

/**
 * Built-ins only an agent's Tools property unlocks: running commands on
 * the serving computer and fetching the web are the two powers an agent
 * could turn against that computer or use to send data out, so an agent
 * has them only while its Tools list them (a support agent that reads mail
 * from strangers simply doesn't). Everything else is always on.
 */
const GATED_TOOLS: Readonly<Record<string, true>> = { shell_exec: true, web_fetch: true };

/** What an agent's Tools property adds to the core set (tool-objects.ts): the gated built-ins it lists and its custom tools by name. */
export interface Toolset {
	granted: ReadonlySet<string>;
	custom: ReadonlyMap<string, CustomTool>;
}

const S = (v: unknown): string => (typeof v === "string" ? v : "");
const N = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const A = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * The body as addressable lines, in reading order: each block's id, its
 * nesting depth and the line a human reads. Conversation subtrees are not
 * body and never appear; editing tools accept only these ids.
 */
export function bodyBlocks(obj: ObjectJSON): Array<{ id: string; depth: number; line: string; block: BlockJSON }> {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const ordinals = listOrdinals(obj);
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const out: Array<{ id: string; depth: number; line: string; block: BlockJSON }> = [];
	const walk = (id: string, depth: number) => {
		const b = byId.get(id);
		if (!b) return;
		const kind = b.content.custom?.contentType;
		if (kind === "chat" || kind === "discussion" || kind === "agent_message") return;
		out.push({ id, depth, line: blockLine(b, ordinals.get(b.id)), block: b });
		for (const c of b.childrenIds) walk(c, depth + 1);
	};
	for (const b of obj.blocks) if (!referenced.has(b.id) && b.id !== "__discussion__") walk(b.id, 0);
	return out;
}

/**
 * A stored value as plain JSON for the agent: links as their target ids,
 * maps as objects, lists of either. Only strings used to survive - a
 * query's filters, an agent's credentials, a task's agent all read as
 * null, and an agent guessed at a view it could not see.
 */
function plainValue(v: ValueJSON | undefined): unknown {
	if (!v) return null;
	if (v.stringValue !== undefined) return v.stringValue;
	if (v.intValue !== undefined) return v.intValue;
	if (v.floatValue !== undefined) return v.floatValue;
	if (v.boolValue !== undefined) return v.boolValue;
	if (v.linkValue) return v.linkValue.targetId ?? null;
	if (v.valuesValue) return v.valuesValue.items.map(plainValue);
	if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.entries ?? {}).map(([k, x]) => [k, plainValue(x)]));
	return null;
}

async function summarizeObject(obj: ObjectJSON): Promise<string> {
	const fields: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj.fields)) fields[k] = plainValue(v);
	const blocks = bodyBlocks(obj).slice(0, 400);
	// A link card reads as the linked object's name on the page, so the agent sees that too (plus the id to open it).
	const lines = await Promise.all(
		blocks.map(async (b) => {
			const target = b.block.content.custom?.contentType === "link" ? (b.block.content.custom.meta?.["target"] ?? "") : "";
			if (!target) return b.line;
			const o = await fetchObject(target).catch(() => null);
			return o && !o.deleted ? `[link] "${str(o.fields, "name") || "Untitled"}" (${o.typeKey}, object ${target})` : `[link to a deleted object ${target}]`;
		}),
	);
	const total = bodyBlocks(obj).length;
	return JSON.stringify(
		{
			id: obj.id,
			typeKey: obj.typeKey,
			fields,
			// Body, one entry per block: pass `block` to the object_*_block tools to change it.
			body: blocks.map((b, i) => ({ block: b.id, depth: b.depth, line: lines[i].slice(0, 300) })),
			...(total > 400 ? { bodyTruncated: total - 400 } : {}),
		},
		null,
		1,
	);
}

/**
 * The object and body line a block tool acts on (`id`, else this turn's
 * object; `block` must be a line of that body - never conversation), or
 * the refusal to return instead.
 */
async function bodyTarget(input: Record<string, unknown>, ctx: ToolContext): Promise<{ obj: ObjectJSON; entry: ReturnType<typeof bodyBlocks>[number] } | string> {
	const id = S(input.id) || ctx.boundObject || "";
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await assertInSpace(await fetchObject(id), ctx);
	ctx.touched.add(obj.id);
	const entry = bodyBlocks(obj).find((e) => e.id === S(input.block));
	if (!entry) return `error: nothing written. "${S(input.block)}" is not a line of this object's body. Read object_get's body for the ids.`;
	return { obj, entry };
}

/** One body line as the human now reads it, after a write. */
async function lineNow(objectId: string, blockId: string): Promise<string> {
	const entry = bodyBlocks(await fetchObject(objectId)).find((e) => e.id === blockId);
	return entry ? `Line is now: ${entry.line}` : "The line is no longer in the body.";
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
	const res = await apiFetch(`${API}/api/channels`);
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

/** Formats a person can create in the app (the website's CREATABLE_FORMATS). */
const PROPERTY_FORMATS = ["shorttext", "longtext", "number", "status", "tag", "date", "checkbox", "url", "email", "phone", "object"] as const;

/** A property's key from its name, as the app derives it (relations.ts slugKey). */
const propertyKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `prop_${Date.now()}`;

/** Infrastructure types: never retyped, and nothing is retyped into them. */
const FIXED_TYPES = new Set(["agent", "machine", "install", "capability", "channel", "relation", "type", "template", "query", "collection", "set", "chat", "skill"]);

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes after local midnight as a clock time: 570 -> "9:30 AM". */
function clockTime(minutes: number): string {
	return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * An object's repeat rule in the words the Repeat cell uses, with its next
 * occurrence: "every 2 weeks on Wed at 9:00 AM, 1:00 PM · next Wed, Oct 8,
 * 9:00 AM", "every 5 minutes on Mon, Tue from 9:00 AM to 5:00 PM · next ...".
 */
function describeRepeat(v: ValueJSON | undefined): string {
	const e = v?.mapValue?.entries;
	if (!e) return "does not repeat";
	const ints = (key: string): number[] => (e[key]?.valuesValue?.items ?? []).map((i) => i.intValue ?? 0);
	const freq = e["freq"]?.stringValue ?? "";
	const every = e["interval"]?.intValue ?? 1;
	const unit = every === 1 ? freq : `${every} ${freq}s`;
	const days = ints("weekdays").map((i) => WEEKDAY_NAMES[i] ?? "").map((d) => d.charAt(0).toUpperCase() + d.slice(1));
	const subDaily = freq === "minute" || freq === "hour";
	let at: string;
	if (subDaily) {
		const [from = 0, until = 1439] = ints("window");
		at = from === 0 && until === 1439 ? "" : ` from ${clockTime(from)} to ${clockTime(until)}`;
	} else {
		// Rules written before several times a day carry one `time`.
		const times = e["times"] ? ints("times") : [e["time"]?.intValue ?? 0];
		at = ` at ${times.map(clockTime).join(", ")}`;
	}
	const next = e["next"]?.intValue;
	const on = (freq === "week" || subDaily) && days.length ? ` on ${days.join(", ")}` : "";
	const when = next ? ` · next ${new Date(next).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
	return `every ${unit}${on}${at}${when}`;
}

/** "HH:MM" (24h) as minutes after midnight, or null. */
function minutesOf(hhmm: string): number | null {
	const hm = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) return null;
	return Number(hm[1]) * 60 + Number(hm[2]);
}

/** The occurrence planner's clock params: now, and this machine's UTC offset. */
export function localClock(): { now_ms: number; tz_offset_min: number } {
	return { now_ms: Date.now(), tz_offset_min: -new Date().getTimezoneOffset() };
}

// ── Machine capabilities, brokered ────────────────────────────────
//
// The harness executes these in-process with machine-local credentials;
// agents get the effect, never the secret. A capability failure files a
// holdup in the machine ledger (Machine panel) and tells the agent the
// truth so it can answer honestly instead of inventing a coordinator.

const WEB_FETCH_TIMEOUT_MS = 60_000;
const WEB_FETCH_CAP = 14_000;

function shq(v: string): string {
	return `'${v.replace(/'/g, `'\''`)}'`;
}

/** Crude but honest DOM → text: scripts/styles out, tags out, whitespace collapsed. */
function domToText(html: string): string {
	const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => `${body.replace(/<[^>]+>/g, "")} (${href}) `)
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*/g, "\n")
		.trim();
	return (title ? `[title] ${title}\n` : "") + text;
}

/**
 * Why the serving rule left this object here without the capability, if
 * that is the case: a human pin to a machine that lacks it, or no machine
 * having it at all. Empty otherwise (the object never required it).
 */
async function resolutionNote(capability: string, ctx: ToolContext): Promise<string> {
	if (!ctx.boundObject) return "";
	const s = await serverOf(ctx.boundObject).catch(() => null);
	if (!s || !s.skills.includes(capability)) return "";
	if (s.reason === "pinned-uncapable") return ` (serving: pinned-uncapable - the object is pinned to this machine, which lacks ${capability})`;
	if (s.reason === "unsatisfied") return ` (serving: unsatisfied - no machine has ${capability})`;
	return "";
}

/** File a holdup with best-effort agent/object names; never throws. */
export async function fileCapabilityHoldup(capability: string, error: string, ctx: ToolContext): Promise<void> {
	let agentName = ctx.agentId.slice(0, 8);
	let objectId = ctx.boundObject ?? "";
	let objectName = "";
	try {
		const agent = await fetchObject(ctx.agentId);
		agentName = str(agent.fields, "name") || agentName;
		if (objectId) objectName = str((await fetchObject(objectId)).fields, "name");
	} catch {
		/* names are cosmetic */
	}
	try {
		await fileHoldup({ capability, agentId: ctx.agentId, agentName, objectId, objectName, error: error + (await resolutionNote(capability, ctx)) });
	} catch {
		/* the ledger must never break the turn */
	}
	// The same problem lands on the object's Error badge (prefix "needs
	// <cap>:" - clearing the holdup clears exactly this).
	if (ctx.boundObject) {
		try {
			await setField(ctx.boundObject, "error", sv(`needs ${capability}: ${error}`.slice(0, 300)));
		} catch {
			/* badge must never break the turn */
		}
	}
}

const FLAG_ERROR_TOOL: RegisteredTool = {
	def: {
		name: "object_flag_error",
		description:
			"Flag the object of this conversation as broken: set its Error property so the human sees it in their views (they can sort and filter by it). Pass a short reason. Call again with an empty message once the problem is resolved to clear it. Only turns running on an object can call this.",
		input_schema: { type: "object", properties: { message: { type: "string", description: "short reason; empty clears the flag" } } },
	},
	handler: async (input, ctx) => {
		if (!ctx.boundObject) return "error: this turn is not running on an object, so there is nothing to flag";
		const message = S(input.message).trim().slice(0, 300);
		ctx.touched.add(ctx.boundObject);
		if (!message) {
			await deleteField(ctx.boundObject, "error");
			return "ok: error flag cleared";
		}
		await setField(ctx.boundObject, "error", sv(message));
		return `ok: error flagged ("${message}") - it shows in the human's views until cleared. Tell them plainly.`;
	},
};

const CAPABILITY_LIST_TOOL: RegisteredTool = {
	def: {
		name: "capability_list",
		description: "List skill/auth installation object addresses and their machine-local status across computers. Returns status and errors, never credential values.",
		input_schema: { type: "object", properties: { key: { type: "string", description: "optional catalog key" } } },
	},
	handler: async (input) => {
		const key = S(input.key);
		return JSON.stringify((await fetchInstallations()).filter((row) => !key || row.key === key));
	},
};

const CAPABILITY_TOOL: RegisteredTool = {
	def: {
		name: "capability_request",
		description:
			"Request setup or maintenance from a skill/auth installation object's owning machine. This only sends a durable request: a human must approve there before anything executes. Never put passwords, tokens, cookies or other secrets in the text. Use capability_list to find the installation address.",
		input_schema: {
			type: "object",
			properties: {
				installation_object_id: { type: "string" },
				operation: { type: "string", enum: ["skill.install", "skill.enable", "skill.disable", "skill.uninstall", "auth.login", "auth.check", "auth.revoke"] },
				text: { type: "string", description: "Why this action is needed; no secrets." },
			},
			required: ["installation_object_id", "operation"],
		},
	},
	handler: async (input, ctx) => {
		const agent = await fetchObject(ctx.agentId);
		const result = await requestCapability({
			sender: { objectId: agentSubject(agent), agentId: agent.id },
			installationObjectId: S(input.installation_object_id),
			operation: S(input.operation) as CapabilityOperation,
			author: agent.id,
			text: S(input.text),
		});
		return JSON.stringify({ ...result, status: "awaiting owner-machine approval" });
	},
};

/**
 * Open a page signed in with the agent's credential for a service and
 * return its text. The cookies ride on the Credential object, so this works
 * on any computer; the agent sees page text only, never the cookies.
 */
async function credentialPage(ctx: ToolContext, service: string, url: string, actionJs: string): Promise<string> {
	let cred;
	try {
		cred = await agentCredential(await fetchObject(ctx.agentId), service);
	} catch (error) {
		return `Credential unavailable: ${error instanceof Error ? error.message : String(error)} Tell the person; do not retry this turn.`;
	}
	if (cred.cookies.length === 0) return `Credential unavailable: "${cred.row.name}" has no browser sign-in. Tell the person to press Connect on it.`;
	try {
		const page = await credentialPageAction(cred.cookies, url, actionJs);
		if (!page.arrived && /login|signin|sign-in|onboarding|checkpoint|authwall/i.test(page.url + page.title)) {
			return `Credential signed out: ${url} showed a login page, so "${cred.row.name}" is no longer signed in. Tell the person to press Reconnect on it.`;
		}
		if (!page.arrived) return `Did not reach ${url}: the site sent the page to ${page.url}. Nothing was done there.\n${page.text}`.slice(0, WEB_FETCH_CAP);
		// An action's answer leads: the page text after it is context and may be cut.
		if (page.actionResult) return `Result: ${page.actionResult}\n\n${page.title}\n${page.url}\n${page.text}`.slice(0, WEB_FETCH_CAP);
		return `${page.title}\n${page.url}\n${page.text}`.slice(0, WEB_FETCH_CAP);
	} catch (error) {
		return `Credential page failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Matcherino's featured list through the agent's Matcherino credential.
 * feature_events only ever adds: an id already featured is left alone, and
 * nothing is unfeatured. Each id is read back from the live list afterwards;
 * the public list is served from a short cache, so an id the API accepted
 * but the list doesn't show yet is reported as `notShownYet`, not as done.
 */
async function matcherinoAction(action: string, rawIds: unknown, cred: CredentialRow): Promise<string> {
	if (action !== "list_featured" && action !== "feature_events") return `error: ${action} is not a Matcherino action; Matcherino takes list_featured or feature_events`;
	let token: string;
	try {
		token = await matcherinoToken(cred.fields);
	} catch (error) {
		return `Credential signed out: "${cred.name}" no longer signs in to Matcherino (${error instanceof Error ? error.message : String(error)}). Tell the person to press Reconnect on it; do not retry this turn.`;
	}
	try {
		const before = await featuredEvents();
		if (action === "list_featured") return JSON.stringify(before);
		const ids = (Array.isArray(rawIds) ? rawIds : []).map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
		if (ids.length === 0) return "error: pass the bounty ids to feature in `ids`";
		const was = new Set(before.map((e) => e.id));
		const already = ids.filter((id) => was.has(id));
		const accepted: number[] = [];
		const failed: Array<{ id: number; error: string }> = [];
		for (const id of ids.filter((x) => !was.has(x))) {
			try {
				await setFeatured(token, id, true);
				accepted.push(id);
			} catch (error) {
				failed.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}
		const now = new Set((await featuredEvents()).map((e) => e.id));
		return JSON.stringify({
			featured: accepted.filter((id) => now.has(id)),
			already,
			failed,
			notShownYet: accepted.filter((id) => !now.has(id)),
		});
	} catch (error) {
		return `Matcherino failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

const WEB_TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "credential_action",
			description:
				"Act as a signed-in account through one of YOUR credentials (the Credentials property). The 'Your credentials' section lists each credential's actions as `key - what it does and returns (read|write)`; pass that credential's `service` and one of its action keys, with the inputs the summary names (`url`, `ids`). Only report done what the action's result confirms.",
			input_schema: {
				type: "object",
				properties: {
					service: { type: "string", description: "the `service` of one of your credentials (see Your credentials)" },
					action: { type: "string", description: "one of that credential's action keys" },
					url: { type: "string", description: "page URL for actions whose summary names one" },
					ids: { type: "array", items: { type: "number" }, description: "numeric ids for actions whose summary names them" },
				},
				required: ["service", "action"],
			},
		},
		handler: async (input, ctx) => {
			const service = S(input.service);
			const action = S(input.action);
			// Having the credential is the permission; its actions are its service's (code).
			let cred;
			try {
				cred = await agentCredential(await fetchObject(ctx.agentId), service);
			} catch (error) {
				return `Credential unavailable: ${error instanceof Error ? error.message : String(error)} Tell the person; do not retry this turn.`;
			}
			const actions = actionsOf(cred.row.fields);
			if (!actions.some((a) => a.key === action)) {
				const valid = actions.map((a) => a.key).join(", ");
				return `error: "${cred.row.name}" has no action "${action}"${valid ? `; its actions are ${valid}` : " - it has no actions"}. Don't retry with another name.`;
			}
			if (service === "matcherino") return matcherinoAction(action, input.ids, cred.row);
			if (service === "x") {
				const url = action === "read_mentions" ? "https://x.com/notifications/mentions" : S(input.url).trim();
				if (!/^https:\/\/(?:x|twitter)\.com\//i.test(url)) return "error: url must be an x.com or twitter.com URL";
				return credentialPage(ctx, service, url, action === "read_mentions" ? X_TIMELINE_JS : X_RETWEET_JS);
			}
			return `error: ${service}.${action} is declared on the credential but no harness on this computer implements it`;
		},
	},
	{
		def: {
			name: "credential_fetch",
			description:
				"Fetch a live page signed in through one of YOUR credentials (the Credentials property) in a headless Chrome, and return its rendered text. Some things only appear after a click (a profile menu showing a balance, a tab, a dropdown): pass `click`, a list of controls to click in order, and the result says what opened. Every reply lists the page's clickable controls with selectors you can pass in `click`. Only click to open or reveal things - never a control that buys, sends, deletes, posts or changes anything. Use this instead of web_fetch when the page depends on a signed-in account. If the page shows a login wall, report the credential as signed out.",
			input_schema: {
				type: "object",
				properties: {
					service: { type: "string", description: "the `service` of one of your credentials (see Your credentials) that signs in with a browser" },
					url: { type: "string", description: "absolute http(s) URL" },
					click: { type: "array", items: { type: "string" }, description: "controls to click first, in order: a selector from a previous reply's controls list, or the control's visible text / label" },
				},
				required: ["service", "url"],
			},
		},
		handler: async (input, ctx) => {
			const url = S(input.url).trim();
			if (!/^https?:\/\//i.test(url)) return "error: url must be absolute http(s)";
			// Models sometimes send the list JSON-encoded, or one target as a string: read all three.
			let clicks = A(input.click);
			if (clicks.length === 0 && typeof input.click === "string" && input.click.trim()) {
				try {
					const parsed = JSON.parse(input.click) as unknown;
					clicks = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
				} catch {
					clicks = [input.click.trim()];
				}
			}
			return credentialPage(ctx, S(input.service), url, clickThenReadJs(clicks));
		},
	},
	{
		def: {
			name: "web_fetch",
			description:
				"Fetch a live web page through this machine's headless Chrome (renders JavaScript) and return its text. Use for looking things up on the web - profiles, docs, articles. If the capability is unavailable the call files a holdup for the human and tells you so - relay that honestly and continue without it.",
			input_schema: {
				type: "object",
				properties: { url: { type: "string", description: "absolute http(s) URL" } },
				required: ["url"],
			},
		},
		handler: async (input, ctx) => {
			const url = S(input.url).trim();
			if (!/^https?:\/\//i.test(url)) return "error: url must be absolute http(s)";
			const ready = await skillReady("browserless");
			if (!ready.ok) {
				await fileCapabilityHoldup("browserless", ready.reason, ctx);
				return `Capability unavailable: ${ready.reason}. A holdup has been filed - the human will see it in the Machine panel and can fix it there. Tell them plainly; do not retry this turn.`;
			}
			const proc = Bun.spawn(["sh", "-lc", `browserless ${shq(url)}`], { cwd: process.env.HOME, stdout: "pipe", stderr: "pipe" });
			const timer = setTimeout(() => proc.kill(), WEB_FETCH_TIMEOUT_MS);
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			clearTimeout(timer);
			if (code !== 0 || !out.trim()) {
				const reason = `browserless failed on ${url}: ${(err || out || "no output").trim().slice(0, 300)}`;
				await fileCapabilityHoldup("browserless", reason, ctx);
				return `Capability failed: ${reason}. A holdup has been filed for the human in the Machine panel. Tell them plainly.`;
			}
			return domToText(out).slice(0, WEB_FETCH_CAP) || "(page rendered empty)";
		},
	},
];

const TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "space_activity",
			description:
				"Recent life of this space: latest edited objects, the newest human discussion messages, recurring work due soon or overdue, and open capability holdups. Use it to brief the human on what is new and what matters - especially when they write without a specific request.",
			input_schema: { type: "object", properties: { limit: { type: "number" } } },
		},
		handler: async (input, ctx) => {
			const limit = Math.min(N(input.limit) ?? 12, 25);
			const rows = (await queryAll({ filters: [await spaceFilter(ctx)] })).filter((r: QueryRow) => !["agent", "machine", "relation", "type", "template", "skill", "channel"].includes(r.typeKey));
			const out: string[] = ["RECENTLY EDITED (newest first):"];
			for (const r of [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)) {
				out.push(`- ${r.typeKey} "${str(r.fields, "name") || r.id.slice(0, 8)}" ${new Date(r.updatedAt).toLocaleString()}`);
			}
			const now = Date.now();
			const due = rows
				.flatMap((r: QueryRow) => {
					const next = r.fields["repeat"]?.mapValue?.entries?.["next"]?.intValue;
					return next === undefined || next > now + 48 * 3600_000 ? [] : [{ name: str(r.fields, "name") || r.id.slice(0, 8), next: Number(next) }];
				})
				.sort((a: { next: number }, b: { next: number }) => a.next - b.next)
				.slice(0, 8);
			if (due.length > 0) {
				out.push("", "RECURRING WORK (next occurrence):");
				for (const d of due) out.push(`- "${d.name}" ${d.next < now ? "OVERDUE since" : "due"} ${new Date(d.next).toLocaleString()}`);
			}
			// Chat objects are gone, so there is no chat-row branch any more: a
			// human message now lands in the object's own discussion, and that
			// bumps the object's updatedAt - the rows already scanned above are
			// exactly where the newest human talk is.
			const msgs: string[] = [];
			for (const r of [...rows].sort((a: QueryRow, b: QueryRow) => b.updatedAt - a.updatedAt).slice(0, 6)) {
				const obj = await fetchObject(r.id).catch(() => null);
				if (!obj) continue;
				for (const m of convBlocks(obj, HUMAN_THREAD).slice(-4)) {
					const custom = m.block.content.custom;
					if (custom?.contentType !== "chat") continue;
					const meta = custom.meta ?? {};
					if (isAgentAuthor(String(meta["author"] ?? "")) || meta["origin"]) continue;
					msgs.push(`- ${String(meta["author"] || "human")} on "${str(obj.fields, "name") || obj.id.slice(0, 8)}": ${String(meta["text"] ?? "").slice(0, 140)}`);
				}
			}
			if (msgs.length > 0) out.push("", "LATEST HUMAN MESSAGES:", ...msgs.slice(-5));
			const failing = [...(await myInstallations().catch(() => new Map<string, InstallationRow>())).values()].filter((r) => r.error !== "");
			if (failing.length > 0) {
				out.push("", "OPEN HOLDUPS (capabilities missing):");
				for (const r of failing.slice(0, 5)) out.push(`- ${r.key}: ${r.error.slice(0, 140)}`);
			}
			return out.join("\n");
		},
	},
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
			return await summarizeObject(await assertInSpace(await fetchObject(S(input.id)), ctx));
		},
	},
	{
		def: {
			name: "discussion_read",
			description:
				"Read one conversation on an object (object_get shows only the body). Returns the last messages oldest-first with author names and timestamps. Use it when the current message refers to earlier conversation on that object.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string" },
					thread_id: { type: "string", description: "a conversation on that object; omit for the human discussion" },
					limit: { type: "number", description: "max messages, default 30" },
				},
				required: ["id"],
			},
		},
		handler: async (input, ctx) => {
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
			ctx.touched.add(obj.id);
			const msgs: Array<{ author: string; text: string; ts: number }> = [];
			for (const { block } of convBlocks(obj, S(input.thread_id) || HUMAN_THREAD)) {
				const c = block.content.custom;
				if (c?.contentType !== "chat") continue;
				const meta = c.meta ?? {};
				if (!(meta["text"] ?? "").trim()) continue;
				msgs.push({ author: meta["author"] ?? "", text: meta["text"] ?? "", ts: Number(meta["ts"] ?? 0) });
			}
			for (const entry of obj.mailbox ?? []) {
				if (entry.threadId !== S(input.thread_id)) continue;
				const message = entry.message;
				msgs.push({ author: message.sender.agentId || message.author || message.sender.objectId, text: message.text, ts: message.sentAt });
			}
			msgs.sort((a, b) => a.ts - b.ts);
			if (msgs.length === 0) return S(input.thread_id) ? "(no messages in that conversation)" : "(no discussion on this object)";
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
			description:
				"Set one of the object's properties - only a property that exists in this space (the reply lists them if the key is unknown); a value nothing can display is refused, never stored. The value is written in the property's own type: checkbox true/false, number a number, date epoch milliseconds or an ISO date, tag/object comma-separated; anything else is text. The reply is the value as the human now sees it. Setting done=true on a recurring object completes its current occurrence. key=agent ADDS the given agent id(s) to the guest list (who may be @-asked here); it never removes anyone. To make an object repeat, use object_set_repeat.",
			input_schema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["id", "key", "value"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
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
		},
	},
	{
		def: {
			name: "object_set_repeat",
			description:
				"Make an object repeat, or change how it repeats - exactly what the Repeat cell on the object sets. Every `every` `unit`s. day/week/month/year: it runs at each of `times` (local HH:MM, default 09:00) on every day it runs - several times a day is one rule; weekly rules may name weekdays. minute/hour: it runs every `every` minutes/hours from `from` to `until` (local HH:MM, default the whole day), optionally only on `weekdays`. start is the first day (ISO date, default today). Each occurrence runs through an agent on the object's guest list. The reply is the rule and next occurrence as the human sees them.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string", description: "object id; omit for the object of this conversation" },
					every: { type: "number", description: "interval, default 1 (1-999; hours 1-23)" },
					unit: { type: "string", enum: ["minute", "hour", "day", "week", "month", "year"] },
					times: { type: "array", items: { type: "string" }, description: "day/week/month/year: local HH:MM times (24h) it runs on each day it runs; default [\"09:00\"]" },
					from: { type: "string", description: "minute/hour: local HH:MM the day's runs start; default 00:00" },
					until: { type: "string", description: "minute/hour: local HH:MM of the day's last possible run; default 23:59" },
					weekdays: { type: "array", items: { type: "string" }, description: "mon..sun. week: which days (default the start day's weekday); minute/hour: only these days (default every day)" },
					monthly: { type: "string", enum: ["date", "weekday"], description: "monthly only: same date (default) or same nth weekday" },
					start: { type: "string", description: "first day, ISO date; default today" },
				},
				required: ["unit"],
			},
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const unit = S(input.unit);
			if (!["minute", "hour", "day", "week", "month", "year"].includes(unit)) return `error: nothing written. unit must be minute, hour, day, week, month or year, not "${unit}".`;
			const subDaily = unit === "minute" || unit === "hour";
			const most = unit === "hour" ? 23 : 999;
			const every = input.every === undefined ? 1 : Number(input.every);
			if (!Number.isInteger(every) || every < 1 || every > most) return `error: nothing written. every must be a whole number from 1 to ${most}.`;
			const weekdays: number[] = [];
			for (const w of A(input.weekdays)) {
				const i = WEEKDAY_NAMES.indexOf(w.trim().toLowerCase().slice(0, 3));
				if (i < 0) return `error: nothing written. "${w}" is not a weekday (mon..sun).`;
				weekdays.push(i);
			}
			const rule: Record<string, unknown> = {
				freq: unit,
				interval: every,
				weekdays: unit === "week" || subDaily ? weekdays : [],
				monthly: S(input.monthly) === "weekday" ? "weekday" : "date",
				tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
			};
			if (subDaily) {
				if (input.times !== undefined) return `error: nothing written. times is for day, week, month and year; a ${unit} rule runs from "from" to "until".`;
				const from = minutesOf(S(input.from) || "00:00");
				const until = minutesOf(S(input.until) || "23:59");
				if (from === null || until === null || from > until) return `error: nothing written. from and until must be HH:MM (24h) with from before until, not "${S(input.from)}" - "${S(input.until)}".`;
				rule.window = [from, until];
			} else {
				if (input.from !== undefined || input.until !== undefined) return `error: nothing written. from/until are for minute and hour rules; a ${unit} rule runs at its times.`;
				const raw = input.times === undefined ? ["09:00"] : A(input.times);
				const times = raw.map(minutesOf);
				const bad = raw.find((_, i) => times[i] === null);
				if (raw.length === 0 || bad !== undefined) return `error: nothing written. times must be one or more HH:MM (24h)${bad === undefined ? "" : `, not "${bad}"`}.`;
				rule.times = times;
			}
			if (S(input.start)) {
				const d = new Date(`${S(input.start).slice(0, 10)}T12:00:00`);
				if (Number.isNaN(d.getTime())) return `error: nothing written. start must be an ISO date, not "${S(input.start)}".`;
				// Noon, like the Repeat editor: the anchor lands on that local day whatever the UTC offset.
				rule.anchor_ms = d.getTime();
			}
			await mutate("repeat_set", { object_id: obj.id, rule, ...localClock() });
			const after = await fetchObject(obj.id);
			const guests = guestAgents(after.fields);
			const who = guests.length ? "" : " No agent is on its guest list, so nothing runs each occurrence until one is added (object_set_field key=agent).";
			return `Repeats ${describeRepeat(after.fields["repeat"])}.${who}`;
		},
	},
	{
		def: {
			name: "object_clear_repeat",
			description: "Stop an object repeating - the Repeat cell's \"Turn off repeating\". Its history stays in the DAG.",
			input_schema: { type: "object", properties: { id: { type: "string", description: "object id; omit for the object of this conversation" } } },
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			if (!obj.fields["repeat"]) return "error: nothing written. This object does not repeat.";
			await mutate("repeat_clear", { object_id: obj.id });
			return "This object no longer repeats.";
		},
	},
	{
		def: {
			name: "object_add_property",
			description:
				"Create a new property in this space - on purpose, visible to everyone in the Properties list - when none of the existing ones fits (object_set_field lists them). Then set values with object_set_field. `object` properties may be limited to some types (type keys). Creating a key that already exists changes nothing and says so.",
			input_schema: {
				type: "object",
				properties: {
					name: { type: "string", description: "human name, e.g. 'Mockup status'" },
					format: { type: "string", enum: [...PROPERTY_FORMATS] },
					object_types: { type: "array", items: { type: "string" }, description: "object format only: type keys the value may link to" },
				},
				required: ["name", "format"],
			},
		},
		handler: async (input, ctx) => {
			const name = S(input.name).trim();
			if (!name) return "error: nothing created. A property needs a name.";
			const format = S(input.format);
			if (!(PROPERTY_FORMATS as readonly string[]).includes(format)) return `error: nothing created. format must be one of ${PROPERTY_FORMATS.join(", ")}.`;
			const key = propertyKey(name);
			if (SCHEDULE_KEYS.has(key)) return `error: nothing created. A "${name}" property would not make anything repeat - use object_set_repeat.`;
			const space = await agentSpace(ctx);
			// Same property whatever the spelling: "Due date", "due_date" and the bundled "dueDate" are one.
			const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
			const existing = [...(await relationDefs(space)).values()].find((d) => norm(d.key) === norm(name) || norm(d.name) === norm(name));
			if (existing) return `Nothing created: this space already has ${existing.name} (key ${existing.key}, ${existing.format}). Set it with object_set_field key=${existing.key}.`;
			const types = await typeDefs(space);
			const limits: string[] = [];
			for (const k of format === "object" ? A(input.object_types) : []) {
				const t = types.get(k);
				if (!t) return `error: nothing created. No type "${k}" in this space; types here: ${[...types.keys()].join(", ")}.`;
				limits.push(t.id);
			}
			await createObject(name, "relation", {
				channel: sv(space),
				key: sv(key),
				name: sv(name),
				format: sv(format),
				hidden: bv(false),
				readOnly: bv(false),
				maxCount: iv(format === "status" ? 1 : 0),
				options: lv([]),
				bundled: bv(false),
				...(limits.length ? { object_types: lv(limits) } : {}),
			});
			return `Created the property ${name} (key ${key}, ${format}) in this space; it now shows in the Properties list. Set it with object_set_field key=${key}.`;
		},
	},
	{
		def: {
			name: "object_clear_field",
			description: "Empty one of an object's properties (the Properties pane's Remove). The guest list (agent) and the repeat rule have their own tools; computed dates can't be cleared.",
			input_schema: {
				type: "object",
				properties: { id: { type: "string", description: "object id; omit for the object of this conversation" }, key: { type: "string" } },
				required: ["key"],
			},
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing cleared. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const key = S(input.key);
			if (key === "repeat") return "error: nothing cleared. Stop a repeat with object_clear_repeat.";
			if (key === "agent") return "error: nothing cleared. Agents are not removed from a guest list by agents - ask the human.";
			const def = (await relationDefs(await agentSpace(ctx))).get(key);
			if (!def) return `error: nothing cleared. This space has no "${key}" property.`;
			if (def.readOnly) return `error: nothing cleared. ${def.name} is computed by the store.`;
			if (!(key in obj.fields)) return `Nothing cleared: ${def.name} is already empty.`;
			await mutate("delete_field", { object_id: obj.id, key });
			const after = await fetchObject(obj.id);
			// The engine may answer a cleared pin with its own error (an agent with no Served by): say so.
			const error = str(after.fields, "error");
			return `${def.name} is now empty.${error && error !== str(obj.fields, "error") ? ` The object now shows: ${error}` : ""}`;
		},
	},
	{
		def: {
			name: "object_set_type",
			description:
				"Change an object's type (e.g. note -> task) to one of this space's types; its text, properties and history stay. Infrastructure (agents, computers, spaces, properties, types, templates, queries, collections) is never retyped.",
			input_schema: {
				type: "object",
				properties: { id: { type: "string", description: "object id; omit for the object of this conversation" }, type: { type: "string", description: "type key, e.g. task" } },
				required: ["type"],
			},
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing changed. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const key = S(input.type);
			if (FIXED_TYPES.has(obj.typeKey)) return `error: nothing changed. A ${obj.typeKey} object keeps its type.`;
			if (FIXED_TYPES.has(key)) return `error: nothing changed. Objects are not turned into ${key} objects this way.`;
			const types = await typeDefs(await agentSpace(ctx));
			const t = types.get(key);
			if (!t) {
				const offered = [...types.values()].filter((d) => !FIXED_TYPES.has(d.key)).map((d) => `${d.key} (${d.name})`).join(", ");
				return `error: nothing changed. No type "${key}" in this space; types here: ${offered}.`;
			}
			if (obj.typeKey === key) return `Nothing changed: it is already a ${t.name}.`;
			await mutate("set_type", { object_id: obj.id, type_key: key });
			const after = await fetchObject(obj.id);
			return `It is now a ${types.get(after.typeKey)?.name ?? after.typeKey}.`;
		},
	},
	{
		def: {
			name: "occurrence_complete",
			description:
				"Mark the current occurrence of a recurring object done; its schedule advances to the next occurrence. Call it once, after the scheduled work is actually finished. Notes belong in your reply, not on the object.",
			input_schema: { type: "object", properties: { object_id: { type: "string" } }, required: ["object_id"] },
		},
		handler: async (input, ctx) => {
			const obj = await assertInSpace(await fetchObject(S(input.object_id)), ctx);
			ctx.touched.add(obj.id);
			const { next } = await mutate("occurrence_complete", { object_id: obj.id, ...localClock() });
			return typeof next === "number" ? `ok; next occurrence ${new Date(next).toLocaleString()}` : "ok";
		},
	},
	{
		def: {
			name: "object_add_text",
			description:
				"Append NEW text to an object's body. Markdown lines become real blocks: '- [ ] x' checkboxes, '- x' bullets, '1. x' numbered, '# x' headings, '> x' quotes; plain lines become paragraphs. Indent a line to nest it under the one above; **bold**, *italic*, `code` and [text](url) become formatting. When the object already has a matching list or section, pass 'under' with that block's text (e.g. under: \"Walmart\") so new items join it as children instead of landing at the page root. To change what is already there, use object_edit_block / object_check / object_set_block_style / object_move_block / object_remove_blocks; to link another object, object_add_link (never write '🔗 Name' text).",
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
			name: "object_edit_block",
			description:
				"Replace the text of one line in an object's body, keeping its style (heading, bullet, checkbox...). `block` is the id from object_get's body. The reply is the line as the human now reads it.",
			input_schema: {
				type: "object",
				properties: { id: { type: "string", description: "object id; omit for the object of this conversation" }, block: { type: "string" }, text: { type: "string" } },
				required: ["block", "text"],
			},
		},
		handler: async (input, ctx) => {
			const hit = await bodyTarget(input, ctx);
			if (typeof hit === "string") return hit;
			const t = hit.entry.block.content.text;
			if (!t) return `error: nothing written. That line is a ${hit.entry.block.content.custom?.contentType ?? "non-text"} block, not text.`;
			// Inline markdown in the new text (**bold**, [link](url), `code`) becomes real formatting.
			const { text, marks } = inlineMarks(S(input.text));
			const cleared = (t.marks ?? []).length > 0 && marks.length === 0;
			await mutate("block_update", { object_id: hit.obj.id, block_id: hit.entry.id, content: { ...hit.entry.block.content, text: { ...t, text, marks } } });
			return `${await lineNow(hit.obj.id, hit.entry.id)}${cleared ? "\n(Its inline formatting - bold, links, mentions - was cleared with the old text.)" : ""}`;
		},
	},
	{
		def: {
			name: "object_set_block_style",
			description: "Change what one body line is: paragraph, h1, h2, h3, quote, bullet, numbered or checkbox. `block` is the id from object_get's body.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string", description: "object id; omit for the object of this conversation" },
					block: { type: "string" },
					style: { type: "string", enum: Object.keys(STYLE) },
				},
				required: ["block", "style"],
			},
		},
		handler: async (input, ctx) => {
			const hit = await bodyTarget(input, ctx);
			if (typeof hit === "string") return hit;
			const t = hit.entry.block.content.text;
			if (!t) return `error: nothing written. That line is a ${hit.entry.block.content.custom?.contentType ?? "non-text"} block, not text.`;
			const name = S(input.style) as keyof typeof STYLE;
			if (!(name in STYLE)) return `error: nothing written. style must be one of ${Object.keys(STYLE).join(", ")}.`;
			const style = STYLE[name];
			await mutate("block_update", { object_id: hit.obj.id, block_id: hit.entry.id, content: { ...hit.entry.block.content, text: { ...t, style, checked: style === STYLE.checkbox ? t.checked === true : false } } });
			return await lineNow(hit.obj.id, hit.entry.id);
		},
	},
	{
		def: {
			name: "object_check",
			description: "Tick or untick one checkbox line in an object's body. `block` is the id from object_get's body (a line starting '- [ ]' or '- [x]').",
			input_schema: {
				type: "object",
				properties: { id: { type: "string", description: "object id; omit for the object of this conversation" }, block: { type: "string" }, checked: { type: "boolean" } },
				required: ["block", "checked"],
			},
		},
		handler: async (input, ctx) => {
			const hit = await bodyTarget(input, ctx);
			if (typeof hit === "string") return hit;
			const t = hit.entry.block.content.text;
			if (!t || t.style !== STYLE.checkbox) return `error: nothing written. That line is not a checkbox (${hit.entry.line.slice(0, 80)}).`;
			await mutate("block_update", { object_id: hit.obj.id, block_id: hit.entry.id, content: { ...hit.entry.block.content, text: { ...t, checked: input.checked === true } } });
			return await lineNow(hit.obj.id, hit.entry.id);
		},
	},
	{
		def: {
			name: "object_remove_blocks",
			description: "Delete lines from an object's body - each block and everything nested under it. `blocks` are ids from object_get's body. The reply lists what was removed.",
			input_schema: {
				type: "object",
				properties: { id: { type: "string", description: "object id; omit for the object of this conversation" }, blocks: { type: "array", items: { type: "string" } } },
				required: ["blocks"],
			},
		},
		handler: async (input, ctx) => {
			const ids = A(input.blocks);
			if (ids.length === 0) return "error: nothing removed. Pass the block ids to remove.";
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing removed. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const body = bodyBlocks(obj);
			const missing = ids.filter((b) => !body.some((e) => e.id === b));
			if (missing.length) return `error: nothing removed. Not lines of this object's body: ${missing.join(", ")}. Read object_get's body for the ids.`;
			const removed = body.filter((e) => ids.includes(e.id));
			for (const e of removed) await mutate("block_remove", { object_id: obj.id, block_id: e.id });
			const after = new Set(bodyBlocks(await fetchObject(obj.id)).map((e) => e.id));
			const gone = body.filter((e) => !after.has(e.id));
			return `Removed ${gone.length} line(s):\n${gone.map((e) => `${"  ".repeat(e.depth)}${e.line}`).join("\n")}`;
		},
	},
	{
		def: {
			name: "object_move_block",
			description: "Move one body line (with what's nested under it) before or after another line, or inside it as its last child. Ids come from object_get's body.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string", description: "object id; omit for the object of this conversation" },
					block: { type: "string" },
					to: { type: "string", description: "the line to move next to" },
					where: { type: "string", enum: ["before", "after", "inside"] },
				},
				required: ["block", "to", "where"],
			},
		},
		handler: async (input, ctx) => {
			const hit = await bodyTarget(input, ctx);
			if (typeof hit === "string") return hit;
			const body = bodyBlocks(hit.obj);
			const to = body.find((e) => e.id === S(input.to));
			if (!to) return `error: nothing moved. "${S(input.to)}" is not a line of this object's body.`;
			// The moved line's own subtree, in reading order right after it.
			const at = body.findIndex((e) => e.id === hit.entry.id);
			let end = at + 1;
			while (end < body.length && body[end].depth > hit.entry.depth) end++;
			if (body.slice(at, end).includes(to)) return "error: nothing moved. A line cannot move next to or into itself or its own nested lines.";
			const where = S(input.where);
			const position = where === "before" ? 1 : where === "after" ? 2 : where === "inside" ? 5 : 0;
			if (!position) return "error: nothing moved. where must be before, after or inside.";
			await mutate("block_move", { object_id: hit.obj.id, block_id: hit.entry.id, target_id: to.id, position });
			const now = bodyBlocks(await fetchObject(hit.obj.id));
			const i = now.findIndex((e) => e.id === hit.entry.id);
			const prev = now.slice(0, i).reverse().find((e) => e.depth <= now[i].depth);
			return `${now[i].line}\n${prev ? `now ${prev.depth < now[i].depth ? "inside" : "after"}: ${prev.line}` : "now first in the body"}`;
		},
	},
	{
		def: {
			name: "object_add_link",
			description:
				"Add a link to another object in this object's body - a real, clickable link card, never text that merely looks like one. Place it at the end of the body, inside a line (`under`) or right after one (`after`); those ids come from object_get's body.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string", description: "object id; omit for the object of this conversation" },
					target: { type: "string", description: "id of the object to link to" },
					under: { type: "string", description: "body line to nest the link inside" },
					after: { type: "string", description: "body line to place the link after" },
				},
				required: ["target"],
			},
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: nothing added. No object id and this turn is not running on an object.";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const target = await fetchObject(S(input.target)).catch(() => null);
			if (!target || target.deleted) return `error: nothing added. No object "${S(input.target)}" - find it with object_search first.`;
			await assertInSpace(target, ctx);
			const body = bodyBlocks(obj);
			const anchor = S(input.under) || S(input.after);
			if (anchor && !body.some((e) => e.id === anchor)) return `error: nothing added. "${anchor}" is not a line of this object's body.`;
			await mutate("block_add", {
				object_id: obj.id,
				block: { id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: "link", meta: { target: target.id, style: "text" } } } },
				...(anchor ? { target_id: anchor, position: S(input.under) ? POSITION_INNER : 2 } : {}),
			});
			return `Linked to "${str(target.fields, "name") || "Untitled"}" (${target.typeKey}) - a clickable link in the body.`;
		},
	},
	{
		def: {
			name: "object_delete",
			description: "Move an object to the space's bin (recoverable: object_restore brings it back, with its text, properties and history).",
			input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
			if (obj.deleted) return `Nothing deleted: "${str(obj.fields, "name") || "Untitled"}" is already in the bin.`;
			await mutate("delete", { object_id: obj.id });
			return `Moved "${str(obj.fields, "name") || "Untitled"}" (${obj.typeKey}) to the bin; object_restore brings it back.`;
		},
	},
	{
		def: {
			name: "object_restore",
			description: "Bring an object back from the space's bin (the bin's Restore): its text, properties and history return with it.",
			input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
			if (!obj.deleted) return `error: nothing restored. "${str(obj.fields, "name") || "Untitled"}" is not in the bin.`;
			await mutate("restore", { object_id: obj.id });
			const after = await fetchObject(obj.id);
			return after.deleted ? "error: the restore did not take - it is still in the bin." : `Restored "${str(after.fields, "name") || "Untitled"}" (${after.typeKey}) from the bin.`;
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
			// An object id alone addresses its human discussion; agent-to-agent
			// talk has its own thread (agent_ask) and never lands here.
			await postTo(humanRef(S(input.object_id)), S(input.text), ctx.agentId);
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
		handler: async (input, ctx) => readSkill(S(input.name), ctx.agentId, ctx.toolset?.granted),
	},
];

const SPAWN_TOOL: RegisteredTool = {
	def: {
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
	},
	handler: async (input, ctx) => {
		if (!ctx.spawn) throw new Error("spawn unavailable at this depth");
		return await ctx.spawn(S(input.task), S(input.template) || "task", ctx);
	},
};

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
const SHELL_OUTPUT_CAP = 16_000;

/**
 * shell_exec: gated (GATED_TOOLS) - offered at depth 0 and to the
 * installer template, and only while the agent's Tools (a helper's: its
 * top-level agent's) list it. Spawned task helpers never get it.
 */
const SHELL_TOOL: RegisteredTool = {
	def: {
		name: "shell_exec",
		description:
			"Run a shell command on this machine (sh -lc, 5min timeout). cwd is your Project folder when one is set, else home. Use for repo work, installs, and verification commands.",
		input_schema: {
			type: "object",
			properties: { command: { type: "string", description: "the shell command to run" } },
			required: ["command"],
		},
	},
	handler: async (input, ctx) => {
		const command = S(input.command);
		if (!command) return "error: command required";
		const proc = Bun.spawn(["sh", "-lc", command], { cwd: ctx.workspacePath || process.env.HOME, stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill(), SHELL_TIMEOUT_MS);
		const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		const code = await proc.exited;
		clearTimeout(timer);
		const body = (out + (err ? `\n[stderr]\n${err}` : "")).trim();
		return `exit ${code}\n${body.slice(-SHELL_OUTPUT_CAP) || "(no output)"}`;
	},
};

const SUBMIT_TOOL: RegisteredTool = {
	def: {
		name: "submit_result",
		description: "Submit your final result to the parent agent. Call exactly once when done.",
		input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
	},
	handler: async (input, ctx) => {
		if (!ctx.submitResult) throw new Error("submit_result is subagent-only");
		ctx.submitResult(S(input.content));
		return "result submitted";
	},
};

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
			input_schema: { type: "object", properties: { id: { type: "string", description: "object id; omit for the object of this conversation" } } },
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) throw new Error("no id given and this turn is not running on an object");
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

// A request commits to the sender's DAG before any delivery or recipient turn.
// Only human-rooted turns initiate agent requests; replies cannot fan out
// fresh questions, and group membership is the explicit address snapshot.
// The durable sender is the object this turn is ABOUT (`ctx.boundObject`),
// not the agent's own home: an agent working on object X must let X keep
// the request and see the reply. On the agent's own page there is no bound
// object, so its home is the source.
//
// Guest list rule: a recipient object must name the asked agent in its
// `agent` property. Adding someone to that list IS the way to bring them in
// (object_set_field agent += id). Agent-to-agent asks are allowed.
const A2A_TOOL: RegisteredTool = {
	def: {
		name: "agent_ask",
		description:
			"Send a durable question to agents on ANOTHER object's guest list (its Agent property), as a separate exchange thread. For an agent that is in this chat with you (a guest on the object you're working on), don't use this - make your reply the question, starting with \"@Their Name \", and they answer in the same chat. Every recipient receives its own DAG copy and answers asynchronously on its serving machine, including after being offline. Read replies with discussion_read using the returned threadId. To ask an agent that is not yet on the object, add it first with object_set_field(key=agent). Agents never create minds. Specify the complete group audience for each message; a reply preserves its exchange_id and reply_to.",
		input_schema: {
			type: "object",
			properties: {
				object_ids: { type: "array", items: { type: "string" }, minItems: 1, description: "objects whose existing agents should receive this message" },
				text: { type: "string" },
				exchange_id: { type: "string", description: "existing exchange id, or omit for a new exchange" },
				reply_to: { type: "string", description: "message id being answered in that exchange" },
				title: { type: "string" },
			},
			required: ["object_ids", "text"],
		},
	},
	handler: async (input, ctx) => {
		if (ctx.depth !== 0) throw new Error("agent_ask is only available to top-level turns, not sub-agents");
		const me = await fetchObject(ctx.agentId);
		const subject = await fetchObject(ctx.boundObject ?? agentSubject(me));
		const ids = [...new Set(A(input.object_ids))];
		if (!ids.length || !S(input.text).trim()) throw new Error("recipient objects and nonempty text are required");
		const recipients: AgentEndpoint[] = [];
		const names: string[] = [];
		for (const id of ids) {
			const target = await fetchObject(id);
			if (target.typeKey !== "channel" || target.id !== (await agentSpace(ctx))) await assertInSpace(target, ctx);
			let holder: Pick<ObjectJSON, "id" | "typeKey" | "fields"> | undefined;
			let endpointObjectId: string;
			if (target.typeKey === "agent") {
				holder = target;
				endpointObjectId = agentSubject(target);
			} else {
				// A space is an object: its agents are on its own guest list.
				const guests = guestAgents(target.fields).filter((aid) => aid !== ctx.agentId);
				if (guests.length === 0) throw new Error(`"${str(target.fields, "name") || id}" has no other agent on its guest list; add one with object_set_field(id, "agent", "<agent id>") first`);
				// One recipient per object: the first guest that is not the asker.
				holder = await fetchObject(guests[0]).catch(() => undefined);
				endpointObjectId = target.id;
			}
			if (!holder || holder.typeKey !== "agent") throw new Error(`the agent named on "${str(target.fields, "name") || id}" does not exist`);
			if (holder.id === ctx.agentId) throw new Error("an agent cannot send a request to itself");
			// Both in this object's chat: a visible @-tag there reaches them (the
			// tag wakes them) and keeps the person in the loop; a hidden
			// exchange about this same object only splits the conversation -
			// continuing an old one included, which is how an agent that once
			// used agent_ask here keeps reaching for it.
			if (ctx.boundObject && guestAgents(subject.fields).includes(holder.id)) {
				const name = str(holder.fields, "name") || "the agent";
				throw new Error(`${name} is in this chat with you. Don't use agent_ask, not even to continue an exchange: make your reply the question itself, starting "@${name} " - they see it and answer here.`);
			}
			const endpoint = { objectId: endpointObjectId, agentId: holder.id };
			if (recipients.some((entry) => entry.objectId === endpoint.objectId)) throw new Error("each recipient object must be distinct");
			recipients.push(endpoint);
		}
		const replyTo = S(input.reply_to);
		const parent = replyTo ? subject.mailbox?.find((entry) => entry.message.id === replyTo)?.message : undefined;
		if (replyTo && !parent) throw new Error("reply_to must identify a message on your own object");
		const exchangeId = S(input.exchange_id) || parent?.exchangeId || crypto.randomUUID();
		if (parent && parent.exchangeId !== exchangeId) throw new Error("reply belongs to a different exchange");
		const message: AgentMessage = {
			id: crypto.randomUUID(), exchangeId,
			sender: { objectId: subject.id, agentId: me.id }, recipients,
			text: S(input.text).trim(), replyTo, sentAt: Date.now(),
			title: S(input.title) || parent?.title || [str(me.fields, "name") || me.id, ...names].join(" / "),
			requestReply: true, historical: false, operation: "", author: me.id,
		};
		return JSON.stringify({ ...await sendMessage(message), status: "queued", recipients });
	},
};

/** Every built-in tool, as this harness runs it - what the built-in Tool objects mirror (tool-objects.ts). */
export const BUILTIN_TOOLS: readonly RegisteredTool[] = [...TOOLS, ...EVAL_TOOLS, ...WEB_TOOLS, FLAG_ERROR_TOOL, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL, A2A_TOOL, SPAWN_TOOL, SHELL_TOOL, SUBMIT_TOOL];

/**
 * The tools an agent is offered for a template ("" = a top-level agent).
 * `toolset`: what its Tools property adds - a gated built-in it doesn't
 * list is not offered at all, and its custom tools follow the built-ins
 * (not for explore, which is read-only, nor the installer). Omitted =
 * every built-in, for callers that only inspect the catalog.
 */
export function toolDefs(template: string, depth: number, allowAsk = false, toolset?: Toolset): ToolDef[] {
	const builtins = builtinDefs(template, depth, allowAsk).filter((d) => !toolset || GATED_TOOLS[d.name] !== true || toolset.granted.has(d.name));
	const custom = toolset && template !== "explore" && template !== "installer" ? [...toolset.custom.values()].map((t) => t.def) : [];
	return [...builtins, ...custom];
}

/**
 * Subagents never get the shell: a spawned child runs on its parent's
 * instructions, not the owner's, so it stops at depth 0 (installer
 * template excepted).
 */
function builtinDefs(template: string, depth: number, allowAsk: boolean): ToolDef[] {
	const READ_ONLY = new Set(["object_search", "object_list", "object_get", "memory_recall", "memory_list_facts", "memory_list_milestones", "skill_read", "capability_list"]);
	let defs = [...TOOLS, ...EVAL_TOOLS, ...WEB_TOOLS, FLAG_ERROR_TOOL, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL].map((t) => t.def);
	if (template === "" && depth === 0) defs.push(A2A_TOOL.def);
	if (template === "explore") defs = defs.filter((d) => READ_ONLY.has(d.name));
	const out = [...defs];
	if (template === "installer") {
		// Least privilege: installs need only the shell and the result channel.
		return [SHELL_TOOL.def, SUBMIT_TOOL.def];
	}
	if (template === "") {
		out.push(SPAWN_TOOL.def);
		if (depth === 0) out.push(SHELL_TOOL.def);
	} else out.push(SUBMIT_TOOL.def);
	if (template === "task" && depth < 2) out.push(SPAWN_TOOL.def);
	return out;
}

/** A custom Tool, run in its own process (tool-host.ts); its result as the model reads it. */
async function runCustomTool(tool: CustomTool, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
	const run = await runToolCode(tool.code, input, { agentId: ctx.agentId, objectId: ctx.boundObject ?? "", channelId: ctx.channelId, machineId: await machineId() });
	if (run.log.trim()) console.log(`[tool] ${tool.def.name}: ${run.log.trim().slice(-500)}`);
	if (!run.ok) return { content: `error: ${tool.def.name} failed: ${run.error}`, isError: true };
	const content = typeof run.value === "string" ? run.value : JSON.stringify(run.value);
	return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
}

export async function dispatchTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
	try {
		if (ctx.toolset && GATED_TOOLS[name] === true && !ctx.toolset.granted.has(name)) {
			return { content: `error: ${name} is not one of your tools - your Tools don't list it. Do the task without it, or tell the person what you'd need.`, isError: false };
		}
		const custom = ctx.toolset?.custom.get(name);
		if (custom) return await runCustomTool(custom, input, ctx);
		const tool = BUILTIN_TOOLS.find((t) => t.def.name === name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const content = await tool.handler(input, ctx);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
