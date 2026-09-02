<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { activeSpace } from "$lib/space.svelte";
	import { space as spaceApi, note, fetchObject } from "$lib/api";
	import { inviteUrl } from "$lib/invite";
	import { objectIcon } from "$lib/icons";
	import { store, refreshAll, connectEvents } from "$lib/data.svelte";
	import GraphIcon from "$lib/components/GraphIcon.svelte";
	import PinnedWidget from "$lib/components/PinnedWidget.svelte";
	import { creatableTypes, typeGlyph, createTyped, createCollection, createQuery } from "$lib/create";
	import type { SpaceJSON } from "$lib/types";

	let { children }: { children: import("svelte").Snippet } = $props();

	const channels = $derived(store.channels);

	/** The channel unassigned (pre-channel) objects display under. */
	const defaultChannelId = $derived(channels[0]?.id ?? "");

	const current = $derived(channels.find((c) => c.id === activeSpace.id) ?? channels[0]);

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
		if (path === "/graph") return { icon: "graph", name: `Graph — ${current?.name ?? ""}` };
		return { icon: "◍", name: current?.name ?? "glon" };
	});

	// ── Header toolbar (Anytype header/main/object.tsx) ───────────
	const objectId = $derived(page.url.pathname.startsWith("/object/") ? page.url.pathname.slice("/object/".length) : "");
	const objectSummary = $derived(store.summaries.find((s) => s.id === objectId));

	/** The channel whose pinnedIds owns this object (unassigned → default). */
	const owningSpaceOf = (channelId: string) => channels.find((c) => c.id === channelId);
	const isPinned = $derived.by(() => {
		if (!objectSummary) return false;
		return owningSpaceOf(objectSummary.channelId)?.pinnedIds.includes(objectSummary.id) ?? false;
	});

	let showMore = $state(false);

	// ── Mobile shell (Anytype iOS flow): Spaces list -> channel home -> object.
	let isMobile = $state(false);

	// Profile avatar for the Spaces header (cache-first, harness refresh).
	let profilePic = $state("");
	$effect(() => {
		try {
			profilePic = ((JSON.parse(localStorage.getItem("roostr-profile") ?? "{}") as { picture?: string }).picture ?? "");
		} catch {
			/* no cache */
		}
		void fetch("http://127.0.0.1:7334/profile")
			.then((r) => r.json())
			.then((p: { picture?: string }) => {
				profilePic = p.picture ?? "";
				localStorage.setItem("roostr-profile", JSON.stringify(p));
			})
			.catch(() => {});
	});

	/** Mobile only: true when a channel card has been tapped open. */
	let mobileSpaceOpen = $state(false);
	let mCollapsed = $state<Record<string, boolean>>({});

	/** Channel-home recents card: newest 6 objects in the open channel. */
	const mobileRecents = $derived.by(() => {
		if (!current) return [];
		return store.summaries
			.filter((x) => x.channelId === current.id)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 6);
	});

	/** Latest-touched object in a channel (channel card preview line). */
	function latestInChannel(channelId: string) {
		let best: (typeof store.summaries)[number] | null = null;
		for (const s of store.summaries) {
			if (s.channelId !== channelId) continue;
			if (!best || s.updatedAt > best.updatedAt) best = s;
		}
		return best;
	}

	/** Mobile object back: to the object's channel home (the pinned-cards
	 * frame), not history.back — one more tap reaches the channels list. */
	function mobileBackToSpace() {
		if (objectSummary) {
			const ch = owningSpaceOf(objectSummary.channelId);
			if (ch) selectSpace(ch.id);
		}
		mobileSpaceOpen = true;
		void goto("/");
	}

	function shortDate(ms: number): string {
		const d = new Date(ms);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
		const days = (now.getTime() - d.getTime()) / 86400000;
		if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
		return d.toLocaleDateString([], { month: "short", day: "numeric" });
	}

	/** Per-type expansion in the Types widget (Anytype v0.50 Objects sections). */
	let expandedTypes = $state<Record<string, boolean>>({});

	/** Objects of a type in this channel, newest first (sidebar preview, capped). */
	function typeObjects(typeKey: string) {
		const ch = activeSpace.id || defaultChannelId;
		return store.summaries
			.filter((s) => s.typeKey === typeKey && s.channelId === ch)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 6);
	}
	let showCollections = $state(false);
	let showCreate = $state(false);

	/** Sidebar create (Anytype's typeSuggest menu): pick a type, get an object. */
	async function sidebarCreate(kind: string) {
		showCreate = false;
		const ch = activeSpace.id || defaultChannelId;
		if (kind === "collection") return void (await createCollection(ch));
		if (kind === "query") return void (await createQuery(ch));
		await createTyped(kind, ch);
	}

	const collections = $derived(
		store.summaries.filter(
			(s) => s.typeKey === "collection" && s.id !== objectId &&
				s.channelId === ((objectSummary?.channelId || activeSpace.id) || defaultChannelId),
		),
	);

	async function togglePin() {
		if (!objectSummary) return;
		const ch = owningSpaceOf(objectSummary.channelId);
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

	/** Copy a universal invite link deep-linking to this object; the
	 * space key rides in the URL fragment, so the link grants access. */
	async function copyObjectLink() {
		const ch = objectSummary ? owningSpaceOf(objectSummary.channelId) : undefined;
		if (!objectSummary || !ch) return;
		const payload = await spaceApi.invitePayload(ch.id, "");
		let owner = "";
		try {
			const res = await fetch("http://127.0.0.1:7334/identity");
			if (res.ok) owner = ((await res.json()) as { npub?: string }).npub ?? "";
		} catch {
			// Identity unavailable — the link still carries the key.
		}
		await navigator.clipboard.writeText(
			inviteUrl({
				v: 1,
				t: "space-invite",
				space: ch.id,
				name: (typeof payload.name === "string" && payload.name) || ch.name || undefined,
				owner,
				relays: ["wss://roostr-relay.fly.dev"],
				key: typeof payload.key === "string" ? payload.key : "",
				keyId: typeof payload.key_id === "number" ? payload.key_id : 1,
				object: objectSummary.id,
			}),
		);
	}

	/** Pinned objects of the current channel, in pinned order. */
	const pinned = $derived.by(() => {
		if (!current) return [];
		const byId = new Map(store.summaries.map((s) => [s.id, s]));
		return current.pinnedIds.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
	});

	// ── Widget reorder (Anytype sidebar/page/widget.tsx drag flow) ──
	// Widgets drag whole; the hovered widget splits at its vertical
	// midpoint into top/bottom (2px accent line), drop rewrites pinnedIds.
	let widgetDragId = $state("");
	let widgetOverId = $state("");
	let widgetOverPos = $state<"top" | "bottom">("top");

	function widgetDragOver(e: DragEvent, id: string) {
		if (!widgetDragId || widgetDragId === id) return;
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		widgetOverId = id;
		widgetOverPos = e.clientY <= r.top + r.height / 2 ? "top" : "bottom";
	}

	async function widgetDrop() {
		const dragged = widgetDragId;
		const target = widgetOverId;
		const pos = widgetOverPos;
		widgetDragId = widgetOverId = "";
		if (!current || !dragged || !target || dragged === target) return;
		const ids = current.pinnedIds.filter((x) => x !== dragged);
		const at = ids.indexOf(target) + (pos === "bottom" ? 1 : 0);
		ids.splice(at, 0, dragged);
		await note.setField(current.id, "pinnedIds", { valuesValue: { items: ids.map((id) => ({ stringValue: id })) } });
		await refreshAll();
	}

	// ── Space reorder (drag on the rail, long-press on mobile) ──────
	//
	// `channels` stays in creation order everywhere else on purpose:
	// channels[0] is the default space that owns unassigned legacy objects,
	// and letting a drag change it would hand every orphan object to
	// whichever space you dragged to the top. So the user's order is a
	// DISPLAY concern, applied here and nowhere else.
	//
	// Position is a float on the channel object, defaulting to createdAt so
	// both live in one number space: an unordered vault already sorts
	// correctly, and a drop only has to write the moved space's own field.
	const orderOf = (c: SpaceJSON) => c.order ?? c.createdAt;
	const orderedSpaces = $derived([...channels].sort((a, b) => orderOf(a) - orderOf(b) || a.createdAt - b.createdAt));

	let spaceDragId = $state("");
	let spaceOverId = $state("");
	let spaceOverAfter = $state(false);

	/** Midpoint between the drop neighbours — or a step beyond the edge. */
	async function commitSpaceMove(draggedId: string, targetId: string, after: boolean) {
		if (!draggedId || !targetId || draggedId === targetId) return;
		const rest = orderedSpaces.filter((c) => c.id !== draggedId);
		const at = rest.findIndex((c) => c.id === targetId) + (after ? 1 : 0);
		const before = rest[at - 1];
		const next = rest[at];
		let position: number;
		if (before && next) position = (orderOf(before) + orderOf(next)) / 2;
		else if (next) position = orderOf(next) - 1000;
		else if (before) position = orderOf(before) + 1000;
		else return;
		await note.setField(draggedId, "order", { floatValue: position });
		await refreshAll();
	}

	function spaceDragOver(e: DragEvent, id: string) {
		if (!spaceDragId || spaceDragId === id) return;
		e.preventDefault();
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		spaceOverId = id;
		spaceOverAfter = e.clientY > r.top + r.height / 2;
	}

	async function spaceDrop() {
		const dragged = spaceDragId;
		const target = spaceOverId;
		const after = spaceOverAfter;
		spaceDragId = spaceOverId = "";
		await commitSpaceMove(dragged, target, after);
	}

	// Touch has no HTML5 drag, and a plain touchmove would fight the page
	// scroll — so a card must be HELD to lift it, exactly like reordering
	// home-screen icons. Once lifted, touchmove picks the card under the
	// finger and the drop commits the same move the mouse path does.
	const LIFT_MS = 350;
	let liftTimer: ReturnType<typeof setTimeout> | undefined;
	let spaceLiftId = $state("");

	// Svelte attaches touchmove passively, where preventDefault is a no-op
	// and the list would scroll out from under the held card. Same fix the
	// search sheet uses: register it by hand, non-passive, for the duration
	// of the lift only.
	function onLiftMove(e: TouchEvent) {
		if (!spaceLiftId) return;
		e.preventDefault();
		const t = e.touches[0];
		if (!t) return;
		const card = (document.elementFromPoint(t.clientX, t.clientY) as HTMLElement | null)?.closest("[data-space-id]");
		const id = card?.getAttribute("data-space-id") ?? "";
		if (!id || id === spaceLiftId) return;
		const r = card!.getBoundingClientRect();
		spaceOverId = id;
		spaceOverAfter = t.clientY > r.top + r.height / 2;
	}

	function spaceTouchStart(id: string) {
		clearTimeout(liftTimer);
		liftTimer = setTimeout(() => {
			spaceLiftId = id;
			spaceDragId = id;
			spaceOverId = "";
			document.addEventListener("touchmove", onLiftMove, { passive: false });
			// A lift is a mode change; tell the hand it happened.
			navigator.vibrate?.(12);
		}, LIFT_MS);
	}

	/** A move before the hold completes is a scroll, so drop the pending lift. */
	function spaceTouchCancelLift() {
		if (!spaceLiftId) clearTimeout(liftTimer);
	}

	async function spaceTouchEnd() {
		clearTimeout(liftTimer);
		if (!spaceLiftId) return;
		document.removeEventListener("touchmove", onLiftMove);
		spaceLiftId = "";
		await spaceDrop();
	}

	/** Recently edited in the current channel (unpinned). */
	const recent = $derived.by(() => {
		if (!current) return [];
		const pinnedSet = new Set(current.pinnedIds);
		return store.summaries
			.filter((s) => !pinnedSet.has(s.id) && !["type", "template", "agent", "pinned_fact", "milestone"].includes(s.typeKey) && s.channelId === current.id)
			.slice(0, 8);
	});

	function selectSpace(id: string) {
		activeSpace.id = id;
		localStorage.setItem("glon.channel", id);
		// Graph view is per-channel: switching channels swaps the graph in place.
		if (page.url.pathname !== "/graph") void goto("/");
	}

	async function newSpace() {
		const name = prompt("Space name:");
		if (!name) return;
		const { id } = await spaceApi.create(name);
		await refreshAll();
		selectSpace(id);
	}

	/** Create a type object (Anytype: U.Object.createType); opens its page. */
	async function newType() {
		const name = prompt("Type name:");
		if (!name?.trim()) return;
		let key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
		if (!key) return;
		if (store.types.some((t) => t.key === key)) {
			alert(`A type with key "${key}" already exists.`);
			return;
		}
		const { id } = await note.create(name.trim(), "type", {
			key: { stringValue: key },
			layout: { stringValue: "page" },
		});
		await refreshAll();
		await goto(`/object/${id}`);
	}

	const icon = (o: { icon?: string; typeKey: string }) => objectIcon(o.icon, o.typeKey);

	// Widget collapse state (Anytype Storage.checkToggle('widget', id)).
	let widgetCollapsed = $state<Record<string, boolean>>(
		(() => {
			try {
				return JSON.parse(localStorage.getItem("widget-collapsed") ?? "{}");
			} catch {
				return {};
			}
		})(),
	);
	function flipWidget(id: string) {
		widgetCollapsed[id] = !widgetCollapsed[id];
		localStorage.setItem("widget-collapsed", JSON.stringify(widgetCollapsed));
	}

	// Anytype widget sections (sidebar/page/widget.tsx onToggle): section
	// headers collapse; a viewing preference, persisted per device.
	let sectionCollapsed = $state<Record<string, boolean>>(
		typeof localStorage === "undefined" ? {} : JSON.parse(localStorage.getItem("section-collapsed") ?? "{}"),
	);
	function flipSection(id: string) {
		sectionCollapsed[id] = !sectionCollapsed[id];
		localStorage.setItem("section-collapsed", JSON.stringify(sectionCollapsed));
	}

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
			if (saved && store.channels.some((c) => c.id === saved)) activeSpace.id = saved;
			else if (store.channels.length > 0) activeSpace.id = store.channels[0].id;
			else {
				void spaceApi.create("Personal").then(async ({ id }) => {
					await refreshAll();
					activeSpace.id = id;
				});
			}
		});

		// Mobile shell switch (viewport-driven flow, not just styling).
		const mq = window.matchMedia("(max-width: 720px)");
		const applyMq = () => (isMobile = mq.matches);
		applyMq();
		mq.addEventListener("change", applyMq);

		// Live sidebar: the store debounce-refreshes on DAG activity.
		const stopEvents = connectEvents();
		return () => {
			mq.removeEventListener("change", applyMq);
			stopEvents();
		};
	});
