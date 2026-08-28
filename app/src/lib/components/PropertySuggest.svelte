<script lang="ts">
	/**
	 * Anytype's relationSuggest menu (menu/relation/suggest.tsx): one
	 * search-or-create surface. Filter over existing properties; when the
	 * query matches no existing name, the top item becomes
	 * `Create property "<query>"` which reveals a format picker.
	 */
	import { store } from "$lib/data.svelte";
	import { CREATABLE_FORMATS, RESERVED_KEYS, createRelation } from "$lib/relations";
	import type { RelationDefJSON } from "$lib/types";

	let {
		x,
		y,
		exclude = [],
		extras = [],
		onpick,
		onextra,
		onclose,
	}: {
		x: number;
		y: number;
		/** Relation keys to hide (already present as columns/props). */
		exclude?: string[];
		/** Non-relation options (system columns like Type/Created). */
		extras?: Array<{ key: string; name: string }>;
		onpick: (rel: RelationDefJSON) => void;
		onextra?: (key: string) => void;
		onclose: () => void;
	} = $props();

	let query = $state("");
	let creating = $state(false);
	let createFormat = $state<string>("shorttext");
	let inputEl = $state<HTMLInputElement>();
	let menuEl = $state<HTMLElement>();

	$effect(() => {
		inputEl?.focus();
	});

	const all = $derived(store.relations.filter((r) => !r.hidden && !RESERVED_KEYS[r.key] && !exclude.includes(r.key)));
	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) return all;
		return all.filter((r) => (r.name || r.key).toLowerCase().includes(q));
	});
	const filteredExtras = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const pool = extras.filter((e) => !exclude.includes(e.key));
		if (!q) return pool;
		return pool.filter((e) => e.name.toLowerCase().includes(q));
	});
	const exactMatch = $derived(all.some((r) => (r.name || r.key).toLowerCase() === query.trim().toLowerCase()));
	const canCreate = $derived(query.trim() !== "" && !exactMatch);

	async function create() {
		const rel = await createRelation(query.trim(), createFormat);
		if (rel) onpick(rel);
	}

	const pos = $derived.by(() => {
		const w = 280;
		const h = 320;
		return {
			left: Math.min(x, window.innerWidth - w - 12),
			top: y + h > window.innerHeight - 12 ? Math.max(12, y - h - 28) : y,
		};
	});

	function onWindowPointerDown(e: PointerEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window
	onpointerdown={onWindowPointerDown}
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
/>

<div class="suggest" bind:this={menuEl} style="left: {pos.left}px; top: {pos.top}px" role="dialog" aria-label="Add property">
	<input
		bind:this={inputEl}
		bind:value={query}
		placeholder="Filter or create a property…"
		onkeydown={(e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				if (filtered.length > 0 && !creating) onpick(filtered[0]);
				else if (canCreate) void create();
			}
		}}
	/>
	{#if canCreate}
		{#if !creating}
			<button class="item create" onclick={() => (creating = true)}>＋ Create property “{query.trim()}”</button>
		{:else}
			<div class="create-form">
				<select bind:value={createFormat}>
					{#each CREATABLE_FORMATS as f (f)}
						<option value={f}>{f}</option>
					{/each}
				</select>
				<button onclick={() => void create()}>Create</button>
			</div>
		{/if}
	{/if}
	{#if filteredExtras.length > 0}
		<div class="section">System</div>
		<div class="list">
			{#each filteredExtras as e (e.key)}
				<button class="item" onclick={() => onextra?.(e.key)}>
					<span>{e.name}</span>
				</button>
			{/each}
		</div>
	{/if}
	{#if filtered.length > 0}
		<div class="section">My properties</div>
		<div class="list">
			{#each filtered as rel (rel.key)}
				<button class="item" onclick={() => onpick(rel)}>
					<span>{rel.name || rel.key}</span>
					<span class="fmt">{rel.format}</span>
				</button>
			{/each}
		</div>
	{:else if !canCreate && filteredExtras.length === 0}
		<span class="none">No properties yet — type a name to create one.</span>
	{/if}
</div>

<style>
	.suggest {
		position: fixed;
		z-index: 120;
		width: 280px;
		max-height: 340px;
		display: flex;
		flex-direction: column;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		gap: 4px;
	}
	input,
	select {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: inherit;
		padding: 6px 8px;
		font-size: 13px;
	}
	.section {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 6px 6px 2px;
	}
	.list {
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}
	.item {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		border: none;
		background: none;
		color: inherit;
		text-align: left;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.item:hover {
		background: var(--hover);
	}
	.item.create {
		color: var(--accent);
	}
	.fmt {
		color: var(--muted);
		font-size: 11px;
	}
	.create-form {
		display: flex;
		gap: 6px;
	}
	.create-form select {
		flex: 1;
	}
	.create-form button {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
	}
	.create-form button:hover {
		border-color: var(--accent);
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 6px;
	}
</style>
