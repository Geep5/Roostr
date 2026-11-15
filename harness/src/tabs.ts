/**
 * The person's open tabs in the Roostr app, as the app stores them: the
 * personal preferences object (`__user_prefs__`) holds `open_tabs`, a map of
 * space id -> the strip's paths in order (`/app`, `/app/object/<id>`,
 * `/app/chat/<id>`, `/app/graph`, `/app/graph?focus=<id>`). The app's rules
 * (roostr-core nav.rs): tab #1 is the browsing tab - it never moves and is
 * never removed while others are open ("closing" it shows the space home);
 * one tab per page (`/app` may repeat); new tabs go last; a strip with nothing
 * open (none, or only `/app`) has no entry. Every device picks a change up.
 */

import { API, apiFetch, createObject, fetchObject, setField, type ValueJSON } from "./api";
import { assertInSpace, typeDefs } from "./spacemap";

export const USER_PREFS_ID = "__user_prefs__";
export const OPEN_TABS_KEY = "open_tabs";
export const HOME_PATH = "/app";

export type OpenTabs = Record<string, string[]>;

/** What a tab shows. */
export type TabTarget = { kind: "home" } | { kind: "object"; id: string } | { kind: "chat"; id: string } | { kind: "graph"; focus: string };

/** A change to one space's strip; ids or paths throughout. */
export interface TabChange {
	open?: string[];
	close?: string[];
	move?: { id: string; to: number };
}

