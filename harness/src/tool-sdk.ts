/**
 * `roostr` - what a Tool's TypeScript body is handed (tool-host.ts): the
 * custom tools, and the built-ins whose code lives in their Tool objects.
 * Everyone in a space is trusted, so it is the harness's own client: the
 * same reads and writes the agents' tools make, plus the computer's Google
 * accounts through `gws-as` (the Credentials its served agents list -
 * google-credentials.ts).
 *
 * What only the harness running the turn can do - the agent's shell and
 * web, its credentials' secrets, its helpers and its questions to other
 * agents - the tool asks the harness for (HarnessApi): the call goes back
 * over the tool process's own channel (tool-host.ts) and the harness
 * answers it for this run's agent and turn (tool-harness.ts), keeping its
 * own checks whatever the tool's code says.
 *
 * Two rules hold for every tool. Whatever the SDK throws is a plain Error -
 * the daemon refusing, an object outside the space: an ordinary tool error
 * the agent reads. A JavaScript error from the tool's own code (TypeError,
 * ReferenceError, ...) means that version of the tool is broken
 * (tool-runtime.ts). And no tool changes a Tool object: people edit tools,
 * agents only call them.
 */
import { join } from "node:path";
import { chatPost, createObject, deleteField, fetchObject, guestAgents, mutate, plainValue, query, queryAll, setField, type AgentEndpoint, type BlockJSON, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { HUMAN_THREAD, convBlocks, humanRef, postTo } from "./conv";
import { hideCredentialSecrets, type CredentialAction } from "./credentials";
import type { CapabilityRow } from "./capabilities";
import { STYLE, appendMarkdown, inlineMarks, type Mark } from "./markdown";
import * as memory from "./memory";
import { describeRepeat, localClock } from "./repeat";
import { objectText, type SkillListing } from "./skills";
import type { ScoreRow } from "./jev";
import { assertInSpace, buildNeighborhood, buildSpaceMap, defaultSpaceId, relationDefs, savedViewBody, spaceFilterFor, typeDefs, type RelDef, type TypeDef } from "./spacemap";
import { bodyBlocks, isAgentAuthor, type BodyLine } from "./surfaces";

export type { AgentEndpoint, BlockJSON, ObjectJSON, QueryRow, ValueJSON } from "./api";
export type { CredentialAction } from "./credentials";
export type { CapabilityRow } from "./capabilities";
export type { Mark } from "./markdown";
export type { SkillListing } from "./skills";
export type { RelDef, TypeDef } from "./spacemap";
export type { BodyLine } from "./surfaces";

export const TOOL_TYPE = "tool";
/** What a tool that would change a Tool object gets instead. */
export const TOOL_EDIT_REFUSAL = "Tool objects are changed by people, not agents - nothing was written. Tell the person what you would change.";

/** Who and where a tool runs for. `objectId`: the object of the turn (or the repeating object for a check); "" when none. */
export interface ToolRunContext {
	agentId: string;
	objectId: string;
	channelId: string;
	machineId: string;
}

/** The running agent's long-term memory (memory.ts): pinned facts and milestones, always its own. */
export interface RoostrMemory {
	/** Pin a fact; a second upsert of the same key replaces its value. Returns the fact's id. */
	upsertFact(key: string, value: string, confidence: string, sourcedFromBlockId: string): Promise<string>;
	/** Record a milestone; the ones it `supersedes` are marked superseded. Returns its id. */
	upsertMilestone(args: Parameters<typeof memory.upsertMilestone>[1]): Promise<string>;
	/** Change the given parts of one of the agent's milestones; false when it has none with that id. */
	amendMilestone(id: string, patch: Parameters<typeof memory.amendMilestone>[2]): Promise<boolean>;
	listFacts(key?: string): Promise<QueryRow[]>;
	listMilestones(status?: string): Promise<QueryRow[]>;
	/** Facts and milestones matching a substring query and/or topics. */
	recall(args: Parameters<typeof memory.recall>[1]): Promise<{ facts: QueryRow[]; milestones: QueryRow[] }>;
}

// ── What only the harness can do ────────────────────────────────

/** A shell command's run on this computer: its exit code and the last 256 KB of each stream. */
export interface ShellRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** A live page as this computer's headless Chrome rendered it, or why not (`unavailable`: browserless isn't working here). Either failure files a holdup for the person. */
export type WebPage = { ok: true; html: string } | { ok: false; unavailable: boolean; reason: string };

