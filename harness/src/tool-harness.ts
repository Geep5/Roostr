/**
 * The harness's side of a tool's calls back to it (tool-sdk.ts HarnessApi):
 * what a Tool's code can only ask for, because only the harness running the
 * turn has it - the agent's grants and Project folder, this computer's shell
 * and browser and capability ledger, the agent's credentials' secrets, its
 * subagents, whether its turn is a top-level one. `harnessFor(ctx)` answers
 * one run's calls (tool-host.ts carries them) for that run's agent and turn:
 * nothing a tool passes names another agent, and every check here holds
 * whatever the tool's code says - the shell and the web only for an agent
 * whose Tools list them (tools.ts GATED_TOOLS), agent_ask only from a
 * top-level turn, a credential only the agent's own, and its secrets stay
 * here: a page or an API answer comes back with them blanked out.
 */
import { fetchObject, setField, str, sv, type AgentEndpoint, type AgentMessage } from "./api";
import { credentialPageAction } from "./browser";
import { requestCapability } from "./capability-messages";
import { agentSubject } from "./conv";
import { noteCredentialIssue } from "./credential-issues";
import { agentCredential, CredentialNotConnected, type AgentCredential } from "./credential-objects";
import { actionsOf } from "./credentials";
import { fetchInstallations } from "./descriptors";
import { serverOf } from "./machine";
import { sendMessage } from "./mailbox";
import { matcherinoApi, matcherinoToken } from "./matcherino";
import { fileHoldup, skillReady } from "./skillmgr";
import { listSkills } from "./skills";
import type { HarnessServe } from "./tool-host";
import type { AskMessage, HarnessApi, HarnessMethod, ShellRun } from "./tool-sdk";
import type { ToolContext } from "./tools";

const SHELL_TIMEOUT_MS = 5 * 60 * 1000;
/** What a tool gets of each stream of a shell command: its last 256 KB. */
const SHELL_STREAM_CAP = 256 * 1024;
const WEB_PAGE_TIMEOUT_MS = 60_000;
/** What a tool gets of a rendered page's HTML. */
const WEB_PAGE_CAP = 2_000_000;
/** Where a site sends a signed-out session instead of the page asked for. */
const LOGIN_WALL = /login|signin|sign-in|onboarding|checkpoint|authwall/i;
/** Secret values shorter than this aren't blanked: they would match ordinary text. */
const SECRET_MIN_LENGTH = 8;
const METHODS: Readonly<Record<string, true>> = { GET: true, POST: true, PUT: true, PATCH: true, DELETE: true };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A text argument as the tool's process sent it, or the call is refused. */
function textArg(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`${what} must be text`);
	return value;
}

/** A gated built-in's power, refused to an agent whose Tools don't list it; an internal run (no toolset: a check, a test) has them all. */
function requireGrant(ctx: ToolContext, tool: string): void {
	if (ctx.toolset && !ctx.toolset.granted.has(tool)) throw new Error(`${tool} is not one of your tools - your Tools don't list it, so this computer won't do that for you.`);
}

function shq(v: string): string {
	return `'${v.replace(/'/g, `'\''`)}'`;
}

/** `sh -lc command` in `cwd`, stopped past `timeoutMs` or when the run ends. */
async function sh(command: string, cwd: string | undefined, timeoutMs: number, signal: AbortSignal): Promise<ShellRun> {
	const proc = Bun.spawn(["sh", "-lc", command], { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs, signal });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { exitCode: await proc.exited, stdout, stderr };
}

// ── Capability holdups ───────────────────────────────────────────
//
// A capability failure files a holdup in the machine ledger (Machine panel)
// and tells the agent the truth, so it can answer honestly instead of
// inventing a coordinator.

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

// ── Credentials ─────────────────────────────────────────────────

/** The run's agent's credential for `service`, or why it can't be used; one that is signed out is noted for the run's badge (credential-issues.ts). */
async function credentialFor(ctx: ToolContext, service: string): Promise<{ ok: true; cred: AgentCredential } | { ok: false; error: string }> {
	try {
		return { ok: true, cred: await agentCredential(await fetchObject(ctx.agentId), service) };
	} catch (error) {
		if (error instanceof CredentialNotConnected) noteCredentialIssue(ctx.agentId, error.credentialName);
		return { ok: false, error: errorText(error) };
	}
}

/**
 * Every value of a credential's that is a secret, longest first: its
 * session cookies as stored and decoded - and the strings inside one that
 * holds JSON (Matcherino's refresh token) - its pasted keys, and tokens
 * minted from them.
 */
