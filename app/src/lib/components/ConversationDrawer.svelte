<script lang="ts">
	/**
	 * The drawer's two levels: a LIST of every conversation this object is
	 * in (its own discussion pinned first, then the agent's A2A chats),
	 * and a THREAD filling the drawer when a row is clicked - ‹ returns to
	 * the list, Esc goes up one level (thread → list → closed). With only
	 * the discussion to show, the list is skipped and the thread opens
	 * directly - no menu of one.
	 */
	import { onMount } from "svelte";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchObject } from "$lib/api";
	import { discussionUI } from "$lib/data.svelte";
	import { agoShort, lastMessage, loadAgentThreads, whoName, type AgentThread } from "$lib/conversations";
	import Discussion from "./Discussion.svelte";

	let { object, onchanged }: { object: ObjectJSON; onchanged: () => Promise<void> } = $props();

	let view = $state<"list" | "thread">("list");
	let activeId = $state("");
	let threads = $state<AgentThread[]>([]);
	let activeChat = $state<ObjectJSON | undefined>();
	let booted = $state(false);

	const disc = $derived(lastMessage(object));
	const isDiscussion = $derived(activeId === "__discussion__");
	const activeTitle = $derived(
		isDiscussion ? "Discussion" : (threads.find((t) => t.id === activeId)?.title ?? "Conversation"),
	);

	async function load() {
		threads = await loadAgentThreads(object.id);
		discussionUI.convCount = threads.length + 1;
		if (!booted) {
			booted = true;
			// No menu of one: only the discussion exists → open it directly.
			if (threads.length === 0) openThread("__discussion__");
		}
	}

	async function openThread(id: string) {
		activeId = id;
		view = "thread";
		if (id !== "__discussion__") activeChat = await fetchObject(id);
	}

	async function refreshActive() {
		if (isDiscussion) {
			await onchanged();
		} else if (activeId) {
			activeChat = await fetchObject(activeId);
		}
	}

	function back() {
		view = "list";
		activeChat = undefined;
		activeId = "";
	}

	function onKey(e: KeyboardEvent) {
		if (e.key !== "Escape") return;
		if (view === "thread") back();
		else discussionUI.open = false;
	}

	onMount(() => {
		void load();
		// Agent replies land asynchronously - keep the drawer breathing.
		const timer = setInterval(() => {
			void load();
			if (view === "thread" && !isDiscussion) void refreshActive();
		}, 8000);
		return () => clearInterval(timer);
	});
</script>

<svelte:window onkeydown={onKey} />

<header class="dd-head">
	{#if view === "thread"}
		<button class="dd-back" data-tip="Back to conversations (Esc)" onclick={back}>‹</button>
		<div class="dd-titles">
			<span class="dd-title">{activeTitle}</span>
			<span class="dd-sub">{fieldStr(object.fields, "name") || "Untitled"}</span>
		</div>
		{#if !isDiscussion && activeId}
			<a class="dd-jump" href="/object/{activeId}" data-tip="Open chat page">↗</a>
		{/if}
	{:else}
		<span class="dd-icon">💬</span>
		<div class="dd-titles">
			<span class="dd-title">Conversations</span>
			<span class="dd-sub">{fieldStr(object.fields, "name") || "Untitled"}</span>
		</div>
		<span class="dd-count">{threads.length + 1}</span>
	{/if}
	<button class="dd-close" data-tip="Close" onclick={() => (discussionUI.open = false)}>»</button>
</header>

{#if view === "list"}
	<div class="dd-list">
		<button class="conv" onclick={() => void openThread("__discussion__")}>
			<span class="glyph">💬</span>
			<span class="conv-main">
				<span class="conv-top">
					<span class="conv-title">Discussion</span>
					<span class="conv-time">{agoShort(disc.last)}</span>
				</span>
				<span class="conv-snippet">
					{#if disc.text}<b>{whoName(disc.author)}:</b> {disc.text}{:else}Start a discussion{/if}
				</span>
			</span>
			{#if disc.count > 0}<span class="conv-count">{disc.count}</span>{/if}
		</button>
		{#each threads as t (t.id)}
			<button class="conv" onclick={() => void openThread(t.id)}>
				<span class="glyph">🤝</span>
				<span class="conv-main">
					<span class="conv-top">
						<span class="conv-title">{t.title}</span>
						<span class="conv-time">{agoShort(t.last)}</span>
					</span>
					<span class="conv-snippet">
						{#if t.snippet}<b>{t.snippetWho}:</b> {t.snippet}{:else}No messages yet{/if}
					</span>
				</span>
				<span class="conv-count">{t.count}</span>
			</button>
		{/each}
	</div>
{:else}
	<div class="dd-body">
		{#if isDiscussion}
			<Discussion {object} full onchanged={refreshActive} />
		{:else if activeChat}
			<Discussion object={activeChat} full onchanged={refreshActive} />
		{:else}
			<p class="dd-loading">Loading…</p>
		{/if}
	</div>
{/if}

<style>
	.dd-head {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-bottom: 1px solid var(--border);
		flex: none;
	}
	.dd-icon {
		font-size: 16px;
	}
	.dd-back {
		background: none;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--muted);
		font-size: 16px;
		width: 26px;
		height: 26px;
		line-height: 1;
		cursor: pointer;
		flex: none;
	}
	.dd-back:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.dd-titles {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.dd-title {
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dd-sub {
		font-size: 11.5px;
		color: var(--muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.dd-count {
		font-size: 12px;
		color: var(--muted);
		flex: none;
	}
	.dd-jump {
		color: var(--muted);
		text-decoration: none;
		font-size: 13px;
		flex: none;
		padding: 2px 5px;
		border: 1px solid var(--border);
		border-radius: 7px;
	}
	.dd-jump:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.dd-close {
		background: none;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--muted);
		font-size: 14px;
		width: 26px;
		height: 26px;
		cursor: pointer;
		flex: none;
	}
	.dd-close:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.dd-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.conv {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		background: none;
		border: 1px solid transparent;
		border-radius: 10px;
		color: var(--fg);
		text-align: left;
		padding: 9px 10px;
		cursor: pointer;
	}
	.conv:hover {
		background: var(--hover);
	}
	.glyph {
		font-size: 16px;
		flex: none;
	}
	.conv-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.conv-top {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.conv-title {
		flex: 1;
		min-width: 0;
		font-size: 13.5px;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.conv-time {
		font-size: 11px;
		color: var(--muted);
		flex: none;
	}
	.conv-snippet {
		font-size: 12px;
		color: var(--muted);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.conv-snippet b {
		font-weight: 600;
		color: var(--fg);
	}
	.conv-count {
		font-size: 11px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 1px 7px;
		flex: none;
	}
	.dd-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.dd-loading {
		color: var(--muted);
		font-size: 13px;
		padding: 14px;
	}
	/* The full-variant Discussion fills the drawer: messages scroll,
	   composer pinned at the bottom. */
	.dd-body :global(.discussion.full) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0 14px 12px;
	}
	.dd-body :global(.discussion.full .messages) {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		max-height: none;
	}
</style>