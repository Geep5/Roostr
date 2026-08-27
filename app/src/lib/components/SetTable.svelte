<script lang="ts">
	/**
	 * Anytype dataview grid: a view carries an ordered relation list
	 * (model/view.ts getVisibleRelations) and each visible relation is a
	 * column - Name first, then relation columns, then "+" to add one.
	 * We persist the list as a `viewRelations` field on the query/collection
	 * object itself, same as viewFilters/viewSorts. Hover a header for "×"
	 * (hide column); click a header to sort.
	 */
	import { fetchQuery, note, type QueryResultRow } from "$lib/api";
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	let {
		body,
		object,
		relations,
		defaultSorts = [],
		onchanged,
	}: {
		/** /api/query request body (setId, filters, …). */
		body: Record<string, unknown>;
		/** The query/collection object owning the view config. */
		object: ObjectJSON;
		relations: RelationDefJSON[];
		defaultSorts?: Array<{ key: string; type: "asc" | "desc" }>;
		onchanged: () => Promise<void>;
	} = $props();

	let rows = $state<QueryResultRow[]>([]);
	let override = $state<{ key: string; dir: "asc" | "desc" } | null>(null);
	const sortKey = $derived(override?.key ?? defaultSorts[0]?.key ?? "updatedAt");
	const sortDir = $derived(override?.dir ?? defaultSorts[0]?.type ?? "desc");

	/** Built-in columns that aren't stored fields. */
	const SPECIALS: Array<{ key: string; name: string }> = [
		{ key: "type", name: "Type" },
		{ key: "createdAt", name: "Created" },
		{ key: "updatedAt", name: "Updated" },
	];

	/** Anytype default grid columns for a fresh view. */
	const DEFAULT_COLUMNS = ["type", "updatedAt"];

	const columns = $derived.by(() => {
		const items = object.fields["viewRelations"]?.valuesValue?.items ?? [];
		const keys = items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
		return keys.length > 0 ? keys : DEFAULT_COLUMNS;
	});

	const addable = $derived.by(() => {
		const have = new Set(columns);
		const rels = relations
			.filter((r) => !r.hidden && !have.has(r.key))
			.map((r) => ({ key: r.key, name: r.name || r.key }));
		return [...SPECIALS.filter((s) => !have.has(s.key)), ...rels];
	});

	let adding = $state(false);

	async function saveColumns(keys: string[]) {
		adding = false;
		await note.setField(object.id, "viewRelations", {
			valuesValue: { items: keys.map((k) => ({ stringValue: k })) },
		});
		await onchanged();
	}

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

	function colName(key: string): string {
		return SPECIALS.find((s) => s.key === key)?.name ?? relations.find((r) => r.key === key)?.name ?? key;
	}

	function formatOf(key: string): string {
		return relations.find((r) => r.key === key)?.format ?? "";
	}

	function cell(r: QueryResultRow, key: string): string {
		if (key === "type") return r.typeKey;
		if (key === "createdAt") return r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "";
		if (key === "updatedAt") return r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "";
		const v: ValueJSON | undefined = r.fields[key];
		const format = formatOf(key);
		if (!v) return "";
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.boolValue !== undefined) return v.boolValue ? "✓" : "";
		if (v.intValue !== undefined) return format === "date" ? new Date(v.intValue).toLocaleDateString() : String(v.intValue);
		if (v.floatValue !== undefined) return String(v.floatValue);
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").join(", ");
		if (v.listValue) return v.listValue.values.join(", ");
		if (v.linkValue) return v.linkValue.targetId.slice(0, 8);
		return "";
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
				<th>
					<button class="head" onclick={() => toggleSort("name")}>Name {sortKey === "name" ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
				</th>
				{#each columns as c (c)}
					<th>
						<button class="head" onclick={() => toggleSort(c)}>{colName(c)} {sortKey === c ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
						<button class="hide" title="Hide column" onclick={() => void saveColumns(columns.filter((k) => k !== c))}>×</button>
					</th>
				{/each}
				<th class="plus-col">
					<button class="head plus" title="Add column" onclick={() => (adding = !adding)}>+</button>
					{#if adding}
						<div class="col-menu">
							{#each addable as a (a.key)}
								<button onclick={() => void saveColumns([...columns, a.key])}>{a.name}</button>
							{/each}
							{#if addable.length === 0}<span class="muted">No more properties</span>{/if}
						</div>
					{/if}
				</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				<tr onclick={() => (location.href = `/object/${r.id}`)}>
					<td class="name"><span class="row-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span> {fieldStr(r.fields, "name") || r.id.slice(0, 8)}</td>
					{#each columns as c (c)}
						<td class:muted={c === "type" || c === "createdAt" || c === "updatedAt"}>{cell(r, c)}</td>
					{/each}
					<td></td>
				</tr>
			{/each}
		</tbody>
	</table>
	{#if rows.length === 0}
		<p class="muted empty">No objects match.</p>
	{/if}
</div>
{#if adding}
	<button class="backdrop" aria-label="Close" onclick={() => (adding = false)}></button>
{/if}

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
		border-bottom: 1px solid var(--border);
		padding: 0;
		white-space: nowrap;
		position: relative;
	}
	th .head {
		border: none;
		background: none;
		color: var(--muted);
		font-weight: 500;
		font-size: 13px;
		padding: 6px 10px;
		cursor: pointer;
		user-select: none;
	}
	th .head:hover {
		color: inherit;
	}
	th .hide {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		padding: 0 4px;
		opacity: 0;
		font-size: 12px;
	}
	th:hover .hide {
		opacity: 1;
	}
	th .hide:hover {
		color: #e8524a;
	}
	.plus-col {
		width: 32px;
	}
	.col-menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 90;
		min-width: 180px;
		max-height: 280px;
		overflow-y: auto;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		display: flex;
		flex-direction: column;
	}
	.col-menu button {
		border: none;
		background: none;
		color: inherit;
		text-align: left;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.col-menu button:hover {
		background: var(--hover);
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
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: none;
		border: none;
		cursor: default;
	}
</style>
