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
	import { renderMarkdown } from "$lib/markdown";

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
	let composerEl = $state<HTMLTextAreaElement>();
	const isOpen = $derived(full || open);
	$effect(() => {
		if (isOpen) composerEl?.focus();
	});
	let draft = $state("");
	let replyTo = $state("");
	let pickerFor = $state("");
	let me = $state("");

	$effect(() => {
		void settings.fetch().then((s) => (me = s.authorId));
	});

	// ── Agent presence ─────────────────────────────────────────────
	// The harness reports live turn state on its localhost surface;
	// while the discussion is open we poll it so the user sees the
	// agent composing (typing dots) or failing (warning row).
	const HARNESS = "http://127.0.0.1:7334";
	interface AgentPresence {
		id: string;
		name: string;
		icon: string;
		state: "idle" | "working" | "error";
		surface: string;
		detail: string;
		ts: number;
	}
	let presence = $state<AgentPresence[]>([]);
	$effect(() => {
		if (!isOpen) {
			presence = [];
			return;
		}
		let gone = false;
		const tick = async () => {
			try {
				const res = await fetch(`${HARNESS}/agent/status`);
				const body = (await res.json()) as { agents?: AgentPresence[] };
				if (!gone) presence = body.agents ?? [];
			} catch {
				if (!gone) presence = [];
			}
		};
		void tick();
		const timer = setInterval(tick, 2500);
		return () => {
			gone = true;
			clearInterval(timer);
		};
	});
	const agentWorking = $derived(presence.find((p) => p.state === "working"));
	const agentError = $derived(presence.find((p) => p.state === "error" && Date.now() - p.ts < 15 * 60_000));
	const errorHint = $derived(agentError && /auth|key|401|credential/i.test(agentError.detail) ? "Fix in Settings → Agent." : "");

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

	/**
	 * Emoji avatar for an author, when it has one: agents post as their
	 * object id and carry iconEmoji (set from the space's Agents
	 * settings); the chat object itself covers agent-brain chats.
	 */
	function avatarEmoji(author: string): string {
		if (author === object.id) return object.fields["iconEmoji"]?.stringValue ?? "";
		return store.summaries.find((s) => s.id === author)?.icon ?? "";
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
		<!-- Anytype commentCounter: a centered floating pill, not a full-width bar. -->
		<div class="counter-wrap">
			<button class="opener" onclick={() => (open = true)}>
				<span class="opener-icon">💬</span>
				<span class="opener-label">{messages.length > 0 ? `${messages.length} comment${messages.length === 1 ? "" : "s"}` : "Start a discussion"}</span>
			</button>
		</div>
	{:else}
		{#if !full}
			<!-- Anytype commentSection: a SHORT rule, then the 600-weight title. -->
			<div class="rule"></div>
			<div class="head">
				<span class="head-title">Discussion</span>
				<button class="collapse" title="Collapse" onclick={() => (open = false)}>×</button>
			</div>
		{/if}
		<div class="messages">
			{#each messages as m (m.id)}
				<div class="msg" id="msg-{m.id}">
					{#if avatarEmoji(m.author)}
						<span class="avatar emoji">{avatarEmoji(m.author)}</span>
					{:else}
						<span class="avatar" style="background: hsl({hue(m.author)}, 45%, 35%)">{m.author.slice(0, 2)}</span>
					{/if}
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
						<div class="text md">{@html renderMarkdown(m.text)}</div>
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
			{#if agentWorking}
				<div class="presence working" title="The agent is composing a reply">
					{#if agentWorking.icon}
						<span class="avatar emoji">{agentWorking.icon}</span>
					{:else}
						<span class="avatar" style="background: hsl({hue(agentWorking.id)}, 45%, 35%)">{agentWorking.name.slice(0, 2)}</span>
					{/if}
					<span class="p-name">{agentWorking.name}</span>
					<span class="dots"><i></i><i></i><i></i></span>
				</div>
			{/if}
			{#if agentError && !agentWorking}
				<div class="presence error">
					<span class="p-glyph">⚠︎</span>
					<span class="p-text">{agentError.name} hit a problem: {agentError.detail}{errorHint ? ` — ${errorHint}` : ""}</span>
				</div>
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
		<!-- Anytype commentForm: rounded highlight box, content area on top,
		     toolbar row with the send control at the right. -->
		<div class="composer">
			<textarea
				bind:this={composerEl}
				placeholder="Write a comment… (markdown supported)"
				bind:value={draft}
				rows={1}
				oninput={(e) => {
					const el = e.currentTarget as HTMLTextAreaElement;
					el.style.height = "auto";
					el.style.height = `${el.scrollHeight}px`;
				}}
				onkeydown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						void send();
					}
					if (e.key === "Escape") replyTo = "";
				}}
			></textarea>
			<div class="form-toolbar">
				<span class="toolbar-side"></span>
				<button class="send" disabled={!draft.trim()} aria-label="Send" onclick={() => void send()}>
					<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 16V5M10 5L5 10M10 5l5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</button>
			</div>
		</div>
	{/if}
</section>

<style>
	/* Anytype commentSection: the whole section (divider, title, posts,
	   composer) lives inside the content column - align to the 48px rail. */
	.discussion {
		margin-top: 32px;
		margin-left: 48px;
	}
	.discussion.full {
		margin-left: 0;
	}
	.counter-wrap {
		display: flex;
		justify-content: center;
		padding: 4px 0 12px;
	}
	/* Anytype's short section rule — not full width. */
	/* Anytype commentSection.isVisible: a full-width border-top across
	   the section (comment.scss:40), aligned with the content column. */
	.rule {
		width: 100%;
		height: 1px;
		background: var(--border);
		margin: 0 0 16px;
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
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border: none;
		background: rgb(255 255 255 / 0.06);
		backdrop-filter: blur(10px);
		color: var(--muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		padding: 7px 12px 7px 10px;
		border-radius: 18px;
	}
	/* Mobile: the opener collapses to a centered round chat button. */
	@media (max-width: 720px) {
		.counter-wrap {
			display: flex;
			justify-content: center;
		}
		.opener {
			width: 48px;
			height: 48px;
			border-radius: 50%;
			padding: 0;
			justify-content: center;
			font-size: 20px;
		}
		.opener .opener-icon {
			margin: 0;
		}
		.opener .opener-label {
			display: none;
		}
	}
	.opener:hover {
		background: var(--hover);
		color: var(--fg);
	}
	.opener-icon {
		font-size: 12px;
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
		word-break: break-word;
	}
	/* Markdown render ({@html} content needs :global under scoped styles) */
	.md :global(p) {
		margin: 0 0 6px;
	}
	.md :global(p:last-child) {
		margin-bottom: 0;
	}
	.md :global(code.ic) {
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
		background: var(--hover, #2a2a2a);
		border-radius: 4px;
		padding: 1px 5px;
	}
	.md :global(pre.cb) {
		position: relative;
		font-family: ui-monospace, monospace;
		font-size: 12.5px;
		line-height: 1.5;
		background: var(--hover, #1d1d1d);
		border: 1px solid var(--border, #2a2a2a);
		border-radius: 8px;
		padding: 8px 10px;
		margin: 6px 0;
		overflow-x: auto;
		white-space: pre;
	}
	.md :global(pre.cb .cb-lang) {
		display: block;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin-bottom: 4px;
	}
	.md :global(pre.cb code) {
		background: none;
		padding: 0;
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 4px 0;
		padding-left: 20px;
	}
	.md :global(blockquote) {
		margin: 4px 0;
		padding: 2px 10px;
		border-left: 2px solid var(--accent);
		color: var(--muted);
	}
	.md :global(.md-h) {
		font-weight: 700;
		margin: 6px 0 2px;
	}
	.md :global(.md-h1) {
		font-size: 17px;
	}
	.md :global(.md-h2) {
		font-size: 15.5px;
	}
	.md :global(.md-h3) {
		font-size: 14px;
	}
	.md :global(hr) {
		border: none;
		border-top: 1px solid var(--border, #2a2a2a);
		margin: 8px 0;
	}
	.md :global(a) {
		color: var(--accent);
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
		background: rgb(10 132 255 / 0.12);
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
	/* Anytype commentForm: rounded shape-highlight-light box. */
	.composer {
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		margin-top: 10px;
	}
	.composer textarea {
		background: none;
		border: none;
		outline: none;
		resize: none;
		color: var(--fg);
		font: inherit;
		font-size: 14px;
		line-height: 1.45;
		padding: 12px 12px 4px;
		max-height: 40vh;
	}
	.form-toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 8px 8px;
		min-height: 36px;
	}
	.send {
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: none;
		background: var(--accent);
		color: #fff;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0;
	}
	.send :global(svg) {
		width: 16px;
		height: 16px;
	}
	.send:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.send:not(:disabled):hover {
		border-color: var(--accent);
	}
	.empty {
		color: var(--muted);
		font-size: 13px;
	}
	.avatar.emoji {
		background: var(--hl-light, rgba(255, 255, 255, 0.07));
		font-size: 17px;
	}
	.presence {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 0 6px;
		font-size: 12px;
		color: var(--muted);
	}
	.presence .p-name {
		font-weight: 500;
	}
	.dots {
		display: inline-flex;
		gap: 3px;
		align-items: center;
	}
	.dots i {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--muted);
		animation: dot-pulse 1.2s infinite ease-in-out;
	}
	.dots i:nth-child(2) {
		animation-delay: 0.2s;
	}
	.dots i:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes dot-pulse {
		0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
		30% { opacity: 1; transform: translateY(-2px); }
	}
	.presence.error {
		color: var(--orange, #ff9f0a);
	}
	.presence .p-glyph {
		font-size: 13px;
	}
	.presence .p-text {
		line-height: 1.4;
	}
</style>
