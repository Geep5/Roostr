<script lang="ts">
	import { onMount } from "svelte";
	import { settings } from "$lib/api";

	let { onclose }: { onclose: () => void } = $props();

	let relays = $state<string[]>([]);
	let newRelay = $state("");
	let nsec = $state("");
	let hexKey = $state("");
	let revealed = $state(false);
	let copied = $state("");
	let saveState = $state("");

	onMount(() => {
		void settings.fetch().then((s) => (relays = s.relays));
	});

	async function reveal() {
		const out = await settings.exportKey();
		nsec = out.nsec;
		hexKey = out.hex;
		revealed = true;
	}

	async function copy(text: string, label: string) {
		await navigator.clipboard.writeText(text);
		copied = label;
		setTimeout(() => (copied = ""), 1500);
	}

	async function saveRelays(next: string[]) {
		const out = await settings.setRelays(next);
		relays = out.relays;
		saveState = "Saved";
		setTimeout(() => (saveState = ""), 1500);
	}

	function addRelay() {
		let v = newRelay.trim();
		if (!v) return;
		if (!v.startsWith("wss://") && !v.startsWith("ws://")) v = `wss://${v}`;
		if (!relays.includes(v)) void saveRelays([...relays, v]);
		newRelay = "";
	}

	const SUGGESTED = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];
</script>

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div class="modal" role="dialog" aria-label="Settings">
		<header>
			<h2>Settings</h2>
			<button class="x" onclick={onclose}>×</button>
		</header>

		<section>
			<h3>Nostr identity</h3>
			<p class="hint">
				This key encrypts and signs everything you sync. Anyone holding it has your full identity —
				export it only to back it up or to log in on another device.
			</p>
			{#if !revealed}
				<button class="action" onclick={() => void reveal()}>Reveal private key</button>
			{:else}
				<div class="keyrow">
					<code>{nsec}</code>
					<button onclick={() => void copy(nsec, "nsec")}>{copied === "nsec" ? "Copied" : "Copy"}</button>
				</div>
				<div class="keyrow">
					<code>{hexKey}</code>
					<button onclick={() => void copy(hexKey, "hex")}>{copied === "hex" ? "Copied" : "Copy"}</button>
				</div>
				<button class="action subtle" onclick={() => { revealed = false; nsec = ""; hexKey = ""; }}>Hide</button>
			{/if}
		</section>

		<section>
			<h3>Relays {saveState ? `· ${saveState}` : ""}</h3>
			<p class="hint">Where your encrypted changes sync. Your data stays local until relays are configured.</p>
			{#each relays as r (r)}
				<div class="relay">
					<span>{r}</span>
					<button class="x" onclick={() => void saveRelays(relays.filter((x) => x !== r))}>×</button>
				</div>
			{/each}
			{#if relays.length === 0}
				<p class="hint none">No relays configured.</p>
			{/if}
			<form
				onsubmit={(e) => {
					e.preventDefault();
					addRelay();
				}}
			>
				<input bind:value={newRelay} placeholder="wss://relay.example.com" />
				<button type="submit">Add</button>
			</form>
			{#if relays.length === 0}
				<div class="suggested">
					{#each SUGGESTED as s (s)}
						<button class="chip" onclick={() => void saveRelays([...relays, s])}>{s.replace("wss://", "")}</button>
					{/each}
				</div>
			{/if}
		</section>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
	}
	.modal {
		width: 560px;
		max-width: calc(100vw - 48px);
		max-height: 80vh;
		overflow-y: auto;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 14px;
		padding: 18px 22px 22px;
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}
	h2 {
		margin: 0;
		font-size: 17px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin: 18px 0 6px;
	}
	.hint {
		color: var(--muted);
		font-size: 12px;
		margin: 0 0 10px;
		line-height: 1.5;
	}
	.hint.none {
		margin: 4px 0;
	}
	.action {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 8px;
		padding: 7px 14px;
		font-size: 13px;
		cursor: pointer;
	}
	.action:hover {
		border-color: var(--accent);
	}
	.action.subtle {
		color: var(--muted);
		margin-top: 6px;
	}
	.keyrow {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 6px;
	}
	.keyrow code {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 7px 10px;
		font-size: 11px;
		overflow-x: auto;
		white-space: nowrap;
	}
	.keyrow button,
	.relay button,
	form button {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 7px;
		padding: 5px 12px;
		font-size: 12px;
		cursor: pointer;
	}
	.keyrow button:hover,
	form button:hover {
		border-color: var(--accent);
	}
	.relay {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 13px;
		margin-bottom: 6px;
		font-family: ui-monospace, monospace;
	}
	.x {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		font-size: 16px;
	}
	.x:hover {
		color: #f55522;
	}
	form {
		display: flex;
		gap: 8px;
		margin-top: 8px;
	}
	form input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 13px;
	}
	form input:focus {
		border-color: var(--accent);
		outline: none;
	}
	.suggested {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.chip {
		border: 1px dashed var(--border);
		background: none;
		color: var(--muted);
		border-radius: 999px;
		padding: 3px 12px;
		font-size: 12px;
		cursor: pointer;
	}
	.chip:hover {
		color: var(--fg);
		border-color: var(--accent);
	}
</style>