/** A tab path's page, null for one this app does not open as a tab. */
export function tabTarget(path: string): TabTarget | null {
	if (path === HOME_PATH) return { kind: "home" };
	const graph = /^\/app\/graph(?:\?focus=([^&]*))?$/.exec(path);
	if (graph) return { kind: "graph", focus: decodeURIComponent(graph[1] ?? "") };
	const page = /^\/app\/(object|chat)\/([^/?#]+)$/.exec(path);
	if (!page) return null;
	const id = decodeURIComponent(page[2]);
	return page[1] === "chat" ? { kind: "chat", id } : { kind: "object", id };
}

/** An id or a path as the tab path it opens: a bare id is its object's page. */
export function tabPath(idOrPath: string): string {
	const s = idOrPath.trim();
	return s.startsWith("/") ? s : `/app/object/${encodeURIComponent(s)}`;
}

/** The object a tab shows (its page, its chat, the graph's focus), "" for none. */
function targetId(t: TabTarget): string {
	return t.kind === "object" || t.kind === "chat" ? t.id : t.kind === "graph" ? t.focus : "";
}

/** Whether `path` is the tab `ref` (an id or a path) names: the exact path, or a page of that object. */
function names(path: string, ref: string): boolean {
	const r = ref.trim();
	if (r.startsWith("/")) return path === r;
	const t = tabTarget(path);
	return t !== null && (t.kind === "object" || t.kind === "chat") && t.id === r;
}

/** The open tabs a stored `open_tabs` holds; strips with nothing open drop out. */
export function openTabsFrom(value: ValueJSON | undefined): OpenTabs {
	const out: OpenTabs = {};
	for (const [space, v] of Object.entries(value?.mapValue?.entries ?? {})) {
		const paths = (v.valuesValue?.items ?? []).flatMap((i) => (typeof i.stringValue === "string" ? [i.stringValue] : []));
		if (!isEmptyStrip(paths)) out[space] = paths;
	}
	return out;
}

/** `open_tabs` as stored: a map of lists of strings. */
export function openTabsValue(tabs: OpenTabs): ValueJSON {
	const entries: Record<string, ValueJSON> = {};
	for (const [space, paths] of Object.entries(tabs)) entries[space] = { valuesValue: { items: paths.map((p) => ({ stringValue: p })) } };
	return { mapValue: { entries } };
}

export function isEmptyStrip(paths: readonly string[]): boolean {
	return paths.length === 0 || (paths.length === 1 && paths[0] === HOME_PATH);
}

/**
 * One space's strip after `change`, by the app's rules: opens append (skipping
 * pages already open), closes drop (the browsing tab turns to the space home),
 * a move lands at 1-based `to`, never before #2. Throws on a move of a tab that
 * is not open or of the browsing tab.
 */
export function editStrip(strip: readonly string[], change: TabChange): string[] {
	const out = strip.length ? [...strip] : [HOME_PATH];
	for (const ref of change.close ?? []) {
		if (names(out[0], ref)) out[0] = HOME_PATH;
		for (let i = out.length - 1; i > 0; i--) if (names(out[i], ref)) out.splice(i, 1);
	}
	for (const ref of change.open ?? []) {
		const path = tabPath(ref);
		if (path !== HOME_PATH && out.includes(path)) continue;
		out.push(path);
	}
	if (change.move) {
		const from = out.findIndex((p) => names(p, change.move?.id ?? ""));
		if (from < 0) throw new Error(`no open tab shows ${change.move.id}`);
		if (from === 0) throw new Error("tab #1 is the browsing tab: it never moves");
		const [tab] = out.splice(from, 1);
		const to = Math.min(Math.max(Math.trunc(change.move.to) || 2, 2), out.length + 1);
		out.splice(to - 1, 0, tab);
	}
	return out;
}

/** The person's open tabs on every space; none when the preferences are not there yet. */
export async function readOpenTabs(): Promise<OpenTabs> {
	const res = await apiFetch(`${API}/api/objects/${USER_PREFS_ID}`);
	if (res.status === 404) return {};
	if (!res.ok) throw new Error(`the open tabs could not be read (${res.status})`);
	const prefs = (await res.json()) as { fields?: Record<string, ValueJSON> };
	return openTabsFrom(prefs.fields?.[OPEN_TABS_KEY]);
}

/** One space's strip set to `paths`, every other space's left as it was. */
export async function writeStrip(space: string, paths: readonly string[]): Promise<void> {
	const tabs = await readOpenTabs();
	if (isEmptyStrip(paths)) delete tabs[space];
	else tabs[space] = [...paths];
	// As the app makes it: create-if-absent under the fixed id, then the field.
	await createObject("Preferences", "user_prefs", { channel: { stringValue: "" } }, USER_PREFS_ID);
	await setField(USER_PREFS_ID, OPEN_TABS_KEY, openTabsValue(tabs));
}

/** Refuse (throw) unless every page the change opens is an object of `space`. */
export async function checkOpens(space: string, refs: readonly string[]): Promise<void> {
	for (const ref of refs) {
		const path = tabPath(ref);
		const t = tabTarget(path);
		if (!t) throw new Error(`${ref} is not a tab the app opens (an object id, /app, /app/object/<id>, /app/chat/<id> or /app/graph)`);
		const id = targetId(t);
		if (!id) continue;
		const obj = await fetchObject(id).catch(() => null);
		if (!obj || obj.deleted) throw new Error(`no object ${id}`);
		await assertInSpace(obj, space).catch(() => {
			throw new Error(`object ${id} is in another space; only this space's objects open as its tabs`);
		});
	}
}

/** A strip as numbered lines, each with what it shows; #1 marked as the browsing tab. */
export async function describeStrip(space: string, strip: readonly string[]): Promise<string> {
	const paths = strip.length ? strip : [HOME_PATH];
	const types = await typeDefs(space).catch(() => new Map<string, { name: string }>());
	const lines: string[] = [];
	for (const [i, path] of paths.entries()) {
		const t = tabTarget(path);
		let what = path;
		if (t?.kind === "home") what = "space home";
		else if (t?.kind === "graph" && !t.focus) what = "graph";
		else if (t) {
			const id = targetId(t);
			const obj = await fetchObject(id).catch(() => null);
			const label = obj ? `"${obj.fields.name?.stringValue || "Untitled"}" (${types.get(obj.typeKey)?.name ?? obj.typeKey}, id ${id})` : `object ${id} (not found)`;
			what = t.kind === "chat" ? `chat of ${label}` : t.kind === "graph" ? `graph focused on ${label}` : label;
		}
		lines.push(`${i + 1}. ${what}${i === 0 ? " - browsing tab" : ""}`);
	}
	return `Open tabs (${paths.length}), in order:\n${lines.join("\n")}`;
}

/** Apply `change` to `space`'s strip and store it: refused (thrown) before anything is written when the space or an opened object is wrong. */
export async function editTabs(space: string, change: TabChange): Promise<string[]> {
	const spaces = (await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	if (!spaces.some((s) => s.id === space)) throw new Error(`no space ${space}`);
	await checkOpens(space, change.open ?? []);
	const strip = editStrip((await readOpenTabs())[space] ?? [], change);
	await writeStrip(space, strip);
	return strip;
}
