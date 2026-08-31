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
	import { store } from "$lib/data.svelte";
	import { RESERVED_KEYS, emptyValueFor } from "$lib/relations";
	import PropertyValue from "./PropertyValue.svelte";
	import { tagStyle } from "$lib/options";
	import { fetchBacklinks, type Backlink } from "$lib/backlinks";

	let {
		object,
		relations,
		onchanged,
	}: { object: ObjectJSON; relations: RelationDefJSON[]; onchanged: () => Promise<void> } = $props();

	const featuredKeys = $derived.by(() => {
		const items = object.fields["featuredRelations"]?.valuesValue?.items ?? [];
		return items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
	});

	/** Present, editable properties: featured order first, then the rest. */
	const shown = $derived.by(() => {
		const present = relations.filter((r) => !r.hidden && !RESERVED_KEYS[r.key] && r.key in object.fields);
		const rank = new Map(featuredKeys.map((k, i) => [k, i]));
		return present.toSorted((a, b) => (rank.get(a.key) ?? 999) - (rank.get(b.key) ?? 999));
	});

	// ── Anytype's leading featured cells: object type + backlinks count ──
	const typeDef = $derived(store.types.find((t) => t.key === object.typeKey));
	const typeName = $derived(typeDef?.name || object.typeKey);

	let backlinks = $state<Backlink[]>([]);
	let showBacklinks = $state(false);
	$effect(() => {
		const id = object.id;
		showBacklinks = false;
		void fetchBacklinks(id).then((b) => {
			if (object.id === id) backlinks = b;
		});
	});

	let editing = $state<string | null>(null);

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
	// ── New property (Anytype "create from scratch") ──────────────

	async function removeProp(key: string) {
		editing = null;
		await note.deleteField(object.id, key);
		await onchanged();
	}

	function closeAll() {
		editing = null;
	}
</script>

{#if shown.length > 0 || typeName}
	<div class="featured">
		<span class="cell-wrap">
			<button
				class="cell type-cell"
				title="Type"
				onclick={() => { if (typeDef) location.href = `/object/${typeDef.id}`; }}
			>{typeName}</button>
			<span class="bullet">•</span>
		</span>
		{#if backlinks.length > 0}
			<span class="cell-wrap">
				<button class="cell" title="Backlinks" onclick={() => { editing = null; showBacklinks = !showBacklinks; }}>
					{backlinks.length} backlink{backlinks.length === 1 ? "" : "s"}
				</button>
				<span class="bullet">•</span>
				{#if showBacklinks}
					<div class="pop">
						<div class="pop-head"><span class="pop-name">Linked from</span></div>
						{#each backlinks as b (b.id)}
							<a class="backlink" href="/object/{b.id}" onclick={() => (showBacklinks = false)}>
								<span class="bl-icon">{b.icon || "▨"}</span>{b.name}
								<span class="bl-kind">{b.typeKey}</span>
							</a>
						{/each}
					</div>
				{/if}
			</span>
		{/if}
		{#each shown as rel, i (rel.key)}
			{@const v = object.fields[rel.key]}
			<span class="cell-wrap">
				<button
					class="cell"
					class:empty={display(rel) === ""}
					title={rel.name || rel.key}
					onclick={() => {
						editing = editing === rel.key ? null : rel.key;
					}}
				>
					{#if rel.format === "tag" && (plain(v, "tag") as string[]).length > 0}
						{#each plain(v, "tag") as string[] as t (t)}
							{@const opt = rel.options.find((o) => o.text === t)}
							<span class="tag" style={tagStyle(opt?.color ?? "")}>{t}</span>
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
							{#if rel.key !== "done"}
								<button class="pop-rm" title="Remove property" onclick={() => void removeProp(rel.key)}>Remove</button>
							{/if}
						</div>
						<PropertyValue {rel} value={v} onsave={(nv) => void saveValue(rel.key, nv)} />
					</div>
				{/if}
			</span>
		{/each}
	</div>
	{#if editing}
		<button class="backdrop" aria-label="Close" onclick={closeAll}></button>
	{/if}
{/if}

<style>
	.type-cell {
		color: var(--muted);
	}
	.backlink {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 6px;
		color: var(--fg);
		text-decoration: none;
		font-size: 13px;
	}
	.backlink:hover {
		background: var(--hover);
	}
	.bl-icon {
		flex: none;
		width: 18px;
		text-align: center;
	}
	.bl-kind {
		margin-left: auto;
		color: var(--muted);
		font-size: 11px;
	}
	.featured {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
		margin: 2px 0 14px 48px;
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
	.bullet {
		color: var(--border);
		font-size: 10px;
	}
	/* Anytype tagItem.isSmall: filled pill, pale text, no border. */
	.tag {
		display: inline-block;
		border-radius: 10px;
		padding: 0 6px;
		font-size: 12px;
		line-height: 20px;
		height: 20px;
		margin-right: 3px;
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
		color: var(--red);
	}
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: none;
		border: none;
		cursor: default;
	}
	@media (max-width: 720px) {
		.featured {
			margin: 0 16px 10px;
		}
	}
</style>
