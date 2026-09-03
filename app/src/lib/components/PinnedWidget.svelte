<script lang="ts">
	/**
	 * Sidebar widget body for a pinned object — port of Anytype's widget
	 * views. Sets (query/collection) render a mini version of their CURRENT
	 * view: list/table → first rows · gallery → small card grid · kanban →
	 * groups with counts · calendar → mini month with dot days. Any OTHER
	 * object renders Anytype's TREE widget: the objects it links to.
	 */
	import { fetchObject, fetchQuery, type QueryResultRow } from "$lib/api";
	import type { ObjectJSON, RelationDefJSON } from "$lib/types";
	import { store, onObjectEvent } from "$lib/data.svelte";
	import { engineFiltersOf } from "$lib/filters";
	import { objectIcon } from "$lib/icons";

	let { id }: { id: string } = $props();

	const LIMIT = 4;
	/* The card grid breathes better than rows - give it more slots. */
	const GALLERY_LIMIT = 8;

	let obj = $state<ObjectJSON | null>(null);
	let rows = $state<QueryResultRow[]>([]);
	async function load() {
		try {
			const o = await fetchObject(id);
			obj = o;
			const isSet = o.typeKey === "query" || o.typeKey === "set" || o.typeKey === "collection";
			if (isSet) {
				const memberIds = (o.fields["collectionIds"]?.valuesValue?.items ?? [])
					.map((i) => i.stringValue)
					.filter((s): s is string => !!s);
				// The widget applies the view's filter rules exactly like the
				// page does - a record outside the view never shows here.
				const filters = engineFiltersOf(o, store.relations);
				const body =
					o.typeKey === "collection"
						? memberIds.length
							? { filters: [{ key: "id", condition: "in", value: memberIds }, ...filters] }
							: null
						: { setId: o.id, filters };
				if (!body) {
					rows = [];
					return;
				}
				// The widget mirrors the view's sort rules, so the sidebar
				// order matches the page (falls back to newest-first).
				const sortItems = o.fields["viewSorts"]?.valuesValue?.items ?? [];
				const sorts = sortItems
					.map((i) => {
						const e = i.mapValue?.entries;
						const key = e?.["key"]?.stringValue ?? "";
						const type = e?.["type"]?.stringValue === "asc" ? "asc" : "desc";
						return key ? { key, type, emptyPlacement: "end" } : null;
					})
					.filter((x): x is { key: string; type: string; emptyPlacement: string } => !!x);
				const res = await fetchQuery({ ...body, sorts: sorts.length > 0 ? sorts : [{ key: "updatedAt", type: "desc", emptyPlacement: "end" }], limit: 50 });
				rows = res.records;
				return;
			}
			// Tree widget: outbound links (same shapes as the graph/backlinks).
			const targets = new Set<string>();
			for (const [key, v] of Object.entries(o.fields)) {
				if (key === "channel") continue;
				if (v.linkValue?.targetId) targets.add(v.linkValue.targetId);
				else if (v.valuesValue) {
					for (const item of v.valuesValue.items) {
						if (item.linkValue?.targetId) targets.add(item.linkValue.targetId);
						else if (key === "collectionIds" && item.stringValue) targets.add(item.stringValue);
					}
				}
			}
			if (targets.size === 0) {
				rows = [];
				return;
			}
			const res = await fetchQuery({ filters: [{ key: "id", condition: "in", value: [...targets] }], limit: 20 });
			rows = res.records;
		} catch {
			obj = null;
		}
	}

	$effect(() => {
		void id;
		void load();
		return onObjectEvent((oid) => {
			if (oid === id) void load();
		});
	});

	const isSet = $derived(!!obj && (obj.typeKey === "query" || obj.typeKey === "set" || obj.typeKey === "collection"));
	const viewType = $derived(isSet ? obj?.fields["viewType"]?.stringValue || "table" : "table");
	const groupKey = $derived(obj?.fields["viewGroupKey"]?.stringValue || "");
	const dateKey = $derived(obj?.fields["viewDateKey"]?.stringValue || "createdDate");
	const groupRel = $derived<RelationDefJSON | undefined>(store.relations.find((r) => r.key === groupKey));

	// ── kanban groups (name, count) in the property's option order ──
	const groups = $derived.by(() => {
		if (!groupRel) return [];
		const valsOf = (r: QueryResultRow): string[] => {
			const v = r.fields[groupKey];
			if (!v) return [];
			if (groupRel.format === "checkbox") return [v.boolValue ? "true" : "false"];
			if (v.stringValue !== undefined) return v.stringValue ? [v.stringValue] : [];
			if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").filter(Boolean);
			return [];
		};
		const defs =
			groupRel.format === "checkbox"
				? [
						{ id: "false", name: "Not done" },
						{ id: "true", name: "Done" },
					]
				: [...groupRel.options.map((o) => ({ id: o.text, name: o.text })), { id: "", name: `No ${groupRel.name || groupKey}` }];
		return defs.map((d) => ({
			...d,
			count: rows.filter((r) => {
				const vals = valsOf(r);
				if (groupRel.format === "checkbox") return vals[0] === d.id || (d.id === "false" && vals.length === 0);
				return d.id === "" ? vals.length === 0 : vals.includes(d.id);
			}).length,
		}));
	});

	// ── mini month (Anytype widget): navigable, Monday-first grid
	// padded with adjacent-month days; items mark their day. ─────────
	let monthOff = $state(0);
	const month = $derived.by(() => {
		const now = new Date();
		const view = new Date(now.getFullYear(), now.getMonth() + monthOff, 1);
		const y = view.getFullYear();
		const m = view.getMonth();
		const tsOf = (r: QueryResultRow): number => {
			if (dateKey === "createdDate") return r.createdAt;
			if (dateKey === "modifiedDate") return r.updatedAt;
			const v = r.fields[dateKey];
			return v?.intValue ?? v?.floatValue ?? 0;
		};
		const marked = new Set<number>();
		for (const r of rows) {
			const ts = tsOf(r);
			if (!ts) continue;
			const d = new Date(ts);
			if (d.getFullYear() === y && d.getMonth() === m) marked.add(d.getDate());
		}
		const offset = (view.getDay() + 6) % 7;
		const days = new Date(y, m + 1, 0).getDate();
		const prevDays = new Date(y, m, 0).getDate();
		const isThis = y === now.getFullYear() && m === now.getMonth();
		const cells: Array<{ n: number; cur: boolean; today: boolean; marked: boolean }> = [];
		for (let i = 0; i < offset; i++) cells.push({ n: prevDays - offset + 1 + i, cur: false, today: false, marked: false });
		for (let i = 1; i <= days; i++) cells.push({ n: i, cur: true, today: isThis && i === now.getDate(), marked: marked.has(i) });
		let next = 1;
		while (cells.length % 7 !== 0) cells.push({ n: next++, cur: false, today: false, marked: false });
		return { label: view.toLocaleDateString(undefined, { month: "long" }), year: String(y), cells };
	});
