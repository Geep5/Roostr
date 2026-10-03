/**
 * `roostr` - what a Tool's TypeScript body is handed (tool-host.ts): the
 * custom tools, and the built-ins whose code lives in their Tool objects.
 * Everyone in a space is trusted, so it is the harness's own client: the
 * same reads and writes the agents' tools make, plus the computer's Google
 * accounts through `gws-as` (the Credentials its served agents list -
 * google-credentials.ts).
 *
 * Two rules hold for every tool. Whatever the SDK throws is a plain Error -
 * the daemon refusing, an object outside the space: an ordinary tool error
 * the agent reads. A JavaScript error from the tool's own code (TypeError,
 * ReferenceError, ...) means that version of the tool is broken
 * (tool-runtime.ts). And no tool changes a Tool object: people edit tools,
 * agents only call them.
 */
import { join } from "node:path";
import { chatPost, createObject, deleteField, fetchObject, guestAgents, mutate, plainValue, query, queryAll, setField, type BlockJSON, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { HUMAN_THREAD, convBlocks, humanRef, postTo } from "./conv";
import { STYLE, appendMarkdown, inlineMarks, type Mark } from "./markdown";
import * as memory from "./memory";
import { describeRepeat, localClock } from "./repeat";
import { assertInSpace, buildNeighborhood, buildSpaceMap, defaultSpaceId, relationDefs, savedViewBody, spaceFilterFor, typeDefs, type RelDef, type TypeDef } from "./spacemap";
import { bodyBlocks, type BodyLine } from "./surfaces";

export type { BlockJSON, ObjectJSON, QueryRow, ValueJSON } from "./api";
export type { Mark } from "./markdown";
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
	/** A new object; it lands in this tool's space unless `fields.channel` says otherwise. */
	create(name: string, typeKey: string, fields?: Record<string, ValueJSON>): Promise<{ id: string }>;
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
	memory: RoostrMemory;
	/** `gws-as <mailbox> <args...>` on this computer, its JSON output parsed. */
	gws(mailbox: string, args: string[]): Promise<unknown>;
	/** Notes for the harness log (stderr); never part of the result. */
	log(...args: unknown[]): void;
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

/** The SDK for one run; `touched` collects what the tool marks with `touch`. */
export function createRoostr(context: ToolRunContext, touched: Set<string>): Roostr {
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
		query: (params) => sdkCall(() => (typeof params.limit === "number" ? query(params) : queryAll(params))),
		get: (id) => sdkCall(() => fetchObject(id)),
		getInSpace: (id) => sdkCall(async () => assertInSpace(await fetchObject(id), context.channelId)),
		writable: (id) =>
			sdkCall(async () => {
				const obj = await assertInSpace(await fetchObject(id), context.channelId);
				if (obj.typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				notTools.add(obj.id);
				return obj;
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
		create: (name, typeKey, fields = {}) =>
			sdkCall(async () => {
				if (typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				const created = await createObject(name, typeKey, fields.channel || !context.channelId ? fields : { ...fields, channel: { stringValue: context.channelId } });
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
	};
}
