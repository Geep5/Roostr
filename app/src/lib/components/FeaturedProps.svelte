<script lang="ts">
	/**
	 * Anytype's featured-relations row (block/featured.tsx): properties render
	 * inline under the title as bullet-separated cells, not in a panel. Each
	 * cell shows the value (name as tooltip), click-to-edit in a popover.
	 * Order: the object's `featuredRelations` key list first, then the rest
	 * of the set fields. "+" appends a new property.
	 */
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { note } from "$lib/api";
	import { store, refreshAll } from "$lib/data.svelte";
	import PropertyValue from "./PropertyValue.svelte";

	let {
		object,
		relations,
		onchanged,
	}: { object: ObjectJSON; relations: RelationDefJSON[]; onchanged: () => Promise<void> } = $props();

	const RESERVED: Record<string, true> = {
		name: true,
		iconEmoji: true,
		iconImage: true,
		setOf: true,
		featuredRelations: true,
		collectionIds: true,
		viewFilters: true,
		viewSorts: true,
		viewRelations: true,
		channel: true,
		pinnedIds: true,
		members: true,
		keyId: true,
	};

	const featuredKeys = $derived.by(() => {
		const items = object.fields["featuredRelations"]?.valuesValue?.items ?? [];
		return items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
	});

	/** Present, editable properties: featured order first, then the rest. */
	const shown = $derived.by(() => {
		const present = relations.filter((r) => !r.hidden && !RESERVED[r.key] && r.key in object.fields);
		const rank = new Map(featuredKeys.map((k, i) => [k, i]));
		return present.toSorted((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
	});
	const addable = $derived(relations.filter((r) => !r.hidden && !RESERVED[r.key] && !(r.key in object.fields)));

	let editing = $state<string | null>(null);
	let adding = $state(false);

	function plain(v: ValueJSON | undefined, format: string): string | number | boolean | string[] {
		if (!v) return format === "checkbox" ? false : format === "tag" ? [] : "";
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.intValue !== undefined) return v.intValue;
		if (v.floatValue !== undefined) return v.floatValue;
		if (v.boolValue !== undefined) return v.boolValue;
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "");
		if (v.listValue) return v.listValue.values;
		return "";
	}

	/** Compact display string for a cell, Anytype-style. */
	function display(rel: RelationDefJSON): string {
		const v = object.fields[rel.key];
		const p = plain(v, rel.format);
		if (rel.format === "checkbox") return p === true ? "✓" : "✗";
		if (rel.format === "date") {
			const ms = v?.intValue ?? v?.floatValue;
			return ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
		}
		if (rel.format === "object") {
			const ids = p as string[];
			return ids.map((id) => store.summaries.find((s) => s.id === id)?.name || id.slice(0, 6)).join(", ");
		}
		if (Array.isArray(p)) return p.join(", ");
		if (rel.format === "longtext") return String(p).slice(0, 60);
		return String(p);
	}

	async function saveValue(key: string, value: ValueJSON) {
		await note.setField(object.id, key, value);
		await onchanged();
	}

	/** Initialize a property so it appears (empty per-format default). */
	async function addProp(rel: RelationDefJSON) {
		const empty: ValueJSON =
			rel.format === "checkbox" ? { boolValue: false }
			: rel.format === "tag" || rel.format === "object" ? { valuesValue: { items: [] } }
			: rel.format === "number" || rel.format === "date" ? { intValue: 0 }
			: { stringValue: "" };
		await saveValue(rel.key, empty);
		editing = rel.key;
	}

	// ── New property (Anytype "create from scratch") ──────────────
	const FORMATS = ["shorttext", "longtext", "number", "status", "tag", "date", "checkbox", "url", "email", "phone", "object"] as const;
	let creating = $state(false);
	let newName = $state("");
	let newFormat = $state<string>("shorttext");

	async function createProperty() {
		const name = newName.trim();
		if (!name) return;
		const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `prop_${Date.now()}`;
		if (relations.some((r) => r.key === key)) {
			creating = false;
			return;
		}
		await note.create(name, "relation", {
			key: { stringValue: key },
			name: { stringValue: name },
			format: { stringValue: newFormat },
			hidden: { boolValue: false },
			readOnly: { boolValue: false },
			maxCount: { intValue: newFormat === "status" ? 1 : 0 },
			options: { valuesValue: { items: [] } },
			bundled: { boolValue: false },
		});
		await refreshAll();
		creating = false;
		adding = false;
		const rel = store.relations.find((r) => r.key === key);
		if (rel) await addProp(rel);
		newName = "";
		newFormat = "shorttext";
	}

	async function removeProp(key: string) {
		editing = null;
		await note.deleteField(object.id, key);
		await onchanged();
	}

	function closeAll() {
		editing = null;
		adding = false;
	}
