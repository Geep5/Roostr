<script lang="ts">
	/**
	 * Right-click menu for a record in a set/collection view: open it,
	 * retype it, add it to a collection, sever its collection membership,
	 * or bin it. Bulk by construction: a click inside the selection acts
	 * on the whole selection.
	 *
	 * Shared by every view that lists records — table, gallery, kanban —
	 * because the menu is a property of "a record in a view", not of the
	 * table that first grew one. Removing is offered only when the host
	 * passes `onremove`, i.e. only inside a collection, since a query has
	 * no membership to sever.
	 */
	import { note, fetchObject } from "$lib/api";
	import { tabs } from "$lib/tabs.svelte";
	import { store } from "$lib/data.svelte";
	import { objectIcon } from "$lib/icons";
	import { typeGlyph } from "$lib/create";

	let {
		x,
		y,
		ids,
		spaceId = "",
		onremove,
		onchanged,
		onclose,
	}: {
		x: number;
		y: number;
		/** The records this menu acts on — the selection when the click landed inside it. */
		ids: string[];
		/** Scopes the type / collection submenus to the view's space. */
		spaceId?: string;
		/** Collections only: drop these from the collection, never touch the objects. */
		onremove?: (ids: string[]) => Promise<void>;
		onchanged: () => Promise<void>;
		onclose: () => void;
	} = $props();

	const n = $derived(ids.length);
	const suffix = $derived(n > 1 ? ` (${n})` : "");

	let showTypes = $state(false);
	let showCols = $state(false);

	/** Space types plus bundled ones — the same set every type picker offers. */
	const types = $derived(store.types.filter((t) => !t.space || t.space === spaceId));
	const collections = $derived(
		store.summaries.filter((s) => s.typeKey === "collection" && s.channelId === spaceId && !ids.includes(s.id)),
	);

	/** Snapshot before closing: `ids` is a live prop, and closing clears
	 * the host's selection, so reading it afterwards yields nothing. */
	async function remove() {
		const targets = [...ids];
		onclose();
		await onremove?.(targets);
	}

	async function bin() {
		const targets = [...ids];
		onclose();
		for (const id of targets) await note.del(id);
		await onchanged();
	}

	/** Retype in place — blocks and fields survive, same as the object page. */
	async function retype(typeKey: string) {
		const targets = [...ids];
		onclose();
		for (const id of targets) await note.setType(id, typeKey);
		await onchanged();
	}

	async function addTo(collectionId: string) {
		const targets = [...ids];
		onclose();
		const col = await fetchObject(collectionId);
		const items = col.fields["collectionIds"]?.valuesValue?.items ?? [];
		const have = items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
		const merged = [...have, ...targets.filter((id) => !have.includes(id))];
		if (merged.length !== have.length) {
			await note.setField(collectionId, "collectionIds", {
				valuesValue: { items: merged.map((id) => ({ stringValue: id })) },
			});
		}
		await onchanged();
	}
</script>

<button
	class="ctx-backdrop"
	aria-label="Close menu"
	onclick={onclose}
	oncontextmenu={(e) => {
		e.preventDefault();
		onclose();
	}}
></button>
<div
	class="ctx-menu"
	style="left: {Math.min(x, window.innerWidth - 230)}px; top: {Math.min(y, window.innerHeight - 320)}px"
	role="menu"
>
	<button
		role="menuitem"
		onclick={() => {
			const targets = [...ids];
			onclose();
			// One object opens in place; a multi-selection opens Anytype-style:
			// each object becomes an in-app tab in the strip.
			if (targets.length === 1) {
				location.href = `/object/${targets[0]}`;
				return;
			}
			for (const id of targets) tabs.open(`/object/${id}`);
		}}>Open{suffix}</button
	>
	<button
		role="menuitem"
		onclick={() => {
			const targets = [...ids];
			onclose();
			for (const id of targets) tabs.open(`/object/${id}`);
		}}>Open in new tab{suffix}</button
	>
	<button role="menuitem" onclick={() => { showTypes = !showTypes; showCols = false; }}>⇄ Change type{suffix} ▸</button>
	{#if showTypes}
		<div class="ctx-sub">
			{#each types as t (t.id)}
				<button role="menuitem" onclick={() => void retype(t.key)}>{t.icon || typeGlyph(t.key)} {t.name || t.key}</button>
			{/each}
		</div>
	{/if}
	<button role="menuitem" onclick={() => { showCols = !showCols; showTypes = false; }}>▣ Add to collection{suffix} ▸</button>
	{#if showCols}
		<div class="ctx-sub">
			{#each collections as c (c.id)}
				<button role="menuitem" onclick={() => void addTo(c.id)}>{objectIcon(c.icon, c.typeKey)} {c.name || "Untitled"}</button>
			{/each}
			{#if collections.length === 0}
				<span class="ctx-none">No collections in this space</span>
			{/if}
		</div>
	{/if}
	{#if onremove}
		<button role="menuitem" onclick={() => void remove()}>⊖ Remove from collection{suffix}</button>
	{/if}
	<div class="ctx-sep"></div>
	<button role="menuitem" class="danger" onclick={() => void bin()}>🗑 Move to bin{suffix}</button>
</div>

<style>
	.ctx-backdrop {
		position: fixed;
		inset: 0;
		z-index: 90;
		background: none;
		border: none;
		cursor: default;
	}
	.ctx-menu {
		position: fixed;
		z-index: 91;
		min-width: 190px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 4px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		display: flex;
		flex-direction: column;
	}
	.ctx-menu button {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		color: var(--fg);
		font-size: 13px;
		padding: 7px 10px;
		border-radius: 6px;
		cursor: pointer;
	}
	.ctx-menu button:hover {
		background: var(--hover);
	}
	.ctx-menu .danger {
		color: var(--red);
	}
	.ctx-sep {
		height: 1px;
		background: var(--border);
		margin: 4px 6px;
	}
	.ctx-sub {
		display: flex;
		flex-direction: column;
		max-height: 220px;
		overflow-y: auto;
		margin: 0 0 2px;
		padding: 2px 0 2px 10px;
		border-left: 1px solid var(--border);
	}
	.ctx-none {
		color: var(--muted);
		font-size: 12px;
		padding: 4px 8px;
	}
</style>
