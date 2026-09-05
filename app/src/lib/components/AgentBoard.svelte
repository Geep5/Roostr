<script lang="ts">
	/**
	 * Agent conversations: every A2A chat this object's agent has had.
	 * A conversation is ONE chat object (identity = the agent pair);
	 * object pages merely project the ones that involve them - found two
	 * ways: the chat's `objects` links name this object, or this object's
	 * bound agent is a participant. Rows are a compact inbox (title,
	 * last-message snippet, time, count); expanding renders the full
	 * thread inline, where the human can read AND post - a message wakes
	 * both participants for one answering turn each.
	 */
	import { onMount } from "svelte";
	import type { ObjectJSON } from "$lib/types";
	import { fetchObject, fetchQuery } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import Discussion from "./Discussion.svelte";

	let { object }: { object: ObjectJSON } = $props();

	interface Thread {
		chat: ObjectJSON;
		title: string;
		count: number;
		last: number;
		snippet: string;
		snippetWho: string;
	}
	let threads = $state<Thread[]>([]);
	let openIds = $state<Record<string, boolean>>({});
	let shown = $state(6);

	/** meta.author is an agent uuid; resolve a short display name. */
	function whoName(author: string): string {
		if (!author || author.length !== 36) return "you";
		return store.summaries.find((s) => s.id === author)?.name || "agent";
	}

	async function load() {
		// This object's bound agent, if one has been minted.
		const agentRes = await fetchQuery({
			type: "agent",
			filters: [{ key: "bound_object", condition: "equal", value: object.id }],
			limit: 1,
		});
		const agentId = agentRes.records[0]?.id ?? "";

		const res = await fetchQuery({ type: "chat", filters: [{ key: "a2a_pair", condition: "notEmpty" }], limit: 500 });
		const mine = res.records.filter((r) => {
			const linksMe = (r.fields["objects"]?.valuesValue?.items ?? []).some((i) => i.linkValue?.targetId === object.id);
			const participates =
				!!agentId && (r.fields["participants"]?.valuesValue?.items ?? []).some((i) => i.stringValue === agentId);
			return linksMe || participates;
		});
		const out: Thread[] = [];
		for (const r of mine.slice(0, 30)) {
			const chat = await fetchObject(r.id);
			const msgs = chat.blocks.filter((b) => b.content.custom?.contentType === "chat");
			const lastMsg = msgs[msgs.length - 1];
			const meta = lastMsg?.content.custom?.meta ?? {};
			out.push({
				chat,
				title: r.fields["name"]?.stringValue ?? "Agents",
				count: msgs.length,
				last: Math.max(0, ...msgs.map((b) => Number(b.content.custom?.meta?.["ts"] ?? 0))),
				snippet: (meta["text"] ?? "").slice(0, 90),
				snippetWho: whoName(meta["author"] ?? ""),
			});
		}
		threads = out.toSorted((a, b) => b.last - a.last);
	}

	async function refreshThread(id: string) {
		const fresh = await fetchObject(id);
		threads = threads.map((t) =>
			t.chat.id === id
				? { ...t, chat: fresh, count: fresh.blocks.filter((b) => b.content.custom?.contentType === "chat").length }
				: t,
		);
	}

	function when(ts: number): string {
		if (!ts) return "";
		const m = Math.round((Date.now() - ts) / 60000);
		if (m < 1) return "now";
		if (m < 60) return `${m}m`;
		if (m < 48 * 60) return `${Math.round(m / 60)}h`;
		return `${Math.round(m / 1440)}d`;
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
		{#each threads.slice(0, shown) as t (t.chat.id)}
			<div class="thread" class:open={openIds[t.chat.id]}>
				<button class="row" onclick={() => (openIds[t.chat.id] = !openIds[t.chat.id])}>
					<span class="glyph">🤝</span>
					<span class="row-main">
						<span class="row-top">
							<span class="title">{t.title}</span>
							<span class="time">{when(t.last)}</span>
						</span>
						<span class="snippet">
							{#if t.snippet}<b>{t.snippetWho}:</b> {t.snippet}{:else}No messages yet{/if}
						</span>
					</span>
					<span class="count">{t.count}</span>
					<a class="jump" href="/object/{t.chat.id}" data-tip="Open chat" onclick={(e) => e.stopPropagation()}>↗</a>
				</button>
				{#if openIds[t.chat.id]}
					<div class="body">
						<Discussion object={t.chat} full onchanged={() => refreshThread(t.chat.id)} />
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