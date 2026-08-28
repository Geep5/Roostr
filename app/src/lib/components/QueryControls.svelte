<script lang="ts">
	import TypeSuggest from "./TypeSuggest.svelte";
	import { createRelation } from "$lib/relations";
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { note } from "$lib/api";

	/**
	 * View configuration for a query object — source types, filter rules,
	 * sorts. Persisted on the object as `setOf` / `viewFilters` /
	 * `viewSorts` fields (the one-view simplification of Anytype's
	 * Dataview.View.filters/sorts).
	 */
	let {
		object,
		relations,
		onchanged,
	}: { object: ObjectJSON; relations: RelationDefJSON[]; onchanged: () => Promise<void> } = $props();

	export interface FilterRule {
		key: string;
		condition: string;
		value: string[];
	}

	export interface SortRule {
		key: string;
		type: "asc" | "desc";
	}

	// ── Parse stored view config ──────────────────────────────────
	function strItems(v: ValueJSON | undefined): string[] {
		return (v?.valuesValue?.items ?? []).map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
	}

	export function parseFilters(fields: Record<string, ValueJSON>): FilterRule[] {
		const items = fields["viewFilters"]?.valuesValue?.items ?? [];
		const out: FilterRule[] = [];
		for (const item of items) {
			const e = item.mapValue?.entries;
			if (!e) continue;
			out.push({
				key: e["key"]?.stringValue ?? "",
				condition: e["condition"]?.stringValue ?? "equal",
				value: strItems(e["value"]),
			});
		}
		return out;
	}

	export function parseSorts(fields: Record<string, ValueJSON>): SortRule[] {
		const items = fields["viewSorts"]?.valuesValue?.items ?? [];
		const out: SortRule[] = [];
		for (const item of items) {
			const e = item.mapValue?.entries;
			if (!e) continue;
			out.push({ key: e["key"]?.stringValue ?? "", type: e["type"]?.stringValue === "desc" ? "desc" : "asc" });
		}
		return out;
	}

	const sources = $derived(strItems(object.fields["setOf"]));
	const filters = $derived(parseFilters(object.fields));
	const sorts = $derived(parseSorts(object.fields));

	// ── Persist ───────────────────────────────────────────────────
	async function saveSources(next: string[]) {
		await note.setField(object.id, "setOf", { valuesValue: { items: next.map((s) => ({ stringValue: s })) } });
		await onchanged();
	}

	async function saveFilters(next: FilterRule[]) {
		await note.setField(object.id, "viewFilters", {
			valuesValue: {
				items: next.map((f) => ({
					mapValue: {
						entries: {
							key: { stringValue: f.key },
							condition: { stringValue: f.condition },
							value: { valuesValue: { items: f.value.map((v) => ({ stringValue: v })) } },
						},
					},
				})),
			},
		});
		await onchanged();
	}

	async function saveSorts(next: SortRule[]) {
		await note.setField(object.id, "viewSorts", {
			valuesValue: {
				items: next.map((s) => ({
					mapValue: { entries: { key: { stringValue: s.key }, type: { stringValue: s.type } } },
				})),
			},
		});
		await onchanged();
	}

	// ── Condition catalog per relation format ─────────────────────
	interface ConditionDef {
		id: string;
		label: string;
		needsValue: boolean;
	}

	const TEXT_CONDITIONS: ConditionDef[] = [
		{ id: "like", label: "contains", needsValue: true },
		{ id: "notLike", label: "doesn't contain", needsValue: true },
		{ id: "equal", label: "is", needsValue: true },
		{ id: "notEqual", label: "is not", needsValue: true },
		{ id: "empty", label: "is empty", needsValue: false },
		{ id: "notEmpty", label: "is not empty", needsValue: false },
	];
	const NUMBER_CONDITIONS: ConditionDef[] = [
		{ id: "equal", label: "=", needsValue: true },
		{ id: "notEqual", label: "≠", needsValue: true },
		{ id: "greater", label: ">", needsValue: true },
		{ id: "less", label: "<", needsValue: true },
		{ id: "greaterOrEqual", label: "≥", needsValue: true },
		{ id: "lessOrEqual", label: "≤", needsValue: true },
		{ id: "empty", label: "is empty", needsValue: false },
		{ id: "notEmpty", label: "is not empty", needsValue: false },
	];
	const SELECT_CONDITIONS: ConditionDef[] = [
		{ id: "in", label: "has any of", needsValue: true },
		{ id: "allIn", label: "has all of", needsValue: true },
		{ id: "exactIn", label: "is exactly", needsValue: true },
		{ id: "notIn", label: "has none of", needsValue: true },
		{ id: "empty", label: "is empty", needsValue: false },
		{ id: "notEmpty", label: "is not empty", needsValue: false },
	];
	const PRESENCE_CONDITIONS: ConditionDef[] = [
		{ id: "empty", label: "is empty", needsValue: false },
		{ id: "notEmpty", label: "is not empty", needsValue: false },
	];
	const CHECKBOX_CONDITIONS: ConditionDef[] = [
		{ id: "equal", label: "is checked", needsValue: false },
		{ id: "notEqual", label: "is unchecked", needsValue: false },
	];

	function formatOf(key: string): string {
		if (key === "type" || key === "id") return "shorttext";
		if (key === "createdAt" || key === "updatedAt") return "number";
		return relations.find((r) => r.key === key)?.format ?? "shorttext";
	}

	function conditionsFor(key: string): ConditionDef[] {
		const f = formatOf(key);
		if (f === "number" || f === "date") return NUMBER_CONDITIONS;
		if (f === "tag" || f === "status") return SELECT_CONDITIONS;
		if (f === "checkbox") return CHECKBOX_CONDITIONS;
		if (f === "object") return PRESENCE_CONDITIONS;
		return TEXT_CONDITIONS;
	}

	function optionsFor(key: string): string[] {
		return (relations.find((r) => r.key === key)?.options ?? []).map((o) => o.text);
	}

	/** Filterable keys: virtual keys + every non-hidden relation. */
	const filterKeys = $derived.by(() => {
		const keys = relations.filter((r) => !r.hidden && r.key !== "setOf").map((r) => r.key);
		return ["type", ...keys, "createdAt", "updatedAt"];
	});

	function labelOf(key: string): string {
		if (key === "type") return "Type";
		if (key === "createdAt") return "Created";
		if (key === "updatedAt") return "Updated";
		return relations.find((r) => r.key === key)?.name || key;
	}

	// ── View layout (Anytype: menu/dataview/view/layout.tsx) ───────
	// viewType: table | kanban | calendar. Kanban groups by a
	// select/multi-select/checkbox relation; calendar by a date relation
	// (createdDate / modifiedDate system timestamps, or e.g. dueDate).
	const viewType = $derived(object.fields["viewType"]?.stringValue || "table");
	const groupKey = $derived(object.fields["viewGroupKey"]?.stringValue || "");
	const dateKey = $derived(object.fields["viewDateKey"]?.stringValue || "createdDate");

	/** Anytype getGroupOptions ordering: select first, then multi, then checkbox. */
	const groupOptions = $derived.by(() => {
		const rank: Record<string, number> = { status: 0, tag: 1, checkbox: 2 };
		return relations
			.filter((r) => !r.hidden && r.format in rank)
			.toSorted((a, b) => rank[a.format] - rank[b.format]);
	});
	const dateOptions = $derived.by(() => [
		{ key: "createdDate", name: "Created date" },
		{ key: "modifiedDate", name: "Modified date" },
		...relations.filter((r) => !r.hidden && r.format === "date" && !["createdDate", "modifiedDate"].includes(r.key)).map((r) => ({ key: r.key, name: r.name || r.key })),
	]);

	async function setView(v: string) {
		await note.setField(object.id, "viewType", { stringValue: v });
		// Kanban needs a group relation: default to the first available.
		if (v === "kanban" && !groupKey && groupOptions.length > 0) {
			await note.setField(object.id, "viewGroupKey", { stringValue: groupOptions[0].key });
		}
		await onchanged();
	}

	async function setGroupKey(k: string) {
		await note.setField(object.id, "viewGroupKey", { stringValue: k });
		await onchanged();
	}

	async function setDateKey(k: string) {
		await note.setField(object.id, "viewDateKey", { stringValue: k });
		await onchanged();
	}

	/** "＋ New … property" entries create the relation, then select it. */
	async function onGroupPick(el: HTMLSelectElement) {
		if (el.value !== "__new__") return void setGroupKey(el.value);
		const name = prompt("New tag property name:");
		el.value = groupKey; // restore until created
		if (!name?.trim()) return;
		const rel = await createRelation(name.trim(), "tag");
		if (rel) await setGroupKey(rel.key);
	}

	async function onDatePick(el: HTMLSelectElement) {
		if (el.value !== "__new__") return void setDateKey(el.value);
		const name = prompt("New date property name:");
		el.value = dateKey;
		if (!name?.trim()) return;
		const rel = await createRelation(name.trim(), "date");
		if (rel) await setDateKey(rel.key);
	}

	// ── UI state ──────────────────────────────────────────────────
	let open = $state<"" | "source" | "filter" | "sort">("");
	$effect(() => {
		if (sources.length === 0) open = "source";
	});

	function updateFilter(idx: number, patch: Partial<FilterRule>) {
		const next = filters.map((f, i) => (i === idx ? { ...f, ...patch } : f));
		// Reset condition/value when the key's format changes the catalog.
		if (patch.key !== undefined) {
			next[idx].condition = conditionsFor(patch.key)[0].id;
			next[idx].value = [];
		}
		void saveFilters(next);
	}

	function needsValue(f: FilterRule): boolean {
		return conditionsFor(f.key).find((c) => c.id === f.condition)?.needsValue ?? true;
	}
