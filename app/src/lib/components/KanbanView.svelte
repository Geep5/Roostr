<script lang="ts">
	/**
	 * Board view — port of Anytype's dataview board (view/board.tsx).
	 * Groups by a select/multi-select/checkbox relation (ours: status, tag,
	 * checkbox); columns are the relation's options plus "No <name>"; a
	 * multi-select card appears in every group it belongs to, exactly like
	 * Anytype. Dragging a card between columns rewrites its group value.
	 */
	import { goto } from "$app/navigation";
	import RowContextMenu from "./RowContextMenu.svelte";
	import { fetchQuery, note, type QueryResultRow } from "$lib/api";
	import type { ObjectJSON, RelationDefJSON } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	let {
		body,
		object,
		relations,
		groupKey,
		onchanged,
		sorts = [],
		onremove,
	}: {
		body: Record<string, unknown>;
		object: ObjectJSON;
		relations: RelationDefJSON[];
		groupKey: string;
		onchanged: () => Promise<void>;
		sorts?: Array<{ key: string; type: "asc" | "desc" }>;
		/** Collections only: drop a card's object from the collection. */
		onremove?: (ids: string[]) => Promise<void>;
	} = $props();

	let rows = $state<QueryResultRow[]>([]);

	// Same right-click menu as the other views: a card here is a record in
	// a view too, and a collection browsed as a board still needs its
	// membership severable.
	let ctxMenu = $state<{ x: number; y: number; id: string } | null>(null);

	const rel = $derived(relations.find((r) => r.key === groupKey));

	async function load() {
		const s = (sorts.length > 0 ? sorts : [{ key: "updatedAt", type: "desc" }]).map((x) => ({ ...x, emptyPlacement: "end" }));
		const res = await fetchQuery({ ...body, sorts: s });
		rows = res.records;
	}

	$effect(() => {
		void JSON.stringify(body);
		void object.updatedAt;
		void load();
	});

	interface Column {
		id: string; // option text, "true"/"false" for checkbox, "" for none
		name: string;
		color: string;
	}

	const columns = $derived.by((): Column[] => {
		if (!rel) return [];
		if (rel.format === "checkbox") {
			return [
				{ id: "false", name: "Not done", color: "" },
				{ id: "true", name: "Done", color: "" },
			];
		}
		const opts = rel.options.map((o) => ({ id: o.text, name: o.text, color: o.color ?? "" }));
		return [...opts, { id: "", name: `No ${rel.name || rel.key}`, color: "" }];
	});

	function valuesOf(r: QueryResultRow): string[] {
		const v = r.fields[groupKey];
		if (!v) return [];
		if (rel?.format === "checkbox") return [v.boolValue === true ? "true" : "false"];
		if (v.stringValue !== undefined) return v.stringValue ? [v.stringValue] : [];
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").filter(Boolean);
		return [];
	}

	function cardsFor(col: Column): QueryResultRow[] {
		return rows.filter((r) => {
			const vals = valuesOf(r);
			if (rel?.format === "checkbox") return vals[0] === col.id || (col.id === "false" && vals.length === 0);
			return col.id === "" ? vals.length === 0 : vals.includes(col.id);
		});
	}

	// ── Drag between columns (rewrites the group value) ───────────
	let dragging = $state<{ id: string; from: string } | null>(null);
	let dropCol = $state("");

	async function dropOn(col: Column) {
		const d = dragging;
		dragging = null;
		dropCol = "";
		if (!d || d.from === col.id || !rel) return;
		const row = rows.find((r) => r.id === d.id);
		if (!row) return;
		if (rel.format === "checkbox") {
			await note.setField(d.id, groupKey, { boolValue: col.id === "true" });
		} else if (rel.format === "status") {
			if (col.id === "") await note.deleteField(d.id, groupKey);
			else await note.setField(d.id, groupKey, { valuesValue: { items: [{ stringValue: col.id }] } });
		} else {
			// multi-select: leave other memberships intact (Anytype board semantics)
			const vals = valuesOf(row).filter((v) => v !== d.from);
			if (col.id !== "" && !vals.includes(col.id)) vals.push(col.id);
			if (vals.length === 0) await note.deleteField(d.id, groupKey);
			else await note.setField(d.id, groupKey, { valuesValue: { items: vals.map((v) => ({ stringValue: v })) } });
		}
		await load();
		await onchanged();
	}
</script>

{#if !rel}
	<p class="muted">Pick a property to group by (a status, tag, or checkbox).</p>
{:else}
	<div class="board">
		{#each columns as col (col.id)}
			{@const cards = cardsFor(col)}
			<div
				class="col"
				class:over={dropCol === col.id && !!dragging}
				role="list"
				ondragover={(e) => {
					e.preventDefault();
					dropCol = col.id;
				}}
				ondragleave={() => (dropCol = "")}
				ondrop={(e) => {
					e.preventDefault();
					void dropOn(col);
				}}
			>
				<div class="col-head">
					<span class="col-name" style={col.color ? `color:${col.color}` : ""}>{col.name}</span>
					<span class="count">{cards.length}</span>
				</div>
				{#each cards as r (r.id)}
					<div
						class="card"
						role="button"
						draggable="true"
						ondragstart={() => (dragging = { id: r.id, from: col.id })}
						ondragend={() => {
							dragging = null;
							dropCol = "";
						}}
						onclick={() => void goto(`/object/${r.id}`)}
						oncontextmenu={(e) => {
							e.preventDefault();
							ctxMenu = { x: e.clientX, y: e.clientY, id: r.id };
						}}
						onkeydown={(e) => {
							if (e.key === "Enter") void goto(`/object/${r.id}`);
						}}
						tabindex="0"
					>
						<span class="c-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
						<span class="c-name">{r.fields["name"]?.stringValue || "Untitled"}</span>
					</div>
				{/each}
				{#if cards.length === 0}
					<div class="empty">—</div>
				{/if}
			</div>
		{/each}
	</div>
{/if}

{#if ctxMenu}
	<RowContextMenu
		x={ctxMenu.x}
		y={ctxMenu.y}
		ids={[ctxMenu.id]}
		{onremove}
		onchanged={load}
		onclose={() => (ctxMenu = null)}
	/>
{/if}

<style>
	.board {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		overflow-x: auto;
		padding: 4px 0 16px;
	}
	.col {
		flex: 0 0 220px;
		background: var(--hl-light);
		border-radius: 12px;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-height: 80px;
	}
	.col.over {
		outline: 1px solid var(--accent);
	}
	.col-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px 4px;
	}
	.col-name {
		font-size: 12px;
		font-weight: 600;
	}
	.count {
		color: var(--muted);
		font-size: 11px;
	}
	.card {
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 8px 10px;
		font-size: 13px;
		cursor: grab;
	}
	.card:hover {
		border-color: var(--accent);
	}
	.c-icon {
		flex: none;
	}
	.c-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.empty {
		color: var(--muted);
		text-align: center;
		font-size: 12px;
		padding: 6px;
	}
	.muted {
		color: var(--muted);
		font-size: 13px;
	}
</style>
