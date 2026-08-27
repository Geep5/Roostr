<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { activeChannel } from "$lib/channel.svelte";
	import { channel as channelApi } from "$lib/api";
	import { store, refreshAll, connectEvents } from "$lib/data.svelte";

	let { children }: { children: import("svelte").Snippet } = $props();

	const channels = $derived(store.channels);

	/** The channel unassigned (pre-channel) objects display under. */
	const defaultChannelId = $derived(channels[0]?.id ?? "");

	const current = $derived(channels.find((c) => c.id === activeChannel.id) ?? channels[0]);

	/** Pinned objects of the current channel, in pinned order. */
	const pinned = $derived.by(() => {
		if (!current) return [];
		const byId = new Map(store.summaries.map((s) => [s.id, s]));
		return current.pinnedIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
	});

	/** Recently edited in the current channel (unpinned). */
	const recent = $derived.by(() => {
		if (!current) return [];
		const pinnedSet = new Set(current.pinnedIds);
		return store.summaries
			.filter((s) => !pinnedSet.has(s.id) && (s.channelId === current.id || (s.channelId === "" && current.id === defaultChannelId)))
			.slice(0, 8);
	});

	function selectChannel(id: string) {
		activeChannel.id = id;
		localStorage.setItem("glon.channel", id);
		void goto("/");
	}

	async function newChannel() {
		const name = prompt("Channel name:");
		if (!name) return;
		const { id } = await channelApi.create(name);
		await refreshAll();
		selectChannel(id);
	}

	const icon = (typeKey: string) => ({ query: "▤", set: "▤", collection: "⛁", note: "▨", task: "☐", person: "◉" })[typeKey] ?? "•";

	let showSettings = $state(false);

	onMount(() => {
		void refreshAll().then(() => {
			// Restore selection; bootstrap a Personal channel on first run.
			const saved = localStorage.getItem("glon.channel");
			if (saved && store.channels.some((c) => c.id === saved)) activeChannel.id = saved;
			else if (store.channels.length > 0) activeChannel.id = store.channels[0].id;
			else {
				void channelApi.create("Personal").then(async ({ id }) => {
					await refreshAll();
					activeChannel.id = id;
				});
			}
		});

		// Live sidebar: the store debounce-refreshes on DAG activity.
		return connectEvents();
	});
</script>

<div class="shell">
	<nav class="vault">
		{#each channels as c (c.id)}
			<button
				class="space"
				class:active={current?.id === c.id}
				title="{c.name}{c.members.length ? ` · ${c.members.length} member(s)` : ''}"
				onclick={() => selectChannel(c.id)}
			>
				{c.icon || c.name.slice(0, 1).toUpperCase() || "?"}
			</button>
		{/each}
		<button class="space add" title="New channel" onclick={() => void newChannel()}>+</button>
		<div class="rail-spacer"></div>
		<button class="space settings" title="Settings" onclick={() => (showSettings = true)}>⚙</button>
	</nav>

	<aside class="widgets">
		{#if current}
			<a class="channel-head" href="/object/{current.id}" title="Channel settings">
				<span class="channel-name">{current.name}</span>
				<span class="gear">⚙</span>
			</a>

			{#if pinned.length > 0}
				<div class="section">
					<div class="section-name">Pinned</div>
					{#each pinned as p (p.id)}
						<a class="item" class:current={page.url.pathname === `/object/${p.id}`} href="/object/{p.id}">
							<span class="obj-icon">{icon(p.typeKey)}</span>{p.name || "Untitled"}
						</a>
					{/each}
				</div>
			{/if}

			<div class="section">
				<div class="section-name">Recently edited</div>
				{#each recent as r (r.id)}
					<a class="item" class:current={page.url.pathname === `/object/${r.id}`} href="/object/{r.id}">
						<span class="obj-icon">{icon(r.typeKey)}</span>{r.name || "Untitled"}
					</a>
				{/each}
				{#if recent.length === 0}
					<span class="none">Nothing yet</span>
				{/if}
			</div>

			<a class="all" href="/">All objects →</a>
		{/if}
	</aside>

	<div class="main-col">
		<header>
			<a class="brand" href="/">glon</a>
			<span class="sub">{current?.name ?? "notes"}</span>
		</header>
		<main>{@render children()}</main>
	</div>
</div>

{#if showSettings}
	{#await import("$lib/components/Settings.svelte") then { default: Settings }}
		<Settings onclose={() => (showSettings = false)} />
	{/await}
{/if}

<style>
	:global(:root) {
		--bg: #101216;
		--panel: #1a1d23;
		--hover: #23262e;
		--border: #2b2f38;
		--fg: #e8eaed;
		--muted: #8b909b;
		--accent: #ffa02f;
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
		-webkit-font-smoothing: antialiased;
	}
	:global(a) {
		color: inherit;
		text-decoration: none;
	}
	.shell {
		display: grid;
		grid-template-columns: 56px 220px 1fr;
		height: 100vh;
	}
	.vault {
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 12px 0;
		background: #0c0e11;
	}
	.space {
		width: 36px;
		height: 36px;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--panel);
		color: var(--fg);
		font-size: 15px;
		cursor: pointer;
	}
	.space:hover {
		border-color: var(--accent);
	}
	.space.active {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}
	.space.add {
		color: var(--muted);
		background: none;
		border-style: dashed;
	}
	.rail-spacer {
		flex: 1;
	}
	.space.settings {
		color: var(--muted);
		background: none;
		border-color: transparent;
		font-size: 17px;
	}
	.space.settings:hover {
		color: var(--fg);
		border-color: var(--accent);
	}
	.widgets {
		border-right: 1px solid var(--border);
		padding: 14px 10px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.channel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 700;
		font-size: 14px;
		padding: 4px 8px;
		border-radius: 8px;
	}
	.channel-head:hover {
		background: var(--hover);
	}
	.gear {
		color: var(--muted);
		font-size: 13px;
	}
	.section-name {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 0 8px 6px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 7px;
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.item:hover {
		background: var(--hover);
	}
	.item.current {
		background: var(--hover);
		color: var(--accent);
	}
	.obj-icon {
		color: var(--accent);
		flex: none;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 0 8px;
	}
	.all {
		color: var(--muted);
		font-size: 12px;
		padding: 0 8px;
	}
	.all:hover {
		color: var(--fg);
	}
	.main-col {
		overflow-y: auto;
		padding: 0 32px;
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding: 18px 0 8px;
		border-bottom: 1px solid var(--border);
		max-width: 920px;
		margin: 0 auto;
	}
	.brand {
		font-weight: 750;
		font-size: 17px;
		color: var(--accent);
	}
	.sub {
		color: var(--muted);
		font-size: 13px;
	}
	main {
		padding: 24px 0 80px;
		max-width: 920px;
		margin: 0 auto;
	}
</style>