/** One of the running agent's credentials as a tool sees it: what it is and does, never its secret. */
export type CredentialInfo = { ok: true; name: string; service: string; account: string; actions: CredentialAction[]; browserSignIn: boolean } | { ok: false; error: string };

/**
 * A page opened signed in with a credential, after a script ran in it.
 * `arrived` false: the site sent the page elsewhere and the script did not
 * run; `signedOut`: that was a login wall. A failure is `unavailable` (the
 * credential can't be used) or the browser's. The credential's secrets are
 * blanked out of everything.
 */
export type CredentialPage = { ok: true; name: string; arrived: boolean; signedOut: boolean; url: string; title: string; text: string; result: string } | { ok: false; unavailable: boolean; error: string };

/** A request to a credential's own API. */
export interface CredentialRequest {
	method?: string;
	body?: unknown;
}

/** The API's answer, secrets blanked out; or why there is none (`signedOut`: the credential no longer signs in). */
export type CredentialAnswer = { ok: true; body: unknown } | { ok: false; signedOut: boolean; error: string };

/** What a credential action's harness-side code returned, secrets blanked out; or why it could not run. */
export type CredentialActResult = { ok: true; result: unknown } | { ok: false; error: string };

/** A read-only statement's answer through a database credential (sql.ts), secrets blanked out; or why it did not run. */
export type CredentialSqlResult = { ok: true; columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean } | { ok: false; error: string };

/** Which of the agent's database credentials (its name or id, when it has several) and how many rows at most (default 500, at most 2000). */
export interface CredentialSqlOptions {
	credential?: string;
	maxRows?: number;
}

/** A question to other agents (agent_ask), sent from this turn's object and agent. */
export interface AskMessage {
	recipients: AgentEndpoint[];
	text: string;
	exchangeId: string;
	replyTo: string;
	title: string;
}

/** A message committed to the sender's object; delivery follows. */
export interface SentMessage {
	id: string;
	exchangeId: string;
	threadId: string;
}

/**
 * What only the harness running the turn can do, as a tool's process asks
 * it. Each call is answered for this run's agent and turn - nothing a tool
 * passes names another - and the checks the harness keeps (the agent's
 * Tools, its depth, its credentials) hold whatever the tool's code says.
 */
export interface HarnessApi {
	shell(command: string): Promise<ShellRun>;
	webPage(url: string): Promise<WebPage>;
	credential(service: string): Promise<CredentialInfo>;
	credentialPage(service: string, url: string, script: string): Promise<CredentialPage>;
	credentialApi(service: string, path: string, request: CredentialRequest): Promise<CredentialAnswer>;
	credentialAct(service: string, action: string, input: Record<string, unknown>): Promise<CredentialActResult>;
	credentialSql(service: string, sql: string, options: CredentialSqlOptions): Promise<CredentialSqlResult>;
	skills(): Promise<SkillListing[]>;
	jev(skill: string, objectIds: string[]): Promise<ScoreRow[]>;
	capabilities(): Promise<CapabilityRow[]>;
	requestCapability(capabilityObjectId: string, operation: string, text: string): Promise<SentMessage>;
	ask(message: AskMessage): Promise<SentMessage>;
	spawn(task: string, template: string): Promise<string>;
	submitResult(content: string): Promise<void>;
}

export type HarnessMethod = keyof HarnessApi;
/** One call to the harness: its answer, or a thrown Error. */
export type HarnessCall = <M extends HarnessMethod>(method: M, args: Parameters<HarnessApi[M]>) => ReturnType<HarnessApi[M]>;
/** The same call as it travels: a method name, and arguments only the harness vouches for. */
export type HarnessSend = (method: HarnessMethod, args: unknown[]) => Promise<unknown>;

/** Typed calls over `send`. */
export function harnessCalls(send: HarnessSend): HarnessCall {
	// The harness answers each method with its declared result (tool-harness.ts).
	return <M extends HarnessMethod>(method: M, args: Parameters<HarnessApi[M]>) => send(method, args) as ReturnType<HarnessApi[M]>;
}

