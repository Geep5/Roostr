<script lang="ts">
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { activeSpace } from "$lib/space.svelte";
	import { space as spaceApi, note, fetchObject, fetchQuery } from "$lib/api";
	import { objectIcon } from "$lib/icons";
	import { discussionUI, store, refreshAll, connectEvents } from "$lib/data.svelte";
	import GraphIcon from "$lib/components/GraphIcon.svelte";
	import PinnedWidget from "$lib/components/PinnedWidget.svelte";
	import { creatableTypes, typeGlyph, createTyped, createCollection, createQuery, seedSpaceDefaults } from "$lib/create";
	import { CREATABLE_FORMATS, RESERVED_KEYS, createRelation, formatGlyph, spaceRelations } from "$lib/relations";
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
	const objectRelation = $derived(objectId ? store.relations.find((r) => r.id === objectId) : undefined);

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
	let profileName = $state("");
	$effect(() => {
		try {
			const cached = JSON.parse(localStorage.getItem("roostr-profile") ?? "{}") as { picture?: string; name?: string; display_name?: string };
			profilePic = cached.picture ?? "";
			profileName = cached.display_name || cached.name || "";
		} catch {
			/* no cache */
		}
		void fetch("http://127.0.0.1:7334/profile")
			.then((r) => r.json())
			.then((p: { picture?: string; name?: string; display_name?: string }) => {
				profilePic = p.picture ?? "";
				profileName = p.display_name || p.name || "";
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

	// ── Property deletion: the value is stripped from every object
	// holding it, then the relation object itself is vanished. ──────
	let confirmDeleteProp = $state(false);
	let deletingProp = $state(false);
	let propUsage = $state(-1);

	async function openDeleteProperty() {
		if (!objectRelation) return;
		showMore = false;
		propUsage = -1;
		confirmDeleteProp = true;
		const res = await fetchQuery({ filters: [{ key: objectRelation.key, condition: "exists" }], limit: 1000 });
		propUsage = res.records.filter((r) => r.id !== objectRelation!.id && r.typeKey !== "relation" && r.typeKey !== "type").length;
	}

	async function deleteProperty() {
		const rel = objectRelation;
		if (!rel || deletingProp) return;
		deletingProp = true;
		try {
			// Page until exhausted - a property can live on >1000 objects.
			for (;;) {
				const res = await fetchQuery({ filters: [{ key: rel.key, condition: "exists" }], limit: 1000 });
				const victims = res.records.filter((r) => r.id !== rel.id && r.typeKey !== "relation" && r.typeKey !== "type");
				if (victims.length === 0) break;
				for (const r of victims) await note.deleteField(r.id, rel.key);
			}
			await note.vanish(rel.id);
			confirmDeleteProp = false;
			await refreshAll();
			await goto("/");
		} finally {
			deletingProp = false;
		}
	}

	let showTypePick = $state(false);

	/** Retype the current object in place (blocks and fields survive). */
	async function changeType(typeKey: string) {
		if (!objectId) return;
		await note.setType(objectId, typeKey);
		await refreshAll();
	}

	async function moveToBin() {
		if (!objectId) return;
		await note.del(objectId);
		await refreshAll();
		await goto("/");
	}

	/** Copy the object's id - the stable handle for referencing it to an
	 * agent (object_get, links, queries). Carries no access. */
	async function copyObjectId() {
		if (!objectSummary) return;
		await navigator.clipboard.writeText(objectSummary.id);
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
		await seedSpaceDefaults(id);
		await refreshAll();
		selectSpace(id);
	}

	/** Create a type object (Anytype: U.Object.createType); opens its page. */
	const sidebarProps = $derived(
		spaceRelations(store.relations, activeSpace.id || defaultChannelId)
			.filter((r) => !r.hidden && !RESERVED_KEYS[r.key])
			.toSorted((a, b) => (a.name || a.key).localeCompare(b.name || b.key)),
	);

	/** Spaces are fully self-contained: only this space's types. */
	const sidebarTypes = $derived(store.types.filter((t) => t.space === (activeSpace.id || defaultChannelId)));

	async function newProperty() {
		const name = prompt("Property name:");
		if (!name?.trim()) return;
		const fmt = prompt(`Format (${CREATABLE_FORMATS.join(", ")}):`, "shorttext")?.trim() ?? "";
		if (!(CREATABLE_FORMATS as readonly string[]).includes(fmt)) {
			if (fmt) alert(`Unknown format "${fmt}".`);
			return;
		}
		const rel = await createRelation(name.trim(), fmt);
		if (rel) await goto(`/object/${rel.id}`);
	}

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
			channel: { stringValue: activeSpace.id || defaultChannelId },
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
	// ── Resizable sidebar (invisible drag strip on its right edge) ──
	let sideWidth = $state(typeof localStorage === "undefined" ? 220 : parseInt(localStorage.getItem("side-width") ?? "220") || 220);
	/** Anytype vault: the icon rail pulls out continuously - width follows
	 * the pointer; releasing below the threshold collapses back to icons.
	 * A plain click on the gutter toggles between icons and the last width. */
	const RAIL_MIN = 56;
	const RAIL_MAX = 320;
	let railWidth = $state(
		typeof localStorage === "undefined"
			? 56
			: parseInt(localStorage.getItem("rail-width") ?? "") || (localStorage.getItem("rail-wide") === "1" ? 236 : 56),
	);
	let railWideWidth = $state(typeof localStorage === "undefined" ? 236 : parseInt(localStorage.getItem("rail-width-wide") ?? "") || 236);
	let railDragging = $state(false);
	const railWide = $derived(railWidth > 100);
	function railPersist() {
		localStorage.setItem("rail-width", String(railWidth));
		if (railWidth > 100) localStorage.setItem("rail-width-wide", String(railWidth));
	}
	function railToggle() {
		railWidth = railWidth > 100 ? RAIL_MIN : Math.max(160, railWideWidth);
		railPersist();
	}
	function railResizeStart(e: PointerEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = railWidth;
		let moved = false;
		railDragging = true;
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - startX;
			if (Math.abs(dx) > 4) moved = true;
			railWidth = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startW + dx));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			railDragging = false;
			if (!moved) {
				railToggle();
				return;
			}
			if (railWidth < 140) railWidth = RAIL_MIN;
			else railWideWidth = railWidth;
			railPersist();
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	function sideResizeStart(e: PointerEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = sideWidth;
		const move = (ev: PointerEvent) => {
			sideWidth = Math.min(480, Math.max(180, startW + ev.clientX - startX));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			localStorage.setItem("side-width", String(sideWidth));
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}

	let sectionCollapsed = $state<Record<string, boolean>>(
		typeof localStorage === "undefined" ? {} : JSON.parse(localStorage.getItem("section-collapsed") ?? "{}"),
	);
	function flipSection(id: string) {
		sectionCollapsed[id] = !sectionCollapsed[id];
		localStorage.setItem("section-collapsed", JSON.stringify(sectionCollapsed));
	}

	let showSettings = $state(false);
	let showMachine = $state(false);
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
					await seedSpaceDefaults(id);
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
			{#if objectRelation}
				<div class="m-actions">
				<span class="m-sync" class:ok={store.connected} data-tip={store.connected ? "Local daemon live" : "Daemon offline"}><span class="m-sync-dot"></span></span>
				<div class="more-wrap">
					<button class="m-btn" data-tip="More" onclick={() => { showMore = !showMore; showCollections = false; }}>⋯</button>
					{#if showMore}
						<div class="more-menu">
							<button onclick={() => { showMore = false; void goto(`/graph?focus=${objectId}`); }}>
								<span class="menu-graph-icon"><GraphIcon size={14} /></span> Graph
							</button>
							<div class="menu-sep"></div>
							<button class="danger" onclick={() => void openDeleteProperty()}>🗑 Delete property</button>
						</div>
					{/if}
				</div>
				</div>
			{:else if objectSummary}
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
							<button onclick={() => (showTypePick = !showTypePick)}>⇄ Change type ▸</button>
							{#if showTypePick}
								<div class="submenu">
									{#each sidebarTypes.filter((t) => t.key !== objectSummary?.typeKey) as t (t.id)}
										<button onclick={() => { showMore = false; showTypePick = false; void changeType(t.key); }}>{t.icon || typeGlyph(t.key)} {t.name || t.key}</button>
									{/each}
								</div>
							{/if}
							<button onclick={() => { showMore = false; void duplicateObject(); }}>⧉ Duplicate</button>
							{#if owningSpaceOf(objectSummary.channelId)}
								<button onclick={() => { showMore = false; void copyObjectId(); }}>⧉ Copy ID</button>
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
					<button class="m-avatar" data-tip="This machine" aria-label="This machine" onclick={() => (showMachine = true)}>
						<svg style="width:17px;height:17px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/></svg>
					</button>
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
				<div class="m-section">
					<div class="m-section-head">
						<button class="m-section-label" onclick={() => (mCollapsed["__props"] = !mCollapsed["__props"])}>Properties</button>
						{#if !mCollapsed["__props"]}
							<button class="m-section-add" aria-label="New property" onclick={() => void newProperty()}>＋</button>
						{/if}
						<button class="m-chev-btn" aria-label={mCollapsed["__props"] ? "Expand" : "Collapse"} onclick={() => (mCollapsed["__props"] = !mCollapsed["__props"])}>
							<span class="m-chev" class:open={!mCollapsed["__props"]}>⌄</span>
						</button>
					</div>
					{#if !mCollapsed["__props"]}
						<div class="m-section-body">
							{#each sidebarProps as r (r.id)}
								<a class="m-row" href="/object/{r.id}">
									<span class="obj-icon">{r.iconEmoji || formatGlyph(r.format)}</span>{r.name || r.key}
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
					<div class="m-section-head">
						<button class="m-section-label" onclick={() => (mCollapsed["__recent"] = !mCollapsed["__recent"])}>Recently edited</button>
						<button class="m-chev-btn" aria-label={mCollapsed["__recent"] ? "Expand" : "Collapse"} onclick={() => (mCollapsed["__recent"] = !mCollapsed["__recent"])}>
							<span class="m-chev" class:open={!mCollapsed["__recent"]}>⌄</span>
						</button>
					</div>
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
						<button class="m-section-label" onclick={() => (mCollapsed["__types"] = !mCollapsed["__types"])}>Types</button>
						<!-- Types are only creatable from here on mobile: the bottom ＋
						     composes objects, not types. A collapsed section hides its
						     ＋ - the chevron holds the right edge. -->
						{#if !mCollapsed["__types"]}
							<button class="m-section-add" aria-label="New type" onclick={() => void newType()}>＋</button>
						{/if}
						<button class="m-chev-btn" aria-label={mCollapsed["__types"] ? "Expand" : "Collapse"} onclick={() => (mCollapsed["__types"] = !mCollapsed["__types"])}>
							<span class="m-chev" class:open={!mCollapsed["__types"]}>⌄</span>
						</button>
					</div>
					{#if !mCollapsed["__types"]}
						<div class="m-section-body">
							{#each sidebarTypes as t (t.id)}
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
<div class="shell" style="grid-template-columns: {railWidth}px {sideWidth}px 1fr;{railDragging ? ' transition: none;' : ''}">
	<nav class="vault" class:wide={railWide}>
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
				<span class="space-ico">
					{#if c.icon?.startsWith("http")}
						<img class="rail-img" src={c.icon} alt={c.name} />
					{:else}
						{c.icon || c.name.slice(0, 1).toUpperCase() || "?"}
					{/if}
				</span>
				{#if railWide}<span class="space-label">{c.name}</span>{/if}
			</button>
		{/each}
		<button class="space add" title="New space" onclick={() => void newSpace()}><span class="space-ico">+</span>{#if railWide}<span class="space-label">New space</span>{/if}</button>
		<div class="rail-spacer"></div>
		<!-- Your identity opens Settings - the avatar when the profile has
		     one, a person glyph otherwise (the gear lives inside). -->
		<button class="space settings" title="This machine — integrations &amp; holdups" onclick={() => (showMachine = true)}>
			<span class="space-ico"><svg style="width:17px;height:17px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="15" x2="23" y2="15"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="15" x2="4" y2="15"/></svg></span>
			{#if railWide}<span class="space-label">This machine</span>{/if}
		</button>
		<button class="space settings" title="Settings" onclick={() => (showSettings = true)}>
			<span class="space-ico round">{#if profilePic}<img class="rail-avatar" src={profilePic} alt="" />{:else}<svg style="width:18px;height:18px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>{/if}</span>
			{#if railWide}<span class="space-label">{profileName ? `@${profileName.replace(/^@/, "")}` : "Settings"}</span>{/if}
		</button>
		<div class="rail-resize" role="separator" aria-orientation="vertical" onpointerdown={railResizeStart}><div class="rail-handle"></div></div>
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
						{#each sidebarTypes as t (t.id)}
							<!-- A type row is just a link to its page - the objects live
							     THERE (the type page's set view), not in the nav. -->
							<div class="type-row" class:current={page.url.pathname === `/object/${t.id}`}>
								<a class="item type-link" href="/object/{t.id}">
									<span class="obj-icon">{t.icon || typeGlyph(t.key)}</span>{t.name || t.key}
								</a>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div class="section">
				<div class="section-head">
					<button class="section-name" onclick={() => flipSection("props")}>
						<span class="section-arrow" class:open={!sectionCollapsed["props"]}>▶</span>Properties
					</button>
					<button class="section-add" title="New property" onclick={() => void newProperty()}>＋</button>
				</div>
				{#if !sectionCollapsed["props"]}
					<div class="section-body">
						{#each sidebarProps as r (r.id)}
							<a class="item" class:current={page.url.pathname === `/object/${r.id}`} href="/object/{r.id}">
								<span class="obj-icon">{r.iconEmoji || formatGlyph(r.format)}</span>{r.name || r.key}
							</a>
						{/each}
						{#if sidebarProps.length === 0}
							<span class="none">No properties yet</span>
						{/if}
					</div>
				{/if}
			</div>

		{/if}
		<div class="side-resize" role="separator" aria-orientation="vertical" onpointerdown={sideResizeStart}></div>
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
				{#if discussionUI.available}
					<button class="hbtn disc-chip" class:active={discussionUI.open} data-tip="Discussion" onclick={() => (discussionUI.open = !discussionUI.open)}>
						💬{#if discussionUI.convCount > 1}<span class="disc-n">{discussionUI.convCount}</span>{:else if discussionUI.count > 0}<span class="disc-n">{discussionUI.count}</span>{/if}
					</button>
				{/if}
				{#if objectRelation}
					<div class="more-wrap">
						<button class="hbtn" data-tip="More" onclick={() => { showMore = !showMore; showCollections = false; }}>⋯</button>
						{#if showMore}
							<div class="more-menu">
								<button class="danger" onclick={() => void openDeleteProperty()}>🗑 Delete property</button>
							</div>
						{/if}
					</div>
				{:else if objectSummary}
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
								<button onclick={() => (showTypePick = !showTypePick)}>⇄ Change type ▸</button>
								{#if showTypePick}
									<div class="submenu">
										{#each sidebarTypes.filter((t) => t.key !== objectSummary?.typeKey) as t (t.id)}
											<button onclick={() => { showMore = false; showTypePick = false; void changeType(t.key); }}>{t.icon || typeGlyph(t.key)} {t.name || t.key}</button>
										{/each}
									</div>
								{/if}
								<button onclick={() => { showMore = false; void duplicateObject(); }}>⧉ Duplicate</button>
								{#if owningSpaceOf(objectSummary.channelId)}
									<button onclick={() => { showMore = false; void copyObjectId(); }}>⧉ Copy ID</button>
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
	<button class="menu-backdrop" aria-label="Close menu" onclick={() => { showMore = false; showCollections = false; showTypePick = false; showCreate = false; }}></button>
{/if}
		<main>{@render children()}</main>
	</div>
</div>
{/if}

{#if confirmDeleteProp && objectRelation}
	<div class="prop-del-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget && !deletingProp) confirmDeleteProp = false; }}>
		<div class="prop-del-modal" role="dialog" aria-label="Delete property">
			<h3>Delete "{objectRelation.name || objectRelation.key}"?</h3>
			<p class="hint">
				This deletes the property and removes its value from
				{propUsage < 0 ? "…" : `${propUsage} object${propUsage === 1 ? "" : "s"}`}
				— on every device, forever. This cannot be undone.
			</p>
			<div class="prop-del-row">
				<button onclick={() => (confirmDeleteProp = false)} disabled={deletingProp}>Cancel</button>
				<button class="danger" onclick={() => void deleteProperty()} disabled={deletingProp}>{deletingProp ? "Deleting…" : "Delete property"}</button>
			</div>
		</div>
	</div>
{/if}

{#if showSettings}
	{#await import("$lib/components/Settings.svelte") then { default: Settings }}
		<Settings onclose={() => (showSettings = false)} />
	{/await}
{/if}

{#if showMachine}
	{#await import("$lib/components/Machine.svelte") then { default: Machine }}
		<Machine onclose={() => (showMachine = false)} />
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
		transition: grid-template-columns 0.16s ease;
	}
	/* Anytype pageVault: a rounded solid card, no border — panes separate
	   by background, not lines. */
	.vault {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 12px 0;
		margin: 6px 0 6px 6px;
		background: var(--panel);
		border-radius: 16px;
	}
	.vault.wide {
		align-items: stretch;
		padding: 10px 8px;
	}
	/* Anytype's sidebar resizer, verbatim proportions: a 12px hit zone
	   entirely in the gap between the space rail and the nav pane, holding
	   a small centered pill that fades in on hover and stretches while
	   dragging. Never overlaps either panel. */
	.rail-resize {
		position: absolute;
		top: 0;
		bottom: 0;
		right: -12px;
		width: 12px;
		cursor: col-resize;
		z-index: 60;
		touch-action: none;
	}
	.rail-handle {
		position: absolute;
		left: 0;
		top: 50%;
		margin: -16px 0 0;
		width: 100%;
		height: 32px;
		transition: all 0.15s cubic-bezier(0.22, 1, 0.36, 1);
	}
	.rail-handle::after {
		content: "";
		position: absolute;
		left: 50%;
		top: 0;
		width: 6px;
		height: 100%;
		margin-left: -3px;
		border-radius: 3px;
		background: var(--hover);
		opacity: 0;
		transition: all 0.15s cubic-bezier(0.22, 1, 0.36, 1);
	}
	.rail-resize:hover .rail-handle::after,
	.rail-resize:active .rail-handle::after {
		opacity: 1;
	}
	.rail-resize:active .rail-handle {
		height: 64px;
		margin-top: -32px;
	}
	.rail-handle:hover::after,
	.rail-handle:active::after {
		background: #47474d;
	}
	.space {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 36px;
		height: 36px;
		padding: 0;
		border: none;
		background: none;
		color: var(--fg);
		font-size: 15px;
		cursor: pointer;
		border-radius: 10px;
	}
	.space-ico {
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex: none;
		border-radius: 10px;
		border: 1px solid var(--border);
		background: var(--panel);
		overflow: hidden;
	}
	.space-ico.round {
		border-radius: 50%;
		border: none;
		background: none;
	}
	.space-label {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 14.5px;
		font-weight: 500;
		text-align: left;
	}
	.vault.wide .space {
		width: 100%;
		height: 42px;
		padding: 3px 5px;
		border-radius: 12px;
	}
	.vault.wide .space:hover,
	.vault.wide .space.active {
		background: var(--hover);
	}
	.vault.wide .space.active {
		box-shadow: none;
	}
	.vault.wide .space-ico {
		width: 32px;
		height: 32px;
		border-radius: 9px;
		font-size: 14px;
	}
	.vault.wide .space-ico.round {
		border-radius: 50%;
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
		font-size: 17px;
	}
	.space.settings .space-ico {
		/* The avatar IS the icon: a clean circle clipping the image. */
		overflow: hidden;
	}
	.space.settings:hover {
		color: var(--fg);
		background: var(--hl-med);
	}
	.widgets {
		position: relative;
		padding: 10px 8px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	/* Invisible grab strip on the pane's right edge - only the cursor
	   betrays it. Absolute top+bottom spans the full scroll content, so
	   the visible edge is always draggable at any scroll position. */
	.side-resize {
		position: absolute;
		top: 0;
		bottom: 0;
		right: 0;
		width: 8px;
		cursor: col-resize;
		z-index: 40;
		touch-action: none;
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
	.type-link {
		flex: 1;
		min-width: 0;
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
		/* The hover square is 20px, so the glyph has to be centred in it
		   rather than sitting on the text baseline inside the browser's
		   default 1px 6px button padding - that left 8px of content box
		   for a fullwidth ＋ and pushed it 2px right of centre. */
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		line-height: 1;
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
	/* Screen 2's header lives inside the padded m-screen, which would
	   double both the inset and the safe-area (back button drifts 14px
	   right and one notch down vs the object header). Pull it back to
	   the viewport edges so every back button sits in ONE place. */
	.m-screen > .m-top {
		margin: calc(-1 * (env(safe-area-inset-top, 0px) + 12px)) -14px 0;
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
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		font-size: 13px;
		/* A flexed 1em box centers the ⌄ glyph; the flex row does the rest. */
		line-height: 1;
		height: 1em;
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
	.prop-del-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
	}
	.prop-del-modal {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 20px;
		width: min(420px, calc(100vw - 40px));
	}
	.prop-del-modal h3 {
		margin: 0 0 8px;
		font-size: 16px;
	}
	.prop-del-modal .hint {
		color: var(--muted);
		font-size: 13px;
		margin: 0 0 14px;
		line-height: 1.5;
	}
	.prop-del-row {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.prop-del-row button {
		border: 1px solid var(--border);
		background: none;
		color: var(--fg);
		border-radius: 8px;
		padding: 7px 14px;
		cursor: pointer;
		font-size: 13px;
	}
	.prop-del-row button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.prop-del-row .danger {
		border-color: var(--red);
		color: var(--red);
	}
	.prop-del-row .danger:hover:not(:disabled) {
		background: var(--red);
		color: #fff;
	}
	.rail-avatar {
		width: 100%;
		height: 100%;
		object-fit: cover;
		border-radius: 50%;
		display: block;
	}
	.disc-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.disc-chip.active {
		color: var(--accent);
	}
	.disc-n {
		font-size: 11px;
		color: var(--muted);
	}
	.disc-chip.active .disc-n {
		color: var(--accent);
	}
</style>