</script>

<div class="controls">
	<button class="pill" class:active={open === "source"} onclick={() => (open = open === "source" ? "" : "source")}>
		Source{sources.length ? `: ${sources.join(", ")}` : ""}
	</button>
	<button class="pill" class:active={open === "filter"} onclick={() => (open = open === "filter" ? "" : "filter")}>
		Filter{filters.length ? ` · ${filters.length}` : ""}
	</button>
	<button class="pill" class:active={open === "sort"} onclick={() => (open = open === "sort" ? "" : "sort")}>
		Sort{sorts.length ? ` · ${sorts.length}` : ""}
	</button>
	<span class="spacer"></span>
	<span class="views">
		{#each [["table", "▤"], ["kanban", "▥"], ["calendar", "▦"]] as [v, glyph] (v)}
			<button class="pill view" class:active={viewType === v} title={v} onclick={() => void setView(v)}>{glyph} {v[0].toUpperCase() + v.slice(1)}</button>
		{/each}
	</span>
	{#if viewType === "kanban"}
		<!-- Anytype board: pick WHICH select/tag property groups the board;
		     columns follow the property's option order. -->
		<label class="cfg-label">
			Group by
			<select class="cfg" value={groupKey} onchange={(e) => void onGroupPick(e.currentTarget)}>
				<option value="" disabled>property…</option>
				{#each groupOptions as g (g.key)}
					<option value={g.key}>{g.name || g.key}</option>
				{/each}
				<option value="__new__">＋ New tag property…</option>
			</select>
		</label>
	{/if}
	{#if viewType === "calendar"}
		<label class="cfg-label">
			Date
			<select class="cfg" value={dateKey} onchange={(e) => void onDatePick(e.currentTarget)}>
				{#each dateOptions as d (d.key)}
					<option value={d.key}>{d.name}</option>
				{/each}
				<option value="__new__">＋ New date property…</option>
			</select>
		</label>
	{/if}
</div>

{#if open === "source"}
	<div class="panel">
		{#each sources as s, i (s + i)}
			<div class="rule">
				<span class="chip">{s}</span>
				<button class="x" onclick={() => void saveSources(sources.filter((_, j) => j !== i))}>×</button>
			</div>
		{/each}
		<TypeSuggest
			exclude={sources}
			placeholder="Search types… (e.g. p → Person, Project)"
			onpick={(key) => void saveSources([...sources, key])}
			onclose={() => (open = "")}
		/>
	</div>
{/if}

{#if open === "filter"}
	<div class="panel">
		{#each filters as f, i (i)}
			<div class="rule">
				<select value={f.key} onchange={(e) => updateFilter(i, { key: e.currentTarget.value })}>
					{#each filterKeys as k (k)}
						<option value={k}>{labelOf(k)}</option>
					{/each}
				</select>
				<select value={f.condition} onchange={(e) => updateFilter(i, { condition: e.currentTarget.value })}>
					{#each conditionsFor(f.key) as c (c.id)}
						<option value={c.id}>{c.label}</option>
					{/each}
				</select>
				{#if needsValue(f)}
					{#if optionsFor(f.key).length > 0}
						<div class="tags">
							{#each optionsFor(f.key) as opt (opt)}
								<button
									class="tag"
									class:on={f.value.includes(opt)}
									onclick={() => updateFilter(i, { value: f.value.includes(opt) ? f.value.filter((v) => v !== opt) : [...f.value, opt] })}
								>{opt}</button>
							{/each}
						</div>
					{:else}
						<input
							value={f.value[0] ?? ""}
							placeholder="value"
							onchange={(e) => updateFilter(i, { value: e.currentTarget.value === "" ? [] : [e.currentTarget.value] })}
						/>
					{/if}
				{/if}
				<button class="x" onclick={() => void saveFilters(filters.filter((_, j) => j !== i))}>×</button>
			</div>
		{/each}
		<button class="add" onclick={() => void saveFilters([...filters, { key: "name", condition: "like", value: [] }])}>+ Add filter</button>
	</div>
{/if}

{#if open === "sort"}
	<div class="panel">
		{#each sorts as s, i (i)}
			<div class="rule">
				<select value={s.key} onchange={(e) => void saveSorts(sorts.map((x, j) => (j === i ? { ...x, key: e.currentTarget.value } : x)))}>
					{#each filterKeys as k (k)}
						<option value={k}>{labelOf(k)}</option>
					{/each}
				</select>
				<select value={s.type} onchange={(e) => void saveSorts(sorts.map((x, j) => (j === i ? { ...x, type: e.currentTarget.value === "desc" ? "desc" : "asc" } : x)))}>
					<option value="asc">ascending</option>
					<option value="desc">descending</option>
				</select>
				<button class="x" onclick={() => void saveSorts(sorts.filter((_, j) => j !== i))}>×</button>
			</div>
		{/each}
		<button class="add" onclick={() => void saveSorts([...sorts, { key: "name", type: "asc" }])}>+ Add sort</button>
	</div>
{/if}

<style>
	.spacer {
		flex: 1;
	}
	.views {
		display: flex;
		gap: 4px;
	}
	.cfg-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.cfg {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 12px;
		padding: 3px 8px;
	}
	.controls {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.pill {
		background: none;
		border: 1px solid var(--border);
		color: var(--muted);
		border-radius: 999px;
		padding: 4px 12px;
		font-size: 12px;
		cursor: pointer;
	}
	.pill:hover,
	.pill.active {
		color: var(--fg);
		border-color: var(--accent);
	}
	.panel {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px;
		margin-bottom: 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.rule {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	select,
	input {
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 13px;
	}
	input:focus,
	select:focus {
		border-color: var(--accent);
		outline: none;
	}
	.chip {
		background: var(--panel);
		border-radius: 6px;
		padding: 4px 10px;
		font-size: 13px;
	}
	.tags {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.tag {
		border: 1px solid var(--border);
		background: none;
		color: var(--fg);
		border-radius: 999px;
		padding: 2px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	.tag.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.x {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		font-size: 14px;
	}
	.x:hover {
		color: #f55522;
	}
	.add {
		border: none;
		background: none;
		color: var(--muted);
		text-align: left;
		font-size: 13px;
		cursor: pointer;
		padding: 2px 0;
	}
	.add:hover {
		color: var(--fg);
	}
</style>
