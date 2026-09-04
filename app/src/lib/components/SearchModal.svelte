<script lang="ts">
	import { goto } from "$app/navigation";
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import { activeSpace } from "$lib/space.svelte";
	import { objectIcon } from "$lib/icons";
	import { createTyped } from "$lib/create";

	let { onclose }: { onclose: () => void } = $props();

	const RECENT_LIMIT = 20; // Anytype's empty-query recents

	let query = $state("");
	let selected = $state(0);
	let results = $state<Array<QueryResultRow & { snippet?: string }>>([]);
	let searching = $state(false);
	/** Anytype mobile search chips: "" = All, else a type key. */
	let typeChip = $state("");
	let inputEl = $state<HTMLInputElement>();

	const channelId = $derived(activeSpace.id || store.channels[0]?.id || "");
	const isDefault = $derived(channelId === (store.channels[0]?.id ?? ""));
	const spaceName = $derived(store.channels.find((c) => c.id === channelId)?.name ?? "");

	$effect(() => {
		inputEl?.focus();
	});

	/** Kernel/internal types never appear in search (they're space-less). */
	const TYPE_EXCLUDE = { key: "type", condition: "notIn", value: ["program", "typescript", "json", "proto", "relation", "channel", "type", "template", "agent", "skill", "peer", "machine", "pinned_fact", "milestone", "vanish_log"] };

	/** Space scope filter: unassigned objects live in the default space. */
	function scopeFilters(chip = typeChip): Array<Record<string, unknown>> {
		const scope = isDefault
			? {
					operator: "or",
					nested: [
						{ key: "channel", condition: "equal", value: channelId },
						{ key: "channel", condition: "empty" },
					],
				}
			: { key: "channel", condition: "equal", value: channelId };
		return chip === "" ? [scope, TYPE_EXCLUDE] : [scope, TYPE_EXCLUDE, { key: "type", condition: "equal", value: chip }];
	}

	let seq = 0;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		// Read all reactive inputs synchronously: $effect only tracks reads in
		// this frame, not inside the debounce callback.
		const q = query.trim();
		const chip = typeChip;
		const mine = ++seq;
		clearTimeout(debounce);
		debounce = setTimeout(async () => {
			searching = true;
			try {
				const res = await fetchQuery(
					q === ""
						? { filters: scopeFilters(chip), sorts: [{ key: "updatedAt", type: "desc" }], limit: RECENT_LIMIT }
						: { textQuery: q, filters: scopeFilters(chip), limit: 50 },
				);
				if (mine !== seq) return; // stale response
				results = res.records as typeof results;
				selected = 0;
			} finally {
				if (mine === seq) searching = false;
			}
		}, q === "" ? 0 : 150);
		return () => clearTimeout(debounce);
	});

	function open(row: QueryResultRow) {
		onclose();
		void goto(`/object/${row.id}`);
	}

	/** Anytype: the search popup appends a `Create object "<filter>"` row. */
	const canCreate = $derived(query.trim() !== "");
	const rowCount = $derived(results.length + (canCreate ? 1 : 0));

	async function createFromQuery() {
		const name = query.trim();
		if (!name) return;
		onclose();
		// Anytype: the create row targets the selected chip's type.
		await createTyped(typeChip || "note", channelId, name);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onclose();
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selected = Math.min(selected + 1, rowCount - 1);
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		}
		if (e.key === "Enter") {
			if (results[selected]) open(results[selected]);
			else if (canCreate && selected === results.length) void createFromQuery();
		}
	}

	

	/** Split text into [before, match, after] for highlight rendering. */
	function highlight(text: string, q: string): [string, string, string] {
		const idx = text.toLowerCase().indexOf(q.toLowerCase());
		if (q === "" || idx < 0) return [text, "", ""];
		return [text.slice(0, idx), text.slice(idx, idx + q.length), text.slice(idx + q.length)];
	}

	// ── Mobile sheet drag-to-close ───────────────────────────────────
	// Attached with non-passive listeners on the WHOLE sheet: a downward
	// pull anywhere (results at scroll-top) drags the sheet, drops the
	// keyboard, and dismisses past the threshold. Scrolled results keep
	// native scrolling; horizontal chip swipes are ignored.
	let sheetY = $state(0);
	let sheetDragging = $state(false);
	let modalEl = $state<HTMLDivElement>();
	let resultsEl = $state<HTMLDivElement>();

	$effect(() => {
		const el = modalEl;
		if (!el) return;
		let startY = 0;
		let startX = 0;
		let armed = false;
		let dragging = false;
		const onStart = (e: TouchEvent) => {
			startY = e.touches[0].clientY;
			startX = e.touches[0].clientX;
			armed = true;
			dragging = false;
		};
		const onMove = (e: TouchEvent) => {
			if (!armed) return;
			const dy = e.touches[0].clientY - startY;
			const dx = e.touches[0].clientX - startX;
			if (!dragging) {
				if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
					armed = false; // horizontal (chips) - not ours
					return;
				}
				if (dy < -10) {
					armed = false; // upward - let it scroll
					return;
				}
				if (dy > 10 && (!resultsEl || resultsEl.scrollTop <= 0)) {
					dragging = true;
					sheetDragging = true;
					(document.activeElement as HTMLElement | null)?.blur();
				} else {
					return;
				}
			}
			sheetY = Math.max(0, dy);
			e.preventDefault();
		};
		const onEnd = () => {
			armed = false;
			if (!dragging) return;
			dragging = false;
			sheetDragging = false;
			if (sheetY > 110) onclose();
			else sheetY = 0;
		};
		el.addEventListener("touchstart", onStart, { passive: true });
		el.addEventListener("touchmove", onMove, { passive: false });
		el.addEventListener("touchend", onEnd);
		el.addEventListener("touchcancel", onEnd);
		return () => {
			el.removeEventListener("touchstart", onStart);
			el.removeEventListener("touchmove", onMove);
			el.removeEventListener("touchend", onEnd);
			el.removeEventListener("touchcancel", onEnd);
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div
		class="modal sheet"
		role="dialog"
		aria-label="Search"
		style={sheetY ? `transform: translateY(${sheetY}px); transition: ${sheetDragging ? "none" : "transform 0.18s ease"}` : ""}
		bind:this={modalEl}
	>
		<div class="grab-zone" role="presentation">
			<div class="sheet-handle"></div>
		</div>
		<div class="input-row">
			<span class="scope">{spaceName}</span>
			<span class="m-search-icon">⌕</span>
			<input bind:this={inputEl} bind:value={query} placeholder="Search objects and content…" />
			{#if query !== ""}
				<button class="clear-btn" aria-label="Clear" onclick={() => { query = ""; inputEl?.focus(); }}>×</button>
			{/if}
		</div>

		<div class="chips">
			<button class="chip" class:on={typeChip === ""} onclick={() => (typeChip = "")}>All</button>
			{#each store.types.filter((t) => t.space === channelId) as t (t.id)}
				<button class="chip" class:on={typeChip === t.key} onclick={() => (typeChip = typeChip === t.key ? "" : t.key)}>{t.icon} {t.name || t.key}</button>
			{/each}
		</div>

		<div class="results" bind:this={resultsEl}>
			{#if query.trim() === "" && results.length > 0}
				<div class="section-name">Recently edited</div>
			{/if}
			{#each results as row, i (row.id)}
				{@const name = row.name || "Untitled"}
				{@const [b, m, a] = highlight(name, query.trim())}
				<button class="row" class:selected={i === selected} onclick={() => open(row)} onmouseenter={() => (selected = i)}>
					<span class="icon">{objectIcon(row.fields["iconEmoji"]?.stringValue, row.typeKey)}</span>
					<span class="texts">
						<span class="name">{b}{#if m}<mark>{m}</mark>{/if}{a}</span>
						{#if row.snippet}
							{@const [sb, sm, sa] = highlight(row.snippet, query.trim())}
							<span class="snippet">{sb}{#if sm}<mark>{sm}</mark>{/if}{sa}</span>
						{/if}
					</span>
					<span class="kind">{row.typeKey}</span>
				</button>
			{/each}
			{#if canCreate && !searching}
				<button class="row create" class:selected={selected === results.length} onclick={() => void createFromQuery()} onmouseenter={() => (selected = results.length)}>
					<span class="icon">＋</span>
					<span class="texts"><span class="name">Create object "{query.trim()}"</span></span>
					<span class="kind">{typeChip || "note"}</span>
				</button>
			{/if}
			{#if results.length === 0 && !searching && !canCreate}
				<div class="none">Nothing here yet.</div>
			{/if}
		</div>

		<div class="hints">
			<span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
		</div>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.5);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 12vh;
		z-index: 200;
	}
	.modal {
		width: 620px;
		max-width: calc(100vw - 48px);
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 14px;
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.input-row {
		display: flex;
		align-items: center;
		gap: 10px;
		border-bottom: 1px solid var(--border);
		padding: 12px 14px;
	}
	.scope {
		flex: none;
		font-size: 12px;
		color: var(--accent);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 2px 8px;
	}
	input {
		flex: 1;
		background: none;
		border: none;
		outline: none;
		color: var(--fg);
		font-size: 19px;
		font-weight: 300;
	}
	.results {
		max-height: 46vh;
		overflow-y: auto;
		padding: 6px;
	}
	.section-name {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 6px 10px 4px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		color: var(--fg);
		padding: 8px 10px;
		border-radius: 8px;
		cursor: pointer;
	}
	.row.selected {
		background: var(--accent);
		color: #fff;
	}
	.row.selected .snippet,
	.row.selected .kind,
	.row.selected .icon {
		color: rgb(255 255 255 / 0.72);
	}
	.icon {
		color: var(--accent);
		flex: none;
		width: 18px;
		text-align: center;
	}
	.texts {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}
	.name {
		font-size: 14px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.snippet {
		font-size: 12px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	mark {
		background: none;
		color: var(--accent);
		font-weight: 600;
	}
	.row.selected mark {
		color: #fff;
	}
	.kind {
		flex: none;
		font-size: 11px;
		color: var(--muted);
	}
	.row.create .icon {
		color: var(--accent);
	}
	.none {
		color: var(--muted);
		font-size: 13px;
		padding: 16px 12px;
	}
	.hints {
		display: flex;
		gap: 16px;
		border-top: 1px solid var(--border);
		padding: 8px 14px;
		font-size: 11px;
		color: var(--muted);
	}

	/* ── Mobile sheet (Anytype iOS): handle, rounded field, chips, stacked rows ── */
	.grab-zone,
	.sheet-handle {
		display: none;
	}
	.m-search-icon,
	.clear-btn {
		display: none;
	}
	.chips {
		display: none;
	}
	@media (max-width: 720px) {
		.overlay {
			padding-top: 0 !important;
			align-items: flex-end;
		}
		.modal {
			width: 100%;
			max-width: 100%;
			border-radius: 18px 18px 0 0 !important;
			/* Leave the top strip free: a full-height sheet parks the grab
			   handle inside the iPhone's system-gesture edge. */
			height: calc(100dvh - max(56px, env(safe-area-inset-top) + 32px)) !important;
		}
		.grab-zone {
			display: flex;
			justify-content: center;
			padding: 12px 0 8px;
			flex: none;
			touch-action: none;
		}
		.sheet-handle {
			display: block;
			width: 40px;
			height: 5px;
			border-radius: 3px;
			background: var(--border);
			flex: none;
		}
		.input-row {
			border-bottom: none;
			padding: 8px 14px;
		}
		.scope {
			display: none;
		}
		.m-search-icon {
			display: block;
			color: var(--muted);
			font-size: 16px;
		}
		input {
			background: var(--hover);
			border: 1px solid var(--border);
			border-radius: 12px;
			padding: 10px 12px;
			font-size: 16px;
			font-weight: 400;
		}
		.clear-btn {
			display: flex;
			align-items: center;
			justify-content: center;
			width: 28px;
			height: 28px;
			border-radius: 50%;
			border: none;
			background: var(--hover);
			color: var(--muted);
			font-size: 15px;
			cursor: pointer;
			flex: none;
			margin-left: -36px;
			z-index: 1;
		}
		.chips {
			display: flex;
			gap: 8px;
			overflow-x: auto;
			padding: 4px 14px 10px;
			scrollbar-width: none;
			flex: none;
		}
		.chips .chip {
			flex: none;
			border: none;
			background: var(--hover);
			color: var(--fg);
			border-radius: 999px;
			padding: 7px 14px;
			font-size: 14px;
			cursor: pointer;
		}
		.chips .chip.on {
			background: var(--accent);
			color: #fff;
		}
		.row {
			padding: 12px 14px;
			align-items: flex-start;
		}
		.row .texts {
			flex: 1;
		}
		/* Type label under the name, snippet above it (their stacking). */
		.row {
			flex-wrap: wrap;
		}
		.row .kind {
			order: 3;
			/* basis 100% + a left margin overflowed every row 42px past the
			   sheet - keep the indent inside the basis instead. */
			flex-basis: calc(100% - 42px);
			margin-left: 42px;
			font-size: 12px;
			text-transform: capitalize;
		}
		/* The sheet is a fixed-height flex column: results fill the rest
		   (the desktop 46vh dropdown cap left the bottom half dead). */
		.results {
			flex: 1;
			max-height: none;
			overflow-x: hidden;
		}
		.hints {
			display: none;
		}
		mark {
			background: rgb(80 140 255 / 0.35);
			color: inherit;
			border-radius: 2px;
		}
	}
</style>