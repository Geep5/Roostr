/**
 * Client-side reactive data store — replaces the SvelteKit server loads.
 * Holds channels, object summaries, and relation defs; refreshed from the
 * Odin backend and kept live via the /api/events SSE stream.
 */

import { API, fetchChannels, fetchObjects, fetchRelations } from "$lib/api";
import type { ChannelJSON, ObjectSummary, RelationDefJSON } from "$lib/types";

export const store = $state({
	channels: [] as ChannelJSON[],
	summaries: [] as ObjectSummary[],
	relations: [] as RelationDefJSON[],
	loaded: false,
});

export async function refreshAll(): Promise<void> {
	const [channels, summaries, relations] = await Promise.all([fetchChannels(), fetchObjects(), fetchRelations()]);
	store.channels = channels;
	store.summaries = summaries;
	store.relations = relations;
	store.loaded = true;
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
	const source = new EventSource(`${API}/api/events`);
	es = source;
	let timer: number | undefined;
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
