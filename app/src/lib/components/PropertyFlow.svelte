<script lang="ts">
	/**
	 * Anytype's full add-property flow, ported as one cascading popover:
	 *
	 *   1. dataviewRelationList — the current properties with visibility
	 *      SWITCHES (toggle on/off) and an "Add property" row at the bottom.
	 *   2. relationSuggest — filter box; `Create property "<filter>"` when
	 *      typing; a "Create new" section listing the FORMAT TYPES (clicking
	 *      one jumps to the edit form with that format preselected); then
	 *      "My properties" and "System properties" (click = add existing).
	 *   3. dataviewRelationEdit — Name input, Type row opening a custom
	 *      format submenu (never the browser's native select), Create.
	 */
	import { store } from "$lib/data.svelte";
	import { RESERVED_KEYS, createRelation } from "$lib/relations";
	import type { RelationDefJSON } from "$lib/types";

	export interface FlowItem {
		key: string;
		name: string;
		format: string;
		on: boolean;
	}

	let {
		x,
		y,
		items,
		ontoggle,
		onadd,
		onclose,
	}: {
		x: number;
		y: number;
		/** Stage-1 rows: current/available properties with their toggle state. */
		items: FlowItem[];
		ontoggle: (key: string, on: boolean) => void;
		/** A property picked or created in stages 2-3. */
		onadd: (rel: RelationDefJSON) => void;
		onclose: () => void;
	} = $props();

	// Anytype getRelationTypes order, mapped to our formats.
	const FORMATS: Array<{ id: string; name: string; glyph: string }> = [
		{ id: "object", name: "Object", glyph: "◈" },
		{ id: "longtext", name: "Text", glyph: "≡" },
		{ id: "number", name: "Number", glyph: "#" },
		{ id: "status", name: "Select", glyph: "◉" },
		{ id: "tag", name: "Multi-select", glyph: "▤" },
		{ id: "date", name: "Date", glyph: "▦" },
		{ id: "checkbox", name: "Checkbox", glyph: "☑" },
		{ id: "url", name: "URL", glyph: "⌁" },
		{ id: "email", name: "Email", glyph: "@" },
		{ id: "phone", name: "Phone", glyph: "☏" },
		{ id: "shorttext", name: "Short text", glyph: "–" },
	];
	const glyphFor = (format: string) => FORMATS.find((f) => f.id === format)?.glyph ?? "≡";
	const formatName = (format: string) => FORMATS.find((f) => f.id === format)?.name ?? format;

	let stage = $state<"list" | "suggest" | "edit">("list");
	let query = $state("");
	let editName = $state("");
	let editFormat = $state<string | null>(null);
	let formatMenu = $state(false);
	let menuEl = $state<HTMLElement>();
	let queryEl = $state<HTMLInputElement>();
	let nameEl = $state<HTMLInputElement>();

	$effect(() => {
		if (stage === "suggest") queryEl?.focus();
		if (stage === "edit") nameEl?.focus();
	});

	// ── Stage 2 data (Anytype relationSuggest getSections) ─────────
	const SYSTEM_KEYS = ["createdDate", "modifiedDate", "dueDate", "done", "tag", "status", "url", "email", "phone", "description"];
	const present = $derived(new Set(items.map((i) => i.key)));
	const allRels = $derived(store.relations.filter((r) => !r.hidden && !RESERVED_KEYS[r.key] && !present.has(r.key)));
	const q = $derived(query.trim().toLowerCase());
	const matching = $derived(q ? allRels.filter((r) => (r.name || r.key).toLowerCase().includes(q)) : allRels);
	const library = $derived(matching.filter((r) => !SYSTEM_KEYS.includes(r.key)));
	const system = $derived(matching.filter((r) => SYSTEM_KEYS.includes(r.key)));
	const matchingFormats = $derived(q ? FORMATS.filter((f) => f.name.toLowerCase().includes(q)) : FORMATS);
	const exact = $derived(allRels.some((r) => (r.name || r.key).toLowerCase() === q));
	const canCreate = $derived(q !== "" && !exact);

	function openEdit(name: string, format: string | null) {
		editName = name;
		editFormat = format;
		formatMenu = false;
		stage = "edit";
	}

	async function submitCreate() {
		if (!editName.trim() || !editFormat) return;
		const rel = await createRelation(editName.trim(), editFormat);
		if (rel) {
			onadd(rel);
			onclose();
		}
	}

	const pos = $derived.by(() => {
		const w = 300;
		const h = 400;
		return {
			left: Math.min(x, window.innerWidth - w - 12),
			top: y + h > window.innerHeight - 12 ? Math.max(12, window.innerHeight - h - 12) : y,
		};
	});

	function onWindowPointerDown(e: PointerEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window
	onpointerdown={onWindowPointerDown}
	onkeydown={(e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			if (stage === "edit") stage = "suggest";
			else if (stage === "suggest") stage = "list";
			else onclose();
		}
	}}
/>

