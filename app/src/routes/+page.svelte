<script lang="ts">
	import { activeChannel } from "$lib/channel.svelte";
	import { objectIcon, TYPE_GLYPHS } from "$lib/icons";
	import { store, refreshAll } from "$lib/data.svelte";
	import { createTyped, createCollection as libCreateCollection, createQuery as libCreateQuery } from "$lib/create";

	const defaultChannelId = $derived(store.channels[0]?.id ?? "");
	const channelId = $derived(activeChannel.id || defaultChannelId);

	/** Objects in the active channel (unassigned objects live in the default channel). */
	const objects = $derived(
		store.summaries.filter((o) => !["type", "template", "agent", "pinned_fact", "milestone"].includes(o.typeKey) && (o.channelId === channelId || (o.channelId === "" && channelId === defaultChannelId))),
	);

	const DEFAULT_TYPES = ["note", "task", "person", "project", "bookmark"];
	const knownTypes = $derived.by(() => {
		const t = new Set(DEFAULT_TYPES);
		for (const o of store.summaries) {
			if (o.typeKey !== "collection" && o.typeKey !== "query" && o.typeKey !== "set") t.add(o.typeKey);
		}
		return [...t].sort();
	});

	let picking = $state(false);
	let customType = $state("");

	async function createObject(typeKey: string) {
		picking = false;
		const clean = typeKey.trim().toLowerCase();
		if (!clean) return;
		await createTyped(clean, channelId);
	}

	async function createCollection() {
		await libCreateCollection(channelId);
	}

	async function createQuery() {
		await libCreateQuery(channelId);
	}

	const ICON_BY_TYPE = TYPE_GLYPHS;
</script>

<div class="actions">
	<div class="picker-wrap">
		<button onclick={() => (picking = !picking)}>+ New object</button>
		{#if picking}
			<div class="picker">
				{#each knownTypes as t (t)}
					<button class="type" onclick={() => void createObject(t)}>{ICON_BY_TYPE[t] ?? "•"} {t}</button>
				{/each}
				<form
					onsubmit={(e) => {
						e.preventDefault();
						void createObject(customType);
					}}
				>
					<input bind:value={customType} placeholder="custom type…" />
				</form>
			</div>
		{/if}
	</div>
	<button onclick={() => void createCollection()}>+ New collection</button>
	<button onclick={() => void createQuery()}>+ New query</button>
	<button class="ghost" onclick={() => void refreshAll()}>↻</button>
</div>

<ul class="objects">
	{#each objects as o (o.id)}
		<li>
			<a href="/object/{o.id}">
				<span class="icon">{objectIcon(o.icon, o.typeKey)}</span>
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

<style>
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
	.picker input {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 6px;
		padding: 6px 8px;
		font-size: 13px;
		margin-top: 4px;
		width: 100%;
		box-sizing: border-box;
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
</style>
