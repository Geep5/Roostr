<script lang="ts">
	/**
	 * Anytype's smile menu, compact: searchable emoji grid + random +
	 * remove. Any emoji can also be typed/pasted straight into the
	 * search box and picked from the first cell. Icons are plain
	 * Unicode — portable through nostr sync as-is (NIP-30 image emoji
	 * can layer on later).
	 */
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

	interface Entry {
		e: string;
		k: string; // search keywords
	}

	const EMOJIS: Entry[] = [
		{ e: "📝", k: "note memo write" }, { e: "📄", k: "page document" }, { e: "📋", k: "clipboard list" },
		{ e: "📌", k: "pin" }, { e: "📎", k: "clip attach" }, { e: "✏️", k: "pencil edit" },
		{ e: "📚", k: "books library" }, { e: "📖", k: "book read" }, { e: "🗂️", k: "folder files organize" },
		{ e: "🗃️", k: "archive box" }, { e: "📁", k: "folder" }, { e: "🗄️", k: "cabinet" },
		{ e: "✅", k: "check done task" }, { e: "☑️", k: "checkbox todo" }, { e: "🎯", k: "target goal" },
		{ e: "🚀", k: "rocket launch ship" }, { e: "🔥", k: "fire hot" }, { e: "⭐", k: "star favorite" },
		{ e: "💡", k: "idea light bulb" }, { e: "⚡", k: "zap lightning fast" }, { e: "🧠", k: "brain mind think" },
		{ e: "💭", k: "thought bubble" }, { e: "🗒️", k: "notepad" }, { e: "🧾", k: "receipt" },
		{ e: "📅", k: "calendar date" }, { e: "⏰", k: "alarm clock time" }, { e: "⌛", k: "hourglass time" },
		{ e: "🏠", k: "home house" }, { e: "🏢", k: "office building work" }, { e: "🏗️", k: "construction build" },
		{ e: "💼", k: "briefcase work business" }, { e: "🛠️", k: "tools build fix" }, { e: "⚙️", k: "gear settings" },
		{ e: "🔧", k: "wrench fix" }, { e: "🔨", k: "hammer build" }, { e: "🧰", k: "toolbox" },
		{ e: "💻", k: "laptop computer code" }, { e: "🖥️", k: "desktop computer" }, { e: "⌨️", k: "keyboard type" },
		{ e: "🖱️", k: "mouse" }, { e: "📱", k: "phone mobile" }, { e: "🌐", k: "globe web internet" },
		{ e: "🔗", k: "link chain" }, { e: "🧩", k: "puzzle piece" }, { e: "🤖", k: "robot bot agent" },
		{ e: "👾", k: "alien game" }, { e: "🎮", k: "game controller" }, { e: "🕹️", k: "joystick arcade" },
		{ e: "💰", k: "money bag" }, { e: "💵", k: "dollar cash money" }, { e: "🪙", k: "coin bitcoin crypto" },
		{ e: "📈", k: "chart up growth stocks" }, { e: "📉", k: "chart down" }, { e: "📊", k: "bar chart data" },
		{ e: "🛒", k: "cart shopping groceries" }, { e: "🛍️", k: "shopping bags" }, { e: "🎁", k: "gift present" },
		{ e: "❤️", k: "heart love" }, { e: "💜", k: "purple heart" }, { e: "💙", k: "blue heart" },
		{ e: "🧡", k: "orange heart" }, { e: "💚", k: "green heart" }, { e: "🖤", k: "black heart" },
		{ e: "😀", k: "smile happy grin" }, { e: "😂", k: "laugh joy funny" }, { e: "😊", k: "smile blush" },
		{ e: "😎", k: "cool sunglasses" }, { e: "🤔", k: "think hmm" }, { e: "😴", k: "sleep tired" },
		{ e: "🥳", k: "party celebrate" }, { e: "😤", k: "determined" }, { e: "🤝", k: "handshake deal" },
		{ e: "👍", k: "thumbs up ok" }, { e: "👀", k: "eyes look watch" }, { e: "💪", k: "muscle strong gym" },
		{ e: "🙏", k: "pray thanks" }, { e: "👋", k: "wave hello" }, { e: "🫡", k: "salute" },
		{ e: "🐕", k: "dog puppy" }, { e: "🐈", k: "cat kitten" }, { e: "🐢", k: "turtle" },
		{ e: "🦅", k: "eagle bird" }, { e: "🐋", k: "whale" }, { e: "🦈", k: "shark" },
		{ e: "🌲", k: "tree evergreen nature" }, { e: "🌸", k: "flower blossom" }, { e: "🌵", k: "cactus" },
		{ e: "🍀", k: "clover luck" }, { e: "🌊", k: "wave ocean water" }, { e: "⛰️", k: "mountain" },
		{ e: "☀️", k: "sun sunny" }, { e: "🌙", k: "moon night" }, { e: "🌟", k: "glowing star" },
		{ e: "🪐", k: "planet saturn space" }, { e: "🌍", k: "earth world globe" }, { e: "☄️", k: "comet space" },
		{ e: "🍕", k: "pizza food" }, { e: "🍔", k: "burger food" }, { e: "🌮", k: "taco food" },
		{ e: "☕", k: "coffee cafe" }, { e: "🍺", k: "beer drink" }, { e: "🧋", k: "boba bubble tea" },
		{ e: "🍎", k: "apple fruit" }, { e: "🥑", k: "avocado" }, { e: "🍰", k: "cake dessert" },
		{ e: "🚗", k: "car drive" }, { e: "✈️", k: "plane travel flight" }, { e: "🚲", k: "bike bicycle" },
		{ e: "⛵", k: "sailboat boat" }, { e: "🗺️", k: "map travel" }, { e: "🧳", k: "luggage trip" },
		{ e: "🎵", k: "music note song" }, { e: "🎸", k: "guitar music" }, { e: "🎧", k: "headphones listen" },
		{ e: "🎨", k: "art palette paint design" }, { e: "📷", k: "camera photo" }, { e: "🎬", k: "movie film clapper" },
		{ e: "⚽", k: "soccer football" }, { e: "🏀", k: "basketball" }, { e: "🎾", k: "tennis" },
		{ e: "🧘", k: "yoga meditate zen" }, { e: "🏃", k: "run exercise" }, { e: "🏋️", k: "lift gym weights" },
		{ e: "🔒", k: "lock secure private" }, { e: "🔑", k: "key access" }, { e: "🛡️", k: "shield security" },
		{ e: "⚠️", k: "warning caution" }, { e: "❗", k: "exclamation important" }, { e: "❓", k: "question" },
		{ e: "🧪", k: "test tube experiment science" }, { e: "🔬", k: "microscope research" }, { e: "🧬", k: "dna biology" },
		{ e: "💊", k: "pill medicine health" }, { e: "🩺", k: "doctor health" }, { e: "🦷", k: "tooth dentist" },
	];

	/** Query can be a pasted emoji — offer it directly as the first cell. */
	const isEmojiQuery = $derived(query.trim() !== "" && /\p{Extended_Pictographic}/u.test(query.trim()));
	/** A pasted URL becomes an image icon when the caller allows it. */
	const isUrlQuery = $derived(withImage && /^https?:\/\/\S+$/.test(query.trim()));

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === "" || isEmojiQuery) return EMOJIS;
		return EMOJIS.filter((x) => x.k.includes(q));
	});

	function random() {
		onpick(EMOJIS[Math.floor(Math.random() * EMOJIS.length)].e);
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
		{#each filtered as x (x.e)}
			<button class="cell" title={x.k} onclick={() => onpick(x.e)}>{x.e}</button>
		{/each}
		{#if filtered.length === 0 && !isEmojiQuery}
			<span class="none">No matches — paste any emoji instead.</span>
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
		max-height: 220px;
		overflow-y: auto;
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
