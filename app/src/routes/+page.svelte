<script lang="ts">
	import { activeSpace } from "$lib/space.svelte";
	import { objectIcon } from "$lib/icons";
	import { store, refreshAll, layoutOf } from "$lib/data.svelte";
	import { note } from "$lib/api";
	import CheckboxIcon from "$lib/components/CheckboxIcon.svelte";
	import RowContextMenu from "$lib/components/RowContextMenu.svelte";
	import { createTyped, creatableTypes, createCollection as libCreateCollection, createQuery as libCreateQuery } from "$lib/create";

	const defaultChannelId = $derived(store.channels[0]?.id ?? "");
	const channelId = $derived(activeSpace.id || defaultChannelId);

	/** Objects in the active channel (unassigned objects live in the default channel). */
	const objects = $derived(
		store.summaries.filter((o) => !["type", "template", "agent", "pinned_fact", "milestone"].includes(o.typeKey) && o.channelId === channelId),
	);

	let picking = $state(false);

	async function createObject(typeKey: string) {
		picking = false;
		await createTyped(typeKey, channelId);
	}

	/** Task-layout rows: the list checkbox toggles the bundled done relation. */
	async function toggleDone(e: MouseEvent, id: string, cur: boolean) {
		e.preventDefault();
		e.stopPropagation();
		await note.setField(id, "done", { boolValue: !cur });
		await refreshAll();
	}

	async function createCollection() {
		await libCreateCollection(channelId);
	}

	async function createQuery() {
		await libCreateQuery(channelId);
	}

	// ── Marquee multi-select + row context menu, matching the set tables:
	// press anywhere over the list (rows included - the 4px threshold
	// keeps clicks navigating) and rubber-band rows into the selection. ──
	let listEl = $state<HTMLElement>();
	let selected = $state<string[]>([]);
	let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
	let dragMoved = $state(false);
	let ctxMenu = $state<{ x: number; y: number; id: string } | null>(null);

	function onPageMouseDown(e: MouseEvent) {
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
		const t = e.target as HTMLElement;
		if (!listEl) return;
		const inList = listEl.contains(t);
		if (!inList) {
			const article = listEl.closest("article") ?? listEl.parentElement;
			if (!article || !article.contains(t)) return;
		}
		if (t.closest("button, input, textarea, select, [contenteditable]")) return;
		marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
		dragMoved = false;
	}

	function onMarqueeMove(e: MouseEvent) {
		if (!marquee) return;
		marquee = { ...marquee, x1: e.clientX, y1: e.clientY };
		if (Math.abs(marquee.x1 - marquee.x0) + Math.abs(marquee.y1 - marquee.y0) < 4) return;
		dragMoved = true;
		const left = Math.min(marquee.x0, marquee.x1);
		const right = Math.max(marquee.x0, marquee.x1);
		const top = Math.min(marquee.y0, marquee.y1);
		const bottom = Math.max(marquee.y0, marquee.y1);
		const hit: string[] = [];
		for (const li of listEl?.querySelectorAll<HTMLElement>("li[data-id]") ?? []) {
			const r = li.getBoundingClientRect();
			if (r.bottom >= top && r.top <= bottom && r.right >= left && r.left <= right) hit.push(li.dataset.id ?? "");
		}
		selected = hit;
	}

	function endMarquee() {
		if (marquee && !dragMoved && selected.length && !ctxMenu) selected = [];
		marquee = null;
	}

	function onRowClick(e: MouseEvent, _id: string) {
		// The click ending a drag, or a click while a selection exists,
		// must not navigate - same contract as the table rows.
		if (dragMoved || selected.length) {
			e.preventDefault();
			dragMoved = false;
		}
	}

	function onRowContext(e: MouseEvent, id: string) {
		e.preventDefault();
		ctxMenu = { x: e.clientX, y: e.clientY, id };
	}

	function ctxTargets(): string[] {
		if (!ctxMenu) return [];
		return selected.includes(ctxMenu.id) ? [...selected] : [ctxMenu.id];
	}
</script>

<svelte:window onmousedown={onPageMouseDown} onmousemove={onMarqueeMove} onmouseup={endMarquee} onkeydown={(e) => { if (e.key === "Escape") { selected = []; ctxMenu = null; } }} />

