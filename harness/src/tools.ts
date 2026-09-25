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
	API,
	apiFetch,
	guestAgents,
} from "./api";
import { invalidateServing, machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { CATALOG, fileHoldup, skillReady } from "./skillmgr";
import { myInstallations, type InstallationRow } from "./descriptors";
import { browserProfileDir, credentialStatus } from "./credentials";
import { credentialPageAction, X_RETWEET_JS, X_TIMELINE_JS } from "./browser";
import { isAgentAuthor } from "./surfaces";
import { objectText, readSkill } from "./skills";
import { buildNeighborhood, buildSpaceMap, relationDefs, savedViewBody, spaceFilterFor } from "./spacemap";
import * as memory from "./memory";
import { TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";
import { authRequirementsOf, localAuthRegistry, resolveAuthRequirements, validateAuthSelector } from "./authreq";
import { HUMAN_THREAD, agentSubject, convBlocks, humanRef, postTo } from "./conv";
import { sendMessage } from "./mailbox";
import { fetchInstallations } from "./descriptors";
import { chooseCapability, fetchCapabilities, linkValue, requiredKeys, requirementKeys, requiresItems } from "./capabilities";
import { requestCapability, type CapabilityOperation } from "./capability-messages";
import type { AgentEndpoint, AgentMessage } from "./api";

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
	/** The space's checkout on this machine - shell_exec's cwd when set. */
	workspacePath?: string;
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
 * A field value in the relation's own type. Agents speak strings; the
 * store does not - a checkbox written as "true" text is unchecked, a date
 * as text never sorts. Unknown format (or unparseable input) stays text.
 */
function typedValue(format: string | undefined, raw: string): ValueJSON {
	const n = raw.trim() === "" ? NaN : Number(raw);
	switch (format) {
		case "checkbox":
			return bv(raw.trim().toLowerCase() === "true");
		case "number":
			if (!Number.isFinite(n)) return sv(raw);
			return Number.isInteger(n) ? iv(n) : fv(n);
		case "date": {
			if (Number.isFinite(n)) return iv(n);
			const parsed = Date.parse(raw);
			return Number.isNaN(parsed) ? sv(raw) : iv(parsed);
		}
		case "status":
			return lv(raw.trim() ? [raw.trim()] : []);
		// Tag and object relations are lists in the store (and in the UI):
		// a bare string here would render as an empty cell.
		case "tag":
		case "object":
			return lv(
				raw
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean),
			);
		default:
			return sv(raw);
	}
}

/** The occurrence planner's clock params: now, and this machine's UTC offset. */
function localClock(): { now_ms: number; tz_offset_min: number } {
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
	// The engine returns requires verbatim: capability object ids where the
	// object links them, catalog keys where legacy strings remain.
	if (!s || !requirementKeys(s.requires, await fetchCapabilities()).includes(capability)) return "";
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

const REQUIRE_TOOL: RegisteredTool = {
	def: {
		name: "object_require",
		description:
			"Declare that the object of this conversation needs a machine capability listed under <capabilities-elsewhere> (a catalog key such as browserless or google). Links the matching capability object in the object's `requires`; the machine that serves the capability serves the object from the next turn on - nothing moves mid-turn. Only turns running on an object can call this. Tell the human the work moved, then finish the turn.",
		input_schema: {
			type: "object",
			properties: { capability: { type: "string", description: "catalog capability key" } },
			required: ["capability"],
		},
	},
	handler: async (input, ctx) => {
		const key = S(input.capability).trim();
		if (!CATALOG.some((c) => c.key === key)) return `error: unknown capability "${key}"; known: ${CATALOG.map((c) => c.key).join(", ")}`;
		if (!ctx.boundObject) return "error: this turn is not running on an object, so there is nothing to require it on";
		const obj = await fetchObject(ctx.boundObject);
		const name = str(obj.fields, "name") || obj.id.slice(0, 8);
		const caps = await fetchCapabilities();
		const me = await machineId();
		// A capability with no object yet is not offered: refuse rather than
		// write a requirement nothing can ever resolve.
		const chosen = chooseCapability(caps.filter((c) => c.key === key), me);
		if (!chosen) return `error: no machine offers "${key}" yet - it appears under <capabilities-elsewhere> once a machine installs and enables it. Nothing was required; tell the human.`;
		if (!(await requiredKeys(obj.fields, caps)).includes(key)) {
			await setField(obj.id, "requires", { valuesValue: { items: [...requiresItems(obj.fields), linkValue(chosen.id)] } });
			ctx.touched.add(obj.id);
		}
		invalidateServing();
		const [s, roster] = await Promise.all([serverOf(obj.id), machines()]);
		if (s.reason === "pinned-uncapable" || s.reason === "unsatisfied") {
			const why = s.reason === "pinned-uncapable" ? `"${name}" is pinned to a machine that lacks ${key}` : `no machine has ${key}`;
			await fileCapabilityHoldup(key, `object_require(${key}): ${why}`, ctx);
			const installations = (await fetchInstallations()).filter((row) => row.key === key && (!row.account || key !== "google"));
			return `"${name}" now requires ${key}, but ${why}. A holdup has been filed. Installation objects: ${JSON.stringify(installations.map((row) => ({ id: row.id, machine: row.machineId, status: row.status })))}. Use capability_request to request setup on the chosen installation; its owning machine requires human approval. Tell the human plainly; do not retry this turn.`;
		}
		if (s.machineId === me) return `ok: "${name}" requires ${key}, which this machine already has; the work stays here.`;
		const server = roster.find((m) => m.machineId === s.machineId)?.name ?? s.machineId.slice(0, 8);
		return `ok: "${name}" now requires ${key} and will be served by ${server} from the next turn on. Tell the human the work moved there and finish this turn.`;
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
				operation: { type: "string", enum: ["skill.install", "skill.enable", "skill.disable", "skill.uninstall", "auth.login", "auth.check", "auth.revoke", "auth.save"] },
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

const WEB_TOOLS: RegisteredTool[] = [
	{
		def: {
			name: "credential_action",
			description:
				"Act inside an active credential's logged-in, headless Chrome page and return the resulting page text. Actions: read_mentions (open X mentions), retweet_post (open the given X status URL and click Repost/Retweet through the page). Use credential_fetch for read-only pages; use this for actions the logged-in account must perform.",
			input_schema: {
				type: "object",
				properties: {
					credential: { type: "string", enum: ["x"] },
					action: { type: "string", enum: ["read_mentions", "retweet_post"] },
					url: { type: "string", description: "X status URL for retweet_post" },
				},
				required: ["credential", "action"],
			},
		},
		handler: async (input, ctx) => {
			const key = S(input.credential);
			const entry = credentialStatus().find((c) => c.key === key);
			if (!entry?.active.browser) {
				const reason = `credential "${key}" has no logged-in browser profile`;
				await fileCapabilityHoldup(key, reason, ctx);
				return `Credential unavailable: ${reason}. A holdup has been filed for the human in the Machine panel.`;
			}
			const action = S(input.action);
			const url = action === "read_mentions" ? "https://x.com/notifications/mentions" : S(input.url).trim();
			if (!/^https:\/\/(?:x|twitter)\.com\//i.test(url)) return "error: url must be an x.com or twitter.com URL";
			const js = action === "read_mentions" ? X_TIMELINE_JS : X_RETWEET_JS;
			try {
				const page = await credentialPageAction(browserProfileDir(key), url, js);
				if (/sign in|log in|login/i.test(page.text) && !/notifications|repost|retweet/i.test(page.text)) {
					return `Credential appears broken: the logged-out page was shown for ${url}. Re-login under This machine → Credentials.`;
				}
				const result = page.actionResult ? `\nAction: ${page.actionResult}` : "";
				return `${page.title}\n${page.url}\n${page.text}${result}`.slice(0, WEB_FETCH_CAP);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				await fileCapabilityHoldup(key, reason, ctx);
				return `Credential action failed: ${reason}. A holdup has been filed for the human in the Machine panel.`;
			}
		},
	},
	{
		def: {
			name: "credential_fetch",
			description:
				"Fetch a live page through an active service credential's logged-in Chrome profile, headlessly, and return its rendered text. Use this instead of web_fetch or opening Chrome when the task depends on a signed-in account (currently X). If the credential is unavailable this files a holdup; if the page shows a login wall, report the credential as broken.",
			input_schema: {
				type: "object",
				properties: {
					credential: { type: "string", enum: ["x"] },
					url: { type: "string", description: "absolute http(s) URL" },
				},
				required: ["credential", "url"],
			},
		},
		handler: async (input, ctx) => {
			const key = S(input.credential);
			const entry = credentialStatus().find((c) => c.key === key);
			if (!entry?.active.browser) {
				const reason = `credential "${key}" has no logged-in browser profile`;
				await fileCapabilityHoldup(key, reason, ctx);
				return `Credential unavailable: ${reason}. A holdup has been filed for the human in the Machine panel.`;
			}
			const url = S(input.url).trim();
			if (!/^https?:\/\//i.test(url)) return "error: url must be absolute http(s)";
			const profile = browserProfileDir(key);
			const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"].find((p) => Bun.file(p).size > 0);
			if (!chrome) {
				const reason = "no Chrome/Chromium/Brave binary found";
				await fileCapabilityHoldup(key, reason, ctx);
				return `Credential failed: ${reason}. A holdup has been filed for the human in the Machine panel.`;
			}
			const proc = Bun.spawn([chrome, "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--metrics-recording-only", "--no-first-run", "--no-default-browser-check", "--virtual-time-budget=15000", `--user-data-dir=${profile}`, "--dump-dom", url], { stdout: "pipe", stderr: "pipe" });
			const timer = setTimeout(() => {
				proc.kill();
				Bun.spawn(["pkill", "-TERM", "-P", String(proc.pid)], { stdout: "ignore", stderr: "ignore" });
			}, WEB_FETCH_TIMEOUT_MS);
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			const code = await proc.exited;
			clearTimeout(timer);
			if (code !== 0 || !out.trim()) {
				const reason = `headless ${entry.label} Chrome failed on ${url}: ${(err || out || "no output").trim().slice(0, 300)}`;
				await fileCapabilityHoldup(key, reason, ctx);
				return `Credential failed: ${reason}. A holdup has been filed for the human in the Machine panel.`;
			}
			return domToText(out).slice(0, WEB_FETCH_CAP) || "(page rendered empty)";
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
			return summarizeObject(await assertInSpace(await fetchObject(S(input.id)), ctx));
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
				"Set a field on an object (e.g. name, status, done, dueDate). The value is written in the relation's own type: checkbox fields take true/false, number fields a number, date fields epoch milliseconds or an ISO date; anything else is text. Setting done=true on a recurring object completes its current occurrence. key=agent ADDS the given agent id(s) to the object's guest list (who may be @-asked here); it never removes anyone.",
			input_schema: { type: "object", properties: { id: { type: "string" }, key: { type: "string" }, value: { type: "string" } }, required: ["id", "key", "value"] },
		},
		handler: async (input, ctx) => {
			ctx.touched.add(S(input.id));
			const obj = await assertInSpace(await fetchObject(S(input.id)), ctx);
			const key = S(input.key);
			let value = typedValue((await relationDefs(await agentSpace(ctx))).get(key)?.format, S(input.value));
			if (key === "agent") {
				const adding = S(input.value).split(",").map((s) => s.trim()).filter(Boolean);
				for (const aid of adding) {
					const agent = await fetchObject(aid).catch(() => null);
					if (agent?.typeKey !== "agent") throw new Error(`"${aid}" is not an agent object`);
				}
				value = lv([...new Set([...guestAgents(obj.fields), ...adding])]);
			}
			// The clock rides along for the one case the engine needs it: done
			// on a recurring object advances the occurrence in local time.
			await mutate("set_field", { object_id: obj.id, key, value, ...localClock() });
			return "ok";
		},
	},
	{
		def: {
			name: "object_set_auth",
			description:
				"Declare and verify the identities an object's work needs. requires_auth takes selectors from <auth-contract> (`x`, `matcherino`, `google:support@matcherino.com`); browserless and external_action are checkboxes. Every selector is validated against this machine's identities before anything is written, and the reply reports each one's live status - use it to confirm an object will actually run.",
			input_schema: {
				type: "object",
				properties: {
					id: { type: "string", description: "object id; omit for the object of this conversation" },
					requires_auth: { type: "array", items: { type: "string" }, description: "identity selectors; [] clears the requirement" },
					browserless: { type: "boolean" },
					external_action: { type: "boolean" },
				},
			},
		},
		handler: async (input, ctx) => {
			const id = S(input.id) || ctx.boundObject || "";
			if (!id) return "error: no object id and this turn is not running on an object";
			const obj = await assertInSpace(await fetchObject(id), ctx);
			ctx.touched.add(obj.id);
			const registry = await localAuthRegistry();
			if (Array.isArray(input.requires_auth)) {
				const selectors = A(input.requires_auth);
				const checked = selectors.map((raw) => ({ raw, result: validateAuthSelector(raw, registry) }));
				const bad = checked.filter((c) => "error" in c.result);
				if (bad.length > 0) {
					const known = registry.map((r) => r.selector).join(", ");
					return `error: nothing written. ${bad.map((b) => ("error" in b.result ? b.result.error : "")).join("; ")}. Selectors on this machine: ${known}`;
				}
				if (selectors.length === 0) await deleteField(obj.id, "requires_auth");
				else await setField(obj.id, "requires_auth", lv(selectors));
			}
			for (const key of ["browserless", "external_action"] as const) {
				if (typeof input[key] === "boolean") await setField(obj.id, key, bv(input[key] as boolean));
			}
			const after = await fetchObject(obj.id);
			const resolved = await resolveAuthRequirements(authRequirementsOf(after.fields));
			const rows = resolved.map((r) => `- ${r.raw}: ${r.active ? "active" : `MISSING - ${r.reason}`}`);
			const flags = ["browserless", "external_action"].filter((k) => after.fields[k]?.boolValue).join(", ");
			return [
				resolved.length === 0 ? "requires_auth: (none)" : `requires_auth:\n${rows.join("\n")}`,
				flags ? `flags: ${flags}` : "flags: (none)",
				resolved.some((r) => !r.active) ? "At least one identity is missing: the work cannot run until the human fixes it - file a holdup." : "All declared identities are active: this object can run here.",
			].join("\n");
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
		description:
			"Run a shell command on this machine (sh -lc, 5min timeout). cwd is the space's project checkout when one is bound, else home. Use for repo work, installs, and verification commands.",
		input_schema: {
			type: "object",
			properties: { command: { type: "string", description: "the shell command to run" } },
			required: ["command"],
		},
	},
	handler: async (input, ctx) => {
		const command = S(input.command);
		if (!command) return "error: command required";
		if (/\bopen\b[\s\S]*Chrome|--new-window/.test(command) && command.includes("browser-profiles")) {
			return "error: do not open a headed Chrome for machine credentials. Use credential_fetch for logged-in page reads; it runs headlessly.";
		}
		const proc = Bun.spawn(["sh", "-lc", command], { cwd: ctx.workspacePath || process.env.HOME, stdout: "pipe", stderr: "pipe" });
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
// (object_set_field agent += id). Agent-to-agent asks are allowed but
// bounded: A2A_MAX_HOPS agent-authored messages per exchange, so two minds
// cannot volley forever.
const A2A_MAX_HOPS = 3;
const A2A_TOOL: RegisteredTool = {
	def: {
		name: "agent_ask",
		description:
			"Send a durable question to agents on an object's guest list (its Agent property). Every recipient receives its own DAG copy and answers asynchronously on its serving machine, including after being offline. Read replies with discussion_read using the returned threadId. To ask an agent that is not yet on the object, add it first with object_set_field(key=agent). Agents never create minds. Specify the complete group audience for each message; a reply preserves its exchange_id and reply_to.",
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
			const endpoint = { objectId: endpointObjectId, agentId: holder.id };
			if (recipients.some((entry) => entry.objectId === endpoint.objectId)) throw new Error("each recipient object must be distinct");
			recipients.push(endpoint);
		}
		const replyTo = S(input.reply_to);
		const parent = replyTo ? subject.mailbox?.find((entry) => entry.message.id === replyTo)?.message : undefined;
		if (replyTo && !parent) throw new Error("reply_to must identify a message on your own object");
		const exchangeId = S(input.exchange_id) || parent?.exchangeId || crypto.randomUUID();
		if (parent && parent.exchangeId !== exchangeId) throw new Error("reply belongs to a different exchange");
		if (!ctx.allowAsk) {
			// Answering another agent: allowed, but every hop is an agent-authored
			// message in this exchange. Past the cap, finish with a plain reply.
			const hops = (subject.mailbox ?? []).filter((entry) => entry.message.exchangeId === exchangeId && entry.message.sender.agentId).length;
			if (hops >= A2A_MAX_HOPS) throw new Error(`this exchange already has ${hops} agent-to-agent messages (limit ${A2A_MAX_HOPS}); answer in your reply instead of asking again`);
		}
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

export function toolDefs(template: string, depth: number, allowAsk = false): ToolDef[] {
	const READ_ONLY = new Set(["object_search", "object_list", "object_get", "memory_recall", "memory_list_facts", "memory_list_milestones", "skill_read", "capability_list"]);
	let defs = [...TOOLS, ...EVAL_TOOLS, ...WEB_TOOLS, REQUIRE_TOOL, FLAG_ERROR_TOOL, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL].map((t) => t.def);
	if (template === "" && depth === 0) defs.push(A2A_TOOL.def);
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
		const tool = name === SHELL_TOOL.def.name ? SHELL_TOOL : [...TOOLS, ...EVAL_TOOLS, ...WEB_TOOLS, REQUIRE_TOOL, FLAG_ERROR_TOOL, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL, A2A_TOOL].find((t) => t.def.name === name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const content = await tool.handler(input, ctx);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
