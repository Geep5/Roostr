<script lang="ts">
	/**
	 * Anytype dataview grid: a view carries an ordered relation list
	 * (model/view.ts getVisibleRelations) and each visible relation is a
	 * column - Name first, then relation columns, then "+" to add one.
	 * We persist the list as a `viewRelations` field on the query/collection
	 * object itself, same as viewFilters/viewSorts. Hover a header for "×"
	 * (hide column); click a header to sort.
	 */
	import PropertyFlow from "./PropertyFlow.svelte";
	import RowContextMenu from "./RowContextMenu.svelte";
	import PropertyValue from "./PropertyValue.svelte";
	import { tagStyle } from "$lib/options";
	import CheckboxIcon from "./CheckboxIcon.svelte";
	import { fetchQuery, note, type QueryResultRow } from "$lib/api";
	import { store, layoutOf } from "$lib/data.svelte";
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	let {
		body,
		object,
		relations,
		defaultSorts = [],
		oncreate,
		onremove,
		onchanged,
	}: {
		/** /api/query request body (setId, filters, …). */
		body: Record<string, unknown>;
		/** The query/collection object owning the view config. */
		object: ObjectJSON;
		relations: RelationDefJSON[];
		defaultSorts?: Array<{ key: string; type: "asc" | "desc" }>;
		/** Renders the Anytype "+ New Object" footer row when provided.
		 *  Committing the entry row calls it with the typed name. */
		oncreate?: (name: string) => Promise<void>;
		/** Collections: the row context menu offers "Remove from
		 *  collection", severing membership without touching the object. */
		onremove?: (ids: string[]) => Promise<void>;
		onchanged: () => Promise<void>;
	} = $props();

	let rows = $state<QueryResultRow[]>([]);

	// ── Row multi-select (Anytype SelectType.Record) ────────────────
	// Cmd/ctrl-click toggles, shift-click ranges from the anchor; a
	// selection bar offers bulk delete; Escape or plain click clears.
	let selectedRows = $state<string[]>([]);
	let rowAnchor = "";

	function toggleRow(id: string) {
		rowAnchor = id;
		selectedRows = selectedRows.includes(id) ? selectedRows.filter((x) => x !== id) : [...selectedRows, id];
	}

	function rangeRows(id: string) {
		const a = rows.findIndex((r) => r.id === (rowAnchor || selectedRows[0]));
		const b = rows.findIndex((r) => r.id === id);
		if (a === -1 || b === -1) {
			toggleRow(id);
			return;
		}
		selectedRows = rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.id);
	}

	// ── Drag across rows paints the selection ───────────────────────
	// A bare drag over a table highlights cell TEXT by default, which is
	// meaningless here — records are the unit. tbody opts out of text
	// selection in CSS, freeing the drag to mean "select these records"
	// the way Anytype (and the block editor's marquee) behaves.
	let dragFrom = "";
	let dragMoved = false;
	let dragging = false;

	function onRowMouseDown(e: MouseEvent, id: string) {
		// Modifier clicks are the existing toggle/range gestures, and
		// editable cells own their own mouse handling.
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
		if ((e.target as HTMLElement).closest("td.editable, a, button, input")) return;
		dragFrom = id;
		dragMoved = false;
		dragging = true;
	}

	/** Extend the painted range as the cursor crosses into another row. */
	function onRowEnter(id: string) {
		if (!dragging || id === dragFrom) return;
		dragMoved = true;
		rowAnchor = dragFrom;
		rangeRows(id);
	}

	function endRowDrag() {
		dragging = false;
		dragFrom = "";
	}

	function onRowClick(e: MouseEvent, id: string) {
		if (e.metaKey || e.ctrlKey) {
			e.preventDefault();
			toggleRow(id);
			return;
		}
		if (e.shiftKey) {
			e.preventDefault();
			rangeRows(id);
			return;
		}
		// The click that ends a drag must not clear what the drag just
		// selected — mouseup fires a click on the row under the cursor.
		if (dragMoved) {
			dragMoved = false;
			return;
		}
		if (selectedRows.length) {
			selectedRows = [];
			return;
		}
		location.href = `/object/${id}`;
	}

	// ── Inline cell editing (Anytype dataview.tsx onCellClick + cell/*:
	// only the name cell opens the object; every relation cell edits in
	// place - checkbox toggles instantly, everything else anchors the
	// per-format editor at the cell) ─────────────────────────────────
	let cellEdit = $state<{ recordId: string; key: string; x: number; y: number } | null>(null);

	/** Any real relation column edits inline; specials stay read-only. */
	function isEditable(key: string): boolean {
		const rel = relations.find((r) => r.key === key);
		return !!rel && !rel.readOnly;
	}

	function cellValues(recordId: string, key: string): string[] {
		const r = rows.find((x) => x.id === recordId);
		const v = r?.fields[key];
		if (v?.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").filter(Boolean);
		return v?.stringValue ? [v.stringValue] : [];
	}

	function onCellClick(e: MouseEvent, recordId: string, key: string) {
		e.stopPropagation();
		if (formatOf(key) === "checkbox") {
			// Anytype checkbox cells toggle on click, no menu.
			const cur = rows.find((x) => x.id === recordId)?.fields[key]?.boolValue === true;
			void (async () => {
				await note.setField(recordId, key, { boolValue: !cur });
				await reload();
			})();
			return;
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		cellEdit = cellEdit?.recordId === recordId && cellEdit.key === key ? null : { recordId, key, x: rect.left, y: rect.bottom + 4 };
	}

	async function cellSave(v: ValueJSON) {
		if (!cellEdit) return;
		const { recordId, key } = cellEdit;
		const f = formatOf(key);
		// Single-value editors close on save; tag/object stay open for more picks.
		if (f !== "tag" && f !== "object") cellEdit = null;
		await note.setField(recordId, key, v);
		await reload();
	}

	async function deleteSelected() {
		const ids = [...selectedRows];
		selectedRows = [];
		for (const id of ids) await note.del(id);
		await reload();
	}

	// ── Row context menu (right-click): open / remove-from-collection /
	// bin. A right-click inside the selection acts on the whole
	// selection; outside it, on just that row. ───────────────────────
	let ctxMenu = $state<{ x: number; y: number; id: string } | null>(null);

	function onRowContext(e: MouseEvent, id: string) {
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY, id };
	}

	function ctxTargets(): string[] {
		if (!ctxMenu) return [];
		return selectedRows.includes(ctxMenu.id) ? [...selectedRows] : [ctxMenu.id];
	}

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

	let adding = $state<{ x: number; y: number } | null>(null);

	async function saveColumns(next: Col[]) {
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
		const sorts = (override ? [{ key: override.key, type: override.dir }] : defaultSorts.length > 0 ? defaultSorts : [{ key: "updatedAt", type: "desc" }]).map((s) => ({
			key: s.key,
			type: s.type,
			emptyPlacement: ("empty" in s ? s.empty : undefined) ?? "end",
		}));
		const res = await fetchQuery({ ...body, sorts });
		rows = res.records;
	}

	$effect(() => {
		void body;
		void override;
		void defaultSorts;
		void load();
	});

	/** Task-layout rows show a checkbox instead of the icon (Anytype task
	 * layout): clicking toggles the bundled `done` relation in place. */
	async function toggleDone(r: QueryResultRow, e: MouseEvent) {
		e.stopPropagation();
		await note.setField(r.id, "done", { boolValue: !(r.fields["done"]?.boolValue === true) });
		await reload();
	}

	export function reload(): Promise<void> {
		return load();
	}

	// ── Pending entry row (Anytype: "+ New Object" shows an "Enter
	// name" row in place; the record exists only once committed) ──────
	let pendingNew = $state(false);
	let newDraft = $state("");
	let committing = $state(false);

	export function beginNew() {
		pendingNew = true;
		newDraft = "";
	}

	async function commitNew(cancel = false) {
		if (committing) return;
		const name = newDraft.trim();
		pendingNew = false;
		newDraft = "";
		if (cancel || !oncreate) return;
		committing = true;
		try {
			await oncreate(name);
			await load();
		} finally {
			committing = false;
		}
	}

	function renameInput(node: HTMLInputElement) {
		requestAnimationFrame(() => node.focus());
	}

	function colName(key: string): string {
		return SPECIALS.find((s) => s.key === key)?.name ?? relations.find((r) => r.key === key)?.name ?? key;
	}

	/** The property's own emoji, when it has one (specials have none). */
	function colIcon(key: string): string {
		return relations.find((r) => r.key === key)?.iconEmoji ?? "";
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

<svelte:window onkeydown={(e) => { if (e.key === "Escape") { cellEdit = null; selectedRows = []; ctxMenu = null; } }} onmousedown={(e) => { if (cellEdit && !(e.target as HTMLElement).closest(".cell-pop, td.editable")) cellEdit = null; }} onmouseup={endRowDrag} />

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
						<button class="head" onclick={() => toggleSort(c.key)}>{#if colIcon(c.key)}<span class="head-icon">{colIcon(c.key)}</span>{/if}{colName(c.key)} {sortKey === c.key ? (sortDir === "asc" ? "↑" : "↓") : ""}</button>
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
					<button
						class="head plus"
						title="Add column"
						onclick={(e) => {
							const r = e.currentTarget.getBoundingClientRect();
							adding = adding ? null : { x: r.left, y: r.bottom + 4 };
						}}>+</button
					>
				</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r (r.id)}
				<tr class:selected={selectedRows.includes(r.id)} onclick={(e) => onRowClick(e, r.id)} onmousedown={(e) => onRowMouseDown(e, r.id)} onmouseenter={() => onRowEnter(r.id)} oncontextmenu={(e) => onRowContext(e, r.id)}>
					<td class="name">
						{#if layoutOf(r.typeKey) === "task"}
							<button class="task-check" class:on={r.fields["done"]?.boolValue === true} aria-label="done" onclick={(e) => void toggleDone(r, e)}>
								<CheckboxIcon checked={r.fields["done"]?.boolValue === true} size={18} />
							</button>
						{:else}
							<span class="row-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
						{/if}
						{fieldStr(r.fields, "name") || "Untitled"}</td>
					{#each columns as c (c)}
						{#if isEditable(c)}
							{@const rel = relations.find((x) => x.key === c)}
							{@const fmt = formatOf(c)}
							<td class="editable" onclick={(e) => onCellClick(e, r.id, c)}>
								{#if fmt === "tag" || fmt === "status"}
									{#each cellValues(r.id, c) as t (t)}
										{@const opt = rel?.options.find((o) => o.text === t)}
										<span class="cell-tag" style={tagStyle(opt?.color ?? "")}>{t}</span>
									{/each}
								{:else if fmt === "checkbox"}
									<span class="cell-check" class:on={r.fields[c]?.boolValue === true}><CheckboxIcon checked={r.fields[c]?.boolValue === true} size={20} /></span>
								{:else}
									{cell(r, c)}
								{/if}
							</td>
						{:else}
							<td class:muted={c === "type" || c === "createdAt" || c === "updatedAt"}>{cell(r, c)}</td>
						{/if}
					{/each}
					<td></td>
				</tr>
			{/each}
			{#if oncreate}
			{#if pendingNew}
				<tr class="entry-row">
					<!-- colspan must match the REAL column count: an oversized
					     colspan in a fixed-layout table fabricates phantom
					     columns and crushes the visible ones. -->
					<td colspan={cols.length + 2}>
						<span class="entry-wrap">
							<input
								class="rename"
								placeholder="Enter name"
								bind:value={newDraft}
								use:renameInput
								onblur={() => void commitNew(newDraft.trim() === "")}
								onkeydown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										void commitNew();
									}
									if (e.key === "Escape") {
										e.preventDefault();
										void commitNew(true);
									}
								}}
							/>
						</span>
					</td>
				</tr>
			{/if}
			<tr class="new-row">
				<td colspan={cols.length + 2}>
					<button class="new-object" onclick={() => beginNew()}>＋ New Object</button>
				</td>
			</tr>
		{/if}
	</tbody>
	</table>
	{#if cellEdit}
		{@const rel = relations.find((x) => x.key === cellEdit!.key)}
		{@const row = rows.find((x) => x.id === cellEdit!.recordId)}
		{#if rel && row}
			<div class="cell-pop" style="left:{Math.min(cellEdit.x, window.innerWidth - 320)}px; top:{cellEdit.y}px" role="dialog">
				<PropertyValue {rel} value={row.fields[rel.key]} onsave={(v) => void cellSave(v)} />
			</div>
		{/if}
	{/if}
	{#if selectedRows.length}
		<div class="sel-bar">
			<span>{selectedRows.length} selected</span>
			<button class="del" onclick={() => void deleteSelected()}>Delete</button>
			<button class="clear" onclick={() => (selectedRows = [])}>✕</button>
		</div>
	{/if}
	{#if rows.length === 0}
		<p class="muted empty">No objects match.</p>
	{/if}
</div>
{#if adding}
	<!-- Anytype's property flow: toggle list -> Add property -> search all /
	     create new -> name + type. Fixed-position, viewport-clamped. -->
	<PropertyFlow
		x={adding.x}
		y={adding.y}
		items={[
			...cols.map((c) => {
				const sp = SPECIALS.find((x) => x.key === c.key);
				const rel = relations.find((r) => r.key === c.key);
				return { key: c.key, name: sp?.name ?? rel?.name ?? c.key, format: rel?.format ?? "shorttext", on: true };
			}),
			...SPECIALS.filter((sp) => !columns.includes(sp.key)).map((sp) => ({ key: sp.key, name: sp.name, format: "shorttext", on: false })),
		]}
		ontoggle={(key, on) =>
			void saveColumns(on ? [...cols, { key, width: DEFAULT_WIDTH }] : cols.filter((c) => c.key !== key))}
		onadd={(rel) => void saveColumns([...cols, { key: rel.key, width: DEFAULT_WIDTH }])}
		onclose={() => (adding = null)}
	/>
{/if}

{#if ctxMenu}
	<RowContextMenu
		x={ctxMenu.x}
		y={ctxMenu.y}
		ids={ctxTargets()}
		{onremove}
		onchanged={reload}
		onclose={() => {
			ctxMenu = null;
			selectedRows = [];
		}}
	/>
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
		color: var(--red);
	}
	.plus-col {
		width: 32px;
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
	/* Records are the selectable unit, so a drag must not leave native
	   text highlighting behind. The cell editor popover lives outside the
	   table, so it keeps normal text selection. */
	tbody td {
		user-select: none;
		-webkit-user-select: none;
	}
	tr.selected td {
		background: rgba(55, 122, 255, 0.25);
	}
	.sel-bar {
		position: sticky;
		bottom: 8px;
		display: flex;
		align-items: center;
		gap: 12px;
		width: fit-content;
		margin: 8px auto 0;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px 12px;
		font-size: 13px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
	}
	.sel-bar .del {
		background: none;
		border: none;
		color: #e05555;
		cursor: pointer;
		font-size: 13px;
	}
	.sel-bar .clear {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
	}
	td.editable {
		cursor: pointer;
	}
	td.editable:hover {
		background: var(--hl-light);
	}
	/* Anytype cellContent.c-checkbox: 20px icon, secondary until checked. */
	.cell-check {
		display: inline-flex;
		color: var(--muted);
	}
	.cell-check.on {
		color: var(--fg);
	}
	/* Anytype tagItem.isSmall: filled 20px pill, radius 10, pale text. */
	.cell-tag {
		display: inline-block;
		border-radius: 10px;
		padding: 0 6px;
		font-size: 12px;
		line-height: 20px;
		height: 20px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-right: 4px;
	}
	.cell-pop {
		position: fixed;
		z-index: 130;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
	}
	.new-object {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		border: none;
		background: none;
		color: var(--muted);
		font-size: 14px;
		padding: 10px 8px;
		cursor: pointer;
		text-align: left;
	}
	.new-object:hover {
		color: var(--fg);
	}
	.new-row td {
		border-bottom: none;
	}
	input.rename {
		background: none;
		border: none;
		outline: none;
		color: var(--fg);
		font: inherit;
		width: 100%;
	}
	.entry-row td {
		border-bottom: none;
		padding: 4px 0;
	}
	.entry-wrap {
		display: flex;
		align-items: center;
		gap: 6px;
		border: 2px solid var(--accent);
		border-radius: 8px;
		padding: 8px 10px;
		max-width: 420px;
	}
	.head-icon {
		margin-right: 5px;
		font-size: 12px;
	}
	.task-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		vertical-align: -4px;
		margin-right: 6px;
		padding: 0;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.task-check:hover {
		color: var(--fg);
	}
	.task-check.on {
		color: var(--accent);
	}
</style>
