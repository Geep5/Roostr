/**
 * `roostr` - what a custom Tool's TypeScript body is handed (tool-host.ts).
 * Everyone in a space is trusted, so it is the harness's own client: the
 * same reads and writes the agents' tools make, plus the computer's Google
 * accounts through `gws-as` (the Credentials its served agents list -
 * google-credentials.ts).
 */
import { join } from "node:path";
import { chatPost, createObject, deleteField, fetchObject, mutate, query, queryAll, setField, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";

export type { ObjectJSON, QueryRow, ValueJSON } from "./api";

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

export function createRoostr(context: ToolRunContext): Roostr {
	return {
		context,
		query: (params) => (typeof params.limit === "number" ? query(params) : queryAll(params)),
		get: fetchObject,
		create: (name, typeKey, fields = {}) => createObject(name, typeKey, fields.channel || !context.channelId ? fields : { ...fields, channel: { stringValue: context.channelId } }),
		setField,
		deleteField,
		mutate,
		chatPost,
		async gws(mailbox, args) {
			const proc = Bun.spawn([GWS_AS, mailbox, ...args], { stdout: "pipe", stderr: "pipe" });
			const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
			if ((await proc.exited) !== 0) throw new Error(`gws-as ${mailbox} ${args.slice(0, 3).join(" ")}: ${(err || out).trim().slice(0, 300)}`);
			return JSON.parse(out);
		},
		log: console.error,
	};
}
