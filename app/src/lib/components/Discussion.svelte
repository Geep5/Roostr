<script lang="ts">
	/**
	 * Anytype's object discussion (block/chat): a chat at the bottom of every
	 * object, opened from a button. Messages support replies
	 * (replyToMessageId -> quoted preview above the message) and emoji
	 * reactions (chips with author counts; toggle by identity; "+" opens the
	 * emoji picker). Messages are blocks under "__discussion__" - see
	 * mutate.odin chat_post/chat_react.
	 */
	import type { ObjectJSON } from "$lib/types";
	import { chat, settings } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import EmojiPicker from "./EmojiPicker.svelte";

	let {
		object,
		full = false,
		onchanged,
	}: { object: ObjectJSON; full?: boolean; onchanged: () => Promise<void> } = $props();

	interface Message {
		id: string;
		author: string;
		ts: number;
		text: string;
		replyTo: string;
		origin: string;
		reactions: Array<{ emoji: string; authors: string[] }>;
	}

	const messages = $derived.by((): Message[] => {
		const byId = new Map(object.blocks.map((b) => [b.id, b]));
		const root = byId.get("__discussion__");
		if (!root) return [];
		const out: Message[] = [];
		for (const cid of root.childrenIds) {
			const custom = byId.get(cid)?.content.custom;
			// The harness also stores tool_use/tool_result/compaction blocks
			// under __discussion__ - only chat messages render here.
			if (custom?.contentType !== "chat") continue;
			const meta = custom.meta ?? {};
			const reactions: Message["reactions"] = [];
			for (const chunk of (meta["reactions"] ?? "").split(";")) {
				const bar = chunk.indexOf("|");
				if (bar <= 0) continue;
				const authors = chunk.slice(bar + 1).split(",").filter(Boolean);
				if (authors.length) reactions.push({ emoji: chunk.slice(0, bar), authors });
			}
			out.push({
				id: cid,
				author: meta["author"] ?? "",
				ts: Number(meta["ts"] ?? 0),
				text: meta["text"] ?? "",
				replyTo: meta["replyTo"] ?? "",
				origin: meta["origin"] ?? "",
				reactions,
			});
		}
		return out;
	});

	const messageById = $derived(new Map(messages.map((m) => [m.id, m])));

	let open = $state(false);
	const isOpen = $derived(full || open);
	let draft = $state("");
	let replyTo = $state("");
	let pickerFor = $state("");
	let me = $state("");

	$effect(() => {
		void settings.fetch().then((s) => (me = s.authorId));
	});

	function who(author: string): string {
		if (author === me) return "You";
		// The agent posts as its own object id; on its chat, the agent field.
		if (author === object.id) return object.fields["name"]?.stringValue || "Agent";
		if (author && author === object.fields["agent"]?.stringValue)
			return store.summaries.find((s) => s.id === author)?.name || object.fields["name"]?.stringValue || "Agent";
		return author.slice(0, 6);
	}

	function originName(id: string): string {
		return store.summaries.find((s) => s.id === id)?.name || "object";
	}

	/** Stable avatar hue from the author id. */
	function hue(author: string): number {
		let h = 0;
		for (const c of author) h = (h * 31 + c.charCodeAt(0)) % 360;
		return h;
	}

	function when(ts: number): string {
		const d = new Date(ts);
		const today = new Date().toDateString() === d.toDateString();
		return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
	}

	async function send() {
		const text = draft.trim();
		if (!text) return;
		draft = "";
		const reply = replyTo;
		replyTo = "";
		await chat.post(object.id, text, reply);
		await onchanged();
	}

	async function toggleReaction(messageId: string, emoji: string) {
		pickerFor = "";
		await chat.react(object.id, messageId, emoji);
		await onchanged();
	}
</script>