</script>

{#if isMobile}
<div class="m-shell">
	{#if page.url.pathname.startsWith("/chat/")}
		<!-- Full-screen chat page: brings its own header and keyboard fit. -->
		{@render children()}
	{:else if page.url.pathname === "/graph"}
		<header class="m-top">
			<button class="m-btn" data-tip="Back" aria-label="Back" onclick={() => history.back()}><svg style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 6L9 12l5.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
			<span class="m-obj"><span class="path-icon"><GraphIcon /></span><span class="m-obj-name">Graph</span></span>
			<span class="m-top-spacer"></span>
		</header>
		<main class="m-main">{@render children()}</main>
	{:else if objectId}
		<!-- Object page: back / icon+name / star / more. -->
		<header class="m-top">
			<button class="m-btn" data-tip="Space home" aria-label="Space home" onclick={() => mobileBackToSpace()}><svg style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 6L9 12l5.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
			<span class="m-obj">
				{#if headerPath.icon === "graph"}
					<span class="path-icon"><GraphIcon /></span>
				{:else if headerPath.icon.startsWith("http")}
					<img class="path-img" src={headerPath.icon} alt="" />
				{:else}
					<span class="path-icon">{headerPath.icon}</span>
				{/if}
				<span class="m-obj-name">{headerPath.name}</span>
			</span>
			{#if objectSummary}
				<div class="m-actions">
				<span class="m-sync" class:ok={store.connected} data-tip={store.connected ? "Local daemon live" : "Daemon offline"}><span class="m-sync-dot"></span></span>
				<div class="more-wrap">
					<button class="m-btn" data-tip="More" onclick={() => { showMore = !showMore; showCollections = false; }}>⋯</button>
					{#if showMore}
						<div class="more-menu">
							<button onclick={() => { showMore = false; void goto(objectId ? `/graph?focus=${objectId}` : "/graph"); }}>
								<span class="menu-graph-icon"><GraphIcon size={14} /></span> Graph
							</button>
							<button onclick={() => { showMore = false; void togglePin(); }}>
								{isPinned ? "★ Unpin from space" : "☆ Pin to space"}
							</button>
							<button onclick={() => (showCollections = !showCollections)}>⛁ Add to collection ▸</button>
							{#if showCollections}
								<div class="submenu">
									{#each collections as c (c.id)}
										<button onclick={() => { showMore = false; void addToCollection(c.id); }}>{objectIcon(c.icon, c.typeKey)} {c.name || "Untitled"}</button>
									{/each}
									{#if collections.length === 0}
										<span class="menu-none">No collections in this space</span>
									{/if}
								</div>
							{/if}
							<button onclick={() => { showMore = false; void duplicateObject(); }}>⧉ Duplicate</button>
							{#if owningSpaceOf(objectSummary.channelId)}
								<button onclick={() => { showMore = false; void copyObjectLink(); }}>🔗 Copy link</button>
							{/if}
							<div class="menu-sep"></div>
							<button class="danger" onclick={() => { showMore = false; void moveToBin(); }}>🗑 Move to bin</button>
						</div>
					{/if}
				</div>
				</div>
			{/if}
		</header>
		<main class="m-main">{@render children()}</main>
	{:else if !mobileSpaceOpen || !current}
		<!-- Screen 1: Spaces list. -->
		<div class="m-screen">
			<div class="m-head">
				<!-- Anytype: the avatar sits alone on top; the title gets its own line below. -->
				<div class="m-head-top">
					<button class="m-avatar" data-tip="Settings" aria-label="Settings" onclick={() => (showSettings = true)}>
						{#if profilePic}<img class="m-avatar-img" src={profilePic} alt="" />{:else}⚙{/if}
					</button>
				</div>
				<span class="m-title">Spaces</span>
			</div>
			<div class="m-cards">
				{#each orderedSpaces as c (c.id)}
					{@const latest = latestInChannel(c.id)}
					<button
						class="m-card"
						class:lifted={spaceLiftId === c.id}
						class:over-before={spaceOverId === c.id && !spaceOverAfter}
						class:over-after={spaceOverId === c.id && spaceOverAfter}
						data-space-id={c.id}
						ontouchstart={() => spaceTouchStart(c.id)}
						ontouchmove={spaceTouchCancelLift}
						ontouchend={() => void spaceTouchEnd()}
						ontouchcancel={() => void spaceTouchEnd()}
						oncontextmenu={(e) => {
							// Long-press raises the iOS callout; the hold is ours.
							if (spaceLiftId) e.preventDefault();
						}}
						onclick={() => {
							// A completed lift is a reorder, never navigation.
							if (spaceLiftId) return;
							clearTimeout(liftTimer);
							selectSpace(c.id);
							mobileSpaceOpen = true;
						}}
					>
						<span class="m-card-icon">
							{#if c.icon?.startsWith("http")}
								<img class="m-card-img" src={c.icon} alt="" />
							{:else}
								{c.icon || c.name.slice(0, 1).toUpperCase() || "?"}
							{/if}
						</span>
						<span class="m-card-text">
							<span class="m-card-name">{c.name}</span>
							{#if latest}
								<span class="m-card-sub">{latest.icon ? latest.icon + " " : ""}{latest.name || "Untitled"}</span>
							{/if}
						</span>
						{#if latest}<span class="m-card-side">{shortDate(latest.updatedAt)}</span>{/if}
					</button>
				{/each}
				<button class="m-card add" onclick={() => void newSpace()}>＋ New space</button>
			</div>
			<div class="m-bottom">
				<button class="m-search" onclick={() => (showSearch = true)}>⌕ Search</button>
				<button class="m-compose" data-tip="New object" onclick={() => (showCreate = !showCreate)}>＋</button>
			</div>
		</div>
	{:else}
		<!-- Screen 2: inside a channel — pinned objects as collapsible cards. -->
		<div class="m-screen">
			<div class="m-top">
				<button class="m-btn" data-tip="Spaces" aria-label="Spaces" onclick={() => (mobileSpaceOpen = false)}><svg style="width:20px;height:20px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 6L9 12l5.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
				<span class="m-top-spacer"></span>
				<button class="m-btn" data-tip="Space settings" aria-label="Space settings" onclick={() => goto(`/object/${current.id}`)}><svg style="width:18px;height:18px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
			</div>
			<div class="m-ch-head">
				<span class="m-ch-icon">
					{#if current.icon?.startsWith("http")}
						<img class="m-ch-img" src={current.icon} alt="" />
					{:else}
						{current.icon || current.name.slice(0, 1).toUpperCase() || "?"}
					{/if}
				</span>
				<div class="m-ch-text">
					<div class="m-ch-name">{current.name}</div>
					<div class="m-ch-sub">{current.members.length > 0 ? "Shared space" : "Private space"}</div>
				</div>
			</div>
			<div class="m-cards-col">
				{#each pinned as p (p.id)}
					<div class="m-wcard">
						<div class="m-wcard-head">
							<a class="m-wcard-link" href="/object/{p.id}">
								<span class="obj-icon">{icon(p)}</span>
								<span class="m-wcard-name">{p.name || "Untitled"}</span>
							</a>
							<button class="m-chev-btn" aria-label="Expand" onclick={() => (mCollapsed[p.id] = !mCollapsed[p.id])}>
								<span class="m-chev" class:open={!mCollapsed[p.id]}>⌄</span>
							</button>
						</div>
						{#if !mCollapsed[p.id]}
							<div class="m-wcard-body"><PinnedWidget id={p.id} /></div>
						{/if}
					</div>
				{/each}
				<div class="m-section">
					<button class="m-section-label" onclick={() => (mCollapsed["__recent"] = !mCollapsed["__recent"])}>
						Recently edited
						<span class="m-chev" class:open={!mCollapsed["__recent"]}>⌄</span>
					</button>
					{#if !mCollapsed["__recent"]}
						<div class="m-section-body">
							{#each mobileRecents as o (o.id)}
								<a class="m-row" href="/object/{o.id}">
									<span class="obj-icon">{o.icon || typeGlyph(o.typeKey)}</span>{o.name || "Untitled"}
								</a>
							{/each}
						</div>
					{/if}
				</div>
				<div class="m-section">
					<div class="m-section-head">
						<button class="m-section-label" onclick={() => (mCollapsed["__types"] = !mCollapsed["__types"])}>
							Types
							<span class="m-chev" class:open={!mCollapsed["__types"]}>⌄</span>
						</button>
						<!-- Types are only creatable from here on mobile: the bottom ＋
						     composes objects, not types. -->
						<button class="m-section-add" aria-label="New type" onclick={() => void newType()}>＋</button>
					</div>
					{#if !mCollapsed["__types"]}
						<div class="m-section-body">
							{#each store.types as t (t.id)}
								<a class="m-row" href="/object/{t.id}">
									<span class="obj-icon">{t.icon || typeGlyph(t.key)}</span>{t.name || t.key}
								</a>
							{/each}
						</div>
					{/if}
				</div>
			</div>
			<div class="m-bottom">
				<button class="m-search" onclick={() => (showSearch = true)}>⌕ Search</button>
				<button class="m-compose" data-tip="New object" onclick={() => (showCreate = !showCreate)}>＋</button>
			</div>
		</div>
	{/if}

	{#if showCreate}
		<div class="m-create-menu" role="menu">
			{#each creatableTypes() as t (t.key)}
				<button role="menuitem" onclick={() => void sidebarCreate(t.key)}>
					<span class="obj-icon">{t.icon}</span>{t.name}
				</button>
			{/each}
			<div class="create-sep"></div>
			<button role="menuitem" onclick={() => void sidebarCreate("collection")}>
				<span class="obj-icon">{typeGlyph("collection")}</span>Collection
			</button>
			<button role="menuitem" onclick={() => void sidebarCreate("query")}>
				<span class="obj-icon">{typeGlyph("query")}</span>Query
			</button>
		</div>
	{/if}
</div>
{:else}
<div class="shell">
	<nav class="vault">
		{#each orderedSpaces as c (c.id)}
			<button
				class="space"
				class:active={current?.id === c.id}
				class:drag-src={spaceDragId === c.id}
				class:over-before={spaceOverId === c.id && !spaceOverAfter}
				class:over-after={spaceOverId === c.id && spaceOverAfter}
				title="{c.name}{c.members.length ? ` · ${c.members.length} member(s)` : ''}"
				draggable="true"
				ondragstart={(e) => {
					spaceDragId = c.id;
					e.dataTransfer?.setData("text/plain", c.id);
				}}
				ondragover={(e) => spaceDragOver(e, c.id)}
				ondragleave={() => {
					if (spaceOverId === c.id) spaceOverId = "";
				}}
				ondrop={(e) => {
					e.preventDefault();
					void spaceDrop();
				}}
				ondragend={() => {
					spaceDragId = spaceOverId = "";
				}}
				onclick={() => selectSpace(c.id)}
			>
				{#if c.icon?.startsWith("http")}
					<img class="rail-img" src={c.icon} alt={c.name} />
				{:else}
					{c.icon || c.name.slice(0, 1).toUpperCase() || "?"}
				{/if}
			</button>
		{/each}
		<button class="space add" title="New space" onclick={() => void newSpace()}>+</button>
		<div class="rail-spacer"></div>
		<button class="space settings" title="Settings" onclick={() => (showSettings = true)}>⚙</button>
	</nav>

	<aside class="widgets">
		{#if current}
			<a class="space-head" href="/object/{current.id}" title="Space settings">
				<span class="space-name">{current.name}</span>
				<span class="gear">⚙</span>
			</a>

			<div class="search-row">
				<button class="search-entry" onclick={() => (showSearch = true)}>
					<span class="search-icon">⌕</span> Search
					<span class="kbd">⌘K</span>
				</button>
				<div class="create-wrap">
					<button class="create-btn" title="New object" aria-expanded={showCreate} onclick={() => (showCreate = !showCreate)}>＋</button>
					{#if showCreate}
						<div class="create-menu" role="menu">
							{#each creatableTypes() as t (t.key)}
								<button role="menuitem" onclick={() => void sidebarCreate(t.key)}>
									<span class="obj-icon">{t.icon}</span>{t.name}
								</button>
							{/each}
							<div class="create-sep"></div>
							<button role="menuitem" onclick={() => void sidebarCreate("collection")}>
								<span class="obj-icon">{typeGlyph("collection")}</span>Collection
							</button>
							<button role="menuitem" onclick={() => void sidebarCreate("query")}>
								<span class="obj-icon">{typeGlyph("query")}</span>Query
							</button>
						</div>
					{/if}
				</div>
			</div>

			<!-- Anytype widgets: each pinned object is its OWN widget card with
			     a 600-weight header row (widget/common.scss .head .clickable);
			     sets render their current view beneath. No "Pinned" label. -->
			{#each pinned as p (p.id)}
				<div
					class="widget"
					class:current={page.url.pathname === `/object/${p.id}`}
					class:drag-src={widgetDragId === p.id}
					class:over-top={widgetOverId === p.id && widgetOverPos === "top"}
					class:over-bottom={widgetOverId === p.id && widgetOverPos === "bottom"}
					role="presentation"
					draggable="true"
					ondragstart={(e) => {
						widgetDragId = p.id;
						e.dataTransfer?.setData("text/plain", p.id);
					}}
					ondragover={(e) => widgetDragOver(e, p.id)}
					ondragleave={() => {
						if (widgetOverId === p.id) widgetOverId = "";
					}}
					ondrop={(e) => {
						e.preventDefault();
						void widgetDrop();
					}}
					ondragend={() => {
						widgetDragId = widgetOverId = "";
					}}
				>
					<div class="widget-row">
						<button
							class="widget-collapse"
							class:open={!widgetCollapsed[p.id]}
							aria-label={widgetCollapsed[p.id] ? "Expand" : "Collapse"}
							onclick={() => flipWidget(p.id)}>▶</button
						>
						<a class="widget-head" href="/object/{p.id}">
							<span class="obj-icon">{icon(p)}</span>
							<span class="widget-name">{p.name || "Untitled"}</span>
						</a>
					</div>
					{#if !widgetCollapsed[p.id]}
						<PinnedWidget id={p.id} />
					{/if}
				</div>
			{/each}

			<!-- Anytype widgetSection: the nameWrap sits on the sidebar
			     background; only the items live inside the rounded card. -->
			<div class="section">
				<div class="section-head">
					<button class="section-name" onclick={() => flipSection("recent")}>
						<span class="section-arrow" class:open={!sectionCollapsed["recent"]}>▶</span>Recently edited
					</button>
				</div>
				{#if !sectionCollapsed["recent"]}
					<div class="section-body">
						{#each recent as r (r.id)}
							<a class="item" class:current={page.url.pathname === `/object/${r.id}`} href="/object/{r.id}">
								<span class="obj-icon">{icon(r)}</span>{r.name || "Untitled"}
							</a>
						{/each}
						{#if recent.length === 0}
							<span class="none">Nothing yet</span>
						{/if}
					</div>
				{/if}
			</div>

			<div class="section">
				<div class="section-head">
					<button class="section-name" onclick={() => flipSection("types")}>
						<span class="section-arrow" class:open={!sectionCollapsed["types"]}>▶</span>Types
					</button>
					<button class="section-add" title="New type" onclick={() => void newType()}>＋</button>
				</div>
				{#if !sectionCollapsed["types"]}
					<div class="section-body">
						{#each store.types as t (t.id)}
							{@const objs = typeObjects(t.key)}
							<div class="type-row" class:current={page.url.pathname === `/object/${t.id}`}>
								<button
									class="type-chev"
									class:open={expandedTypes[t.key]}
									data-tip={expandedTypes[t.key] ? "Collapse" : `${objs.length} object${objs.length === 1 ? "" : "s"}`}
									onclick={() => (expandedTypes[t.key] = !expandedTypes[t.key])}
								>
									▶
								</button>
								<a class="item type-link" href="/object/{t.id}">
									<span class="obj-icon">{t.icon || typeGlyph(t.key)}</span>{t.name || t.key}
								</a>
							</div>
							{#if expandedTypes[t.key]}
								<div class="type-objs">
									{#each objs as o (o.id)}
										<a class="item sub" class:current={page.url.pathname === `/object/${o.id}`} href="/object/{o.id}">
											<span class="obj-icon">{o.icon || typeGlyph(o.typeKey)}</span>{o.name || "Untitled"}
										</a>
									{/each}
									{#if objs.length === 0}
										<span class="type-empty">No {t.name || t.key} objects yet</span>
									{/if}
								</div>
							{/if}
						{/each}
					</div>
				{/if}
			</div>

		{/if}
	</aside>

	<div class="main-col">
		<header>
			<div class="header-side left">
				<button class="hbtn" data-tip="Back" aria-label="Back" onclick={() => history.back()}><svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 6L9 12l5.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
				<button class="hbtn" data-tip="Forward" aria-label="Forward" onclick={() => history.forward()}><svg style="width:16px;height:16px" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 6L15 12l-5.5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
			</div>
			<button class="path" data-tip="Search (⌘K)" onclick={() => (showSearch = true)}>
				{#if headerPath.icon === "graph"}
					<span class="path-icon"><GraphIcon /></span>
				{:else if headerPath.icon.startsWith("http")}
					<img class="path-img" src={headerPath.icon} alt="" />
				{:else}
					<span class="path-icon">{headerPath.icon}</span>
				{/if}
				<span class="path-name">{headerPath.name}</span>
			</button>
			<div class="header-side right">
				<a class="hbtn" data-tip="Graph" href={objectId ? `/graph?focus=${objectId}` : "/graph"}><GraphIcon size={16} /></a>
				{#if objectSummary}
					<div class="more-wrap">
						<button class="hbtn" data-tip="More" onclick={() => { showMore = !showMore; showCollections = false; }}>⋯</button>
						{#if showMore}
							<div class="more-menu">
								<button onclick={() => { showMore = false; void togglePin(); }}>
									{isPinned ? "★ Unpin from space" : "☆ Pin to space"}
								</button>
								<button onclick={() => (showCollections = !showCollections)}>⛁ Add to collection ▸</button>
								{#if showCollections}
									<div class="submenu">
										{#each collections as c (c.id)}
											<button onclick={() => { showMore = false; void addToCollection(c.id); }}>{objectIcon(c.icon, c.typeKey)} {c.name || "Untitled"}</button>
										{/each}
										{#if collections.length === 0}
											<span class="menu-none">No collections in this space</span>
										{/if}
									</div>
								{/if}
								<button onclick={() => { showMore = false; void duplicateObject(); }}>⧉ Duplicate</button>
								{#if owningSpaceOf(objectSummary.channelId)}
									<button onclick={() => { showMore = false; void copyObjectLink(); }}>🔗 Copy link</button>
								{/if}
								<div class="menu-sep"></div>
								<button class="danger" onclick={() => { showMore = false; void moveToBin(); }}>🗑 Move to bin</button>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</header>

{#if showMore || showCreate}
	<button class="menu-backdrop" aria-label="Close menu" onclick={() => { showMore = false; showCollections = false; showCreate = false; }}></button>
{/if}
		<main>{@render children()}</main>
	</div>
</div>
{/if}

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
		--bg: #1e1e20;
		--panel: #2b2b2e;
		--hover: #3a3a3e;
		--border: #45454a;
		--fg: #f5f5f7;
		--muted: #98989d;
		--accent: #0a84ff;
		--green: #30d158;
		--orange: #ff9f0a;
		--red: #ff453a;
		--indigo: #7d7aff;
		--mark: rgb(10 132 255 / 0.4);
		/* Anytype shape-highlight tokens (dark theme values). */
		--hl-light: rgba(255, 255, 255, 0.03);
		--hl-med: rgba(255, 255, 255, 0.05);
	}
	/* Minimal scrollbars (Anytype look): thin rounded thumb riding a
	   transparent track, no buttons - Windows' chunky default is gone.
	   Chromium takes the -webkit path; the standard properties apply only
	   where the pseudo-elements don't exist (Firefox), because setting
	   scrollbar-width/color in Chromium would disable the styled ones. */
	@supports not selector(::-webkit-scrollbar) {
		:global(html),
		:global(*) {
			scrollbar-width: thin;
			scrollbar-color: var(--border) transparent;
		}
	}
	:global(::-webkit-scrollbar) {
		width: 10px;
		height: 10px;
	}
	:global(::-webkit-scrollbar-track),
	:global(::-webkit-scrollbar-corner) {
		background: transparent;
	}
	:global(::-webkit-scrollbar-thumb) {
		background: rgb(255 255 255 / 0.16);
		border-radius: 999px;
		border: 3px solid transparent;
		background-clip: padding-box;
		min-height: 40px;
	}
	:global(::-webkit-scrollbar-thumb:hover) {
		background: rgb(255 255 255 / 0.32);
		border: 2px solid transparent;
		background-clip: padding-box;
	}
	:global(::-webkit-scrollbar-button) {
		display: none;
		width: 0;
		height: 0;
	}

	.search-row {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.search-entry {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		color: var(--muted);
		border-radius: 6px;
		height: 28px;
		padding: 0 8px;
		font-size: 14px;
		line-height: 22px;
		cursor: pointer;
		text-align: left;
	}
	.search-entry:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.create-wrap {
		position: relative;
	}
	.create-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		background: none;
		border: none;
		border-radius: 6px;
		color: var(--muted);
		font-size: 15px;
		cursor: pointer;
	}
	.create-btn:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.create-menu {
		position: absolute;
		top: 32px;
		right: 0;
		z-index: 90;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		min-width: 170px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
	}
	.create-menu > button {
		display: flex;
		align-items: center;
		gap: 8px;
		text-align: left;
		background: none;
		border: none;
		color: var(--fg);
		font-size: 13px;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.create-menu > button:hover {
		background: var(--hover);
	}
	.create-sep {
		height: 1px;
		background: var(--border);
		margin: 4px 2px;
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
	/* Anytype pageVault: a rounded solid card, no border — panes separate
	   by background, not lines. */
	.vault {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 12px 0;
		margin: 6px 0 6px 6px;
		background: var(--panel);
		border-radius: 16px;
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
		background: var(--hover);
	}
	.space.active {
		box-shadow: 0 0 0 2px var(--accent);
	}
	/* Reorder affordances. The rail is vertical, so the drop line is
	   horizontal; the dragged tile fades so the line reads as its
	   destination rather than a second selection. */
	.space {
		position: relative;
	}
	.space.drag-src {
		opacity: 0.4;
	}
	.space.over-before::before,
	.space.over-after::after {
		content: "";
		position: absolute;
		left: -2px;
		right: -2px;
		height: 2px;
		border-radius: 2px;
		background: var(--accent);
	}
	.space.over-before::before {
		top: -4px;
	}
	.space.over-after::after {
		bottom: -4px;
	}
	.space.add {
		color: var(--muted);
		background: none;
	}
	.space.add:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.rail-spacer {
		flex: 1;
	}
	.space.settings {
		color: var(--muted);
		background: none;
		font-size: 17px;
	}
	.space.settings:hover {
		color: var(--fg);
		background: var(--hl-med);
	}
	.widgets {
		padding: 10px 8px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* Anytype spaceHead: 600-weight name, 6px radius, highlight hover,
	   settings affordance revealed on hover. */
	.space-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 600;
		font-size: 14px;
		line-height: 22px;
		padding: 4px 6px;
		border-radius: 6px;
	}
	.space-head:hover {
		background: var(--hl-med);
	}
	.gear {
		color: var(--muted);
		font-size: 13px;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.space-head:hover .gear {
		opacity: 1;
	}
	/* Anytype widget: each pinned object is its own card; the header is
	   the 600-weight clickable row with hover highlight. */
	.widget {
		background: var(--hl-light);
		border-radius: 12px;
		padding: 8px;
		position: relative;
	}
	/* Anytype widget.scss .isOver::before: 2px accent line in the 5px gap. */
	.widget.over-top::before,
	.widget.over-bottom::before {
		content: "";
		position: absolute;
		left: 12px;
		width: calc(100% - 24px);
		height: 2px;
		border-radius: 2px;
		background: var(--accent);
	}
	.widget.over-top::before {
		top: -5px;
	}
	.widget.over-bottom::before {
		bottom: -5px;
	}
	.widget.drag-src {
		opacity: 0.4;
	}
	.widget-row {
		display: flex;
		align-items: center;
	}
	.widget-collapse {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 8px;
		width: 16px;
		height: 24px;
		padding: 0;
		flex: none;
		cursor: pointer;
		opacity: 0.6;
		transition: transform 0.15s;
	}
	.widget-collapse.open {
		transform: rotate(90deg);
	}
	.widget-collapse:hover {
		color: var(--fg);
		opacity: 1;
	}
	.widget-head {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 28px;
		padding: 0 8px 0 2px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 600;
		line-height: 22px;
		overflow: hidden;
	}
	.widget-head:hover {
		background: var(--hl-med);
	}
	.widget.current .widget-head {
		background: var(--hl-med);
	}
	.widget-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	/* Anytype widget cards: subtle solid, 12px radius, 8px padding. */
	/* Anytype widgetSection: name on the sidebar background (nameWrap
	   padding 0 4px), items in their own rounded card. */
	.section {
		display: flex;
		flex-direction: column;
	}
	.type-row {
		display: flex;
		align-items: center;
		border-radius: 6px;
	}
	.type-row.current {
		background: var(--hover);
	}
	.type-chev {
		flex: none;
		width: 18px;
		font-size: 8px;
		color: var(--muted);
		background: none;
		border: none;
		cursor: pointer;
		transition: transform 0.12s;
	}
	.type-chev.open {
		transform: rotate(90deg);
	}
	.type-link {
		flex: 1;
		min-width: 0;
	}
	.type-objs .item.sub {
		padding-left: 32px;
	}
	.type-empty {
		display: block;
		padding: 3px 8px 3px 32px;
		font-size: 11px;
		color: var(--muted);
	}
	.section-body {
		background: var(--hl-light);
		border-radius: 12px;
		padding: 8px;
	}
	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	/* Faint add affordance (Anytype nameWrap buttons). */
	.section-add {
		background: none;
		border: none;
		color: var(--muted);
		opacity: 0.5;
		font-size: 12px;
		width: 20px;
		height: 20px;
		border-radius: 4px;
		cursor: pointer;
		margin-right: 2px;
	}
	.section-add:hover {
		opacity: 1;
		background: var(--hl-med);
		color: var(--fg);
	}
	/* Anytype nameWrap: 12px/18px medium, sentence case, secondary. */
	.section-name {
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		font-size: 11px;
		font-weight: 600;
		line-height: 18px;
		font-family: inherit;
		color: var(--muted);
		padding: 2px 8px 6px;
		cursor: pointer;
		transition: color 0.15s;
	}
	.section-name:hover {
		color: var(--fg);
	}
	.section-arrow {
		font-size: 8px;
		display: inline-block;
		transition: transform 0.15s;
		opacity: 0.7;
	}
	.section-arrow.open {
		transform: rotate(90deg);
	}
	.section-head {
		padding: 0 4px;
	}
	/* Anytype tree item: 28px row, 6px radius, highlight-medium hover. */
	.item {
		display: flex;
		align-items: center;
		gap: 6px;
		height: 26px;
		padding: 0 8px;
		border-radius: 6px;
		font-size: 13px;
		line-height: 22px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.item:hover {
		background: var(--hl-med);
	}
	.item.current {
		background: var(--hl-med);
	}
	.obj-icon {
		color: var(--accent);
		flex: none;
		width: 20px;
		text-align: center;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 0 8px;
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
	/* Anytype-style tooltip: delayed dark pill below the control. */
	[data-tip] {
		position: relative;
	}
	[data-tip]:hover::after {
		content: attr(data-tip);
		position: absolute;
		top: calc(100% + 6px);
		left: 50%;
		transform: translateX(-50%);
		background: var(--panel);
		color: var(--fg);
		border: 1px solid var(--border);
		box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
		font-size: 11px;
		font-weight: 400;
		padding: 3px 8px;
		border-radius: 6px;
		white-space: nowrap;
		z-index: 80;
		pointer-events: none;
		opacity: 0;
		animation: tip-in 0.12s ease 0.4s forwards;
	}
	@keyframes tip-in {
		to {
			opacity: 1;
		}
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
		background: var(--accent);
		color: #fff;
	}
	.more-menu .danger {
		color: var(--red);
	}
	.more-menu > button.danger:hover {
		background: var(--red);
		color: #fff;
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
	.rail-img {
		width: 100%;
		height: 100%;
		border-radius: inherit;
		object-fit: cover;
	}
	.path-img {
		width: 18px;
		height: 18px;
		border-radius: 5px;
		object-fit: cover;
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

	/* ── Mobile shell (<=720px): Spaces list -> channel home -> object ── */
	.m-shell {
		/* viewport-fit=cover extends the page under the notch - without
		   this the header buttons sit inside the status bar where iOS
		   does not deliver taps. */
		padding-top: env(safe-area-inset-top);
		display: flex;
		flex-direction: column;
		height: 100dvh;
		background: var(--bg);
		color: var(--fg);
	}
	.m-screen {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: calc(env(safe-area-inset-top, 0px) + 12px) 14px 0;
	}
	.m-head {
		display: flex;
		flex-direction: column;
		align-items: stretch;
		margin-bottom: 14px;
	}
	.m-title {
		font-size: 32px;
		font-weight: 700;
		letter-spacing: -0.01em;
	}
	.m-head-top {
		display: flex;
		justify-content: flex-end;
		padding-bottom: 10px;
	}
	.m-avatar {
		padding: 0;
		overflow: hidden;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: var(--hover);
		border: 1px solid var(--border);
		color: var(--fg);
		font-size: 16px;
		cursor: pointer;
	}
	.m-cards {
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding-bottom: 12px;
	}
	.m-card {
		display: flex;
		align-items: center;
		gap: 12px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 14px;
		color: var(--fg);
		text-align: left;
		cursor: pointer;
		min-height: 64px;
	}
	/* Held card lifts off the list; the accent line shows where releasing
	   will drop it. touch-action keeps the hold from scrolling the page. */
	.m-card {
		position: relative;
		touch-action: pan-y;
	}
	.m-card.lifted {
		transform: scale(1.03);
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.45);
		border-color: var(--accent);
		z-index: 2;
	}
	.m-card.over-before::before,
	.m-card.over-after::after {
		content: "";
		position: absolute;
		left: 8px;
		right: 8px;
		height: 2px;
		border-radius: 2px;
		background: var(--accent);
	}
	.m-card.over-before::before {
		top: -5px;
	}
	.m-card.over-after::after {
		bottom: -5px;
	}
	.m-card.add {
		justify-content: center;
		color: var(--muted);
		min-height: 0;
		padding: 12px;
	}
	.m-card-icon {
		flex: none;
		width: 44px;
		height: 44px;
		border-radius: 10px;
		background: var(--hover);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 22px;
		overflow: hidden;
	}
	.m-card-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.m-card-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.m-card-name {
		font-size: 16px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m-card-sub {
		font-size: 13px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m-card-side {
		flex: none;
		font-size: 12px;
		color: var(--muted);
	}
	.m-bottom {
		display: flex;
		gap: 10px;
		padding: 10px 0 calc(env(safe-area-inset-bottom, 0px) + 12px);
	}
	.m-search {
		flex: 1;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		font-size: 15px;
		padding: 12px 16px;
		text-align: left;
		cursor: pointer;
	}
	.m-compose {
		width: 46px;
		height: 46px;
		border-radius: 50%;
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		font-size: 22px;
		cursor: pointer;
	}
	header.m-top {
		margin: 0;
		max-width: none;
		border-bottom: none;
	}
	.m-top {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: calc(env(safe-area-inset-top, 0px) + 10px) 12px 10px;
		background: var(--bg);
		flex: none;
		min-height: 56px;
		z-index: 10;
	}
	.m-btn {
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		font-size: 19px;
		cursor: pointer;
		/* Inline SVGs ride the text baseline - flex-center them dead-on. */
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.m-btn :global(svg) {
		display: block;
	}
	.m-top-spacer {
		flex: 1;
	}
	.m-sync {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--panel);
		border: 1px solid var(--border);
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.m-sync-dot {
		display: block;
		flex: none;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--muted);
	}
	.m-sync.ok .m-sync-dot {
		background: var(--green);
	}
	.m-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: none;
	}
	.m-obj {
		position: absolute;
		left: 50%;
		transform: translateX(-50%);
		max-width: 46%;
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 16px;
		font-weight: 600;
		pointer-events: none;
	}
	.m-obj-name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m-main {
		flex: 1;
		min-height: 0;
		width: 100%;
		max-width: 100%;
		/* min-width 0 is load-bearing: as a flex item, min-width:auto let
		   one wide row (e.g. an unbreakable code/npub line) blow the whole
		   page out to its min-content and create a horizontal scrollbar. */
		min-width: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.m-ch-head {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 4px 16px;
	}
	.m-ch-icon {
		width: 52px;
		height: 52px;
		border-radius: 12px;
		background: var(--hover);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 26px;
		overflow: hidden;
		flex: none;
	}
	.m-ch-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.m-ch-name {
		font-size: 20px;
		font-weight: 700;
	}
	.m-ch-sub {
		font-size: 13px;
		color: var(--muted);
	}
	.m-cards-col {
		display: flex;
		flex-direction: column;
		gap: 10px;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
		padding-bottom: 12px;
	}
	.m-wcard {
		/* flex: none is load-bearing - overflow:hidden gives a flex item
		   an automatic min-height of 0, so the scroll column was crushing
		   these cards to their borders when content overflowed. */
		flex: none;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		overflow: hidden;
	}
	.m-wcard-head {
		display: flex;
		align-items: center;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		font-size: 15px;
		font-weight: 600;
		padding: 0;
		cursor: pointer;
		text-align: left;
	}
	.m-wcard-link {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 6px 12px 16px;
		color: var(--fg);
		text-decoration: none;
	}
	/* Fixed icon box: emoji widths vary wildly, which staggered every
	   card's text start and made rows read as off-center. */
	.m-wcard-link :global(.obj-icon),
	.m-wcard-link .obj-icon {
		flex: none;
		width: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		line-height: 1;
	}
	.m-chev-btn {
		flex: none;
		background: none;
		border: none;
		color: var(--fg);
		padding: 12px 14px;
		cursor: pointer;
	}
	.m-wcard-name {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.m-chev {
		color: var(--muted);
		font-size: 13px;
		transition: transform 0.12s;
	}
	.m-chev.open {
		transform: rotate(180deg);
	}
	.m-wcard-body {
		padding: 0 10px 10px;
	}
	/* A pinned object with no preview (notes, pages) renders an empty
	   body - its bottom padding pushed the header row visually high. */
	.m-wcard-body:empty {
		display: none;
	}
	.m-section-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		background: none;
		border: none;
		color: var(--muted);
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 10px 4px 6px;
		cursor: pointer;
		text-align: left;
	}
	.m-section-head {
		display: flex;
		align-items: center;
	}
	.m-section-head .m-section-label {
		flex: 1;
	}
	.m-section-add {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		/* 44px: the minimum comfortable touch target. */
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		background: none;
		border: none;
		color: var(--muted);
		font-size: 17px;
		line-height: 1;
		cursor: pointer;
	}
	.m-section-body {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 4px 10px 8px;
		margin-bottom: 6px;
	}
	/* Divider between rows inside the card, desktop-list style. */
	.m-section-body .m-row + .m-row {
		border-top: 1px solid var(--border);
		border-radius: 0;
	}
	.m-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 9px 6px;
		color: var(--fg);
		text-decoration: none;
		font-size: 14px;
		border-radius: 8px;
	}
	.m-row:active {
		background: var(--hover);
	}
	.m-create-menu {
		position: fixed;
		left: 14px;
		right: 14px;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 72px);
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 14px;
		padding: 6px;
		z-index: 70;
		display: flex;
		flex-direction: column;
	}
	.m-create-menu button {
		display: flex;
		align-items: center;
		gap: 10px;
		background: none;
		border: none;
		color: var(--fg);
		font-size: 15px;
		padding: 11px 10px;
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
	}
	.m-create-menu button:hover {
		background: var(--hover);
	}
	.more-wrap {
		position: relative;
	}
	/* Modals go full-screen on mobile. */
	@media (max-width: 720px) {
		:global(.overlay) {
			padding: 0 !important;
		}
		/* .sheet modals (Settings) opt out: they are bottom sheets with
		   their own height/drag behavior. */
		:global(.overlay .modal:not(.sheet)) {
			width: 100% !important;
			max-width: none !important;
			height: 100dvh !important;
			max-height: none !important;
			border-radius: 0 !important;
		}
	}
	.m-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: 50%;
		display: block;
	}
	/* App-like mobile scrolling: no overlay scrollbar riding on top of
	   card content (iOS draws it over the rounded cards). */
	.m-cards,
	.m-main,
	.m-cards-col {
		scrollbar-width: none;
	}
	.m-cards::-webkit-scrollbar,
	.m-main::-webkit-scrollbar,
	.m-cards-col::-webkit-scrollbar {
		display: none;
	}
	.menu-graph-icon {
		display: inline-flex;
		vertical-align: -2px;
		margin-right: 2px;
	}
</style>