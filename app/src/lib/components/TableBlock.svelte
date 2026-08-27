<script lang="ts">
	/**
	 * Anytype-faithful table renderer. The table block's children are two
	 * layouts (TABLE_COLUMNS holding column markers, TABLE_ROWS holding row
	 * blocks); a cell is an ordinary text block with id "<rowId>-<colId>".
	 * Cell edits ride the editor's normal save pipeline (data-block + .text
	 * + data-ready), so a table cell syncs like any other block.
	 */
	import type { BlockJSON } from "$lib/types";
	import { Layout } from "$lib/types";
	import { toHtml } from "$lib/marks";
	import { table as tableApi, note } from "$lib/api";

	let {
		block,
		byId,
		objectId,
		onrefresh,
		oninput,
		onblur,
	}: {
		block: BlockJSON;
		byId: Map<string, BlockJSON>;
		objectId: string;
		onrefresh: () => void | Promise<void>;
		oninput: (id: string) => void;
		onblur: (id: string) => void;
	} = $props();

	const colIds = $derived(
		block.childrenIds
			.map((id) => byId.get(id))
			.find((b) => b?.content.layout?.style === Layout.TABLE_COLUMNS)?.childrenIds ?? [],
	);
	const rowIds = $derived(
		block.childrenIds
			.map((id) => byId.get(id))
			.find((b) => b?.content.layout?.style === Layout.TABLE_ROWS)?.childrenIds ?? [],
	);

	/** Populate cell HTML when not editing; gate saves until populated. */
	function cellContent(cellId: string) {
		return (el: HTMLElement) => {
			const t = byId.get(cellId)?.content.text;
			if (!t) return;
			if (document.activeElement !== el) {
				const html = toHtml(t.text, t.marks ?? []);
				if (el.innerHTML !== html) el.innerHTML = html;
			}
			el.dataset.ready = "1";
		};
	}

	function focusCell(cellId: string) {
		const el = document.querySelector<HTMLElement>(`[data-block="${cellId}"] .text`);
		el?.focus();
	}

	/** Enter commits; Tab / Shift-Tab walk cells row-major like Anytype. */
	function cellKeydown(e: KeyboardEvent, rowIdx: number, colIdx: number) {
		if (e.key === "Enter") {
			e.preventDefault();
			(e.currentTarget as HTMLElement).blur();
			return;
		}
		if (e.key === "Tab") {
			e.preventDefault();
			const flat = rowIdx * colIds.length + colIdx + (e.shiftKey ? -1 : 1);
			if (flat < 0 || flat >= rowIds.length * colIds.length) return;
			const r = Math.floor(flat / colIds.length);
			const c = flat % colIds.length;
			(e.currentTarget as HTMLElement).blur();
			focusCell(`${rowIds[r]}-${colIds[c]}`);
		}
	}

	async function addRow() {
		await tableApi.rowAdd(objectId, block.id);
		await onrefresh();
	}
	async function addCol() {
		await tableApi.colAdd(objectId, block.id);
		await onrefresh();
	}
	async function removeRow(rowId: string) {
		await note.blockRemove(objectId, rowId);
		await onrefresh();
	}
	async function removeCol(colId: string) {
		await tableApi.colRemove(objectId, block.id, colId);
		await onrefresh();
	}
</script>

<div class="table-wrap">
	<div class="col-gutter" style="grid-template-columns: repeat({colIds.length}, 1fr)">
		{#each colIds as colId (colId)}
			<button class="mini" title="Delete column" onclick={() => void removeCol(colId)} disabled={colIds.length <= 1}>×</button>
		{/each}
	</div>
	<div class="grid-row">
		<table>
			<tbody>
				{#each rowIds as rowId, rowIdx (rowId)}
					<tr class:header={byId.get(rowId)?.content.tableRow?.isHeader}>
						{#each colIds as colId, colIdx (colId)}
							{@const cellId = `${rowId}-${colId}`}
							<td data-block={cellId}>
								{#if byId.get(cellId)?.content.text}
									<div
										class="text"
										role="textbox"
										tabindex="0"
										contenteditable="true"
										{@attach cellContent(cellId)}
										onkeydown={(e) => cellKeydown(e, rowIdx, colIdx)}
										oninput={() => oninput(cellId)}
										onblur={() => onblur(cellId)}
									></div>
								{/if}
							</td>
						{/each}
						<td class="row-gutter">
							<button class="mini" title="Delete row" onclick={() => void removeRow(rowId)} disabled={rowIds.length <= 1}>×</button>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		<button class="edge col" title="Add column" onclick={() => void addCol()}>+</button>
	</div>
	<button class="edge row" title="Add row" onclick={() => void addRow()}>+</button>
</div>

<style>
	.table-wrap {
		flex: 1;
		min-width: 0;
		padding: 4px 0;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		table-layout: fixed;
	}
	td {
		border: 1px solid var(--border);
		padding: 0;
		vertical-align: top;
		min-width: 60px;
	}
	tr.header td {
		background: var(--hover);
		font-weight: 600;
	}
	.text {
		padding: 6px 8px;
		min-height: 20px;
		outline: none;
		font-size: 14px;
		line-height: 1.45;
		word-break: break-word;
	}
	.grid-row {
		display: flex;
		align-items: stretch;
		gap: 2px;
	}
	.col-gutter {
		display: grid;
		gap: 0;
		height: 14px;
		margin-right: 20px; /* row-gutter + edge width */
		opacity: 0;
		transition: opacity 0.1s;
	}
	.table-wrap:hover .col-gutter {
		opacity: 1;
	}
	td.row-gutter {
		border: none;
		width: 18px;
		min-width: 18px;
		vertical-align: middle;
		opacity: 0;
		transition: opacity 0.1s;
	}
	.table-wrap:hover td.row-gutter {
		opacity: 1;
	}
	.mini {
		border: none;
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
		padding: 0 4px;
		line-height: 14px;
	}
	.mini:hover:not(:disabled) {
		color: #e8524a;
	}
	.mini:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.edge {
		border: 1px dashed var(--border);
		background: none;
		color: var(--muted);
		border-radius: 6px;
		cursor: pointer;
		opacity: 0;
		transition: opacity 0.1s;
		font-size: 13px;
	}
	.table-wrap:hover .edge {
		opacity: 1;
	}
	.edge.col {
		width: 16px;
		margin-right: 2px;
	}
	.edge.row {
		width: calc(100% - 20px);
		height: 16px;
		margin-top: 2px;
	}
	.edge:hover {
		color: var(--accent);
		border-color: var(--accent);
	}
</style>
