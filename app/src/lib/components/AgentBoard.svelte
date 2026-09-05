<script lang="ts">
	/**
	 * Agent conversations, mobile-only surface: the desktop equivalent
	 * lives in the conversation drawer. Rows are the shared inbox shape
	 * ($lib/conversations); expanding renders the thread inline where the
	 * human can read AND post - a message wakes both participants for one
	 * answering turn each.
	 */
	import { onMount } from "svelte";
	import type { ObjectJSON } from "$lib/types";
	import { fetchObject } from "$lib/api";
	import { agoShort, loadAgentThreads, type AgentThread } from "$lib/conversations";
	import Discussion from "./Discussion.svelte";

	let { object }: { object: ObjectJSON } = $props();

	interface Thread extends AgentThread {
		chat: ObjectJSON | null;
	}
	let threads = $state<Thread[]>([]);
	let openIds = $state<Record<string, boolean>>({});
	let shown = $state(6);

	async function load() {
		const rows = await loadAgentThreads(object.id);
		threads = rows.map((r) => ({ ...r, chat: threads.find((t) => t.id === r.id)?.chat ?? null }));
	}

	async function toggleThread(id: string) {
		openIds[id] = !openIds[id];
		if (openIds[id]) await refreshThread(id);
	}

	async function refreshThread(id: string) {
		const fresh = await fetchObject(id);
		threads = threads.map((t) => (t.id === id ? { ...t, chat: fresh, count: fresh.blocks.filter((b) => b.content.custom?.contentType === "chat").length } : t));
	}

	onMount(() => {
		void load();
		// Agent replies land asynchronously - keep the board breathing.
		const timer = setInterval(() => void load(), 8000);
		return () => clearInterval(timer);
	});
</script>

{#if threads.length > 0}
	<div class="board">
		<h3>Agent conversations <span class="h-count">{threads.length}</span></h3>
		{#each threads.slice(0, shown) as t (t.id)}
			<div class="thread" class:open={openIds[t.id]}>
				<button class="row" onclick={() => void toggleThread(t.id)}>
					<span class="glyph">🤝</span>
					<span class="row-main">
						<span class="row-top">
							<span class="title">{t.title}</span>
							<span class="time">{agoShort(t.last)}</span>
						</span>
						<span class="snippet">
							{#if t.snippet}<b>{t.snippetWho}:</b> {t.snippet}{:else}No messages yet{/if}
						</span>
					</span>
					<span class="count">{t.count}</span>
					<a class="jump" href="/object/{t.id}" data-tip="Open chat" onclick={(e) => e.stopPropagation()}>↗</a>
				</button>
				{#if openIds[t.id] && t.chat}
					<div class="body">
						<Discussion object={t.chat} full onchanged={() => refreshThread(t.id)} />
					</div>
				{/if}
			</div>
		{/each}
		{#if threads.length > shown}
			<button class="more" onclick={() => (shown += 12)}>Show {threads.length - shown} more</button>
		{/if}
	</div>
{/if}

<style>
	.board {
		margin-top: 18px;
		padding: 0 48px;
	}
	.board h3 {
		font-size: 13px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin: 0 0 8px;
	}
	.h-count {
		font-weight: 400;
	}
	.thread {
		border: 1px solid var(--border);
		border-radius: 10px;
		margin-bottom: 8px;
		overflow: hidden;
	}
	.thread.open {
		border-color: var(--muted);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		background: none;
		border: none;
		color: var(--fg);
		text-align: left;
		padding: 9px 12px;
		cursor: pointer;
	}
	.row:hover {
		background: var(--hover);
	}
	.glyph {
		font-size: 16px;
		flex: none;
	}
	.row-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.row-top {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.title {
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.time {
		font-size: 11px;
		color: var(--muted);
		flex: none;
	}
	.snippet {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.snippet b {
		font-weight: 600;
		color: var(--fg);
	}
	.count {
		font-size: 11px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 1px 7px;
		flex: none;
	}
	.jump {
		color: var(--muted);
		text-decoration: none;
		font-size: 13px;
		flex: none;
		padding: 2px 4px;
		border-radius: 6px;
	}
	.jump:hover {
		color: var(--fg);
		background: var(--hover);
	}
	.body {
		border-top: 1px solid var(--border);
		padding: 0 12px 8px;
	}
	.more {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
		padding: 4px 0;
	}
	.more:hover {
		color: var(--fg);
	}
</style>