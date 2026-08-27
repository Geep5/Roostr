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
	import { store } from "$lib/data.svelte";
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
	const DEFAULT_WIDTH = 150;
	const MIN_WIDTH = 60;

	interface Col {
		key: string;
		width: number;
	}

	/** Anytype viewRelation = {relationKey, width, isVisible}; ours is a
	 * {key, width} map per item. Plain-string items (pre-width format)
	 * still parse. */
	const stored = $derived.by((): Col[] => {
		const items = object.fields["viewRelations"]?.valuesValue?.items ?? [];
		const out: Col[] = [];
		for (const i of items) {
			if (typeof i.stringValue === "string") {
				out.push({ key: i.stringValue, width: DEFAULT_WIDTH });
			} else if (i.mapValue) {
				const k = i.mapValue.entries["key"]?.stringValue;
				if (k) out.push({ key: k, width: i.mapValue.entries["width"]?.intValue ?? DEFAULT_WIDTH });
			}
		}
		return out.length > 0 ? out : DEFAULT_COLUMNS.map((k) => ({ key: k, width: DEFAULT_WIDTH }));
	});

	/** Uncommitted state during a resize/reorder gesture. */
	let local = $state<Col[] | null>(null);
	const cols = $derived(local ?? stored);
	const columns = $derived(cols.map((c) => c.key));

	const addable = $derived.by(() => {
		const have = new Set(columns);
		const rels = relations
			.filter((r) => !r.hidden && !have.has(r.key))
			.map((r) => ({ key: r.key, name: r.name || r.key }));
		return [...SPECIALS.filter((s) => !have.has(s.key)), ...rels];
	});

	let adding = $state(false);

	async function saveColumns(next: Col[]) {
		adding = false;
		local = next;
		await note.setField(object.id, "viewRelations", {
			valuesValue: {
				items: next.map((c) => ({
					mapValue: { entries: { key: { stringValue: c.key }, width: { intValue: c.width } } },
				})),
			},
		});
		await onchanged();
		local = null;
	}

	// ── Column resize (drag the header's right edge) ──────────────
	function startResize(e: PointerEvent, idx: number) {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startW = cols[idx].width;
		const snapshot = cols.map((c) => ({ ...c }));
		const move = (ev: PointerEvent) => {
			snapshot[idx] = { ...snapshot[idx], width: Math.max(MIN_WIDTH, startW + (ev.clientX - startX)) };
			local = [...snapshot];
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			void saveColumns(snapshot);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	// ── Column reorder (drag a header onto another) ───────────────
	let dragIdx = $state(-1);
	let overIdx = $state(-1);

	function dropColumn() {
		if (dragIdx < 0 || overIdx < 0 || dragIdx === overIdx) {
			dragIdx = overIdx = -1;
			return;
		}
		const next = cols.map((c) => ({ ...c }));
		const [moved] = next.splice(dragIdx, 1);
		next.splice(overIdx, 0, moved);
		dragIdx = overIdx = -1;
		void saveColumns(next);
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
		if (format === "object" && v.valuesValue) {
			return v.valuesValue.items
				.map((i) => store.summaries.find((s) => s.id === i.stringValue)?.name || (i.stringValue ?? "").slice(0, 6))
				.join(", ");
		}
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
		<colgroup>
			<col />
			{#each cols as c (c.key)}
				<col style="width: {c.width}px" />
			{/each}
			<col style="width: 32px" />
		</colgroup>
		<thead>
			<tr>
				<th>
					<button class="head" onclick={() => toggleSort("name")}>Name {sortKey === "name" ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
				</th>
				{#each cols as c, i (c.key)}
					<th
						class:drag-over={overIdx === i && dragIdx !== i}
						draggable="true"
						ondragstart={(e) => {
							dragIdx = i;
							e.dataTransfer?.setData("text/plain", c.key);
						}}
						ondragover={(e) => {
							if (dragIdx < 0) return;
							e.preventDefault();
							overIdx = i;
						}}
						ondragleave={() => {
							if (overIdx === i) overIdx = -1;
						}}
						ondrop={(e) => {
							e.preventDefault();
							overIdx = i;
							dropColumn();
						}}
						ondragend={() => (dragIdx = overIdx = -1)}
					>
						<button class="head" onclick={() => toggleSort(c.key)}>{colName(c.key)} {sortKey === c.key ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
						<button class="hide" title="Hide column" onclick={() => void saveColumns(cols.filter((x) => x.key !== c.key))}>×</button>
						<span
							class="resize"
							role="separator"
							aria-orientation="vertical"
							title="Drag to resize"
							onpointerdown={(e) => startResize(e, i)}
						></span>
					</th>
				{/each}
				<th class="plus-col">
					<button class="head plus" title="Add column" onclick={() => (adding = !adding)}>+</button>
					{#if adding}
						<div class="col-menu">
							{#each addable as a (a.key)}
								<button onclick={() => void saveColumns([...cols, { key: a.key, width: DEFAULT_WIDTH }])}>{a.name}</button>
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
		table-layout: fixed;
		font-size: 13px;
	}
	th {
		text-align: left;
		border-bottom: 1px solid var(--border);
		padding: 0;
		white-space: nowrap;
		position: relative;
	}
	th.drag-over {
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.resize {
		position: absolute;
		top: 0;
		right: -3px;
		width: 7px;
		height: 100%;
		cursor: col-resize;
		z-index: 2;
	}
	.resize:hover {
		background: var(--accent);
		opacity: 0.5;
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
