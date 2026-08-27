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

	let {
		object,
		relations,
		onchanged,
	}: { object: ObjectJSON; relations: RelationDefJSON[]; onchanged: () => Promise<void> } = $props();

	const RESERVED: Record<string, true> = {
		name: true,
		iconEmoji: true,
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
			return ms ? new Date(ms).toLocaleDateString() : "";
		}
		if (Array.isArray(p)) return p.join(", ");
		return String(p);
	}

	async function save(key: string, format: string, raw: string | number | boolean | string[]) {
		let value: ValueJSON;
		if (format === "checkbox") value = { boolValue: raw === true };
		else if (format === "number") value = Number.isInteger(Number(raw)) ? { intValue: Number(raw) } : { floatValue: Number(raw) };
		else if (format === "date") value = { intValue: typeof raw === "string" ? new Date(raw).getTime() : Number(raw) };
		else if (format === "tag") value = { valuesValue: { items: (raw as string[]).map((s) => ({ stringValue: s })) } };
		else value = { stringValue: String(raw) };
		await note.setField(object.id, key, value);
		await onchanged();
	}

	async function removeProp(key: string) {
		editing = null;
		await note.deleteField(object.id, key);
		await onchanged();
	}

	function dateInput(v: ValueJSON | undefined): string {
		const ms = v?.intValue ?? v?.floatValue;
		if (!ms) return "";
		return new Date(ms).toISOString().slice(0, 10);
	}

	async function toggleTag(rel: RelationDefJSON, tag: string) {
		const cur = plain(object.fields[rel.key], "tag") as string[];
		const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
		await save(rel.key, "tag", next);
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
						{#if rel.format === "checkbox"}
							<input type="checkbox" checked={plain(v, "checkbox") === true} onchange={(e) => void save(rel.key, "checkbox", e.currentTarget.checked)} />
						{:else if rel.format === "number"}
							<input type="number" value={plain(v, "number")} onchange={(e) => void save(rel.key, "number", e.currentTarget.value)} />
						{:else if rel.format === "date"}
							<input type="date" value={dateInput(v)} onchange={(e) => void save(rel.key, "date", e.currentTarget.value)} />
						{:else if rel.format === "status"}
							<select value={plain(v, "status")} onchange={(e) => void save(rel.key, "status", e.currentTarget.value)}>
								<option value=""></option>
								{#each rel.options as o (o.id)}
									<option value={o.text}>{o.text}</option>
								{/each}
							</select>
						{:else if rel.format === "tag"}
							<div class="tag-list">
								{#each plain(v, "tag") as string[] as t (t)}
									<button class="tag on" onclick={() => void toggleTag(rel, t)}>{t} ×</button>
								{/each}
								{#each rel.options.filter((o) => !(plain(v, "tag") as string[]).includes(o.text)) as o (o.id)}
									<button class="tag" style="border-color:{o.color}" onclick={() => void toggleTag(rel, o.text)}>{o.text}</button>
								{/each}
							</div>
						{:else}
							<input type="text" value={plain(v, rel.format)} onchange={(e) => void save(rel.key, rel.format, e.currentTarget.value)} />
						{/if}
					</div>
				{/if}
			</span>
		{/each}
		{#if addable.length > 0}
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
									void save(rel.key, rel.format, rel.format === "checkbox" ? false : rel.format === "tag" ? [] : "");
								}}>{rel.name || rel.key} <span class="fmt">{rel.format}</span></button
							>
						{/each}
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
	.pop input[type="text"],
	.pop input[type="number"],
	.pop input[type="date"],
	.pop select {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: inherit;
		padding: 5px 8px;
		font-size: 13px;
	}
	.tag-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.tag-list .tag {
		cursor: pointer;
	}
	.tag-list .tag.on {
		background: var(--hover);
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
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: none;
		border: none;
		cursor: default;
	}
</style>
