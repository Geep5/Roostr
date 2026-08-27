<script lang="ts">
	import { goto } from "$app/navigation";
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import { activeChannel } from "$lib/channel.svelte";

	let { onclose }: { onclose: () => void } = $props();

	const RECENT_LIMIT = 20; // Anytype's empty-query recents

	let query = $state("");
	let selected = $state(0);
	let results = $state<Array<QueryResultRow & { snippet?: string }>>([]);
	let searching = $state(false);
	let inputEl = $state<HTMLInputElement>();

	const channelId = $derived(activeChannel.id || store.channels[0]?.id || "");
	const isDefault = $derived(channelId === (store.channels[0]?.id ?? ""));
	const channelName = $derived(store.channels.find((c) => c.id === channelId)?.name ?? "");

	$effect(() => {
		inputEl?.focus();
	});

	/** Kernel/internal types never appear in search (they're channel-less). */
	const TYPE_EXCLUDE = { key: "type", condition: "notIn", value: ["program", "typescript", "json", "proto", "relation", "channel"] };

	/** Channel scope filter: unassigned objects live in the default channel. */
	function scopeFilters(): Array<Record<string, unknown>> {
		const scope = isDefault
			? {
					operator: "or",
					nested: [
						{ key: "channel", condition: "equal", value: channelId },
						{ key: "channel", condition: "empty" },
					],
				}
			: { key: "channel", condition: "equal", value: channelId };
		return [scope, TYPE_EXCLUDE];
	}

	let seq = 0;
	let debounce: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const q = query.trim();
		const mine = ++seq;
		clearTimeout(debounce);
		debounce = setTimeout(async () => {
			searching = true;
			try {
				const res = await fetchQuery(
					q === ""
						? { filters: scopeFilters(), sorts: [{ key: "updatedAt", type: "desc" }], limit: RECENT_LIMIT }
						: { textQuery: q, filters: scopeFilters(), limit: 50 },
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

	function onKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") onclose();
		if (e.key === "ArrowDown") {
			e.preventDefault();
			selected = Math.min(selected + 1, results.length - 1);
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			selected = Math.max(selected - 1, 0);
		}
		if (e.key === "Enter" && results[selected]) open(results[selected]);
	}

	const ICON: Record<string, string> = { query: "▤", set: "▤", collection: "⛁", note: "▨", task: "☐", person: "◉", channel: "◍", agent: "◈" };

	/** Split text into [before, match, after] for highlight rendering. */
	function highlight(text: string, q: string): [string, string, string] {
		const idx = text.toLowerCase().indexOf(q.toLowerCase());
		if (q === "" || idx < 0) return [text, "", ""];
		return [text.slice(0, idx), text.slice(idx, idx + q.length), text.slice(idx + q.length)];
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div class="modal" role="dialog" aria-label="Search">
		<div class="input-row">
			<span class="scope">{channelName}</span>
			<input bind:this={inputEl} bind:value={query} placeholder="Search objects and content…" />
		</div>

		<div class="results">
			{#if query.trim() === "" && results.length > 0}
				<div class="section-name">Recently edited</div>
			{/if}
			{#each results as row, i (row.id)}
				{@const name = row.name || "Untitled"}
				{@const [b, m, a] = highlight(name, query.trim())}
				<button class="row" class:selected={i === selected} onclick={() => open(row)} onmouseenter={() => (selected = i)}>
					<span class="icon">{ICON[row.typeKey] ?? "•"}</span>
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
			{#if results.length === 0 && !searching}
				<div class="none">{query.trim() === "" ? "Nothing here yet." : "No matches."}</div>
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
		font-size: 15px;
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
		background: var(--hover);
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
	}
	.kind {
		flex: none;
		font-size: 11px;
		color: var(--muted);
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
</style>
