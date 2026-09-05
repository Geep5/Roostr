<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { engineFiltersOf, spaceFilterOf } from "$lib/filters";
	import { spaceRelations } from "$lib/relations";
	import { fetchObject, fetchQuery, note } from "$lib/api";
	import { discussionUI, store, refreshAll, onObjectEvent, layoutOf } from "$lib/data.svelte";
	import Editor from "$lib/components/Editor.svelte";
	import FeaturedProps from "$lib/components/FeaturedProps.svelte";
	import Discussion from "$lib/components/Discussion.svelte";
	import ConversationDrawer from "$lib/components/ConversationDrawer.svelte";
	import { loadAgentThreads } from "$lib/conversations";
	import SetTable from "$lib/components/SetTable.svelte";
	import QueryControls from "$lib/components/QueryControls.svelte";
	import KanbanView from "$lib/components/KanbanView.svelte";
	import CalendarView from "$lib/components/CalendarView.svelte";
	import GalleryView from "$lib/components/GalleryView.svelte";
	import SpaceManage from "$lib/components/SpaceManage.svelte";
	import TypePanel from "$lib/components/TypePanel.svelte";
	import PropertyPanel from "$lib/components/PropertyPanel.svelte";
	import AgentBoard from "$lib/components/AgentBoard.svelte";
	import EmojiPicker from "$lib/components/EmojiPicker.svelte";
	import { objectIcon } from "$lib/icons";

	let object = $state<ObjectJSON>();
	let editor = $state<Editor>();
	let table = $state<SetTable>();
	let queryControls = $state<{ createRecord: (name?: string) => Promise<void> } | undefined>();

	/** Table-view New: the record joins the view (collection membership
	 *  included) - Anytype's inline entry row. */
	async function onRecordCreated(id: string) {
		if (isCollection) await setMembers([...memberIds, id]);
		await refresh();
		await table?.reload();
	}

	// Client-side load keyed on the route param; re-fetches on navigation.
	$effect(() => {
		const id = page.params.id;
		if (!id) return;
		object = undefined;
		void fetchObject(id).then((o) => {
			if (page.params.id !== id) return;
			// Agents have no page of their own — they're managed in channel
			// settings (and deleting the object there once looked like
			// deleting "all agents").
			if (o.typeKey === "agent") {
				const ch = o.fields["channel"]?.stringValue || store.channels[0]?.id;
				if (ch) {
					void goto(`/object/${ch}`, { replaceState: true });
					return;
				}
			}
			// Anytype's phone idiom: a chat object IS its discussion -
			// open the full-screen chat page on mobile.
			if (o.typeKey === "chat" && matchMedia("(max-width: 720px)").matches) {
				void goto(`/chat/${o.id}`, { replaceState: true });
				return;
			}
			object = o;
		});
	});

	async function refresh() {
		if (!object) return;
		object = await fetchObject(object.id);
	}

	let nameDraft = $state("");
	let titleEl = $state<HTMLInputElement>();
	let nameDraftFor = "";
	$effect(() => {
		const id = object?.id ?? "";
		const name = object ? fieldStr(object.fields, "name") : "";
		// Refreshes (template writes, SSE echoes) must not clobber live
		// typing: adopt server state only when switching objects or when
		// the title isn't being edited.
		if (id !== nameDraftFor || document.activeElement !== titleEl) {
			nameDraftFor = id;
			nameDraft = name;
		}
	});

	async function saveName() {
		if (!object || nameDraft === fieldStr(object.fields, "name")) return;
		await note.setField(object.id, "name", { stringValue: nameDraft });
		await refresh();
	}

	let showEmoji = $state(false);

	/** Anytype setIcon semantics: emoji and image are mutually exclusive. */
	async function setEmoji(value: string) {
		if (!object) return;
		const isImage = /^https?:\/\//.test(value);
		await note.setField(object.id, isImage ? "iconImage" : "iconEmoji", { stringValue: value });
		await note.deleteField(object.id, isImage ? "iconEmoji" : "iconImage").catch(() => {});
		await refresh();
	}

	// ── Query / collection tables ─────────────────────────────────
	const isQuery = $derived(object?.typeKey === "query" || object?.typeKey === "set");
	const isCollection = $derived(object?.typeKey === "collection");


	const isChat = $derived(object?.typeKey === "chat");
	const isAgent = $derived(object?.typeKey === "agent");
	const isType = $derived(object?.typeKey === "type");
	const isTemplate = $derived(object?.typeKey === "template");
	const isRelation = $derived(object?.typeKey === "relation");

	/** A template renders with its TARGET type's layout (so a task template shows the checkbox). */
	const effectiveTypeKey = $derived.by(() => {
		const o = object;
		if (!o) return "";
		if (o.typeKey !== "template") return o.typeKey;
		return store.types.find((t) => t.id === fieldStr(o.fields, "target_type"))?.key ?? "";
	});
	const isTaskLayout = $derived(!!object && layoutOf(effectiveTypeKey) === "task");
	const done = $derived(object?.fields["done"]?.boolValue === true);
	const templateTargetName = $derived.by(() => {
		const o = object;
		if (!o || o.typeKey !== "template") return "";
		return store.types.find((t) => t.id === fieldStr(o.fields, "target_type"))?.name ?? "";
	});

	async function toggleDone() {
		if (!object) return;
		await note.setField(object.id, "done", { boolValue: !done });
		await refresh();
	}

	const memberIds = $derived.by(() => {
		const items = object?.fields["collectionIds"]?.valuesValue?.items ?? [];
		return items.map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
	});

	/** Stored viewFilters → engine filter objects with format-aware value coercion. */
	const engineFilters = $derived.by((): Array<Record<string, unknown>> => (object ? engineFiltersOf(object, scopedRelations) : []));

	/** Pick-lists (columns, filters, featured props) offer only this
	 *  space's properties - spaces are self-contained. */
	const scopedRelations = $derived(object ? spaceRelations(store.relations, object.fields["channel"]?.stringValue || store.channels[0]?.id || "") : []);

	const viewSorts = $derived.by((): Array<{ key: string; type: "asc" | "desc" }> => {
		const items = object?.fields["viewSorts"]?.valuesValue?.items ?? [];
		const out: Array<{ key: string; type: "asc" | "desc" }> = [];
		for (const item of items) {
			const e = item.mapValue?.entries;
			if (!e) continue;
			const key = e["key"]?.stringValue;
			if (key) out.push({ key, type: e["type"]?.stringValue === "desc" ? "desc" : "asc" });
		}
		return out;
	});

	/** Live search text from the controls row (Anytype's dataview Filter). */
	let searchText = $state("");

	const tableBody = $derived.by((): Record<string, unknown> | null => {
		if (!object) return null;
		const text = searchText.trim() ? { textQuery: searchText.trim() } : {};
		// Spaces are self-contained: every set implicitly filters to the
		// owning space's objects.
		const spaceFilter = spaceFilterOf(object, store.channels[0]?.id ?? "");
		if (isQuery) return { setId: object.id, filters: [...engineFilters, spaceFilter], ...text };
		// A type page IS a set of its instances (Anytype's type view).
		if (isType) {
			const key = object.fields["key"]?.stringValue;
			if (!key) return null;
			return { type: key, filters: [...engineFilters, spaceFilter], ...text };
		}
		if (isCollection) {
			if (memberIds.length === 0) return null;
			// View filters stack on top of membership (AND semantics).
			return { filters: [{ key: "id", condition: "in", value: memberIds }, ...engineFilters, spaceFilter], ...text };
		}
		return null;
	});

	// Collection membership picker.
	let picking = $state(false);
	let candidates = $state<Array<{ id: string; name: string; typeKey: string }>>([]);

	async function openPicker() {
		if (!object) return;
		// Self-contained spaces: only this space's objects are addable.
		const res = await fetchQuery({ filters: [spaceFilterOf(object, store.channels[0]?.id ?? "")], limit: 200 });
		const HIDDEN: Record<string, true> = { program: true, typescript: true, json: true, proto: true, relation: true, collection: true, query: true, set: true, type: true, template: true, agent: true, skill: true };
		const currentId = object.id;
		candidates = res.records
			.filter((r) => r.id !== currentId && !memberIds.includes(r.id) && !HIDDEN[r.typeKey])
			.map((r) => ({ id: r.id, name: fieldStr(r.fields, "name") || r.id.slice(0, 8), typeKey: r.typeKey }));
		picking = true;
	}

	/** Anytype collection New: create an object and link it as a member. */
	async function newInCollection() {
		if (!object) return;
		const { id } = await note.create("", "note");
		await setMembers([...memberIds, id]);
		await goto(`/object/${id}`);
	}

	async function setMembers(ids: string[]) {
		if (!object) return;
		await note.setField(object.id, "collectionIds", {
			valuesValue: { items: ids.map((id) => ({ stringValue: id })) },
		});
		await refresh();
		await table?.reload();
	}

	// ── Channel + pinning ─────────────────────────────────────────
	const isChannel = $derived(object?.typeKey === "channel");

	// ── Discussion drawer (desktop): the page publishes availability +
	// count to the shared store; the header chip toggles it; the drawer
	// docks right so the doc stays readable beside the thread. ──
	let isMobileVp = $state(typeof matchMedia === "undefined" ? false : matchMedia("(max-width: 720px)").matches);
	$effect(() => {
		const mq = matchMedia("(max-width: 720px)");
		const fn = () => (isMobileVp = mq.matches);
		mq.addEventListener("change", fn);
		return () => mq.removeEventListener("change", fn);
	});
	const hasDiscussion = $derived(
		!!object && !isChannel && !isChat && !isAgent && !isType && !isTemplate && !isRelation && !isQuery && !isCollection,
	);
	$effect(() => {
		discussionUI.available = hasDiscussion && !isMobileVp;
		if (!object) {
			discussionUI.count = 0;
			return;
		}
		const root = object.blocks.find((b) => b.id === "__discussion__");
		const byId = new Map(object.blocks.map((b) => [b.id, b]));
		discussionUI.count = (root?.childrenIds ?? []).filter((c) => byId.get(c)?.content.custom?.contentType === "chat").length;
	});
	$effect(() => () => {
		discussionUI.available = false;
	});
	$effect(() => {
		if (!object || !hasDiscussion) return;
		const id = object.id;
		void loadAgentThreads(id).then((rows) => {
			if (page.params.id === id) discussionUI.convCount = rows.length + 1;
		});
	});
	let drawerTop = $state(0);
	$effect(() => {
		if (!discussionUI.open) return;
		const h = document.querySelector(".main-col > header");
		drawerTop = h ? Math.max(0, Math.round(h.getBoundingClientRect().bottom)) : 0;
	});
	let drawerW = $state(typeof localStorage === "undefined" ? 380 : parseInt(localStorage.getItem("disc-drawer-w") ?? "380") || 380);
	function drawerResizeStart(e: PointerEvent) {
		e.preventDefault();
		const startX = e.clientX;
		const startW = drawerW;
		const move = (ev: PointerEvent) => {
			drawerW = Math.min(640, Math.max(300, startW + (startX - ev.clientX)));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			localStorage.setItem("disc-drawer-w", String(drawerW));
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	}
	const spaceInfo = $derived(store.channels.find((c) => c.id === object?.id));


	onMount(() =>
		onObjectEvent((objectId) => {
			if (!object || objectId !== object.id) return;
			// Skip refresh while the user is actively typing (own writes echo back).
			if (editor && Date.now() - editor.lastEditAt() < 1200) return;
			void refresh();
			void table?.reload();
		}),
	);
</script>

<svelte:head><title>{object ? fieldStr(object.fields, "name") || "Untitled" : "Loading…"} — glon</title></svelte:head>

{#if object}
	<article>
		{#if !isTaskLayout}
			<!-- Anytype: the object icon sits ABOVE the title, aligned with the
			     content edge - not inline to its left. -->
			<div class="icon-wrap">
				<button
					class="obj-emoji"
					class:placeholder={!object.fields["iconEmoji"]?.stringValue}
					title="Set icon"
					onclick={() => (showEmoji = !showEmoji)}
				>
					{#if object.fields["iconImage"]?.stringValue}
						<img class="obj-img" src={object.fields["iconImage"].stringValue} alt="icon" />
					{:else}
						{objectIcon(object.fields["iconEmoji"]?.stringValue, object.typeKey)}
					{/if}
				</button>
				{#if showEmoji}
					<EmojiPicker
						withImage={true}
						onpick={(e) => {
							showEmoji = false;
							void setEmoji(e);
						}}
						onclose={() => (showEmoji = false)}
					/>
				{/if}
			</div>
		{/if}
		<div class="title-row" class:with-check={isTaskLayout}>
			{#if isTaskLayout}
				<!-- Anytype task layout: the Done checkbox stays inline with the title. -->
				<button class="done-check" class:done onclick={() => void toggleDone()} title={done ? "Done" : "Mark done"}>
					{done ? "✓" : ""}
				</button>
			{/if}
			<input
				class="title"
				placeholder="Untitled"
				bind:value={nameDraft}
				bind:this={titleEl}
				onblur={() => void saveName()}
				onkeydown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		</div>
		{#if isTemplate}
			<p class="tpl-note">Template{templateTargetName ? ` of ${templateTargetName}` : ""} — new objects copy these blocks.</p>
		{/if}
		{#if !isChannel && !isChat && !isType && !isRelation}
			<FeaturedProps {object} relations={scopedRelations} onchanged={refresh} />
		{/if}

		{#if isChannel}
			<SpaceManage {object} {spaceInfo} onchanged={refresh} />
		{:else if isChat}
			<Discussion {object} full onchanged={refresh} />
		{:else if isType}
			<TypePanel {object} onchanged={refresh} />
			<div class="dataview">
				<QueryControls
					bind:this={queryControls}
					{object}
					relations={scopedRelations}
					onchanged={refresh}
					onsearch={(q) => (searchText = q)}
					mode="type"
					channelId={object.fields["channel"]?.stringValue ?? ""}
					oncreated={onRecordCreated}
					onnewinline={() => table?.beginNew()}
				/>
				{#if tableBody}
					{@const viewType = object.fields["viewType"]?.stringValue || "table"}
					{#if viewType === "gallery"}
						<GalleryView body={tableBody} {object} relations={scopedRelations} sorts={viewSorts} />
					{:else if viewType === "kanban"}
						<KanbanView body={tableBody} {object} relations={scopedRelations} sorts={viewSorts} groupKey={object.fields["viewGroupKey"]?.stringValue || ""} onchanged={refresh} />
					{:else if viewType === "calendar"}
						<CalendarView body={tableBody} {object} dateKey={object.fields["viewDateKey"]?.stringValue || "createdDate"} />
					{:else}
						<SetTable bind:this={table} body={tableBody} {object} relations={scopedRelations} defaultSorts={viewSorts} onchanged={refresh} oncreate={(name) => queryControls?.createRecord(name) ?? Promise.resolve()} />
					{/if}
				{/if}
			</div>
		{:else if isRelation}
			<PropertyPanel {object} />
		{:else if isQuery || isCollection}
			<!-- Dataview aligns with the title/featured edge (48px rail). -->
			<div class="dataview">
				{#if isCollection}
					<div class="collection-bar">
						<!-- Anytype's New on a collection: create + auto-link
						     (recordCreate with createdInContext + collection add). -->
						<button class="new-btn" onclick={() => void newInCollection()}>New</button>
						<button onclick={() => void openPicker()}>+ Add object</button>
						{#if memberIds.length > 0}
							<span class="muted">{memberIds.length} object(s)</span>
						{/if}
					</div>
					{#if picking}
						<div class="picker">
							{#each candidates as c (c.id)}
								<button
									onclick={() => {
										picking = false;
										void setMembers([...memberIds, c.id]);
									}}>{c.name} <span class="muted">{c.typeKey}</span></button
								>
							{/each}
							{#if candidates.length === 0}<span class="muted">Nothing to add.</span>{/if}
							<button class="close" onclick={() => (picking = false)}>Close</button>
						</div>
					{/if}
				{/if}
				<!-- Collections share the query surface minus the Source pill:
				     same layouts (table/gallery/kanban/calendar), filters,
				     sorts, search, and view settings. -->
				<QueryControls
					bind:this={queryControls}
					{object}
					relations={scopedRelations}
					onchanged={refresh}
					onsearch={(q) => (searchText = q)}
					mode={isQuery ? "query" : "collection"}
					channelId={object.fields["channel"]?.stringValue ?? ""}
					oncreated={onRecordCreated}
					onnewinline={() => table?.beginNew()}
				/>
				{#if tableBody}
					{@const viewType = object.fields["viewType"]?.stringValue || "table"}
					{#if viewType === "gallery"}
						<GalleryView body={tableBody} {object} relations={scopedRelations} sorts={viewSorts} onremove={isCollection ? (ids) => setMembers(memberIds.filter((m) => !ids.includes(m))) : undefined} />
					{:else if viewType === "kanban"}
						<KanbanView body={tableBody} {object} relations={scopedRelations} sorts={viewSorts} groupKey={object.fields["viewGroupKey"]?.stringValue || ""} onchanged={refresh} onremove={isCollection ? (ids) => setMembers(memberIds.filter((m) => !ids.includes(m))) : undefined} />
					{:else if viewType === "calendar"}
						<CalendarView body={tableBody} {object} dateKey={object.fields["viewDateKey"]?.stringValue || "createdDate"} />
					{:else}
						<SetTable bind:this={table} body={tableBody} {object} relations={scopedRelations} defaultSorts={viewSorts} onchanged={refresh} oncreate={(name) => queryControls?.createRecord(name) ?? Promise.resolve()} onremove={isCollection ? (ids) => setMembers(memberIds.filter((m) => !ids.includes(m))) : undefined} />
					{/if}
				{:else}
					<p class="muted">Empty collection — add objects.</p>
				{/if}
			</div>
		{:else}
			<Editor bind:this={editor} {object} onchanged={refresh} />
		{/if}

		<!-- Anytype: queries/collections (sets) carry no discussion. -->
		{#if hasDiscussion}
			{#if isMobileVp}
				<Discussion {object} onchanged={refresh} />
				<AgentBoard {object} />
			{/if}
		{/if}

	</article>

	{#if hasDiscussion && !isMobileVp && discussionUI.open}
		<aside class="disc-drawer" style="width: {drawerW}px; top: {drawerTop}px">
			<div class="dd-resize" role="separator" aria-orientation="vertical" onpointerdown={drawerResizeStart}></div>
			<ConversationDrawer {object} onchanged={refresh} />
		</aside>
	{/if}
{:else}
	<p class="muted">Loading…</p>
{/if}
<style>
	.done-check {
		width: 20px;
		height: 20px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--panel);
		color: #fff;
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		flex: none;
		align-self: center;
	}
	.done-check:hover {
		border-color: var(--accent);
	}
	.done-check.done {
		background: var(--accent);
		border-color: var(--accent);
	}
	.dataview {
		margin-left: 48px;
	}
	.tpl-note {
		color: var(--muted);
		font-size: 12px;
		margin: 0 0 8px 48px;
	}
	.obj-img {
		width: 96px;
		height: 96px;
		border-radius: 18px;
		object-fit: cover;
	}
	/* Anytype: the icon sits ABOVE the title at the content edge (48px). */
	.icon-wrap {
		position: relative;
		margin: 16px 0 4px 44px;
		width: fit-content;
	}
	/* Anytype blockIconPage: 80px emoji (96 with image), breathing room. */
	.obj-emoji {
		width: 80px;
		height: 80px;
		border: none;
		background: none;
		font-size: 64px;
		line-height: 1;
		border-radius: 14px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.obj-emoji:hover {
		background: var(--hover);
	}
	.obj-emoji.placeholder {
		color: var(--muted);
		font-size: 32px;
		opacity: 0.5;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 0;
		padding-left: 48px;
	}
	/* Task layout: the checkbox occupies the rail, inline with the title. */
	.title-row.with-check {
		padding-left: 0;
	}
	.title-row > .done-check {
		margin-left: 14px;
		margin-right: 6px;
	}
	.title {
		width: 100%;
		background: none;
		border: none;
		outline: none;
		color: var(--fg);
		font-size: 34px;
		font-weight: 750;
		padding: 8px 0 16px;
		font-family: inherit;
	}
	.title::placeholder {
		color: var(--muted);
		opacity: 0.5;
	}
	.collection-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}
	.collection-bar button,
	.picker button {
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 8px;
		padding: 6px 12px;
		font-size: 13px;
		cursor: pointer;
	}
	.collection-bar button:hover,
	.picker button:hover {
		border-color: var(--accent);
	}
	.picker {
		display: flex;
		flex-direction: column;
		gap: 4px;
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px;
		margin-bottom: 14px;
		max-height: 260px;
		overflow-y: auto;
	}
	.picker button {
		text-align: left;
		border: none;
	}
	.picker .close {
		color: var(--muted);
	}
	.muted {
		color: var(--muted);
		font-size: 12px;
	}
	.new-btn {
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 8px;
		height: 28px;
		padding: 0 12px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	.new-btn:hover {
		filter: brightness(1.1);
	}

	/* Mobile: drop the 48px rail; ONE 16px gutter for icon, title, meta,
	   and block text (Anytype's phone layout), tighter vertical rhythm. */
	@media (max-width: 720px) {
		.dataview {
			margin-left: 0;
		}
		.tpl-note {
			margin: 0 0 8px 16px;
		}
		.icon-wrap {
			margin: 8px 0 2px 16px;
		}
		.title-row {
			padding-left: 16px;
		}
		.title {
			font-size: 32px;
			padding: 4px 0 6px;
		}
		.obj-emoji {
			width: 56px;
			height: 56px;
			font-size: 42px;
		}
		.obj-img {
			width: 72px;
			height: 72px;
		}
	}
	.disc-drawer {
		position: fixed;
		right: 0;
		bottom: 0;
		z-index: 90;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border-left: 1px solid var(--border);
		box-shadow: -16px 0 48px rgb(0 0 0 / 0.35);
	}
	.dd-resize {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -6px;
		width: 12px;
		cursor: col-resize;
		z-index: 5;
		touch-action: none;
	}
	/* The full-variant Discussion fills the drawer: messages scroll,
	   composer pinned at the bottom. */
</style>