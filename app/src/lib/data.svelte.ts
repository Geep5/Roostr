/**
 * Client-side reactive data store — replaces the SvelteKit server loads.
 * Holds channels, object summaries, and relation defs; refreshed from the
 * Odin backend and kept live via the /api/events SSE stream.
 */

import { API, fetchChannels, fetchObjects, fetchQuery, fetchRelations } from "$lib/api";
import type { SpaceJSON, ObjectSummary, RelationDefJSON } from "$lib/types";

/** A type object (Anytype ObjectType analog). */
export interface TypeDef {
	id: string;
	key: string;
	name: string;
	icon: string;
	layout: string; // "page" | "task"
	defaultTemplateId: string;
}

export const store = $state({
	channels: [] as SpaceJSON[],
	summaries: [] as ObjectSummary[],
	/** SSE link to the local daemon (drives the mobile sync dot). */
	connected: false,
	relations: [] as RelationDefJSON[],
	types: [] as TypeDef[],
	loaded: false,
});

async function fetchTypes(): Promise<TypeDef[]> {
	const res = await fetchQuery({ type: "type", limit: 100 });
	const s = (f: Record<string, { stringValue?: string }>, k: string) => f[k]?.stringValue ?? "";
	return res.records
		.map((r) => ({
			id: r.id,
			key: s(r.fields, "key"),
			name: s(r.fields, "name"),
			icon: s(r.fields, "iconEmoji"),
			layout: s(r.fields, "layout") || "page",
			defaultTemplateId: s(r.fields, "default_template_id"),
		}))
		.filter((t) => t.key)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export async function refreshAll(): Promise<void> {
	const [channels, summaries, relations, types] = await Promise.all([fetchChannels(), fetchObjects(), fetchRelations(), fetchTypes()]);
	store.channels = channels;
	store.summaries = summaries;
	store.relations = relations;
	store.types = types;
	store.loaded = true;
}

/** Layout for a typeKey: the type object's layout, else legacy fallback. */
export function layoutOf(typeKey: string): string {
	return store.types.find((t) => t.key === typeKey)?.layout ?? (typeKey === "task" ? "task" : "page");
}

type ObjectListener = (objectId: string) => void;
const objectListeners = new Set<ObjectListener>();

/** Register a per-object SSE listener; returns an unsubscribe function. */
export function onObjectEvent(fn: ObjectListener): () => void {
	objectListeners.add(fn);
	return () => objectListeners.delete(fn);
}

let es: EventSource | undefined;

/** Connect the SSE stream (idempotent); debounce-refreshes the store on activity. */
export function connectEvents(): () => void {
	if (es) return () => {};
	// HMR re-instantiates this module, wiping the `es` guard — each hot update
	// would leak a live EventSource until the browser's 6-per-host pool is
	// exhausted and every request to the API hangs. The window global
	// survives module replacement; close the predecessor before connecting.
	const w = window as unknown as { __glonES?: EventSource };
	w.__glonES?.close();
	const source = new EventSource(`${API}/api/events`);
	w.__glonES = source;
	es = source;
	// bfcache keeps unloaded pages (and their EventSources) alive, which
	// exhausts the browser's 6-per-host connection pool. Close on pagehide;
	// a bfcache restore reconnects.
	window.addEventListener("pagehide", () => source.close());
	window.addEventListener("pageshow", (e) => {
		if ((e as PageTransitionEvent).persisted && es === source) {
			es = undefined;
			connectEvents();
		}
	});
	let timer: number | undefined;
	source.onopen = () => {
		store.connected = true;
	};
	source.onerror = () => {
		store.connected = source.readyState === EventSource.OPEN;
	};
	source.onmessage = (ev) => {
		clearTimeout(timer);
		timer = setTimeout(() => void refreshAll(), 1500);
		try {
			const msg = JSON.parse(ev.data);
			if (typeof msg.objectId === "string") {
				for (const fn of objectListeners) fn(msg.objectId);
			}
		} catch {
			// Ignore malformed events.
		}
	};
	return () => {
		clearTimeout(timer);
		source.close();
		es = undefined;
	};
}
