<script lang="ts">
	import { onMount } from "svelte";
	import { page } from "$app/state";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchObject, fetchQuery, note } from "$lib/api";
	import { store, refreshAll, onObjectEvent } from "$lib/data.svelte";
	import Editor from "$lib/components/Editor.svelte";
	import FeaturedProps from "$lib/components/FeaturedProps.svelte";
	import Discussion from "$lib/components/Discussion.svelte";
	import SetTable from "$lib/components/SetTable.svelte";
	import QueryControls from "$lib/components/QueryControls.svelte";
	import ChannelManage from "$lib/components/ChannelManage.svelte";
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
			if (page.params.id === id) object = o;
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

	async function setEmoji(emoji: string) {
		if (!object) return;
		await note.setField(object.id, "iconEmoji", { stringValue: emoji });
		await refresh();
	}

	// ── Query / collection tables ─────────────────────────────────
	const isQuery = $derived(object?.typeKey === "query" || object?.typeKey === "set");
	const isCollection = $derived(object?.typeKey === "collection");

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

	const tableBody = $derived.by((): Record<string, unknown> | null => {
		if (!object) return null;
		if (isQuery) return { setId: object.id, filters: engineFilters };
		if (isCollection) {
			if (memberIds.length === 0) return null;
			return { filters: [{ key: "id", condition: "in", value: memberIds }] };
		}
		return null;
	});

	// Collection membership picker.
	let picking = $state(false);
	let candidates = $state<Array<{ id: string; name: string; typeKey: string }>>([]);

	async function openPicker() {
		if (!object) return;
		const res = await fetchQuery({ limit: 200 });
		const HIDDEN: Record<string, true> = { program: true, typescript: true, json: true, proto: true, relation: true, collection: true, query: true, set: true };
		const currentId = object.id;
		candidates = res.records
			.filter((r) => r.id !== currentId && !memberIds.includes(r.id) && !HIDDEN[r.typeKey])
			.map((r) => ({ id: r.id, name: fieldStr(r.fields, "name") || r.id.slice(0, 8), typeKey: r.typeKey }));
		picking = true;
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
		<div class="title-row">
			<div class="icon-wrap">
				<button
					class="obj-emoji"
					class:placeholder={!object.fields["iconEmoji"]?.stringValue}
					title="Set icon"
					onclick={() => (showEmoji = !showEmoji)}
				>
					{objectIcon(object.fields["iconEmoji"]?.stringValue, object.typeKey)}
				</button>
				{#if showEmoji}
					<EmojiPicker
						onpick={(e) => {
							showEmoji = false;
							void setEmoji(e);
						}}
						onclose={() => (showEmoji = false)}
					/>
				{/if}
			</div>
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

		{#if !isChannel}
			<FeaturedProps {object} relations={store.relations} onchanged={refresh} />
		{/if}

		{#if isChannel}
			<ChannelManage {object} {channelInfo} relations={store.relations} onchanged={refresh} />
		{:else if isQuery || isCollection}
			{#if isCollection}
				<div class="collection-bar">
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
				<QueryControls {object} relations={store.relations} onchanged={refresh} />
			{/if}
			{#if tableBody}
				<SetTable bind:this={table} body={tableBody} {object} relations={store.relations} defaultSorts={viewSorts} onchanged={refresh} />
			{:else}
				<p class="muted">Empty collection — add objects.</p>
			{/if}
		{:else}
			<Editor bind:this={editor} {object} onchanged={refresh} />
		{/if}

		{#if !isChannel}
			<Discussion {object} onchanged={refresh} />
		{/if}

	</article>
{:else}
	<p class="muted">Loading…</p>
{/if}
<style>
	.icon-wrap {
		position: relative;
		flex: none;
	}
	.obj-emoji {
		width: 44px;
		height: 44px;
		border: none;
		background: none;
		font-size: 30px;
		border-radius: 10px;
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
		font-size: 22px;
		opacity: 0.6;
	}
	.title-row {
		display: flex;
		align-items: center;
		gap: 10px;
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
</style>
