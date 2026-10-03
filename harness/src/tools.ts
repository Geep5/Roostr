/**
 * Tool registry. In glon, tools were data (ToolSpec rows dispatching to
 * daemon programs via dispatchProgram); Roostr's sidecar IS the dispatcher,
 * so tools are code with the same owner-binding guarantee: the agent id is
 * bound here, never taken from model input.
 */

import {
	bv,
	fetchObject,
	fv,
	iv,
	lv,
	mutate,
	plainValue,
	queryAll,
	setField,
	str,
	sv,
	type ObjectJSON,
	type QueryRow,
	type ValueJSON,
	guestAgents,
} from "./api";
import { invalidateServing, machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { CATALOG, fileHoldup, skillReady } from "./skillmgr";
import { myInstallations, type InstallationRow } from "./descriptors";
import { agentCredential, CredentialNotConnected, type CredentialRow } from "./credential-objects";
import { coerceToolInput } from "./tool-input";
import { noteCredentialIssue } from "./credential-issues";
import { actionsOf } from "./credentials";
import { clickThenReadJs, credentialPageAction, X_RETWEET_JS, X_TIMELINE_JS } from "./browser";
import { bodyBlocks, isAgentAuthor } from "./surfaces";
import { appendMarkdown, inlineMarks } from "./markdown";
import { featuredEvents, matcherinoToken, setFeatured } from "./matcherino";
import { readSkill } from "./skills";
import { assertInSpace, defaultSpaceId, relationDefs, spaceFilterFor } from "./spacemap";
import { describeRepeat, localClock } from "./repeat";
import { TOOL_RESULT_TRUNCATE, type ToolDef } from "./types";
import { HUMAN_THREAD, agentSubject, convBlocks, humanRef, postTo } from "./conv";
import { sendMessage } from "./mailbox";
import { fetchInstallations } from "./descriptors";
import { fetchCapabilities, fullySetUp, linkValue } from "./capabilities";
import { SKILLS_KEY, machineSkillKeys, skillForKey, skillIds } from "./skills";
import type { ToolRun } from "./tool-host";
import { SHIPPED_TOOLS, runObjectTool, type ObjectTool } from "./tool-runtime";
import { TOOL_EDIT_REFUSAL, TOOL_TYPE } from "./tool-sdk";
import { requestCapability, type CapabilityOperation } from "./capability-messages";
import type { AgentEndpoint, AgentMessage } from "./api";

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
	/** What the agent runs from Tool objects and what its Tools property unlocks (tool-objects.ts); unset = every built-in, built-ins in objects running their shipped code, no custom tools (tests, internal callers). */
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

/** What an agent runs from Tool objects (tool-objects.ts): the gated built-ins its Tools list, and every tool whose code is a Tool object's - its space's code-in-object built-ins and its custom tools - by name. */
export interface Toolset {
	granted: ReadonlySet<string>;
	objects: ReadonlyMap<string, ObjectTool>;
}

const S = (v: unknown): string => (typeof v === "string" ? v : "");
const N = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const A = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

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
		if (error instanceof CredentialNotConnected) noteCredentialIssue(ctx.agentId, error.credentialName);
		return `Credential unavailable: ${error instanceof Error ? error.message : String(error)} Tell the person; do not retry this turn.`;
	}
	if (cred.cookies.length === 0) return `Credential unavailable: "${cred.row.name}" has no browser sign-in. Tell the person to press Connect on it.`;
	try {
		const page = await credentialPageAction(cred.cookies, url, actionJs);
		if (!page.arrived && /login|signin|sign-in|onboarding|checkpoint|authwall/i.test(page.url + page.title)) {
			noteCredentialIssue(ctx.agentId, cred.row.name);
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
async function matcherinoAction(ctx: ToolContext, action: string, rawIds: unknown, cred: CredentialRow): Promise<string> {
	if (action !== "list_featured" && action !== "feature_events") return `error: ${action} is not a Matcherino action; Matcherino takes list_featured or feature_events`;
	let token: string;
	try {
		token = await matcherinoToken(cred.fields);
	} catch (error) {
		noteCredentialIssue(ctx.agentId, cred.name);
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
				if (error instanceof CredentialNotConnected) noteCredentialIssue(ctx.agentId, error.credentialName);
				return `Credential unavailable: ${error instanceof Error ? error.message : String(error)} Tell the person; do not retry this turn.`;
			}
			const actions = actionsOf(cred.row.fields);
			if (!actions.some((a) => a.key === action)) {
				const valid = actions.map((a) => a.key).join(", ");
				return `error: "${cred.row.name}" has no action "${action}"${valid ? `; its actions are ${valid}` : " - it has no actions"}. Don't retry with another name.`;
			}
			if (service === "matcherino") return matcherinoAction(ctx, action, input.ids, cred.row);
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
			const rows = (await queryAll({ filters: [await spaceFilterFor(ctx.channelId)] })).filter((r: QueryRow) => !["agent", "machine", "relation", "type", "template", "skill", "channel"].includes(r.typeKey));
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
	const obj = await assertInSpace(await fetchObject(S(input.id)), ctx.channelId);
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
			if (target.typeKey !== "channel" || target.id !== (await agentSpace(ctx))) await assertInSpace(target, ctx.channelId);
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

/** Every built-in the harness runs itself - what the harness-run built-in Tool objects mirror (tool-objects.ts). The others run from their Tool objects (tool-code.ts). */
export const BUILTIN_TOOLS: readonly RegisteredTool[] = [...TOOLS, ...WEB_TOOLS, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL, A2A_TOOL, SPAWN_TOOL, SHELL_TOOL, SUBMIT_TOOL];

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
		// A built-in whose code is its Tool object's is offered as that object describes it.
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
	const READ_ONLY = new Set(["object_search", "object_list", "object_get", "memory_recall", "memory_list_facts", "memory_list_milestones", "skill_read", "capability_list"]);
	let defs = [...[...SHIPPED_TOOLS.values()].map((t) => t.def), ...[...TOOLS, ...WEB_TOOLS, CAPABILITY_LIST_TOOL, CAPABILITY_TOOL].map((t) => t.def)];
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

/**
 * Run a tool whose code is a Tool object's (tool-runtime.ts) for this turn:
 * a built-in in the recovery core falls back to its frozen copy.
 */
export async function runObjectToolFor(tool: ObjectTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRun> {
	const copy = tool.builtin && Object.hasOwn(RECOVERY_CORE, tool.def.name) ? RECOVERY_CORE[tool.def.name] : undefined;
	const context = { agentId: ctx.agentId, objectId: ctx.boundObject ?? "", channelId: ctx.channelId, machineId: await machineId() };
	const run = await runObjectTool(tool, input, context, copy && (() => copy(input, ctx)));
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
		const fromObject = ctx.toolset?.objects.get(name) ?? SHIPPED_TOOLS.get(name);
		if (fromObject) {
			const run = await runObjectToolFor(fromObject, coerceToolInput(fromObject.def, input), ctx);
			if (!run.ok) return { content: `error: ${fromObject.builtin ? run.error : `${name} failed: ${run.error}`}`, isError: true };
			const content = typeof run.value === "string" ? run.value : JSON.stringify(run.value);
			return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
		}
		const tool = BUILTIN_TOOLS.find((t) => t.def.name === name);
		if (!tool) return { content: `unknown tool: ${name}`, isError: true };
		const content = await tool.handler(coerceToolInput(tool.def, input), ctx);
		return { content: content.slice(0, TOOL_RESULT_TRUNCATE), isError: false };
	} catch (err) {
		return { content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
	}
}