<div class="flow" bind:this={menuEl} style="left: {pos.left}px; top: {pos.top}px" role="dialog" aria-label="Properties">
	{#if stage === "list"}
		<!-- Stage 1: dataviewRelationList — switches over current properties. -->
		<div class="list">
			{#each items as it (it.key)}
				<div class="row">
					<span class="r-glyph">{glyphFor(it.format)}</span>
					<span class="r-name">{it.name}</span>
					<button
						class="switch"
						class:on={it.on}
						role="switch"
						aria-checked={it.on}
						aria-label="Toggle {it.name}"
						onclick={() => ontoggle(it.key, !it.on)}
					>
						<span class="knob"></span>
					</button>
				</div>
			{/each}
			{#if items.length === 0}
				<span class="none">No properties yet.</span>
			{/if}
		</div>
		<div class="sep"></div>
		<button class="add-row" onclick={() => (stage = "suggest")}>＋ Add property</button>
	{:else if stage === "suggest"}
		<!-- Stage 2: relationSuggest. -->
		<input
			bind:this={queryEl}
			bind:value={query}
			placeholder="Filter or create…"
			onkeydown={(e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					if (library[0]) {
						onadd(library[0]);
						onclose();
					} else if (canCreate) openEdit(query.trim(), null);
				}
			}}
		/>
		<div class="scroll">
			{#if canCreate}
				<button class="row pick create" onclick={() => openEdit(query.trim(), null)}>
					＋ Create property “{query.trim()}”
				</button>
				<div class="sep"></div>
			{/if}
			{#if matchingFormats.length > 0}
				<div class="section">Create new</div>
				{#each matchingFormats as f (f.id)}
					<button class="row pick" onclick={() => openEdit(query.trim(), f.id)}>
						<span class="r-glyph">{f.glyph}</span>
						<span class="r-name">{f.name}</span>
						<span class="arrow">›</span>
					</button>
				{/each}
			{/if}
			{#if library.length > 0}
				<div class="sep"></div>
				<div class="section">My properties</div>
				{#each library as rel (rel.key)}
					<button
						class="row pick"
						onclick={() => {
							onadd(rel);
							onclose();
						}}
					>
						<span class="r-glyph">{glyphFor(rel.format)}</span>
						<span class="r-name">{rel.name || rel.key}</span>
					</button>
				{/each}
			{/if}
			{#if system.length > 0}
				<div class="sep"></div>
				<div class="section">System properties</div>
				{#each system as rel (rel.key)}
					<button
						class="row pick"
						onclick={() => {
							onadd(rel);
							onclose();
						}}
					>
						<span class="r-glyph">{glyphFor(rel.format)}</span>
						<span class="r-name">{rel.name || rel.key}</span>
					</button>
				{/each}
			{/if}
		</div>
	{:else}
		<!-- Stage 3: dataviewRelationEdit — Name, Type (custom submenu), Create. -->
		<div class="form">
			<div class="f-label">Name</div>
			<input
				bind:this={nameEl}
				bind:value={editName}
				placeholder="Property name"
				onkeydown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void submitCreate();
					}
				}}
			/>
			<div class="f-label">Type</div>
			<div class="type-wrap">
				<button class="row pick type-row" onclick={() => (formatMenu = !formatMenu)}>
					<span class="r-glyph">{editFormat ? glyphFor(editFormat) : "?"}</span>
					<span class="r-name">{editFormat ? formatName(editFormat) : "Select property type"}</span>
					<span class="arrow">›</span>
				</button>
				{#if formatMenu}
					<div class="type-menu">
						{#each FORMATS as f (f.id)}
							<button
								class="row pick"
								class:active={editFormat === f.id}
								onclick={() => {
									editFormat = f.id;
									formatMenu = false;
								}}
							>
								<span class="r-glyph">{f.glyph}</span>
								<span class="r-name">{f.name}</span>
								{#if editFormat === f.id}<span class="check">✓</span>{/if}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<button class="submit-btn" disabled={!editName.trim() || !editFormat} onclick={() => void submitCreate()}>Create</button>
		</div>
	{/if}
</div>

<style>
	.flow {
		position: fixed;
		z-index: 140;
		width: 300px;
		max-height: 420px;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
		gap: 4px;
	}
	.list,
	.scroll {
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px;
		border-radius: 6px;
		font-size: 13px;
		color: var(--fg);
	}
	.row.pick {
		background: none;
		border: none;
		cursor: pointer;
		text-align: left;
		width: 100%;
	}
	.row.pick:hover,
	.row.pick.active {
		background: var(--hl-med);
	}
	.row.create {
		color: var(--accent);
	}
	.r-glyph {
		width: 18px;
		text-align: center;
		color: var(--muted);
		flex: none;
	}
	.r-name {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.arrow,
	.check {
		color: var(--muted);
	}
	/* Anytype Switch */
	.switch {
		width: 30px;
		height: 18px;
		border-radius: 9px;
		border: none;
		background: var(--hover);
		position: relative;
		cursor: pointer;
		flex: none;
		padding: 0;
		transition: background 0.15s;
	}
	.switch.on {
		background: var(--accent);
	}
	.knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		transition: left 0.15s;
	}
	.switch.on .knob {
		left: 14px;
	}
	.sep {
		height: 1px;
		background: var(--border);
		margin: 4px 0;
		flex: none;
	}
	.section {
		font-size: 11px;
		color: var(--muted);
		padding: 4px 8px 2px;
	}
	.add-row {
		background: none;
		border: none;
		color: var(--fg);
		font-size: 13px;
		text-align: left;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
	}
	.add-row:hover {
		background: var(--hl-med);
	}
	input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 13px;
		padding: 6px 10px;
		outline: none;
		flex: none;
	}
	input:focus {
		border-color: var(--accent);
	}
	.form {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.f-label {
		font-size: 11px;
		color: var(--muted);
		padding: 2px 2px 0;
	}
	.type-wrap {
		position: relative;
	}
	.type-row {
		border: 1px solid var(--border) !important;
		border-radius: 8px;
	}
	.type-menu {
		position: absolute;
		left: 0;
		right: 0;
		top: 34px;
		z-index: 10;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 4px;
		max-height: 240px;
		overflow-y: auto;
		box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
	}
	.submit-btn {
		margin-top: 4px;
		background: var(--accent);
		border: none;
		border-radius: 8px;
		color: #14161a;
		font-size: 13px;
		font-weight: 600;
		padding: 7px 0;
		cursor: pointer;
	}
	.submit-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 4px 8px;
	}
</style>
