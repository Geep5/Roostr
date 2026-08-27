/**
 * HTTP client for the Roostr Odin server. The harness is a pure client of
 * the DAG: every read is /api/objects | /api/query, every write is
 * /api/mutate, and wakeups arrive over /api/events SSE. Nothing here holds
 * state that the DAG doesn't.
 */

export const API = process.env.GLON_API ?? "http://127.0.0.1:7333";

export interface ValueJSON {
	stringValue?: string;
	intValue?: number;
	floatValue?: number;
	boolValue?: boolean;
	valuesValue?: { items: ValueJSON[] };
	listValue?: { values: string[] };
	linkValue?: { targetId: string; relationKey?: string };
	mapValue?: { entries: Record<string, ValueJSON> };
}

export interface BlockJSON {
	id: string;
	childrenIds: string[];
	content: {
		text?: { text: string; style: number; checked?: boolean };
		custom?: { contentType: string; meta?: Record<string, string> };
		layout?: { style: number };
	};
}

export interface ObjectJSON {
	id: string;
	typeKey: string;
	fields: Record<string, ValueJSON>;
	blocks: BlockJSON[];
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface QueryRow {
	id: string;
	typeKey: string;
	name?: string;
	createdAt: number;
	updatedAt: number;
	fields: Record<string, ValueJSON>;
}

export async function fetchObject(id: string): Promise<ObjectJSON> {
	const res = await fetch(`${API}/api/objects/${id}`);
	if (!res.ok) throw new Error(`objects/${id}: ${res.status}`);
	return res.json() as Promise<ObjectJSON>;
}

export async function query(body: Record<string, unknown>): Promise<QueryRow[]> {
	const res = await fetch(`${API}/api/query`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`query: ${res.status}`);
	const out = (await res.json()) as { records: QueryRow[] };
	return out.records;
}

export async function mutate(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await fetch(`${API}/api/mutate`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, ...params }),
	});
	if (!res.ok) throw new Error(`mutate ${action}: ${res.status}`);
	const out = (await res.json()) as Record<string, unknown> & { ok?: boolean; error?: string };
	if (!out.ok) throw new Error(out.error ?? `mutate ${action} failed`);
	return out;
}

// ── Field helpers ────────────────────────────────────────────────

export const str = (fields: Record<string, ValueJSON>, key: string): string =>
	fields[key]?.stringValue ?? "";

export const num = (fields: Record<string, ValueJSON>, key: string): number | undefined => {
	const v = fields[key];
	return v?.intValue ?? v?.floatValue;
};

export const flag = (fields: Record<string, ValueJSON>, key: string): boolean =>
	fields[key]?.boolValue === true;

export const list = (fields: Record<string, ValueJSON>, key: string): string[] =>
	(fields[key]?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean);

export const sv = (s: string): ValueJSON => ({ stringValue: s });
export const iv = (n: number): ValueJSON => ({ intValue: Math.round(n) });
export const fv = (n: number): ValueJSON => ({ floatValue: n });
export const bv = (b: boolean): ValueJSON => ({ boolValue: b });
export const lv = (items: string[]): ValueJSON => ({ valuesValue: { items: items.map(sv) } });

export const setField = (id: string, key: string, value: ValueJSON) =>
	mutate("set_field", { object_id: id, key, value });

export const createObject = async (name: string, typeKey: string, fields?: Record<string, ValueJSON>) =>
	(await mutate("create", { name, type_key: typeKey, fields })) as { id: string };

/** Append a chat message block; `asAuthor` attributes it to the agent. */
export const chatPost = async (objectId: string, text: string, asAuthor = "", replyTo = "") =>
	(await mutate("chat_post", { object_id: objectId, text, as_author: asAuthor, reply_to: replyTo })) as { id: string };

/** Append an arbitrary block (used for tool_use / tool_result / compaction). */
export const addBlock = (objectId: string, block: Partial<BlockJSON>, targetId = "", position = 0) =>
	mutate("block_add", { object_id: objectId, block, target_id: targetId, position });

/** Subscribe to commit events; calls onObject for every committed object id. */
export function subscribe(onObject: (objectId: string) => void): void {
	void (async () => {
		for (;;) {
			try {
				const res = await fetch(`${API}/api/events`);
				const reader = res.body?.getReader();
				if (!reader) throw new Error("no SSE body");
				const decoder = new TextDecoder();
				let buf = "";
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let idx: number;
					while ((idx = buf.indexOf("\n\n")) >= 0) {
						const frame = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						const m = frame.match(/^data: (.+)$/m);
						if (!m) continue;
						try {
							const parsed = JSON.parse(m[1]) as { objectId?: string };
							if (parsed.objectId) onObject(parsed.objectId);
						} catch {
							/* hello frame etc. */
						}
					}
				}
			} catch {
				/* server restart — retry */
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 1000);
			await promise;
		}
	})();
}
