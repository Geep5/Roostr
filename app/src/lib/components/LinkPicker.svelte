<script lang="ts">
	/**
	 * Anytype's searchObject menu for "Link to existing page": a search box
	 * over the space's objects; picking one creates the link block.
	 */
	import { store } from "$lib/data.svelte";
	import { objectIcon } from "$lib/icons";

	let {
		x,
		y,
		excludeId,
		onpick,
		onclose,
	}: {
		x: number;
		y: number;
		/** The object being edited - never link to itself. */
		excludeId: string;
		onpick: (targetId: string) => void;
		onclose: () => void;
	} = $props();

	let query = $state("");
	let inputEl: HTMLInputElement | undefined = $state();

	const HIDDEN = new Set(["type", "template", "relation", "agent", "pinned_fact", "milestone", "channel"]);
	const candidates = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return store.summaries
			.filter((s) => s.id !== excludeId && !HIDDEN.has(s.typeKey))
			.filter((s) => !q || (s.name || "Untitled").toLowerCase().includes(q))
			.slice(0, 8);
	});

	$effect(() => {
		inputEl?.focus();
	});
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
	onmousedown={(e) => {
		if (!(e.target as HTMLElement).closest(".link-picker")) onclose();
	}}
/>

<div class="link-picker" style="left:{x}px; top:{y}px" role="dialog" aria-label="Link to object">
	<input
		bind:this={inputEl}
		bind:value={query}
		placeholder="Search objects…"
		onkeydown={(e) => {
			if (e.key === "Enter" && candidates[0]) {
				e.preventDefault();
				onpick(candidates[0].id);
			}
		}}
	/>
	{#each candidates as c (c.id)}
		<button class="row" onclick={() => onpick(c.id)}>
			<span class="obj-icon">{objectIcon(c.icon, c.typeKey)}</span>
			<span class="name">{c.name || "Untitled"}</span>
			<span class="tk">{c.typeKey}</span>
		</button>
	{/each}
	{#if candidates.length === 0}
		<span class="none">No matching objects.</span>
	{/if}
</div>

<style>
	.link-picker {
		position: fixed;
		z-index: 120;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 280px;
		max-width: 340px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
	}
	input {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 13px;
		padding: 6px 10px;
		outline: none;
		margin-bottom: 4px;
	}
	input:focus {
		border-color: var(--accent);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		border-radius: 6px;
		padding: 5px 6px;
		cursor: pointer;
		color: var(--fg);
		font-size: 13px;
		text-align: left;
	}
	.row:hover {
		background: var(--hl-med);
	}
	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tk {
		color: var(--muted);
		font-size: 11px;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 4px 6px;
	}
</style>