</script>

{#if obj && (rows.length > 0 || viewType === "calendar")}
	<div class="widget-body">
		{#if viewType === "kanban" && groupRel}
			{#each groups.filter((g) => g.count > 0) as g (g.id)}
				<a class="w-group" href="/object/{id}">
					<span class="wg-name">{g.name}</span>
					<span class="wg-count">{g.count}</span>
				</a>
			{/each}
		{:else if viewType === "calendar"}
			<div class="w-cal">
				<div class="w-cal-head">
					<a class="w-cal-title" href="/object/{id}">{month.label} <span class="w-cal-year">{month.year}</span></a>
					<span class="w-cal-nav">
						<button aria-label="Previous month" onclick={() => monthOff--}>‹</button>
						<button aria-label="Next month" onclick={() => monthOff++}>›</button>
					</span>
				</div>
				<a class="w-cal-grid" href="/object/{id}" aria-label="Open calendar">
					{#each ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as d, i (d)}
						<span class="w-dow" class:wknd={i >= 5}>{d}</span>
					{/each}
					{#each month.cells as c, i (i)}
						<span class="w-day" class:dim={!c.cur} class:today={c.today} class:marked={c.marked} class:wknd={i % 7 >= 5}>{c.n}</span>
					{/each}
				</a>
			</div>
		{:else if viewType === "gallery"}
			<div class="w-cards">
				{#each rows.slice(0, GALLERY_LIMIT) as r (r.id)}
					<a class="w-card" href="/object/{r.id}">
						<span class="w-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
						<span class="w-name">{r.fields["name"]?.stringValue || "Untitled"}</span>
					</a>
				{/each}
				{#if rows.length > GALLERY_LIMIT}
					<a class="w-card w-card-more" href="/object/{id}">+{rows.length - GALLERY_LIMIT} more</a>
				{/if}
			</div>
		{:else}
			{#each rows.slice(0, LIMIT) as r (r.id)}
				<a class="w-row" href="/object/{r.id}">
					<span class="w-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
					<span class="w-name">{r.fields["name"]?.stringValue || "Untitled"}</span>
				</a>
			{/each}
			{#if rows.length > LIMIT}
				<a class="w-more" href="/object/{id}">+{rows.length - LIMIT} more</a>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.widget-body {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 2px 0 0;
	}
	.w-row,
	.w-group {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 24px;
		padding: 0 8px;
		border-radius: 6px;
		font-size: 12px;
		color: var(--muted);
		text-decoration: none;
		overflow: hidden;
	}
	.w-row:hover,
	.w-group:hover,
	.w-card:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.w-icon {
		flex: none;
		font-size: 11px;
	}
	.w-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.wg-name {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.wg-count {
		font-size: 11px;
	}
	.w-more {
		font-size: 11px;
		color: var(--muted);
		padding: 2px 8px;
		text-decoration: none;
	}
	.w-more:hover {
		color: var(--fg);
	}
	/* Anytype's sidebar gallery: pronounced bordered cards on a 2-col
	   grid - roomy padding, 500-weight names, visible outlines. */
	.w-cards {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		padding: 4px 8px 6px 0;
	}
	.w-card {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		background: var(--hl-light);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 11px 12px;
		font-size: 13px;
		font-weight: 500;
		color: var(--fg);
		text-decoration: none;
		overflow: hidden;
	}
	.w-card:hover {
		border-color: color-mix(in srgb, var(--border) 55%, var(--fg));
	}
	.w-card .w-icon {
		font-size: 15px;
	}
	.w-cal {
		padding: 2px 8px 6px 0;
	}
	.w-cal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 2px 6px 6px;
	}
	.w-cal-title {
		font-size: 15px;
		font-weight: 700;
		color: var(--fg);
		text-decoration: none;
	}
	.w-cal-year {
		margin-left: 4px;
	}
	.w-cal-nav {
		display: flex;
		gap: 2px;
	}
	.w-cal-nav button {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 2px 5px;
	}
	.w-cal-nav button:hover {
		color: var(--fg);
	}
	.w-cal-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		text-decoration: none;
	}
	.w-dow {
		font-size: 11px;
		color: var(--muted);
		text-align: center;
		padding: 4px 0;
	}
	.w-day {
		font-size: 12.5px;
		color: var(--fg);
		text-align: center;
		padding: 5px 0;
		position: relative;
	}
	.w-day.dim {
		color: var(--muted);
		opacity: 0.6;
	}
	.w-day.today {
		color: var(--accent);
		font-weight: 700;
	}
	/* Weekend band: Sa/Su columns ride a raised strip (Anytype look). */
	.wknd {
		background: var(--hl-light);
	}
	.w-dow.wknd:nth-child(6) {
		border-top-left-radius: 8px;
	}
	.w-dow.wknd:nth-child(7) {
		border-top-right-radius: 8px;
	}
	.w-cal-grid > :nth-last-child(2).wknd {
		border-bottom-left-radius: 8px;
	}
	.w-cal-grid > :nth-last-child(1).wknd {
		border-bottom-right-radius: 8px;
	}
	.w-day.marked::after {
		content: "";
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		bottom: 1px;
		width: 3px;
		height: 3px;
		border-radius: 50%;
		background: var(--accent);
	}
	.w-card-more {
		justify-content: center;
		color: var(--muted);
		font-weight: 400;
		border-style: dashed;
	}
</style>