function secretsOf(cred: AgentCredential, minted: string[] = []): string[] {
	const values = [...minted, ...Object.values(cred.keys ?? {})];
	const leaves = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(leaves) : []);
	for (const c of cred.cookies) {
		values.push(c.value);
		try {
			const decoded = decodeURIComponent(c.value);
			values.push(decoded);
			values.push(...leaves(JSON.parse(decoded)));
		} catch {
			/* not URI-encoded JSON: the value itself is the secret */
		}
	}
	return [...new Set(values.filter((v) => v.length >= SECRET_MIN_LENGTH))].sort((a, b) => b.length - a.length);
}

/** `text` with every secret blanked out. */
function blankSecrets(text: string, secrets: string[]): string {
	return secrets.reduce((out, secret) => out.replaceAll(secret, "[secret]"), text);
}

/** Any JSON value with every secret blanked out of its strings, at any depth. */
function blankSecretsDeep(value: unknown, secrets: string[]): unknown {
	if (typeof value === "string") return blankSecrets(value, secrets);
	if (Array.isArray(value)) return value.map((v: unknown) => blankSecretsDeep(v, secrets));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankSecretsDeep(v, secrets)]));
	return value;
}

// ── Agent messages ──────────────────────────────────────────────

/** The question a tool asks to send, as its process sent it; refused unless it is one. */
function askArg(value: unknown): AskMessage {
	if (typeof value !== "object" || value === null) throw new Error("the message must be an object");
	const recipients: unknown[] = "recipients" in value && Array.isArray(value.recipients) ? value.recipients : [];
	const text = "text" in value ? textArg(value.text, "text").trim() : "";
	if (recipients.length === 0 || !text) throw new Error("recipient objects and nonempty text are required");
	return {
		recipients: recipients.map((r): AgentEndpoint => {
			if (typeof r !== "object" || r === null || !("objectId" in r) || !("agentId" in r) || typeof r.objectId !== "string" || typeof r.agentId !== "string") throw new Error("each recipient is {objectId, agentId}");
			return { objectId: r.objectId, agentId: r.agentId };
		}),
		text,
		exchangeId: "exchangeId" in value ? textArg(value.exchangeId, "exchangeId") : "",
		replyTo: "replyTo" in value ? textArg(value.replyTo, "replyTo") : "",
		title: "title" in value ? textArg(value.title, "title") : "",
	};
}

// ── One run's calls ─────────────────────────────────────────────

type Handlers = { [M in HarnessMethod]: (args: unknown[], signal: AbortSignal) => ReturnType<HarnessApi[M]> };

