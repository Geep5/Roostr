<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { activeChannel } from "$lib/channel.svelte";
	import { channel as channelApi, note, fetchObject } from "$lib/api";
	import { objectIcon } from "$lib/icons";
	import { store, refreshAll, connectEvents } from "$lib/data.svelte";

	let { children }: { children: import("svelte").Snippet } = $props();

	const channels = $derived(store.channels);

	/** The channel unassigned (pre-channel) objects display under. */
	const defaultChannelId = $derived(channels[0]?.id ?? "");

	const current = $derived(channels.find((c) => c.id === activeChannel.id) ?? channels[0]);

	/** Header center (Anytype's .path): icon + name of what you're looking at; click opens search. */
	const headerPath = $derived.by(() => {
		const path = page.url.pathname;
		if (path.startsWith("/object/")) {
			const id = path.slice("/object/".length);
			const s = store.summaries.find((x) => x.id === id);
			if (s) return { icon: objectIcon(s.icon, s.typeKey), name: s.name || "Untitled" };
			const c = channels.find((x) => x.id === id);
			if (c) return { icon: c.icon || "◍", name: c.name };
			return { icon: "▨", name: "…" };
		}
		if (path === "/graph") return { icon: "◉", name: `Graph — ${current?.name ?? ""}` };
		return { icon: "◍", name: current?.name ?? "glon" };
	});

	// ── Header toolbar (Anytype header/main/object.tsx) ───────────
	const objectId = $derived(page.url.pathname.startsWith("/object/") ? page.url.pathname.slice("/object/".length) : "");
	const objectSummary = $derived(store.summaries.find((s) => s.id === objectId));

	/** The channel whose pinnedIds owns this object (unassigned → default). */
	const owningChannelOf = (channelId: string) => channels.find((c) => c.id === (channelId || defaultChannelId));
	const isPinned = $derived.by(() => {
		if (!objectSummary) return false;
		return owningChannelOf(objectSummary.channelId)?.pinnedIds.includes(objectSummary.id) ?? false;
	});

	let showMore = $state(false);
	let showCollections = $state(false);

	const collections = $derived(
		store.summaries.filter(
			(s) => s.typeKey === "collection" && s.id !== objectId &&
				(s.channelId || defaultChannelId) === ((objectSummary?.channelId ?? activeChannel.id) || defaultChannelId),
		),
	);

	async function togglePin() {
		if (!objectSummary) return;
		const ch = owningChannelOf(objectSummary.channelId);
		if (!ch) return;
		const next = isPinned ? ch.pinnedIds.filter((x) => x !== objectSummary.id) : [...ch.pinnedIds, objectSummary.id];
		await note.setField(ch.id, "pinnedIds", { valuesValue: { items: next.map((id) => ({ stringValue: id })) } });
		await refreshAll();
	}

	async function addToCollection(collectionId: string) {
		if (!objectId) return;
		const col = await fetchObject(collectionId);
		const items = col.fields["collectionIds"]?.valuesValue?.items ?? [];
		const ids = items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
		if (!ids.includes(objectId)) {
			await note.setField(collectionId, "collectionIds", {
				valuesValue: { items: [...ids, objectId].map((id) => ({ stringValue: id })) },
			});
		}
		await refreshAll();
	}

	/** Duplicate object: same fields, full block tree (block ids are object-scoped). */
	async function duplicateObject() {
		if (!objectId) return;
		const src = await fetchObject(objectId);
		const name = (src.fields["name"]?.stringValue || "Untitled") + " copy";
		const fields = { ...src.fields, name: { stringValue: name } };
		const { id } = await note.create(name, src.typeKey, fields);
		// Parent map from childrenIds; blocks arrive in DFS order so parents
		// exist before their children. Roots append; children INNER-append,
		// which preserves sibling order.
		const parentOf = new Map<string, string>();
		for (const b of src.blocks) for (const c of b.childrenIds) parentOf.set(c, b.id);
		for (const b of src.blocks) {
			const pid = parentOf.get(b.id);
			await note.blockAdd(id, { ...b, childrenIds: [] }, pid ?? "", pid ? 5 : 0);
		}
		await goto(`/object/${id}`);
	}

	async function moveToBin() {
		if (!objectId) return;
		await note.del(objectId);
		await refreshAll();
		await goto("/");
	}

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
		// Graph view is per-channel: switching channels swaps the graph in place.
		if (page.url.pathname !== "/graph") void goto("/");
	}

	async function newChannel() {
		const name = prompt("Channel name:");
		if (!name) return;
		const { id } = await channelApi.create(name);
		await refreshAll();
		selectChannel(id);
	}

	const icon = (o: { icon?: string; typeKey: string }) => objectIcon(o.icon, o.typeKey);

	let showSettings = $state(false);
	let showSearch = $state(false);

	function onGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
			e.preventDefault();
			showSearch = true;
		}
	}

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

			<button class="search-entry" onclick={() => (showSearch = true)}>
				<span class="search-icon">⌕</span> Search
				<span class="kbd">⌘K</span>
			</button>

			{#if pinned.length > 0}
				<div class="section">
					<div class="section-name">Pinned</div>
					{#each pinned as p (p.id)}
						<a class="item" class:current={page.url.pathname === `/object/${p.id}`} href="/object/{p.id}">
							<span class="obj-icon">{icon(p)}</span>{p.name || "Untitled"}
						</a>
					{/each}
				</div>
			{/if}

			<div class="section">
				<div class="section-name">Recently edited</div>
				{#each recent as r (r.id)}
					<a class="item" class:current={page.url.pathname === `/object/${r.id}`} href="/object/{r.id}">
						<span class="obj-icon">{icon(r)}</span>{r.name || "Untitled"}
					</a>
				{/each}
				{#if recent.length === 0}
					<span class="none">Nothing yet</span>
				{/if}
			</div>

			<a class="all" class:current-view={page.url.pathname === "/graph"} href="/graph">◉ Graph</a>
			<a class="all" href="/">All objects →</a>
		{/if}
	</aside>

	<div class="main-col">
		<header>
			<div class="header-side left">
				<button class="hbtn" title="Back" onclick={() => history.back()}>‹</button>
				<button class="hbtn" title="Forward" onclick={() => history.forward()}>›</button>
			</div>
			<button class="path" title="Search (⌘K)" onclick={() => (showSearch = true)}>
				<span class="path-icon">{headerPath.icon}</span>
				<span class="path-name">{headerPath.name}</span>
			</button>
			<div class="header-side right">
				<a class="hbtn" title="Graph" href={objectId ? `/graph?focus=${objectId}` : "/graph"}>◉</a>
				{#if objectSummary}
					<div class="more-wrap">
						<button class="hbtn" title="More" onclick={() => { showMore = !showMore; showCollections = false; }}>⋯</button>
						{#if showMore}
							<div class="more-menu">
								<button onclick={() => { showMore = false; void togglePin(); }}>
									{isPinned ? "★ Unpin from channel" : "☆ Pin to channel"}
								</button>
								<button onclick={() => (showCollections = !showCollections)}>⛁ Add to collection ▸</button>
								{#if showCollections}
									<div class="submenu">
										{#each collections as c (c.id)}
											<button onclick={() => { showMore = false; void addToCollection(c.id); }}>{objectIcon(c.icon, c.typeKey)} {c.name || "Untitled"}</button>
										{/each}
										{#if collections.length === 0}
											<span class="menu-none">No collections in this channel</span>
										{/if}
									</div>
								{/if}
								<button onclick={() => { showMore = false; void duplicateObject(); }}>⧉ Duplicate</button>
								<div class="menu-sep"></div>
								<button class="danger" onclick={() => { showMore = false; void moveToBin(); }}>🗑 Move to bin</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</header>

{#if showMore}
	<button class="menu-backdrop" aria-label="Close menu" onclick={() => { showMore = false; showCollections = false; }}></button>
{/if}
		<main>{@render children()}</main>
	</div>
</div>

{#if showSettings}
	{#await import("$lib/components/Settings.svelte") then { default: Settings }}
		<Settings onclose={() => (showSettings = false)} />
	{/await}
{/if}

{#if showSearch}
	{#await import("$lib/components/SearchModal.svelte") then { default: SearchModal }}
		<SearchModal onclose={() => (showSearch = false)} />
	{/await}
{/if}

<svelte:window onkeydown={onGlobalKeydown} />

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
	.search-entry {
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--muted);
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 13px;
		cursor: pointer;
		text-align: left;
	}
	.search-entry:hover {
		border-color: var(--accent);
		color: var(--fg);
	}
	.search-icon {
		font-size: 14px;
	}
	.kbd {
		margin-left: auto;
		font-size: 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 5px;
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
	.header-side {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.path {
		justify-self: center;
	}
	.hbtn {
		width: 28px;
		height: 28px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: none;
		color: var(--muted);
		font-size: 16px;
		border-radius: 7px;
		cursor: pointer;
	}
	.hbtn:hover {
		background: var(--hover);
		color: var(--fg);
	}
	.more-wrap {
		position: relative;
	}
	.more-menu {
		position: absolute;
		top: 32px;
		right: 0;
		z-index: 90;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		min-width: 220px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
	}
	.more-menu > button,
	.submenu > button {
		text-align: left;
		border: none;
		background: none;
		color: var(--fg);
		padding: 7px 10px;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
	}
	.more-menu > button:hover,
	.submenu > button:hover {
		background: var(--hover);
	}
	.more-menu .danger {
		color: #f55522;
	}
	.submenu {
		display: flex;
		flex-direction: column;
		border-left: 2px solid var(--border);
		margin-left: 12px;
	}
	.menu-sep {
		height: 1px;
		background: var(--border);
		margin: 4px 6px;
	}
	.menu-none {
		color: var(--muted);
		font-size: 12px;
		padding: 6px 10px;
	}
	.menu-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: none;
		border: none;
		cursor: default;
	}
	header {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: 8px;
		padding: 18px 0 8px;
		border-bottom: 1px solid var(--border);
		max-width: 920px;
		margin: 0 auto;
	}
	.all.current-view {
		color: var(--accent);
	}
	.path {
		display: flex;
		align-items: center;
		gap: 8px;
		border: none;
		background: none;
		color: var(--fg);
		font-size: 14px;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: 8px;
		cursor: pointer;
		max-width: 60%;
	}
	.path:hover {
		background: var(--hover);
	}
	.path-icon {
		font-size: 15px;
	}
	.path-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	main {
		padding: 24px 0 80px;
		max-width: 920px;
		margin: 0 auto;
	}
</style>
