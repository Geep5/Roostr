<script lang="ts">
	/**
	 * Anytype's smile menu, compact: searchable emoji grid + random +
	 * remove. Any emoji can also be typed/pasted straight into the
	 * search box and picked from the first cell. Icons are plain
	 * Unicode — portable through nostr sync as-is (NIP-30 image emoji
	 * can layer on later).
	 */
	import { EMOJI, EMOJI_GROUPS } from "$lib/emoji-data";

	let {
		onpick,
		onclose,
		withImage = false,
	}: {
		onpick: (emoji: string) => void;
		onclose: () => void;
		/** Anytype's Upload tab analog: accept an image URL as the icon. */
		withImage?: boolean;
	} = $props();

	let query = $state("");
	let inputEl = $state<HTMLInputElement>();
	let menuEl = $state<HTMLElement>();

	$effect(() => {
		inputEl?.focus();
	});

	/**
	 * Extra search words for emoji whose CLDR name misses the obvious query
	 * ("bot" never appears in "robot face", "zap" never in "high voltage").
	 * Carried over from the hand-picked list this picker shipped with, so no
	 * search that used to work stops working now that the set is complete.
	 */
	const ALIASES: Record<string, string> = {
		"📝": "note memo", "📄": "page", "📋": "clipboard list", "📌": "pin", "📎": "clip attach",
		"✏️": "edit", "🗂️": "files organize", "🗃️": "archive", "🗄️": "cabinet", "✅": "done task",
		"☑️": "todo", "🎯": "goal", "🚀": "launch ship", "🔥": "hot", "⭐": "favorite",
		"💡": "idea", "⚡": "zap fast", "🧠": "mind think", "💭": "thought", "🗒️": "notepad",
		"📅": "date", "⏰": "time", "⌛": "time", "🏢": "office work", "🏗️": "build",
		"💼": "work business", "🛠️": "tools build fix", "⚙️": "settings config", "🔧": "fix", "🔨": "build",
		"💻": "laptop code", "🖥️": "desktop", "⌨️": "type", "📱": "phone mobile", "🌐": "web internet",
		"🔗": "link", "🧩": "puzzle", "🤖": "bot agent ai", "🎮": "game", "🕹️": "arcade",
		"💰": "money", "💵": "cash money", "🪙": "bitcoin crypto", "📈": "growth stocks up", "📉": "down",
		"📊": "data chart", "🛒": "shopping groceries", "🛍️": "shopping", "🎁": "present", "❤️": "love",
		"😀": "happy", "😂": "funny lol", "😎": "cool", "🤔": "hmm", "😴": "tired",
		"🥳": "celebrate", "🤝": "deal", "👍": "ok approve", "👀": "look watch", "💪": "strong gym",
		"🙏": "thanks please", "👋": "hello bye", "🌲": "nature", "🍀": "luck", "☀️": "sunny",
		"🌙": "night", "🪐": "space", "🌍": "world", "☄️": "space", "☕": "cafe",
		"🧋": "boba", "🚗": "drive", "✈️": "travel flight", "🚲": "bike", "⛵": "boat",
		"🗺️": "travel", "🧳": "trip", "🎵": "song", "🎨": "art design", "📷": "photo",
		"🎬": "movie film", "⚽": "football", "🧘": "yoga zen meditate", "🏃": "exercise", "🏋️": "gym weights",
		"🔒": "secure private", "🔑": "access", "🛡️": "security", "⚠️": "caution", "❗": "important",
		"🧪": "experiment science", "🔬": "research", "🧬": "biology", "💊": "medicine health", "🩺": "doctor health",
	};

	/** Query can be a pasted emoji — offer it directly as the first cell. */
	const isEmojiQuery = $derived(query.trim() !== "" && /\p{Extended_Pictographic}/u.test(query.trim()));
	/** A pasted URL becomes an image icon when the caller allows it. */
	const isUrlQuery = $derived(withImage && /^https?:\/\/\S+$/.test(query.trim()));

	/** Flat matches while searching; null means "show the standard groups". */
	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === "" || isEmojiQuery) return null;
		return EMOJI.filter(([e, name]) => name.includes(q) || (ALIASES[e] ?? "").includes(q));
	});

	const grouped = $derived.by(() => EMOJI_GROUPS.map((label, i) => ({ label, items: EMOJI.filter((x) => x[2] === i) })));

	function random() {
		onpick(EMOJI[Math.floor(Math.random() * EMOJI.length)][0]);
	}

	function onWindowMousedown(e: MouseEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window
	onmousedown={onWindowMousedown}
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
/>

<div class="picker" bind:this={menuEl} role="dialog" aria-label="Choose emoji">
	<div class="top">
		<input bind:this={inputEl} bind:value={query} placeholder={withImage ? "Search, paste an emoji or an image URL…" : "Search or paste an emoji…"} />
		<button title="Random" onclick={random}>🎲</button>
		<button title="Remove icon" onclick={() => onpick("")}>×</button>
	</div>
	<div class="grid">
		{#if isUrlQuery}
			<button class="cell img-cell" title="Use image" onclick={() => onpick(query.trim())}>
				<img src={query.trim()} alt="icon" />
			</button>
		{:else if isEmojiQuery}
			<button class="cell paste" title="Use {query.trim()}" onclick={() => onpick(query.trim())}>{query.trim()}</button>
		{/if}
		{#if matches}
			{#each matches as x (x[0])}
				<button class="cell" title={x[1]} onclick={() => onpick(x[0])}>{x[0]}</button>
			{/each}
			{#if matches.length === 0 && !isEmojiQuery}
				<span class="none">No matches — paste any emoji instead.</span>
			{/if}
		{:else}
			{#each grouped as g (g.label)}
				<div class="ghead">{g.label}</div>
				{#each g.items as x (x[0])}
					<button class="cell" title={x[1]} onclick={() => onpick(x[0])}>{x[0]}</button>
				{/each}
			{/each}
		{/if}
	</div>
</div>

<style>
	.picker {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 90;
		width: 320px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 12px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		overflow: hidden;
	}
	.top {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 8px;
		border-bottom: 1px solid var(--border);
	}
	.top input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 7px;
		padding: 5px 9px;
		font-size: 13px;
		outline: none;
	}
	.top input:focus {
		border-color: var(--accent);
	}
	.top button {
		border: none;
		background: none;
		font-size: 16px;
		cursor: pointer;
		color: var(--muted);
	}
	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
		padding: 8px;
		/* Taller than the old 220px: the set is now the full 1,900, so a
		   two-row window would make browsing pointless. */
		max-height: 300px;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	/* Full-width break in the flex flow — the standard Unicode group order
	   is the same one every other emoji keyboard uses, so the headers are
	   the map people already know. */
	.ghead {
		flex: 0 0 100%;
		position: sticky;
		top: -8px;
		z-index: 1;
		background: var(--panel);
		color: var(--muted);
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		padding: 6px 2px 3px;
	}
	.ghead:first-child {
		padding-top: 0;
	}
	.cell {
		width: 32px;
		height: 32px;
		border: none;
		background: none;
		font-size: 19px;
		border-radius: 6px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.cell:hover {
		background: var(--hover);
	}
	.img-cell img {
		width: 26px;
		height: 26px;
		border-radius: 6px;
		object-fit: cover;
	}
	.cell.paste {
		outline: 1px dashed var(--accent);
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 8px;
	}
</style>