/** The running agent's credentials (its Credentials property), used by the harness: a tool sees what they show and what they fetch, never their secrets. */
export interface RoostrCredentials {
	/** The agent's credential for `service`: its name, account, actions, and whether it signs in with a browser. */
	get(service: string): Promise<CredentialInfo>;
	/** Open `url` in a throwaway headless Chrome signed in with that credential, run `script` there (an async function body; what it returns is `result`), and read the page. */
	page(service: string, url: string, script: string): Promise<CredentialPage>;
	/** A request to the service's own API (a path on it), signed in with that credential; only for services whose sign-in the harness knows how to send (an extension's `credentialApis`). */
	api(service: string, path: string, request?: CredentialRequest): Promise<CredentialAnswer>;
	/** Run one of the credential's actions whose code lives on the harness (an extension's `credentialActions`), with `input` from the tool. */
	act(service: string, action: string, input?: Record<string, unknown>): Promise<CredentialActResult>;
	/** One read-only SQL statement against the service's database (a `postgres` credential), run by the harness in a READ ONLY transaction with a 30s timeout; the URL and password stay with the harness. */
	sql(service: string, sql: string, options?: CredentialSqlOptions): Promise<CredentialSqlResult>;
}

export interface Roostr {
	context: ToolRunContext;
	/** The engine's query (`/api/query` body: type, filters, textQuery, ...): every match, or one page when `limit` is given. */
	query(params: Record<string, unknown>): Promise<QueryRow[]>;
	get(id: string): Promise<ObjectJSON>;
	/** One object, refused (thrown) unless it lives in this tool's space - what every built-in that takes an id checks. */
	getInSpace(id: string): Promise<ObjectJSON>;
	/** One object this tool may change: in its space and not a Tool - else thrown, before anything is written. */
	writable(id: string): Promise<ObjectJSON>;
	/** The id of this tool's space (the default space for an agent without one). */
	space(): Promise<string>;
	/** The query filter that keeps a search to this tool's space. */
	spaceFilter(): Promise<Record<string, unknown>>;
	/** This space's properties by key: name, format, and whether the store computes it. */
	properties(): Promise<Map<string, RelDef>>;
	/** This space's types by key. */
	types(): Promise<Map<string, TypeDef>>;
	/** The object's body as addressable lines in reading order (the ids the body-editing tools take); never its conversation. */
	body(obj: ObjectJSON): BodyLine[];
	/** A stored value as plain JSON: links as their target ids, lists and maps of those. */
	plain(value: ValueJSON | undefined): unknown;
	/** The agent ids on an object's guest list (its `agent` property), whichever shape the field holds. */
	guests(fields: Record<string, ValueJSON>): string[];
	/** A repeat rule in the Repeat cell's words, with its next occurrence ("does not repeat" for none). */
	describeRepeat(value: ValueJSON | undefined): string;
	/** The occurrence planner's clock - now, and this computer's UTC offset: what set_field (done), repeat_set and occurrence_complete take to plan in local time. */
	clock(): { now_ms: number; tz_offset_min: number };
	/** Inline markdown (**bold**, [text](url), `code`, ...) as plain text and the editor's marks. */
	inlineMarks(text: string): { text: string; marks: Mark[] };
	/** A body line's style number by name: paragraph, h1, h2, h3, quote, bullet, numbered, checkbox. */
	textStyles: Readonly<Record<string, number>>;
	/** Keep an object in the agent's context when its conversation is compacted: this tool worked on it. */
	touch(id: string): void;
	/** The space census the agent's prompt carries: types with counts, saved views, agents. */
	spaceMap(): Promise<string>;
	/** An object's typed connections: links in and out, collections, the saved views it matches. */
	neighborhood(id: string): Promise<string>;
	/** The query that runs a saved view (a query or collection) exactly as the app does; null for an empty collection. */
	viewQuery(view: ObjectJSON): Promise<Record<string, unknown> | null>;
	/**
	 * A new object; it lands in this tool's space unless `fields.channel` says otherwise.
	 * `opts.id` fixes its id (letters, digits, - _ . :): derived from a source - a Gmail
	 * thread - two computers importing it at once write one object. An id that already
	 * exists changes nothing and answers `existed: true`.
	 */
	create(name: string, typeKey: string, fields?: Record<string, ValueJSON>, opts?: { id?: string }): Promise<{ id: string; existed?: boolean }>;
	setField(id: string, key: string, value: ValueJSON): Promise<Record<string, unknown>>;
	deleteField(id: string, key: string): Promise<Record<string, unknown>>;
	/** Any engine mutation (`/api/mutate`), e.g. ("block_add", {object_id, block}). */
	mutate(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
	/** Markdown appended to an object's body as the editor's blocks - one per line, indentation nests, inline marks - inside the line `parentId` when given. Returns how many were added. */
	addText(objectId: string, markdown: string, parentId?: string): Promise<number>;
	/** A message in the object's chat, as the app's own chat box posts it. */
	chatPost(objectId: string, text: string): Promise<{ id: string; threadId: string }>;
	/** A message from this tool's agent in an object's human discussion. */
	reply(objectId: string, text: string): Promise<{ id: string }>;
	/** One conversation's blocks on an object, in the order they happened: `threadId`, or ("") its human discussion. */
	conversation(obj: ObjectJSON, threadId: string): Array<{ id: string; block: BlockJSON }>;
	/** An object's body as plain text: its lines in reading order, nesting kept. */
	text(obj: ObjectJSON): string;
	/** Whether a message's author is an agent (an agent id) rather than a person (a key). */
	isAgentAuthor(author: string): boolean;
	memory: RoostrMemory;
	/** `gws-as <mailbox> <args...>` on this computer, its JSON output parsed. */
	gws(mailbox: string, args: string[]): Promise<unknown>;
	/** Notes for the harness log (stderr); never part of the result. */
	log(...args: unknown[]): void;
	// ── Asked of the harness (HarnessApi) ──
	/** `sh -lc command` on this computer (5 minutes at most), in the agent's Project folder, else home. Refused unless the agent's Tools list shell_exec. */
	shell(command: string): Promise<ShellRun>;
	/** A live http(s) page through this computer's headless Chrome (browserless). Refused unless the agent's Tools list web_fetch. */
	webPage(url: string): Promise<WebPage>;
	credentials: RoostrCredentials;
	/** The skills this agent may read: its own and the shared ones, narrowed by its Skills; machine skills only while working here, and only with the shell. */
	skills(): Promise<SkillListing[]>;
	/** Run one of the agent's Jev Skills (a Skill with an Answer) on objects: Jev's answer becomes the Skill's property on each, with how sure. Uses the agent's TypeSafe credential. */
	jev(skill: string, objectIds: string[]): Promise<ScoreRow[]>;
	/** Every computer's capabilities (one catalog skill on one computer) with their status. */
	capabilities(): Promise<CapabilityRow[]>;
	/** Ask a capability's computer for a setup or maintenance operation (skill.install, skill.check, ...) on the agent's behalf; a person there approves it before anything runs. */
	requestCapability(capabilityObjectId: string, operation: string, text: string): Promise<SentMessage>;
	/** A question to other agents (agent_ask), sent from this turn's object; top-level turns only. */
	ask(message: AskMessage): Promise<SentMessage>;
	/** Run a subagent on `task` (template task, explore or quick_task) and return what it submitted. */
	spawn(task: string, template: string): Promise<string>;
	/** A subagent's final result, for the agent that spawned it; subagents only. */
	submitResult(content: string): Promise<void>;
}

const GWS_AS = join(import.meta.dir, "..", "bin", "gws-as");

/** One SDK call, its failure turned into a plain Error: an ordinary tool error, never a sign the tool's code is broken. */
async function sdkCall<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (err) {
		throw new Error(err instanceof Error ? err.message : String(err));
	}
}

