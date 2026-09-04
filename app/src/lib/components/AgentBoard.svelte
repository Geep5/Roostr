<script lang="ts">
	/**
	 * The message board: every A2A pair chat that involves this object's
	 * agent, rendered as collapsible threads the human can read AND post
	 * into - a human message wakes both participants for one answering
	 * turn each. Threads are ordinary chat objects; this is just a view.
	 */
	import { onMount } from "svelte";
	import type { ObjectJSON } from "$lib/types";
	import { fetchObject, fetchQuery } from "$lib/api";
	import Discussion from "./Discussion.svelte";

	let { object }: { object: ObjectJSON } = $props();

	interface Thread {
		chat: ObjectJSON;
		title: string;
		count: number;
		last: number;
	}
	let threads = $state<Thread[]>([]);

	async function load() {
		const res = await fetchQuery({ type: "chat", filters: [{ key: "a2a_pair", condition: "notEmpty" }], limit: 100 });
		const mine = res.records.filter((r) => (r.fields["objects"]?.valuesValue?.items ?? []).some((i) => i.linkValue?.targetId === object.id));
		const out: Thread[] = [];
		for (const r of mine) {
			const chat = await fetchObject(r.id);
			const msgs = chat.blocks.filter((b) => b.content.custom?.contentType === "chat");
			out.push({
				chat,
				title: r.fields["name"]?.stringValue ?? "Agents",
				count: msgs.length,
				last: Math.max(0, ...msgs.map((b) => Number(b.content.custom?.meta?.["ts"] ?? 0))),
			});
		}
		threads = out.toSorted((a, b) => b.last - a.last);
	}

	async function refreshThread(id: string) {
		const fresh = await fetchObject(id);
		threads = threads.map((t) => (t.chat.id === id ? { ...t, chat: fresh, count: fresh.blocks.filter((b) => b.content.custom?.contentType === "chat").length } : t));
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
		<h3>Agent conversations</h3>
		{#each threads as t, i (t.chat.id)}
			<details class="thread" open={i === 0}>
				<summary>🤝 {t.title} <span class="muted">· {t.count} message{t.count === 1 ? "" : "s"}</span></summary>
				<Discussion object={t.chat} full onchanged={() => refreshThread(t.chat.id)} />
			</details>
		{/each}
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
	.thread {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px 12px;
		margin-bottom: 8px;
	}
	.thread summary {
		cursor: pointer;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--fg);
	}
	.muted {
		color: var(--muted);
		font-weight: 400;
	}
</style>
