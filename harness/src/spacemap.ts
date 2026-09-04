/**
 * The three understandings an object agent is born with:
 *
 *   1. the SPACE  — a census: types (with definitions), saved views, agents
 *   2. the TYPE   — its def, its properties' definitions, which views watch it
 *   3. CONNECTIONS — typed edges in/out, memberships, matching views
 *
 * All built from the same query engine the UI uses. Reads are free; the
 * primer tells agents to query before they ever consider waking a peer.
 */

import { API, fetchObject, query, queryAll, str, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";

// ── space filter (objects with no stamp belong to the default space) ──

let defaultSpaceCache: string | null = null;
export async function defaultSpaceId(): Promise<string> {
	if (defaultSpaceCache !== null) return defaultSpaceCache;
	const res = await fetch(`${API}/api/channels`);
	const chans = (await res.json()) as Array<{ id: string }>;
	defaultSpaceCache = chans[0]?.id ?? "";
	return defaultSpaceCache;
}

export async function spaceFilterFor(spaceId: string): Promise<Record<string, unknown>> {
	const dflt = await defaultSpaceId();
	const own = spaceId || dflt;
	return own === dflt
		? { key: "channel", condition: "in", value: [own, ""] }
		: { key: "channel", condition: "equal", value: own };
}

async function queryTotal(body: Record<string, unknown>): Promise<number> {
	const res = await fetch(`${API}/api/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...body, limit: 1 }),
	});
	if (!res.ok) return 0;
	return ((await res.json()) as { total?: number }).total ?? 0;
}

// ── defs (space-scoped, definitions included) ─────────────────────

export interface RelDef {
	key: string;
	name: string;
	emoji: string;
	format: string;
	definition: string;
}

export async function relationDefs(spaceId: string): Promise<Map<string, RelDef>> {
	const sf = await spaceFilterFor(spaceId);
	const rows = await queryAll({ type: "relation", filters: [sf] });
	const out = new Map<string, RelDef>();
	for (const r of rows) {
		const key = str(r.fields, "key");
		if (!key) continue;
		out.set(key, {
			key,
			name: str(r.fields, "name") || key,
			emoji: str(r.fields, "iconEmoji"),
			format: str(r.fields, "format") || "shorttext",
			definition: str(r.fields, "description"),
		});
	}
	return out;
}

interface TypeDef {
	id: string;
	key: string;
	name: string;
	emoji: string;
	definition: string;
}

async function typeDefs(spaceId: string): Promise<Map<string, TypeDef>> {
	const sf = await spaceFilterFor(spaceId);
	const rows = await queryAll({ type: "type", filters: [sf] });
	const out = new Map<string, TypeDef>();
	for (const r of rows) {
		const key = str(r.fields, "key");
		if (!key) continue;
		out.set(key, {
			id: r.id,
			key,
			name: str(r.fields, "name") || key,
			emoji: str(r.fields, "iconEmoji"),
			definition: str(r.fields, "description"),
		});
	}
	return out;
}

// ── saved-view filter conversion (port of the app's engineFiltersOf) ──
//
// The daemon applies stored viewFilters naively (a value-less checkbox
// filter matches everything), so saved queries are run with the same
// client-side conversion the UI uses — one truth, not two.

function strItems(v: ValueJSON | undefined): string[] {
	return (v?.valuesValue?.items ?? []).map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
}

export function convertViewFilters(obj: ObjectJSON, rels: Map<string, RelDef>): Array<Record<string, unknown>> {
	const items = obj.fields["viewFilters"]?.valuesValue?.items ?? [];
	const out: Array<Record<string, unknown>> = [];
	for (const item of items) {
		const e = item.mapValue?.entries;
		if (!e) continue;
		const key = e["key"]?.stringValue ?? "";
		const condition = e["condition"]?.stringValue ?? "equal";
		const values = strItems(e["value"]);
		if (!key) continue;
		const format = key === "createdAt" || key === "updatedAt" ? "number" : (rels.get(key)?.format ?? "shorttext");
		let value: unknown;
		if (format === "checkbox") value = true;
		else if (condition === "in" || condition === "notIn" || condition === "allIn" || condition === "exactIn") value = values;
		else if (format === "number" || format === "date") value = values[0] !== undefined ? Number(values[0]) : undefined;
		else value = values[0];
		if (
			condition !== "empty" &&
			condition !== "notEmpty" &&
			condition !== "exists" &&
			format !== "checkbox" &&
			(value === undefined || value === "" || (Array.isArray(value) && value.length === 0))
		)
			continue;
		out.push({ key, condition, value });
	}
	return out;
}

/** The body that runs a saved view exactly as the UI would. */
export async function savedViewBody(view: ObjectJSON, spaceId: string, rels: Map<string, RelDef>): Promise<Record<string, unknown> | null> {
	const sf = await spaceFilterFor(spaceId);
	if (view.typeKey === "collection") {
		const members = strItems(view.fields["collectionIds"]);
		if (members.length === 0) return null;
		return { filters: [{ key: "id", condition: "in", value: members }, ...convertViewFilters(view, rels), sf] };
	}
	return { setId: view.id, filters: [...convertViewFilters(view, rels), sf] };
}

function viewSummary(v: QueryRow | ObjectJSON): string {
	const sources = strItems(v.fields["setOf"]);
	const filters = (v.fields["viewFilters"]?.valuesValue?.items ?? [])
		.map((i) => i.mapValue?.entries?.["key"]?.stringValue)
		.filter(Boolean);
	const kind = v.typeKey === "collection" ? "collection" : `query of ${sources.join("+") || "anything"}`;
	return filters.length ? `${kind}, filtered on ${filters.join(", ")}` : kind;
}

// ── 1. the space census ───────────────────────────────────────────

export async function buildSpaceMap(spaceId: string): Promise<string> {
	const sf = await spaceFilterFor(spaceId);
	const [types, views, collections, agents] = await Promise.all([
		typeDefs(spaceId),
		queryAll({ type: "query", filters: [sf] }),
		queryAll({ type: "collection", filters: [sf] }),
		queryAll({ type: "agent", filters: [sf] }),
	]);
	const lines: string[] = [];

	const typeLines: string[] = [];
	for (const t of types.values()) {
		const total = await queryTotal({ type: t.key, filters: [sf] });
		if (total === 0 && !t.definition) continue;
		const def = t.definition ? ` — "${t.definition.slice(0, 90)}"` : "";
		typeLines.push(`${t.emoji ? t.emoji + " " : ""}${t.name} ×${total}${def}`);
	}
	lines.push(`Types here: ${typeLines.join(" · ") || "(none)"}`);

	const viewLines = [...views, ...collections].map((v) => `${str(v.fields, "name") || "Untitled"} (${viewSummary(v)})`);
	if (viewLines.length) lines.push(`Saved views — the human's own groupings; query_run any of them:\n  ${viewLines.join("\n  ")}`);

	const agentLines: string[] = [];
	for (const a of agents) {
		if (str(a.fields, "spawn_parent")) continue;
		const bound = str(a.fields, "bound_object");
		if (bound) {
			const target = await fetchObject(bound).catch(() => null);
			agentLines.push(`${str(a.fields, "name")} — agent of "${target ? str(target.fields, "name") : bound.slice(0, 8)}"`);
		} else {
			const types_ = strItems(a.fields["responsible_types"]);
			agentLines.push(`${str(a.fields, "name")} — space agent${types_.length ? ` for ${types_.join(", ")}` : ""}`);
		}
	}
	if (agentLines.length) lines.push(`Agents alive in this space:\n  ${agentLines.join("\n  ")}`);
	return lines.join("\n");
}

// ── 2. the type understanding ─────────────────────────────────────

export async function buildTypeContext(obj: ObjectJSON, spaceId: string): Promise<string> {
	const [types, rels, sf] = await Promise.all([typeDefs(spaceId), relationDefs(spaceId), spaceFilterFor(spaceId)]);
	const t = types.get(obj.typeKey);
	const lines: string[] = [];
	const label = t ? `${t.emoji ? t.emoji + " " : ""}${t.name}` : obj.typeKey;
	const siblings = await queryTotal({ type: obj.typeKey, filters: [sf] });
	lines.push(`You are a ${label} (${siblings} of these exist here).${t?.definition ? ` The human defines this type as: "${t.definition}"` : ""}`);

	// Property meanings for the fields this object actually carries.
	const propLines: string[] = [];
	for (const key of Object.keys(obj.fields)) {
		const r = rels.get(key);
		if (!r || !r.definition) continue;
		propLines.push(`${r.emoji ? r.emoji + " " : ""}${r.name}: "${r.definition}"`);
	}
	if (propLines.length) lines.push(`Property meanings:\n  ${propLines.join("\n  ")}`);

	// Which saved views watch this type.
	const views = await queryAll({ type: "query", filters: [sf] });
	const watching = views.filter((v) => strItems(v.fields["setOf"]).includes(obj.typeKey)).map((v) => str(v.fields, "name") || "Untitled");
	if (watching.length) lines.push(`Saved views watching this type: ${watching.join(", ")}`);
	return lines.join("\n");
}

// ── 3. connections ────────────────────────────────────────────────

const SYSTEM_FIELDS = new Set(["channel", "collectionIds", "viewFilters", "viewSorts", "viewRelations", "pinnedIds", "setOf", "featuredRelations"]);

export async function buildNeighborhood(objectId: string, spaceId: string): Promise<string> {
	const [obj, rels, sf] = await Promise.all([fetchObject(objectId), relationDefs(spaceId), spaceFilterFor(spaceId)]);
	const rows = await queryAll({ filters: [sf] });
	const names = new Map<string, { name: string; type: string }>();
	for (const r of rows) names.set(r.id, { name: r.name ?? str(r.fields, "name") ?? r.id.slice(0, 8), type: r.typeKey });

	// Agents bound to neighbors: askable minds.
	const agents = await queryAll({ type: "agent", filters: [sf] });
	const boundOf = new Map<string, string>();
	for (const a of agents) {
		const b = str(a.fields, "bound_object");
		if (b) boundOf.set(b, str(a.fields, "name"));
	}
	const tag = (id: string): string => {
		const n = names.get(id);
		const agent = boundOf.has(id) ? ", has agent" : "";
		return n ? `"${n.name}" (${n.type}${agent})` : id.slice(0, 8);
	};
	const relLabel = (key: string): string => {
		const r = rels.get(key);
		return r ? `${r.emoji ? r.emoji + " " : ""}${r.name}` : key;
	};

	const lines: string[] = [];
	// Outbound: this object's own link fields.
	for (const [key, v] of Object.entries(obj.fields)) {
		if (SYSTEM_FIELDS.has(key)) continue;
		const targets: string[] = [];
		if (v.linkValue?.targetId) targets.push(v.linkValue.targetId);
		for (const item of v.valuesValue?.items ?? []) if (item.linkValue?.targetId) targets.push(item.linkValue.targetId);
		for (const t of targets) lines.push(`${relLabel(key)} → ${tag(t)}`);
	}
	// Inbound: everything in the space that points here.
	for (const r of rows) {
		if (r.id === objectId) continue;
		for (const [key, v] of Object.entries(r.fields)) {
			if (key === "channel") continue;
			if (key === "collectionIds") {
				if (strItems(v).includes(objectId)) lines.push(`in collection: ${tag(r.id)}`);
				continue;
			}
			const hit =
				v.linkValue?.targetId === objectId || (v.valuesValue?.items ?? []).some((i) => i.linkValue?.targetId === objectId);
			if (hit) lines.push(`← ${relLabel(key)} of ${tag(r.id)}`);
		}
	}
	// Saved views this object currently matches.
	const views = await queryAll({ type: "query", filters: [sf] });
	for (const v of views) {
		const view = await fetchObject(v.id).catch(() => null);
		if (!view) continue;
		const body = await savedViewBody(view, spaceId, rels);
		if (!body) continue;
		const withId = { ...body, filters: [...(body.filters as Array<Record<string, unknown>>), { key: "id", condition: "equal", value: objectId }] };
		if ((await queryTotal(withId)) > 0) lines.push(`matched by view: "${str(v.fields, "name") || "Untitled"}"`);
	}
	return lines.length ? lines.join("\n") : "(no connections yet)";
}

// ── field summary for the bound object itself ─────────────────────

export async function buildObjectSummary(obj: ObjectJSON, spaceId: string): Promise<string> {
	const rels = await relationDefs(spaceId);
	const lines: string[] = [`"${str(obj.fields, "name") || "Untitled"}" (${obj.typeKey}) — id ${obj.id}`];
	for (const [key, v] of Object.entries(obj.fields)) {
		if (SYSTEM_FIELDS.has(key) || key === "name" || key === "iconEmoji") continue;
		const r = rels.get(key);
		let val = "";
		if (v.stringValue !== undefined) val = v.stringValue;
		else if (v.boolValue !== undefined) val = v.boolValue ? "yes" : "no";
		else if (v.intValue !== undefined) val = new Date(v.intValue).getFullYear() > 1990 ? new Date(v.intValue).toISOString().slice(0, 10) : String(v.intValue);
		else if (v.floatValue !== undefined) val = String(v.floatValue);
		else if (v.valuesValue) {
			const texts = strItems(v);
			val = texts.length ? texts.join(", ") : `${(v.valuesValue.items ?? []).length} link(s)`;
		}
		if (!val) continue;
		lines.push(`${r ? `${r.emoji ? r.emoji + " " : ""}${r.name}` : key}: ${val.slice(0, 120)}`);
	}
	return lines.join("\n");
}

// ── bound-context assembly, memoized per turn window ──────────────

export interface BoundContext {
	object: string;
	type: string;
	connections: string;
	space: string;
}

const memo = new Map<string, { at: number; ctx: BoundContext }>();
const MEMO_TTL = 30_000;

export async function boundObjectContext(objectId: string, spaceId: string): Promise<BoundContext> {
	const hit = memo.get(objectId);
	if (hit && Date.now() - hit.at < MEMO_TTL) return hit.ctx;
	const obj = await fetchObject(objectId);
	const [object, type, connections, space] = await Promise.all([
		buildObjectSummary(obj, spaceId),
		buildTypeContext(obj, spaceId),
		buildNeighborhood(objectId, spaceId),
		buildSpaceMap(spaceId),
	]);
	const ctx = { object, type, connections, space };
	memo.set(objectId, { at: Date.now(), ctx });
	return ctx;
}