/** The answers to one tool run's harness calls, for the agent and turn `ctx` is. */
export function harnessFor(ctx: ToolContext): HarnessServe {
	/** Matcherino access tokens minted for this run, by credential: one sign-in for its several calls. */
	const tokens = new Map<string, string>();
	const handlers: Handlers = {
		shell: async ([command], signal) => {
			requireGrant(ctx, "shell_exec");
			const run = await sh(textArg(command, "command"), ctx.workspacePath || process.env.HOME, SHELL_TIMEOUT_MS, signal);
			return { exitCode: run.exitCode, stdout: run.stdout.slice(-SHELL_STREAM_CAP), stderr: run.stderr.slice(-SHELL_STREAM_CAP) };
		},
		webPage: async ([rawUrl], signal) => {
			requireGrant(ctx, "web_fetch");
			const url = textArg(rawUrl, "url").trim();
			if (!/^https?:\/\//i.test(url)) throw new Error("url must be absolute http(s)");
			const ready = await skillReady("browserless");
			if (!ready.ok) {
				await fileCapabilityHoldup("browserless", ready.reason, ctx);
				return { ok: false, unavailable: true, reason: ready.reason };
			}
			const run = await sh(`browserless ${shq(url)}`, process.env.HOME, WEB_PAGE_TIMEOUT_MS, signal);
			if (run.exitCode !== 0 || !run.stdout.trim()) {
				const reason = `browserless failed on ${url}: ${(run.stderr || run.stdout || "no output").trim().slice(0, 300)}`;
				await fileCapabilityHoldup("browserless", reason, ctx);
				return { ok: false, unavailable: false, reason };
			}
			return { ok: true, html: run.stdout.slice(0, WEB_PAGE_CAP) };
		},
		credential: async ([service]) => {
			const found = await credentialFor(ctx, textArg(service, "service"));
			if (!found.ok) return found;
			const { row, cookies } = found.cred;
			return { ok: true, name: row.name, service: row.service, account: row.account, actions: actionsOf(row.fields), browserSignIn: cookies.length > 0 };
		},
		credentialPage: async ([service, rawUrl, rawScript]) => {
			const url = textArg(rawUrl, "url").trim();
			if (!/^https?:\/\//i.test(url)) throw new Error("url must be absolute http(s)");
			const script = textArg(rawScript, "script");
			const found = await credentialFor(ctx, textArg(service, "service"));
			if (!found.ok) return { ok: false, unavailable: true, error: found.error };
			const { row, cookies } = found.cred;
			if (cookies.length === 0) return { ok: false, unavailable: true, error: `"${row.name}" has no browser sign-in - it needs Connect pressed on it.` };
			const page = await credentialPageAction(cookies, url, script).catch((error: unknown) => new Error(errorText(error)));
			if (page instanceof Error) return { ok: false, unavailable: false, error: page.message };
			const signedOut = !page.arrived && LOGIN_WALL.test(page.url + page.title);
			if (signedOut) noteCredentialIssue(ctx.agentId, row.name);
			const secrets = secretsOf(found.cred);
			return { ok: true, name: row.name, arrived: page.arrived, signedOut, url: blankSecrets(page.url, secrets), title: blankSecrets(page.title, secrets), text: blankSecrets(page.text, secrets), result: blankSecrets(page.actionResult, secrets) };
		},
		credentialApi: async ([service, rawPath, request]) => {
			const name = textArg(service, "service");
			const path = textArg(rawPath, "path");
			if (typeof request !== "object" || request === null) throw new Error("request must be an object");
			const method = "method" in request && request.method !== undefined ? textArg(request.method, "method").toUpperCase() : "GET";
			if (!Object.hasOwn(METHODS, method)) throw new Error(`${method} is not an HTTP method`);
			// The one service whose API the harness knows how to sign in to.
			if (name !== "matcherino") return { ok: false, signedOut: false, error: `the harness signs no API requests for "${name}" credentials` };
			const found = await credentialFor(ctx, name);
			if (!found.ok) return { ok: false, signedOut: false, error: found.error };
			const { row } = found.cred;
			let token = tokens.get(row.id);
			if (!token) {
				try {
					token = await matcherinoToken(row.fields);
				} catch (error) {
					noteCredentialIssue(ctx.agentId, row.name);
					return { ok: false, signedOut: true, error: errorText(error) };
				}
				tokens.set(row.id, token);
			}
			const secrets = secretsOf(found.cred, [token]);
			try {
				return { ok: true, body: blankSecretsDeep(await matcherinoApi(token, path, method, "body" in request ? request.body : undefined), secrets) };
			} catch (error) {
				return { ok: false, signedOut: false, error: blankSecrets(errorText(error), secrets) };
			}
		},
		skills: () => listSkills(ctx.agentId, ctx.toolset?.granted),
		installations: () => fetchInstallations(),
		requestCapability: async ([installationObjectId, operation, text]) => {
			const agent = await fetchObject(ctx.agentId);
			return requestCapability({
				sender: { objectId: agentSubject(agent), agentId: agent.id },
				installationObjectId: textArg(installationObjectId, "installationObjectId"),
				operation: textArg(operation, "operation"),
				author: agent.id,
				text: textArg(text, "text"),
			});
		},
		ask: async ([raw]) => {
			// Only human-rooted top-level turns start an exchange; a helper works for its parent.
			if (ctx.depth !== 0) throw new Error("agent_ask is only available to top-level turns, not sub-agents");
			const ask = askArg(raw);
			if (ask.recipients.some((r) => r.agentId === ctx.agentId)) throw new Error("an agent cannot send a request to itself");
			const me = await fetchObject(ctx.agentId);
			const message: AgentMessage = {
				id: crypto.randomUUID(),
				exchangeId: ask.exchangeId || crypto.randomUUID(),
				// From the object this turn is about (on the agent's own page, its home) and this agent - never who the tool says.
				sender: { objectId: ctx.boundObject ?? agentSubject(me), agentId: me.id },
				recipients: ask.recipients,
				text: ask.text,
				replyTo: ask.replyTo,
				sentAt: Date.now(),
				title: ask.title || str(me.fields, "name") || me.id,
				requestReply: true,
				historical: false,
				operation: "",
				author: me.id,
			};
			return sendMessage(message);
		},
		spawn: async ([task, template]) => {
			if (!ctx.spawn) throw new Error("spawn unavailable at this depth");
			return ctx.spawn(textArg(task, "task"), textArg(template, "template") || "task", ctx);
		},
		submitResult: async ([content]) => {
			if (!ctx.submitResult) throw new Error("submit_result is subagent-only");
			ctx.submitResult(textArg(content, "content"));
		},
	};
	const known = (method: string): method is HarnessMethod => Object.hasOwn(handlers, method);
	return (method, args, signal) => (known(method) ? handlers[method](args, signal) : Promise.reject(new Error(`the harness has no call "${method}"`)));
}
