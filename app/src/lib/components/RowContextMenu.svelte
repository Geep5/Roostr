<script lang="ts">
	/**
	 * Right-click menu for a record in a set/collection view: open it,
	 * sever its collection membership, or bin it.
	 *
	 * Shared by every view that lists records — table, gallery, kanban —
	 * because the menu is a property of "a record in a view", not of the
	 * table that first grew one. Removing is offered only when the host
	 * passes `onremove`, i.e. only inside a collection, since a query has
	 * no membership to sever.
	 */
	import { note } from "$lib/api";

	let {
		x,
		y,
		ids,
		onremove,
		onchanged,
		onclose,
	}: {
		x: number;
		y: number;
		/** The records this menu acts on — the selection when the click landed inside it. */
		ids: string[];
		/** Collections only: drop these from the collection, never touch the objects. */
		onremove?: (ids: string[]) => Promise<void>;
		onchanged: () => Promise<void>;
		onclose: () => void;
	} = $props();

	const n = $derived(ids.length);
	const suffix = $derived(n > 1 ? ` (${n})` : "");

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
	style="left: {Math.min(x, window.innerWidth - 210)}px; top: {Math.min(y, window.innerHeight - 130)}px"
	role="menu"
>
	<button
		role="menuitem"
		onclick={() => {
			const id = ids[0];
			onclose();
			location.href = `/object/${id}`;
		}}>Open</button
	>
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
</style>
