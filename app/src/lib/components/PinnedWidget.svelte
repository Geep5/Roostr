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
				const body =
					o.typeKey === "collection"
						? memberIds.length
							? { filters: [{ key: "id", condition: "in", value: memberIds }] }
							: null
						: { setId: o.id };
				if (!body) {
					rows = [];
					return;
				}
				const res = await fetchQuery({ ...body, limit: 50 });
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

	// ── mini month: which days have items ──────────────────────────
	const month = $derived.by(() => {
		const now = new Date();
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
			if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) marked.add(d.getDate());
		}
		const first = new Date(now.getFullYear(), now.getMonth(), 1);
		const offset = (first.getDay() + 6) % 7;
		const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
		return { offset, days, today: now.getDate(), marked };
	});
</script>

{#if obj && rows.length > 0}
	<div class="widget-body">
		{#if viewType === "kanban" && groupRel}
			{#each groups.filter((g) => g.count > 0) as g (g.id)}
				<a class="w-group" href="/object/{id}">
					<span class="wg-name">{g.name}</span>
					<span class="wg-count">{g.count}</span>
				</a>
			{/each}
		{:else if viewType === "calendar"}
			<a class="w-cal" href="/object/{id}" aria-label="Open calendar">
				{#each Array(month.offset) as _, i (i)}<span class="w-day dim"></span>{/each}
				{#each Array(month.days) as _, i (i)}
					<span class="w-day" class:today={i + 1 === month.today} class:marked={month.marked.has(i + 1)}>{i + 1}</span>
				{/each}
			</a>
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
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 1px;
		padding: 2px 8px 2px 0;
		text-decoration: none;
	}
	.w-day {
		font-size: 9px;
		color: var(--muted);
		text-align: center;
		border-radius: 4px;
		padding: 1px 0;
	}
	.w-day.marked {
		background: var(--hl-med);
		color: var(--fg);
		font-weight: 600;
	}
	.w-day.today {
		outline: 1px solid var(--accent);
	}
	.w-card-more {
		justify-content: center;
		color: var(--muted);
		font-weight: 400;
		border-style: dashed;
	}
</style>
