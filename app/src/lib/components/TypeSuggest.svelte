<script lang="ts">
	/**
	 * Anytype's typeSuggest menu (lib/util/menu.ts typeSuggest): a filter box
	 * over the space's type objects. Typing narrows by name/key — prefix
	 * matches rank first, then substring. ↑↓/Enter/Escape navigate.
	 */
	import { store } from "$lib/data.svelte";
	import { typeGlyph } from "$lib/create";

	let {
		exclude = [],
		placeholder = "Filter types…",
		onpick,
		onclose,
	}: {
		exclude?: string[];
		placeholder?: string;
		onpick: (key: string) => void;
		onclose?: () => void;
	} = $props();

	let query = $state("");
	let selected = $state(0);
	let inputEl = $state<HTMLInputElement>();

	$effect(() => {
		inputEl?.focus();
	});

	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const pool = store.types.filter((t) => !exclude.includes(t.key));
		if (!q) return pool;
		const starts = pool.filter((t) => t.name.toLowerCase().startsWith(q) || t.key.startsWith(q));
		const contains = pool.filter(
			(t) => !starts.includes(t) && (t.name.toLowerCase().includes(q) || t.key.includes(q)),
		);
		return [...starts, ...contains];
	});

	$effect(() => {
		void matches;
		selected = 0;
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selected = Math.min(selected + 1, matches.length - 1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (matches[selected]) pick(matches[selected].key);
		} else if (e.key === "Escape") {
			e.preventDefault();
			onclose?.();
		}
	}

	function pick(key: string) {
		query = "";
		onpick(key);
	}
</script>

<div class="suggest">
	<input bind:this={inputEl} bind:value={query} {placeholder} onkeydown={onKeydown} />
	<div class="options">
		{#each matches as t, i (t.id)}
			<button class="option" class:selected={i === selected} onmouseenter={() => (selected = i)} onclick={() => pick(t.key)}>
				<span class="t-icon">{t.icon || typeGlyph(t.key)}</span>
				<span class="t-name">{t.name || t.key}</span>
				<span class="t-key">{t.key}</span>
			</button>
		{/each}
		{#if matches.length === 0}
			<span class="none">No matching types.</span>
		{/if}
	</div>
</div>

<style>
	.suggest {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 240px;
	}
	input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 13px;
		padding: 6px 10px;
		outline: none;
	}
	input:focus {
		border-color: var(--accent);
	}
	.options {
		display: flex;
		flex-direction: column;
		max-height: 240px;
		overflow-y: auto;
	}
	.option {
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		color: var(--fg);
		font-size: 13px;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
	}
	.option.selected {
		background: var(--hl-med);
	}
	.t-icon {
		width: 20px;
		text-align: center;
		flex: none;
	}
	.t-name {
		flex: 1;
	}
	.t-key {
		color: var(--muted);
		font-size: 11px;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 6px 8px;
	}
</style>