/** The SDK for one run; `touched` collects what the tool marks with `touch`, `harness` carries what only the harness does. */
export function createRoostr(context: ToolRunContext, touched: Set<string>, harness: HarnessCall): Roostr {
	/** Objects this run has seen are not Tools: written to again without asking the daemon what they are. */
	const notTools = new Set<string>();
	/** Refuse writing to a Tool object: people edit tools. */
	const refuseToolEdit = async (objectId: string): Promise<void> => {
		if (notTools.has(objectId)) return;
		if ((await fetchObject(objectId)).typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
		notTools.add(objectId);
	};
	const owner = context.agentId;
	return {
		context,
		// Every object a tool is handed shows a Credential's secrets as "[secret]" (credentials.ts hideCredentialSecrets): only the harness acts with them.
		query: (params) => sdkCall(async () => (typeof params.limit === "number" ? await query(params) : await queryAll(params)).map(hideCredentialSecrets)),
		get: (id) => sdkCall(async () => hideCredentialSecrets(await fetchObject(id))),
		getInSpace: (id) => sdkCall(async () => hideCredentialSecrets(await assertInSpace(await fetchObject(id), context.channelId))),
		writable: (id) =>
			sdkCall(async () => {
				const obj = await assertInSpace(await fetchObject(id), context.channelId);
				if (obj.typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				notTools.add(obj.id);
				return hideCredentialSecrets(obj);
			}),
		space: () => sdkCall(async () => context.channelId || (await defaultSpaceId())),
		spaceFilter: () => sdkCall(() => spaceFilterFor(context.channelId)),
		properties: () => sdkCall(() => relationDefs(context.channelId)),
		types: () => sdkCall(() => typeDefs(context.channelId)),
		body: bodyBlocks,
		plain: plainValue,
		guests: guestAgents,
		describeRepeat,
		clock: localClock,
		inlineMarks,
		textStyles: STYLE,
		touch: (id) => {
			if (id) touched.add(id);
		},
		spaceMap: () => sdkCall(() => buildSpaceMap(context.channelId)),
		neighborhood: (id) => sdkCall(() => buildNeighborhood(id, context.channelId)),
		viewQuery: (view) => sdkCall(async () => savedViewBody(view, context.channelId, await relationDefs(context.channelId))),
		create: (name, typeKey, fields = {}, opts = {}) =>
			sdkCall(async () => {
				if (typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				const created = await createObject(name, typeKey, fields.channel || !context.channelId ? fields : { ...fields, channel: { stringValue: context.channelId } }, opts.id);
				notTools.add(created.id);
				return created;
			}),
		setField: (id, key, value) =>
			sdkCall(async () => {
				await refuseToolEdit(id);
				return setField(id, key, value);
			}),
		deleteField: (id, key) =>
			sdkCall(async () => {
				await refuseToolEdit(id);
				return deleteField(id, key);
			}),
		mutate: (action, params) =>
			sdkCall(async () => {
				if ((action === "create" || action === "set_type") && params.type_key === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				// A chat message is conversation, not the tool: posting on a Tool's discussion stays open.
				if (typeof params.object_id === "string" && action !== "chat_post") await refuseToolEdit(params.object_id);
				return mutate(action, params);
			}),
		addText: (objectId, markdown, parentId = "") =>
			sdkCall(async () => {
				await refuseToolEdit(objectId);
				return appendMarkdown(objectId, markdown, parentId);
			}),
		chatPost: (objectId, text) => sdkCall(() => chatPost(objectId, text)),
		// An object id alone addresses its human discussion; agent-to-agent talk has its own threads.
		reply: (objectId, text) => sdkCall(() => postTo(humanRef(objectId), text, owner)),
		conversation: (obj, threadId) => convBlocks(obj, threadId || HUMAN_THREAD),
		text: objectText,
		isAgentAuthor,
		memory: {
			upsertFact: (key, value, confidence, sourcedFromBlockId) => sdkCall(() => memory.upsertFact(owner, key, value, confidence, sourcedFromBlockId)),
			upsertMilestone: (args) => sdkCall(() => memory.upsertMilestone(owner, args)),
			amendMilestone: (id, patch) => sdkCall(() => memory.amendMilestone(owner, id, patch)),
			listFacts: (key) => sdkCall(() => memory.listFacts(owner, key)),
			listMilestones: (status) => sdkCall(() => memory.listMilestones(owner, status)),
			recall: (args) => sdkCall(() => memory.recall(owner, args)),
		},
		gws: (mailbox, args) =>
			sdkCall(async () => {
				const proc = Bun.spawn([GWS_AS, mailbox, ...args], { stdout: "pipe", stderr: "pipe" });
				const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
				if ((await proc.exited) !== 0) throw new Error(`gws-as ${mailbox} ${args.slice(0, 3).join(" ")}: ${(err || out).trim().slice(0, 300)}`);
				return JSON.parse(out);
			}),
		log: console.error,
		shell: (command) => sdkCall(() => harness("shell", [command])),
		webPage: (url) => sdkCall(() => harness("webPage", [url])),
		credentials: {
			get: (service) => sdkCall(() => harness("credential", [service])),
			page: (service, url, script) => sdkCall(() => harness("credentialPage", [service, url, script])),
			api: (service, path, request = {}) => sdkCall(() => harness("credentialApi", [service, path, request])),
			act: (service, action, input = {}) => sdkCall(() => harness("credentialAct", [service, action, input])),
			sql: (service, sql, options = {}) => sdkCall(() => harness("credentialSql", [service, sql, options])),
		},
		skills: () => sdkCall(() => harness("skills", [])),
		jev: (skill, objectIds) => sdkCall(() => harness("jev", [skill, objectIds])),
		capabilities: () => sdkCall(() => harness("capabilities", [])),
		requestCapability: (capabilityObjectId, operation, text) => sdkCall(() => harness("requestCapability", [capabilityObjectId, operation, text])),
		ask: (message) => sdkCall(() => harness("ask", [message])),
		spawn: (task, template) => sdkCall(() => harness("spawn", [task, template])),
		submitResult: (content) => sdkCall(() => harness("submitResult", [content])),
	};
}
