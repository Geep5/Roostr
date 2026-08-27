<script lang="ts">
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import type { RelationDefJSON, ValueJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	/** `body` is a /api/query request body (setId, filters, type, …).
	 * `defaultSorts` applies until the user clicks a column header. */
	let {
		body,
		relations,
		defaultSorts = [],
	}: {
		body: Record<string, unknown>;
		relations: RelationDefJSON[];
		defaultSorts?: Array<{ key: string; type: "asc" | "desc" }>;
	} = $props();

	let rows = $state<QueryResultRow[]>([]);
	let override = $state<{ key: string; dir: "asc" | "desc" } | null>(null);
	const sortKey = $derived(override?.key ?? defaultSorts[0]?.key ?? "updatedAt");
	const sortDir = $derived(override?.dir ?? defaultSorts[0]?.type ?? "desc");

	const HIDDEN_COLUMNS: Record<string, true> = {
		name: true,
		setOf: true,
		featuredRelations: true,
		collectionIds: true,
		viewFilters: true,
		viewSorts: true,
	};

	const columns = $derived.by(() => {
		const keys = new Set<string>();
		for (const r of rows) {
			for (const k of Object.keys(r.fields)) {
				if (!HIDDEN_COLUMNS[k]) keys.add(k);
			}
		}
		return [...keys].sort();
	});

	async function load() {
		const sorts = override ? [{ key: override.key, type: override.dir }] : defaultSorts.length > 0 ? defaultSorts : [{ key: "updatedAt", type: "desc" }];
		const res = await fetchQuery({ ...body, sorts });
		rows = res.records;
	}

	$effect(() => {
		void body;
		void override;
		void defaultSorts;
		void load();
	});

	export function reload(): Promise<void> {
		return load();
	}

	function cell(v: ValueJSON | undefined, format: string): string {
		if (!v) return "";
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.intValue !== undefined) return format === "date" ? new Date(v.intValue).toLocaleDateString() : String(v.intValue);
		if (v.floatValue !== undefined) return String(v.floatValue);
		if (v.boolValue !== undefined) return v.boolValue ? "✓" : "";
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").join(", ");
		if (v.listValue) return v.listValue.values.join(", ");
		if (v.linkValue) return v.linkValue.targetId.slice(0, 8);
		return "";
	}

	function formatOf(key: string): string {
		return relations.find((r) => r.key === key)?.format ?? "";
	}

	function toggleSort(key: string) {
		if (sortKey === key) override = { key, dir: sortDir === "asc" ? "desc" : "asc" };
		else override = { key, dir: "asc" };
	}
</script>

<div class="set-table">
	<table>
		<thead>
			<tr>
				<th onclick={() => toggleSort("name")}>Name {sortKey === "name" ? (sortDir === "asc" ? "↑" : "↓") : ""}</th>
				{#each columns as c (c)}
					<th onclick={() => toggleSort(c)}>{relations.find((r) => r.key === c)?.name ?? c} {sortKey === c ? (sortDir === "asc" ? "↑" : "↓") : ""}</th>
				{/each}
				<th onclick={() => toggleSort("type")}>Type {sortKey === "type" ? (sortDir === "asc" ? "↑" : "↓") : ""}</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				<tr onclick={() => (location.href = `/object/${r.id}`)}>
					<td class="name"><span class="row-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span> {fieldStr(r.fields, "name") || r.id.slice(0, 8)}</td>
					{#each columns as c (c)}
						<td>{cell(r.fields[c], formatOf(c))}</td>
					{/each}
					<td class="muted">{r.typeKey}</td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#if rows.length === 0}
		<p class="muted empty">No objects match.</p>
	{/if}
</div>

<style>
	.set-table {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 13px;
	}
	th {
		text-align: left;
		color: var(--muted);
		font-weight: 500;
		border-bottom: 1px solid var(--border);
		padding: 6px 10px;
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
	}
	td {
		border-bottom: 1px solid var(--border);
		padding: 7px 10px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		max-width: 280px;
	}
	tbody tr {
		cursor: pointer;
	}
	tbody tr:hover {
		background: var(--hover);
	}
	.name {
		font-weight: 550;
	}
	.muted {
		color: var(--muted);
	}
	.empty {
		padding: 16px 10px;
	}
</style>
