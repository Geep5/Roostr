<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchObject, fetchQuery, note } from "$lib/api";
	import { store, refreshAll, onObjectEvent, layoutOf } from "$lib/data.svelte";
	import Editor from "$lib/components/Editor.svelte";
	import FeaturedProps from "$lib/components/FeaturedProps.svelte";
	import Discussion from "$lib/components/Discussion.svelte";
	import SetTable from "$lib/components/SetTable.svelte";
	import QueryControls from "$lib/components/QueryControls.svelte";
	import KanbanView from "$lib/components/KanbanView.svelte";
	import CalendarView from "$lib/components/CalendarView.svelte";
	import GalleryView from "$lib/components/GalleryView.svelte";
	import ChannelManage from "$lib/components/ChannelManage.svelte";
	import TypePanel from "$lib/components/TypePanel.svelte";
	import EmojiPicker from "$lib/components/EmojiPicker.svelte";
	import { objectIcon } from "$lib/icons";

	let object = $state<ObjectJSON>();
	let editor = $state<Editor>();
	let table = $state<SetTable>();

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
			object = o;
		});
	});

	async function refresh() {
		if (!object) return;
		object = await fetchObject(object.id);
	}

	let nameDraft = $state("");
	$effect(() => {
		nameDraft = object ? fieldStr(object.fields, "name") : "";
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
	const engineFilters = $derived.by((): Array<Record<string, unknown>> => {
		const items = object?.fields["viewFilters"]?.valuesValue?.items ?? [];
		const out: Array<Record<string, unknown>> = [];
		for (const item of items) {
			const e = item.mapValue?.entries;
			if (!e) continue;
			const key = e["key"]?.stringValue ?? "";
			const condition = e["condition"]?.stringValue ?? "equal";
			const values = (e["value"]?.valuesValue?.items ?? [])
				.map((i) => i.stringValue)
				.filter((s): s is string => typeof s === "string");
			if (!key) continue;
			const format = key === "createdAt" || key === "updatedAt" ? "number" : (store.relations.find((r) => r.key === key)?.format ?? "shorttext");
			let value: unknown;
			if (format === "checkbox") value = true; // "is checked"/"is unchecked" via equal/notEqual true
			else if (condition === "in" || condition === "notIn" || condition === "allIn" || condition === "exactIn") value = values;
			else if (format === "number" || format === "date") value = values[0] !== undefined ? Number(values[0]) : undefined;
			else value = values[0];
			if (condition !== "empty" && condition !== "notEmpty" && condition !== "exists" && format !== "checkbox" && (value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
				continue; // incomplete rule — don't filter on it yet
			}
			out.push({ key, condition, value });
		}
		return out;
	});

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
		if (isQuery) return { setId: object.id, filters: engineFilters, ...text };
		if (isCollection) {
			if (memberIds.length === 0) return null;
			return { filters: [{ key: "id", condition: "in", value: memberIds }], ...text };
		}
		return null;
	});

	// Collection membership picker.
	let picking = $state(false);
	let candidates = $state<Array<{ id: string; name: string; typeKey: string }>>([]);

	async function openPicker() {
		if (!object) return;
		const res = await fetchQuery({ limit: 200 });
		const HIDDEN: Record<string, true> = { program: true, typescript: true, json: true, proto: true, relation: true, collection: true, query: true, set: true, type: true, template: true, agent: true };
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
	const channelInfo = $derived(store.channels.find((c) => c.id === object?.id));


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
				onblur={() => void saveName()}
				onkeydown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
			/>
		</div>
		{#if isTemplate}
			<p class="tpl-note">Template{templateTargetName ? ` of ${templateTargetName}` : ""} — new objects copy these blocks.</p>
		{/if}
		{#if !isChannel && !isChat && !isType}
			<FeaturedProps {object} relations={store.relations} onchanged={refresh} />
		{/if}

		{#if isChannel}
			<ChannelManage {object} {channelInfo} relations={store.relations} onchanged={refresh} />
		{:else if isChat}
			<Discussion {object} full onchanged={refresh} />
		{:else if isType}
			<TypePanel {object} onchanged={refresh} />
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
				{#if isQuery}
					<QueryControls {object} relations={store.relations} onchanged={refresh} onsearch={(q) => (searchText = q)} />
				{/if}
				{#if tableBody}
					{@const viewType = object.fields["viewType"]?.stringValue || "table"}
					{#if viewType === "gallery"}
						<GalleryView body={tableBody} {object} relations={store.relations} />
					{:else if viewType === "kanban"}
						<KanbanView body={tableBody} {object} relations={store.relations} groupKey={object.fields["viewGroupKey"]?.stringValue || ""} onchanged={refresh} />
					{:else if viewType === "calendar"}
						<CalendarView body={tableBody} {object} dateKey={object.fields["viewDateKey"]?.stringValue || "createdDate"} />
					{:else}
						<SetTable bind:this={table} body={tableBody} {object} relations={store.relations} defaultSorts={viewSorts} onchanged={refresh} />
					{/if}
				{:else}
					<p class="muted">Empty collection — add objects.</p>
				{/if}
			</div>
		{:else}
			<Editor bind:this={editor} {object} onchanged={refresh} />
		{/if}

		<!-- Anytype: queries/collections (sets) carry no discussion. -->
		{#if !isChannel && !isChat && !isAgent && !isType && !isTemplate && !isQuery && !isCollection}
			<Discussion {object} onchanged={refresh} />
		{/if}

	</article>
{:else}
	<p class="muted">Loading…</p>
{/if}
<style>
	.done-check {
		width: 28px;
		height: 28px;
		border: 2px solid var(--border);
		border-radius: 6px;
		background: none;
		color: var(--bg);
		font-size: 16px;
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
		color: #101216;
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
</style>
