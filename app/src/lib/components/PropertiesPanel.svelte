<script lang="ts">
	import type { ObjectJSON, RelationDefJSON, ValueJSON } from "$lib/types";
	import { note } from "$lib/api";

	let {
		object,
		relations,
		onchanged,
	}: { object: ObjectJSON; relations: RelationDefJSON[]; onchanged: () => Promise<void> } = $props();

	const RESERVED: Record<string, true> = { name: true, setOf: true, featuredRelations: true };

	const shown = $derived(
		relations.filter((r) => !r.hidden && !RESERVED[r.key] && r.key in object.fields),
	);
	const addable = $derived(
		relations.filter((r) => !r.hidden && !RESERVED[r.key] && !(r.key in object.fields)),
	);

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
</script>

<aside class="props">
	<h3>Properties</h3>
	{#each shown as rel (rel.key)}
		{@const v = object.fields[rel.key]}
		<div class="prop">
			<span class="key" title={rel.format}>{rel.name || rel.key}</span>
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
				<div class="tags">
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
	{/each}

	{#if adding}
		<div class="add-list">
			{#each addable as rel (rel.key)}
				<button
					onclick={() => {
						adding = false;
						void save(rel.key, rel.format, rel.format === "checkbox" ? false : rel.format === "tag" ? [] : "");
					}}>{rel.name || rel.key} <span class="fmt">{rel.format}</span></button
				>
			{/each}
		</div>
	{:else if addable.length > 0}
		<button class="add" onclick={() => (adding = true)}>+ Add property</button>
	{/if}
</aside>

<style>
	.props {
		border-top: 1px solid var(--border);
		margin-top: 20px;
		padding-top: 12px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin: 0 0 10px;
	}
	.prop {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 3px 0;
		font-size: 13px;
	}
	.key {
		width: 130px;
		flex: none;
		color: var(--muted);
	}
	input[type="text"],
	input[type="number"],
	input[type="date"],
	select {
		background: var(--panel);
		border: 1px solid transparent;
		color: var(--fg);
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 13px;
		width: 220px;
	}
	input:focus,
	select:focus {
		border-color: var(--accent);
		outline: none;
	}
	.tags {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}
	.tag {
		border: 1px solid var(--border);
		background: none;
		color: var(--fg);
		border-radius: 999px;
		padding: 2px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	.tag.on {
		background: var(--accent);
		border-color: var(--accent);
		color: #fff;
	}
	.add,
	.add-list button {
		border: none;
		background: none;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
		padding: 4px 0;
		text-align: left;
	}
	.add:hover,
	.add-list button:hover {
		color: var(--fg);
	}
	.add-list {
		display: flex;
		flex-direction: column;
	}
	.fmt {
		color: var(--muted);
		font-size: 11px;
	}
</style>