</script>

{#if shown.length > 0 || addable.length > 0}
	<div class="featured">
		{#each shown as rel, i (rel.key)}
			{@const v = object.fields[rel.key]}
			<span class="cell-wrap">
				<button
					class="cell"
					class:empty={display(rel) === ""}
					title={rel.name || rel.key}
					onclick={() => {
						adding = false;
						editing = editing === rel.key ? null : rel.key;
					}}
				>
					{#if rel.format === "tag" && (plain(v, "tag") as string[]).length > 0}
						{#each plain(v, "tag") as string[] as t (t)}
							{@const opt = rel.options.find((o) => o.text === t)}
							<span class="tag" style={opt?.color ? `border-color:${opt.color}` : ""}>{t}</span>
						{/each}
					{:else}
						{display(rel) || rel.name || rel.key}
					{/if}
				</button>
				{#if i < shown.length - 1}<span class="bullet">•</span>{/if}
				{#if editing === rel.key}
					<div class="pop">
						<div class="pop-head">
							<span class="pop-name">{rel.name || rel.key}</span>
							<button class="pop-rm" title="Remove property" onclick={() => void removeProp(rel.key)}>Remove</button>
						</div>
						<PropertyValue {rel} value={v} onsave={(nv) => void saveValue(rel.key, nv)} />
					</div>
				{/if}
			</span>
		{/each}
		{#if true}
			<span class="cell-wrap">
				<button
					class="cell add"
					title="Add property"
					onclick={() => {
						editing = null;
						adding = !adding;
					}}>+</button
				>
				{#if adding}
					<div class="pop">
						{#each addable as rel (rel.key)}
							<button
								class="add-item"
								onclick={() => {
									adding = false;
									void addProp(rel);
								}}>{rel.name || rel.key} <span class="fmt">{rel.format}</span></button
							>
						{/each}
						{#if !creating}
							<button class="add-item new" onclick={() => (creating = true)}>+ New property…</button>
						{:else}
							<form
								class="new-form"
								onsubmit={(e) => {
									e.preventDefault();
									void createProperty();
								}}
							>
								<input bind:value={newName} placeholder="Property name" />
								<select bind:value={newFormat}>
									{#each FORMATS as f (f)}
										<option value={f}>{f}</option>
									{/each}
								</select>
								<button type="submit">Create</button>
							</form>
						{/if}
					</div>
				{/if}
			</span>
		{/if}
	</div>
	{#if editing || adding}
		<button class="backdrop" aria-label="Close" onclick={closeAll}></button>
	{/if}
{/if}

<style>
	.featured {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
		margin: 2px 0 14px;
		font-size: 13px;
	}
	.cell-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.cell {
		border: none;
		background: none;
		color: var(--muted);
		padding: 2px 4px;
		border-radius: 6px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 13px;
	}
	.cell:hover {
		background: var(--hover);
		color: var(--fg, inherit);
	}
	.cell.empty {
		opacity: 0.6;
	}
	.cell.add {
		font-size: 14px;
		padding: 0 8px;
	}
	.bullet {
		color: var(--border);
		font-size: 10px;
	}
	.tag {
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 11px;
		background: none;
		color: inherit;
	}
	.pop {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 90;
		min-width: 220px;
		max-height: 300px;
		overflow-y: auto;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.pop-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	.pop-name {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
	}
	.pop-rm {
		border: none;
		background: none;
		color: var(--muted);
		font-size: 11px;
		cursor: pointer;
	}
	.pop-rm:hover {
		color: #e8524a;
	}
	.add-item {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		border: none;
		background: none;
		color: inherit;
		padding: 5px 6px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
		text-align: left;
	}
	.add-item:hover {
		background: var(--hover);
	}
	.fmt {
		color: var(--muted);
		font-size: 11px;
	}
	.add-item.new {
		color: var(--accent);
	}
	.new-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.new-form input,
	.new-form select {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: inherit;
		padding: 5px 8px;
		font-size: 13px;
	}
	.new-form button {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 6px;
		padding: 5px 8px;
		cursor: pointer;
	}
	.new-form button:hover {
		border-color: var(--accent);
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
