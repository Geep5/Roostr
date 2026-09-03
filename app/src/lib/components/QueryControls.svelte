<script lang="ts">
	import { goto } from "$app/navigation";
	import TypeSuggest from "./TypeSuggest.svelte";
	import LayoutIcon from "./LayoutIcon.svelte";
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
		onsearch,
		mode = "query",
		channelId = "",
		oncreated,
	}: {
		object: ObjectJSON;
		relations: RelationDefJSON[];
		onchanged: () => Promise<void>;
		onsearch?: (q: string) => void;
		mode?: "query" | "collection";
		/** The page object's space - new records land beside it. */
		channelId?: string;
		/** Table views: handle the new record inline instead of navigating. */
		oncreated?: (id: string) => Promise<void>;
	} = $props();

	// Anytype's dataview search (controls.tsx Filter): magnifier expands an
	// inline input; text live-filters the records via textQuery.
	let searchOpen = $state(false);
	let searchValue = $state("");
	let searchEl: HTMLInputElement | undefined = $state();
	function toggleSearch() {
		searchOpen = !searchOpen;
		if (!searchOpen) {
			searchValue = "";
			onsearch?.("");
		}
	}
	$effect(() => {
		if (searchOpen) searchEl?.focus();
	});

	export interface FilterRule {
		key: string;
		condition: string;
		value: string[];
	}

	export interface SortRule {
		key: string;
		type: "asc" | "desc";
		/** Where empty values sort (Anytype menuDataviewSortShowEmpty). */
		empty?: "start" | "end";
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
			out.push({
				key: e["key"]?.stringValue ?? "",
				type: e["type"]?.stringValue === "desc" ? "desc" : "asc",
				empty: e["empty"]?.stringValue === "start" ? "start" : "end",
			});
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
					mapValue: { entries: { key: { stringValue: s.key }, type: { stringValue: s.type }, empty: { stringValue: s.empty ?? "end" } } },
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
	async function onGroupPick(v: string) {
		if (v !== "__new__") return void setGroupKey(v);
		const name = prompt("New tag property name:");
		if (!name?.trim()) return;
		const rel = await createRelation(name.trim(), "tag");
		if (rel) await setGroupKey(rel.key);
	}

	async function onDatePick(v: string) {
		if (v !== "__new__") return void setDateKey(v);
		const name = prompt("New date property name:");
		if (!name?.trim()) return;
		const rel = await createRelation(name.trim(), "date");
		if (rel) await setDateKey(rel.key);
	}

	// ── New record (Anytype's accent New button, dataview.tsx recordCreate) ──
	// Creates an object of the set's source type with details prefilled
	// from the view filters (getDetails: equal/in/allIn conditions seed
	// values); calendar views seed the date property with today.
	let creating = $state(false);

	/** Create a record inheriting the view (filters seed fields, calendar
	 *  seeds the date, the page's space is stamped). Exported so the
	 *  table's "+ New Object" row shares one implementation. */
	export async function createRecord(): Promise<void> {
		if (creating) return;
		creating = true;
		try {
			const typeKey = sources[0] || "note";
			const fields: Record<string, ValueJSON> = {};
			if (channelId) fields["channel"] = { stringValue: channelId };
			for (const f of filters) {
				if (!["equal", "in", "allIn"].includes(f.condition) || f.value.length === 0) continue;
				const rel = relations.find((r) => r.key === f.key);
				if (!rel) continue;
				fields[f.key] = rel.format === "tag" || rel.format === "status"
					? { valuesValue: { items: f.value.map((v) => ({ stringValue: v })) } }
					: { stringValue: f.value[0] };
			}
			if (viewType === "calendar" && dateKey) {
				fields[dateKey] = { intValue: Date.now() };
			}
			const { id } = await note.create("", typeKey, fields);
			await onchanged();
			// Anytype's table New edits the record in place; other views open it.
			if (oncreated && viewType === "table") await oncreated(id);
			else await goto(`/object/${id}`);
		} finally {
			creating = false;
		}
	}

	const newRecord = () => createRecord();

	// ── View settings menu (Anytype dataviewViewSettings) ───────────
	// The controls row carries a single settings button; Layout (and the
	// board/calendar config rows) live in its two-pane popover menu.
	let settingsOpen = $state(false);
	let settingsPane = $state<"root" | "layout" | "group" | "date">("root");

	function toggleSettings() {
		settingsOpen = !settingsOpen;
		settingsPane = "root";
	}

	// ── UI state ──────────────────────────────────────────────────
	let open = $state<"" | "source" | "filter" | "sort">("");
	/** Index of the sort row whose "Show empty" menu is open. */
	let sortMore = $state(-1);
	/** Drag-reorder state for sort rules (Anytype useSortable rows). */
	let sortDragIdx = $state(-1);
	let sortOverIdx = $state(-1);

	async function sortReorder() {
		if (sortDragIdx < 0 || sortOverIdx < 0 || sortDragIdx === sortOverIdx) {
			sortDragIdx = sortOverIdx = -1;
			return;
		}
		const next = [...sorts];
		const [moved] = next.splice(sortDragIdx, 1);
		next.splice(sortOverIdx, 0, moved);
		sortDragIdx = sortOverIdx = -1;
		await saveSorts(next);
	}
	$effect(() => {
		// A sourceless QUERY needs a source before it can show anything -
		// open the picker. Collections have no source concept: their
		// membership IS the source, so nothing auto-opens.
		if (mode === "query" && sources.length === 0) open = "source";
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

<svelte:window onmousedown={(e) => { if (settingsOpen && !(e.target as HTMLElement).closest(".settings-anchor")) settingsOpen = false; }} onkeydown={(e) => { if (e.key === "Escape") settingsOpen = false; }} />

<div class="controls">
	{#if mode === "query"}
		<button class="pill" class:active={open === "source"} onclick={() => (open = open === "source" ? "" : "source")}>
			Source{sources.length ? `: ${sources.join(", ")}` : ""}
		</button>
	{/if}
	<span class="spacer"></span>
	<span class="view-chip"><LayoutIcon kind={viewType} size={16} /> {viewType[0].toUpperCase() + viewType.slice(1)}</span>
	<!-- Anytype dataviewControlsSideRight: search, then the collapsible
	     filter/sort buttons (accent "on" state when rules exist), then the
	     persistent settings button; their exact 20x20 icons. -->
	{#if searchOpen}
		<input
			class="search-input"
			bind:this={searchEl}
			bind:value={searchValue}
			placeholder="Search"
			oninput={() => onsearch?.(searchValue)}
			onkeydown={(e) => {
				if (e.key === "Escape") toggleSearch();
			}}
		/>
	{/if}
	<button class="cbtn" class:on={searchOpen} title="Search" onclick={toggleSearch}>
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none"><path d="M8.5 2.5C11.8137 2.5 14.5 5.18629 14.5 8.5C14.5 9.79977 14.0852 11.0019 13.3828 11.9844L17.2227 15.8242C17.6132 16.2147 17.6132 16.8478 17.2227 17.2383C16.8321 17.6288 16.1991 17.6288 15.8086 17.2383L11.9658 13.3955C10.9867 14.0899 9.79171 14.5 8.5 14.5C5.18629 14.5 2.5 11.8137 2.5 8.5C2.5 5.18629 5.18629 2.5 8.5 2.5ZM8.5 4C6.01472 4 4 6.01472 4 8.5C4 10.9853 6.01472 13 8.5 13C10.9853 13 13 10.9853 13 8.5C13 6.01472 10.9853 4 8.5 4Z" fill="currentColor" /></svg>
	</button>
	<button class="cbtn" class:on={filters.length > 0 || open === "filter"} title="Filters" onclick={() => (open = open === "filter" ? "" : "filter")}>
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M3 6C3 5.58579 3.29381 5.25 3.65625 5.25H16.3438C16.7062 5.25 17 5.58579 17 6C17 6.41421 16.7062 6.75 16.3438 6.75H3.65625C3.29381 6.75 3 6.41421 3 6ZM6 10C6 9.58579 6.26863 9.25 6.6 9.25H13.4C13.7314 9.25 14 9.58579 14 10C14 10.4142 13.7314 10.75 13.4 10.75H6.6C6.26863 10.75 6 10.4142 6 10ZM8.75 13.25C8.33579 13.25 8 13.5858 8 14C8 14.4142 8.33579 14.75 8.75 14.75H11.25C11.6642 14.75 12 14.4142 12 14C12 13.5858 11.6642 13.25 11.25 13.25H8.75Z" fill="currentColor" /></svg>
	</button>
	<button class="cbtn" class:on={sorts.length > 0 || open === "sort"} title="Sorts" onclick={() => (open = open === "sort" ? "" : "sort")}>
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.705 9.02168C10.9784 9.32611 11.4216 9.32611 11.695 9.02168L13.25 7.29001V15.75H14.75V7.29001L16.305 9.02168C16.5784 9.32611 17.0216 9.32611 17.295 9.02168C17.5683 8.71726 17.5683 8.2237 17.295 7.91928L14 4.25L10.705 7.91928C10.4317 8.2237 10.4317 8.71726 10.705 9.02168ZM9.29497 10.9803C9.02161 10.6758 8.57839 10.6758 8.30503 10.9803L6.75 12.7119L6.75 4.25195L5.25 4.25195L5.25 12.7119L3.69498 10.9803C3.42161 10.6758 2.97839 10.6758 2.70503 10.9803C2.43166 11.2847 2.43166 11.7783 2.70503 12.0827L6 15.752L9.29497 12.0827C9.56834 11.7783 9.56834 11.2847 9.29497 10.9803Z" fill="currentColor" /></svg>
	</button>
	<span class="settings-anchor">
		<button class="cbtn" class:on={settingsOpen} title="View settings" onclick={toggleSettings}>
			<svg viewBox="0 0 20 20" width="20" height="20" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M13.75 6C13.75 6.69036 13.1903 7.25 12.5 7.25C11.8097 7.25 11.25 6.69036 11.25 6C11.25 5.30964 11.8097 4.75 12.5 4.75C13.1903 4.75 13.75 5.30964 13.75 6ZM14.8856 6.75C14.567 7.76428 13.6194 8.5 12.5 8.5C11.3806 8.5 10.433 7.76428 10.1144 6.75H3.58333C3.26117 6.75 3 6.41421 3 6C3 5.58579 3.26117 5.25 3.58333 5.25H10.1144C10.433 4.23572 11.3806 3.5 12.5 3.5C13.6194 3.5 14.567 4.23572 14.8856 5.25H16.4167C16.7388 5.25 17 5.58579 17 6C17 6.41421 16.7388 6.75 16.4167 6.75H14.8856ZM6.25 14C6.25 14.6903 6.80964 15.25 7.5 15.25C8.19036 15.25 8.75 14.6903 8.75 14C8.75 13.3097 8.19036 12.75 7.5 12.75C6.80964 12.75 6.25 13.3097 6.25 14ZM3.58333 13.25H5.11445C5.43301 12.2357 6.38059 11.5 7.5 11.5C8.61941 11.5 9.56699 12.2357 9.88555 13.25H16.4167C16.7388 13.25 17 13.5858 17 14C17 14.4142 16.7388 14.75 16.4167 14.75H9.88555C9.56699 15.7643 8.61941 16.5 7.5 16.5C6.38059 16.5 5.43301 15.7643 5.11445 14.75H3.58333C3.26117 14.75 3 14.4142 3 14C3 13.5858 3.26117 13.25 3.58333 13.25Z" fill="currentColor" /></svg>
		</button>
		{#if settingsOpen}
			<!-- Anytype dataviewViewSettings: Layout row (caption = current
			     layout) opening the dataviewViewLayout picker; board group
			     and calendar date rows for those layouts. -->
			<div class="vmenu" role="menu">
				{#if settingsPane === "root"}
					<button class="vrow" onclick={() => (settingsPane = "layout")}>
						<span>Layout</span>
						<span class="vcap">{viewType[0].toUpperCase() + viewType.slice(1)} ›</span>
					</button>
					{#if viewType === "kanban"}
						<button class="vrow" onclick={() => (settingsPane = "group")}>
							<span>Group by</span>
							<span class="vcap">{groupOptions.find((g) => g.key === groupKey)?.name || groupKey || "—"} ›</span>
						</button>
					{/if}
					{#if viewType === "calendar"}
						<button class="vrow" onclick={() => (settingsPane = "date")}>
							<span>Date</span>
							<span class="vcap">{dateOptions.find((d) => d.key === dateKey)?.name || dateKey} ›</span>
						</button>
					{/if}
				{:else if settingsPane === "layout"}
					<button class="vback" onclick={() => (settingsPane = "root")}>‹ Layout</button>
					{#each [["table", "Table"], ["gallery", "Gallery"], ["kanban", "Kanban"], ["calendar", "Calendar"]] as [v, label] (v)}
						<button
							class="vrow"
							onclick={() => {
								void setView(v);
								settingsPane = "root";
							}}
						>
							<span class="vlabel"><LayoutIcon kind={v} size={22} /> {label}</span>
							{#if viewType === v}<span class="vcheck">✓</span>{/if}
						</button>
					{/each}
				{:else if settingsPane === "group"}
					<button class="vback" onclick={() => (settingsPane = "root")}>‹ Group by</button>
					{#each groupOptions as g (g.key)}
						<button
							class="vrow"
							onclick={() => {
								void onGroupPick(g.key);
								settingsPane = "root";
							}}
						>
							<span>{g.name || g.key}</span>
							{#if groupKey === g.key}<span class="vcheck">✓</span>{/if}
						</button>
					{/each}
					<button class="vrow" onclick={() => void onGroupPick("__new__")}><span>＋ New tag property…</span></button>
				{:else if settingsPane === "date"}
					<button class="vback" onclick={() => (settingsPane = "root")}>‹ Date</button>
					{#each dateOptions as d (d.key)}
						<button
							class="vrow"
							onclick={() => {
								void onDatePick(d.key);
								settingsPane = "root";
							}}
						>
							<span>{d.name}</span>
							{#if dateKey === d.key}<span class="vcheck">✓</span>{/if}
						</button>
					{/each}
					<button class="vrow" onclick={() => void onDatePick("__new__")}><span>＋ New date property…</span></button>
				{/if}
			</div>
		{/if}
	</span>
	<button class="new-btn" disabled={creating} onclick={() => void newRecord()}>New</button>
</div>

{#if open === "source" && mode === "query"}
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
	<!-- Anytype dataviewSort menu: draggable rules; relation chip + a
	     sort-arrow chip toggling Asc/Desc (arrow rotates 180deg for Desc);
	     hover buttons: more (Show empty Top/Bottom) and delete; then the
	     "Add sort" / "Delete sort" rows below a divider. -->
	<div class="panel sort-panel">
		{#if sorts.length === 0}
			<span class="muted-row">No sorts applied</span>
		{/if}
		{#each sorts as s, i (i)}
			<div
				class="sort-item"
				class:drag-over={sortOverIdx === i && sortDragIdx !== i}
				class:dragging={sortDragIdx === i}
				role="presentation"
				draggable="true"
				ondragstart={() => (sortDragIdx = i)}
				ondragover={(e) => {
					e.preventDefault();
					sortOverIdx = i;
				}}
				ondrop={(e) => {
					e.preventDefault();
					void sortReorder();
				}}
				ondragend={() => (sortDragIdx = sortOverIdx = -1)}
			>
				<span class="dnd">⋮⋮</span>
				<span class="chip relation">
					<select value={s.key} onchange={(e) => void saveSorts(sorts.map((x, j) => (j === i ? { ...x, key: e.currentTarget.value } : x)))}>
						{#each filterKeys as k (k)}
							<option value={k}>{labelOf(k)}</option>
						{/each}
					</select>
				</span>
				<button
					class="chip type"
					title={s.type === "asc" ? "Ascending" : "Descending"}
					onclick={() => void saveSorts(sorts.map((x, j) => (j === i ? { ...x, type: x.type === "asc" ? "desc" : "asc" } : x)))}
				>
					<svg class="sort-arrow" class:desc={s.type === "desc"} viewBox="0 0 20 20" width="16" height="16" fill="none">
						<path d="M10 4v12M10 4l-4.5 4.5M10 4l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
					</svg>
					{s.type === "asc" ? "Asc" : "Desc"}
				</button>
				<span class="row-btns">
					<span class="more-anchor">
						<button class="ibtn" title="Show empty" onclick={() => (sortMore = sortMore === i ? -1 : i)}>⋯</button>
						{#if sortMore === i}
							<div class="more-menu" role="menu">
								<span class="more-title">Show empty</span>
								<button
									class="vrow"
									onclick={() => {
										sortMore = -1;
										void saveSorts(sorts.map((x, j) => (j === i ? { ...x, empty: "start" } : x)));
									}}
								>
									<span>At the top</span>
									{#if s.empty === "start"}<span class="vcheck">✓</span>{/if}
								</button>
								<button
									class="vrow"
									onclick={() => {
										sortMore = -1;
										void saveSorts(sorts.map((x, j) => (j === i ? { ...x, empty: "end" } : x)));
									}}
								>
									<span>At the bottom</span>
									{#if s.empty !== "start"}<span class="vcheck">✓</span>{/if}
								</button>
							</div>
						{/if}
					</span>
					<button class="ibtn" title="Remove sort" onclick={() => void saveSorts(sorts.filter((_, j) => j !== i))}>✕</button>
				</span>
			</div>
		{/each}
		<div class="sort-div"></div>
		<button class="add" onclick={() => void saveSorts([...sorts, { key: "name", type: "asc", empty: "end" }])}>＋ Add sort</button>
		{#if sorts.length}
			<button class="add clear" onclick={() => void saveSorts([])}>Delete sort</button>
		{/if}
	</div>
{/if}

<style>
	.spacer {
		flex: 1;
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
	.view-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--muted);
		font-size: 12px;
		align-self: center;
	}
	.vlabel {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.settings-anchor {
		position: relative;
		display: inline-block;
	}
	.vmenu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 110;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 220px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
	}
	.vrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		background: none;
		border: none;
		border-radius: 6px;
		padding: 6px 8px;
		cursor: pointer;
		color: var(--fg);
		font-size: 13px;
		text-align: left;
	}
	.vrow:hover {
		background: var(--hl-med);
	}
	.vcap {
		color: var(--muted);
		font-size: 12px;
	}
	.vcheck {
		color: var(--accent);
	}
	.vback {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 12px;
		text-align: left;
		padding: 4px 8px;
		cursor: pointer;
	}
	.vback:hover {
		color: var(--fg);
	}
	.sort-panel {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.muted-row {
		color: var(--muted);
		font-size: 12px;
		padding: 2px 4px;
	}
	.sort-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 3px 4px;
		border-radius: 8px;
	}
	.sort-item.dragging {
		opacity: 0.4;
	}
	.sort-item.drag-over {
		box-shadow: 0 -2px 0 var(--accent);
	}
	.sort-item .dnd {
		color: var(--muted);
		font-size: 10px;
		letter-spacing: -2px;
		cursor: grab;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.sort-item:hover .dnd {
		opacity: 0.7;
	}
	.sort-item .chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: none;
		color: var(--fg);
		font-size: 13px;
		padding: 3px 8px;
	}
	.sort-item .chip.type {
		cursor: pointer;
	}
	.sort-item .chip.type:hover {
		background: var(--hl-med);
	}
	.sort-item .chip select {
		background: none;
		border: none;
		color: var(--fg);
		font-size: 13px;
		outline: none;
	}
	.sort-arrow {
		transition: transform 0.15s;
	}
	.sort-arrow.desc {
		transform: rotate(180deg);
	}
	.row-btns {
		display: flex;
		align-items: center;
		gap: 2px;
		margin-left: auto;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.sort-item:hover .row-btns {
		opacity: 1;
	}
	.ibtn {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		border-radius: 6px;
		padding: 2px 7px;
		font-size: 13px;
	}
	.ibtn:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.more-anchor {
		position: relative;
	}
	.more-menu {
		position: absolute;
		right: 0;
		top: calc(100% + 4px);
		z-index: 120;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 160px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
	}
	.more-title {
		color: var(--muted);
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.4px;
		padding: 2px 8px;
	}
	.sort-div {
		height: 1px;
		background: var(--border);
		margin: 4px 0;
	}
	.add.clear {
		color: var(--muted);
	}
	.cbtn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: none;
		border-radius: 6px;
		color: var(--muted);
		cursor: pointer;
		padding: 0;
		align-self: center;
	}
	.cbtn:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.cbtn.on {
		color: var(--accent);
	}
	.search-input {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 13px;
		padding: 4px 10px;
		outline: none;
		width: 180px;
		align-self: center;
	}
	.search-input:focus {
		border-color: var(--accent);
	}
	.new-btn {
		align-self: center;
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 8px;
		height: 28px;
		padding: 0 12px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	.new-btn:hover {
		filter: brightness(1.1);
	}
	.new-btn:disabled {
		opacity: 0.5;
	}
</style>