<div class="actions">
	<div class="picker-wrap">
		<button onclick={() => (picking = !picking)}>+ New object</button>
		{#if picking}
			<div class="picker" role="menu">
				{#each creatableTypes() as t (t.key)}
					<button class="type" role="menuitem" onclick={() => void createObject(t.key)}>{t.icon} {t.name}</button>
				{/each}
			</div>
		{/if}
	</div>
	<button onclick={() => void createCollection()}>+ New collection</button>
	<button onclick={() => void createQuery()}>+ New query</button>
	<button class="ghost" onclick={() => void refreshAll()}>↻</button>
</div>

{#if marquee && dragMoved}
	<div
		class="marquee"
		style="left: {Math.min(marquee.x0, marquee.x1)}px; top: {Math.min(marquee.y0, marquee.y1)}px; width: {Math.abs(marquee.x1 - marquee.x0)}px; height: {Math.abs(marquee.y1 - marquee.y0)}px"
	></div>
{/if}
<ul class="objects" bind:this={listEl}>
	{#each objects as o (o.id)}
		<li data-id={o.id} class:selected={selected.includes(o.id)} oncontextmenu={(e) => onRowContext(e, o.id)}>
			<a href="/object/{o.id}" onclick={(e) => onRowClick(e, o.id)} ondragstart={(e) => e.preventDefault()}>
				{#if layoutOf(o.typeKey) === "task"}
					<button class="task-check" class:on={o.done === true} aria-label="done" onclick={(e) => void toggleDone(e, o.id, o.done === true)}>
						<CheckboxIcon checked={o.done === true} size={18} />
					</button>
				{:else}
					<span class="icon">{objectIcon(o.icon, o.typeKey)}</span>
				{/if}
				<span class="name">{o.name || "Untitled"}</span>
				<span class="type">{o.typeKey}</span>
				<span class="when">{o.updatedAt ? new Date(o.updatedAt).toLocaleString() : ""}</span>
			</a>
		</li>
	{/each}
</ul>
{#if objects.length === 0}
	<p class="empty">Nothing yet — create an object.</p>
{/if}
{#if selected.length}
	<div class="sel-bar">
		<span>{selected.length} selected</span>
		<button class="clear" onclick={() => (selected = [])}>✕</button>
	</div>
{/if}
{#if ctxMenu}
	<RowContextMenu
		x={ctxMenu.x}
		y={ctxMenu.y}
		ids={ctxTargets()}
		spaceId={channelId}
		onchanged={refreshAll}
		onclose={() => {
			ctxMenu = null;
			selected = [];
		}}
	/>
{/if}

<style>
	.marquee {
		position: fixed;
		z-index: 80;
		pointer-events: none;
		background: rgba(55, 122, 255, 0.12);
		border: 1px solid rgba(55, 122, 255, 0.55);
		border-radius: 2px;
	}
	.objects li.selected > a {
		background: rgba(55, 122, 255, 0.22);
	}
	.objects li {
		user-select: none;
	}
	.sel-bar {
		position: fixed;
		left: 50%;
		bottom: 26px;
		transform: translateX(-50%);
		z-index: 85;
		display: flex;
		align-items: center;
		gap: 12px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px 14px;
		font-size: 13px;
		box-shadow: 0 12px 36px rgb(0 0 0 / 0.45);
	}
	.sel-bar .clear {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		padding: 2px 4px;
	}
	.actions {
		display: flex;
		gap: 10px;
		margin-bottom: 18px;
	}
	.picker-wrap {
		position: relative;
	}
	button {
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 8px;
		padding: 7px 14px;
		font-size: 13px;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	.ghost {
		border-color: transparent;
		background: none;
		color: var(--muted);
	}
	.picker {
		position: absolute;
		top: 38px;
		left: 0;
		z-index: 40;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		min-width: 180px;
		box-shadow: 0 12px 36px rgb(0 0 0 / 0.45);
	}
	.picker .type {
		border: none;
		background: none;
		text-align: left;
		padding: 7px 10px;
		border-radius: 6px;
	}
	.picker .type:hover {
		background: var(--hover);
	}
	.picker .type:focus-visible {
		background: var(--hover);
	}
	.objects {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.objects a {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 10px;
		border-radius: 8px;
		font-size: 14px;
	}
	.objects a:hover {
		background: var(--hover);
	}
	.icon {
		color: var(--accent);
	}
	.name {
		font-weight: 550;
		flex: 1;
	}
	.type,
	.when {
		color: var(--muted);
		font-size: 12px;
	}
	.empty {
		color: var(--muted);
	}
	.task-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		flex: none;
		padding: 0;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}
	.task-check:hover {
		color: var(--fg);
	}
	.task-check.on {
		color: var(--accent);
	}
</style>
