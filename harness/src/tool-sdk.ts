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
import { chatPost, createObject, deleteField, fetchObject, mutate, plainValue, query, queryAll, setField, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { assertInSpace, buildNeighborhood, buildSpaceMap, relationDefs, savedViewBody, spaceFilterFor } from "./spacemap";
import { bodyBlocks, type BodyLine } from "./surfaces";

export type { ObjectJSON, QueryRow, ValueJSON } from "./api";
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

export interface Roostr {
	context: ToolRunContext;
	/** The engine's query (`/api/query` body: type, filters, textQuery, ...): every match, or one page when `limit` is given. */
	query(params: Record<string, unknown>): Promise<QueryRow[]>;
	get(id: string): Promise<ObjectJSON>;
	/** One object, refused (thrown) unless it lives in this tool's space - what every built-in that takes an id checks. */
	getInSpace(id: string): Promise<ObjectJSON>;
	/** The query filter that keeps a search to this tool's space. */
	spaceFilter(): Promise<Record<string, unknown>>;
	/** The object's body as addressable lines in reading order (the ids the body-editing tools take); never its conversation. */
	body(obj: ObjectJSON): BodyLine[];
	/** A stored value as plain JSON: links as their target ids, lists and maps of those. */
	plain(value: ValueJSON | undefined): unknown;
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
	/** A message in the object's chat, as the app's own chat box posts it. */
	chatPost(objectId: string, text: string): Promise<{ id: string; threadId: string }>;
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

/** Refuse writing to a Tool object: people edit tools. */
async function refuseToolEdit(objectId: string): Promise<void> {
	if ((await fetchObject(objectId)).typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
}

/** The SDK for one run; `touched` collects what the tool marks with `touch`. */
export function createRoostr(context: ToolRunContext, touched: Set<string>): Roostr {
	return {
		context,
		query: (params) => sdkCall(() => (typeof params.limit === "number" ? query(params) : queryAll(params))),
		get: (id) => sdkCall(() => fetchObject(id)),
		getInSpace: (id) => sdkCall(async () => assertInSpace(await fetchObject(id), context.channelId)),
		spaceFilter: () => sdkCall(() => spaceFilterFor(context.channelId)),
		body: bodyBlocks,
		plain: plainValue,
		touch: (id) => {
			if (id) touched.add(id);
		},
		spaceMap: () => sdkCall(() => buildSpaceMap(context.channelId)),
		neighborhood: (id) => sdkCall(() => buildNeighborhood(id, context.channelId)),
		viewQuery: (view) => sdkCall(async () => savedViewBody(view, context.channelId, await relationDefs(context.channelId))),
		create: (name, typeKey, fields = {}) =>
			sdkCall(async () => {
				if (typeKey === TOOL_TYPE) throw new Error(TOOL_EDIT_REFUSAL);
				return createObject(name, typeKey, fields.channel || !context.channelId ? fields : { ...fields, channel: { stringValue: context.channelId } });
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
		chatPost: (objectId, text) => sdkCall(() => chatPost(objectId, text)),
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
