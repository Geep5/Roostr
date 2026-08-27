<script lang="ts">
	/**
	 * Anytype's relation block (BlockType.Relation): a property rendered
	 * inline in the document as "Name  value". The block only carries the
	 * relation key (meta.key); the value lives in the object's fields, so
	 * the block and the featured row always agree.
	 */
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { note } from "$lib/api";
	import { store } from "$lib/data.svelte";

	let {
		block,
		object,
		onrefresh,
	}: {
		block: { content: { custom?: { meta?: Record<string, string> } } };
		object: ObjectJSON;
		onrefresh: () => void | Promise<void>;
	} = $props();

	const key = $derived(block.content.custom?.meta?.["key"] ?? "");
	const rel = $derived(store.relations.find((r) => r.key === key));
	const v = $derived(object.fields[key]);

	function plain(val: ValueJSON | undefined, format: string): string | number | boolean | string[] {
		if (!val) return format === "checkbox" ? false : format === "tag" ? [] : "";
		if (val.stringValue !== undefined) return val.stringValue;
		if (val.intValue !== undefined) return val.intValue;
		if (val.floatValue !== undefined) return val.floatValue;
		if (val.boolValue !== undefined) return val.boolValue;
		if (val.valuesValue) return val.valuesValue.items.map((i) => i.stringValue ?? "");
		if (val.listValue) return val.listValue.values;
		return "";
	}

	async function save(format: string, raw: string | number | boolean | string[]) {
		let value: ValueJSON;
		if (format === "checkbox") value = { boolValue: raw === true };
		else if (format === "number") value = Number.isInteger(Number(raw)) ? { intValue: Number(raw) } : { floatValue: Number(raw) };
		else if (format === "date") value = { intValue: typeof raw === "string" ? new Date(raw).getTime() : Number(raw) };
		else if (format === "tag") value = { valuesValue: { items: (raw as string[]).map((s) => ({ stringValue: s })) } };
		else value = { stringValue: String(raw) };
		await note.setField(object.id, key, value);
		await onrefresh();
	}

	function dateInput(val: ValueJSON | undefined): string {
		const ms = val?.intValue ?? val?.floatValue;
		if (!ms) return "";
		return new Date(ms).toISOString().slice(0, 10);
	}

	async function toggleTag(tag: string) {
		if (!rel) return;
		const cur = plain(v, "tag") as string[];
		const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag];
		await save("tag", next);
	}
</script>

{#if rel}
	<div class="relation">
		<span class="rel-name" title={rel.format}>{rel.name || rel.key}</span>
		{#if rel.format === "checkbox"}
			<input type="checkbox" checked={plain(v, "checkbox") === true} onchange={(e) => void save("checkbox", e.currentTarget.checked)} />
		{:else if rel.format === "number"}
			<input type="number" value={plain(v, "number")} placeholder="Empty" onchange={(e) => void save("number", e.currentTarget.value)} />
		{:else if rel.format === "date"}
			<input type="date" value={dateInput(v)} onchange={(e) => void save("date", e.currentTarget.value)} />
		{:else if rel.format === "status"}
			<select value={plain(v, "status")} onchange={(e) => void save("status", e.currentTarget.value)}>
				<option value=""></option>
				{#each rel.options as o (o.id)}
					<option value={o.text}>{o.text}</option>
				{/each}
			</select>
		{:else if rel.format === "tag"}
			<div class="tags">
				{#each plain(v, "tag") as string[] as t (t)}
					<button class="tag on" onclick={() => void toggleTag(t)}>{t} ×</button>
				{/each}
				{#each rel.options.filter((o) => !(plain(v, "tag") as string[]).includes(o.text)) as o (o.id)}
					<button class="tag" style="border-color:{o.color}" onclick={() => void toggleTag(o.text)}>{o.text}</button>
				{/each}
			</div>
		{:else}
			<input type="text" value={plain(v, rel.format)} placeholder="Empty" onchange={(e) => void save(rel.format, e.currentTarget.value)} />
		{/if}
	</div>
{:else}
	<div class="relation missing">Unknown property "{key}"</div>
{/if}

<style>
	.relation {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 3px 0;
		font-size: 14px;
	}
	.rel-name {
		flex: 0 0 140px;
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.relation input[type="text"],
	.relation input[type="number"],
	.relation input[type="date"],
	.relation select {
		background: none;
		border: none;
		color: inherit;
		font-size: 14px;
		padding: 2px 4px;
		border-radius: 6px;
		min-width: 0;
		flex: 1;
	}
	.relation input:hover,
	.relation input:focus,
	.relation select:hover {
		background: var(--hover);
		outline: none;
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.tag {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.tag.on {
		background: var(--hover);
		border-color: var(--accent);
	}
	.missing {
		color: var(--muted);
		font-style: italic;
	}
</style>