<section class="discussion" class:full>
	{#if !isOpen}
		<button class="opener" onclick={() => (open = true)}>
			💬 {messages.length > 0 ? `Discussion · ${messages.length}` : "Start a discussion"}
		</button>
	{:else}
		{#if !full}
			<div class="head">
				<span class="head-title">Discussion</span>
				<button class="collapse" title="Collapse" onclick={() => (open = false)}>×</button>
			</div>
		{/if}
		<div class="messages">
			{#each messages as m (m.id)}
				<div class="msg" id="msg-{m.id}">
					<span class="avatar" style="background: hsl({hue(m.author)}, 45%, 35%)">{m.author.slice(0, 2)}</span>
					<div class="body">
						{#if m.replyTo && messageById.has(m.replyTo)}
							{@const target = messageById.get(m.replyTo)!}
							<a class="quote" href="#msg-{m.replyTo}">
								<span class="q-author">{who(target.author)}</span>
								<span class="q-text">{target.text.slice(0, 80)}</span>
							</a>
						{/if}
						<div class="meta-row">
							<span class="author">{who(m.author)}</span>
							{#if m.origin}
								<a class="origin" href="/object/{m.origin}" title="Asked from this object">↳ {originName(m.origin)}</a>
							{/if}
							<span class="time">{when(m.ts)}</span>
						</div>
						<div class="text">{m.text}</div>
						{#if m.reactions.length > 0 || pickerFor === m.id}
							<div class="reactions">
								{#each m.reactions as r (r.emoji)}
									<button
										class="chip"
										class:mine={r.authors.includes(me)}
										title={r.authors.map(who).join(", ")}
										onclick={() => void toggleReaction(m.id, r.emoji)}
									>
										{r.emoji} {r.authors.length}
									</button>
								{/each}
							</div>
						{/if}
					</div>
					<div class="actions">
						<button title="Add reaction" onclick={() => (pickerFor = pickerFor === m.id ? "" : m.id)}>😀</button>
						<button title="Reply" onclick={() => (replyTo = m.id)}>↩</button>
					</div>
					{#if pickerFor === m.id}
						<div class="picker-wrap">
							<EmojiPicker onpick={(e) => void toggleReaction(m.id, e)} onclose={() => (pickerFor = "")} />
						</div>
					{/if}
				</div>
			{/each}
			{#if messages.length === 0}
				<p class="empty">No messages yet.</p>
			{/if}
		</div>
		{#if replyTo && messageById.has(replyTo)}
			{@const target = messageById.get(replyTo)!}
			<div class="replying">
				<span class="q-author">Replying to {who(target.author)}</span>
				<span class="q-text">{target.text.slice(0, 60)}</span>
				<button title="Cancel reply" onclick={() => (replyTo = "")}>×</button>
			</div>
		{/if}
		<div class="composer">
			<input
				placeholder="Write a message…"
				bind:value={draft}
				onkeydown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						void send();
					}
					if (e.key === "Escape") replyTo = "";
				}}
			/>
			<button class="send" disabled={!draft.trim()} onclick={() => void send()}>Send</button>
		</div>
	{/if}
</section>

<style>
	.discussion {
		margin-top: 32px;
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}
	.discussion.full {
		margin-top: 8px;
		border-top: none;
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 60vh;
	}
	.discussion.full .messages {
		max-height: none;
		flex: 1;
	}
	.origin {
		font-size: 11px;
		color: var(--accent);
		text-decoration: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0 6px;
	}
	.origin:hover {
		border-color: var(--accent);
	}
	.opener {
		margin-left: 40px;
		border: none;
		background: none;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
		padding: 6px 8px;
		border-radius: 8px;
	}
	.opener:hover {
		background: var(--hover);
		color: inherit;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.head-title {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
	}
	.collapse {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		font-size: 14px;
	}
	.messages {
		display: flex;
		flex-direction: column;
		gap: 14px;
		max-height: 420px;
		overflow-y: auto;
		padding: 4px 0;
	}
	.msg {
		display: flex;
		gap: 10px;
		position: relative;
	}
	.msg .actions {
		opacity: 0;
		display: flex;
		gap: 2px;
		align-self: flex-start;
		transition: opacity 0.1s;
	}
	.msg:hover .actions {
		opacity: 1;
	}
	.msg .actions button {
		border: none;
		background: none;
		cursor: pointer;
		font-size: 13px;
		padding: 2px 4px;
		border-radius: 6px;
	}
	.msg .actions button:hover {
		background: var(--hover);
	}
	.avatar {
		flex: none;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 10px;
		font-family: ui-monospace, monospace;
		color: #fff;
	}
	.body {
		flex: 1;
		min-width: 0;
	}
	.meta-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.author {
		font-size: 12px;
		font-weight: 600;
	}
	.time {
		font-size: 11px;
		color: var(--muted);
	}
	.text {
		font-size: 14px;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
	}
	.quote {
		display: flex;
		gap: 6px;
		align-items: baseline;
		font-size: 11px;
		color: var(--muted);
		border-left: 2px solid var(--accent);
		padding: 1px 6px;
		margin-bottom: 2px;
		text-decoration: none;
		overflow: hidden;
		white-space: nowrap;
	}
	.quote .q-text {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.q-author {
		font-weight: 600;
		flex: none;
	}
	.reactions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
	.chip {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 12px;
		cursor: pointer;
	}
	.chip:hover {
		border-color: var(--accent);
	}
	.chip.mine {
		border-color: var(--accent);
		background: var(--hover);
	}
	.picker-wrap {
		position: absolute;
		right: 0;
		top: 24px;
		z-index: 95;
	}
	.replying {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 11px;
		color: var(--muted);
		border-left: 2px solid var(--accent);
		padding: 2px 8px;
		margin: 8px 0 4px;
		overflow: hidden;
		white-space: nowrap;
	}
	.replying button {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		margin-left: auto;
	}
	.composer {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	.composer input {
		flex: 1;
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: inherit;
		padding: 8px 10px;
		font-size: 13px;
	}
	.send {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 8px;
		padding: 0 14px;
		cursor: pointer;
		font-size: 13px;
	}
	.send:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.send:not(:disabled):hover {
		border-color: var(--accent);
	}
	.empty {
		color: var(--muted);
		font-size: 13px;
	}
</style>
