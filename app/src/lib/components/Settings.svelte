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
	let importing = $state(false);
	let importDraft = $state("");
	let importError = $state("");

	async function importKey() {
		importError = "";
		try {
			await settings.importKey(importDraft.trim());
			importing = false;
			importDraft = "";
			revealed = false;
			nsec = "";
			hexKey = "";
			await load();
		} catch (err) {
			importError = err instanceof Error ? err.message : String(err);
		}
	}

	// Agent credentials: managed by the harness daemon's localhost auth
	// endpoint (it owns auth.json and the OAuth exchange).
	const HARNESS = "http://127.0.0.1:7334";
	interface ProviderStatus {
		mode: "plan" | "api_key" | "env" | "claude_code" | "none";
		masked?: string;
		expires?: number;
	}
	let agentAuth = $state<{ anthropic: ProviderStatus; kimi: ProviderStatus } | null | undefined>(undefined);
	let anthropicDraft = $state("");
	let kimiDraft = $state("");
	let agentSaved = $state("");
	let loginPending = $state(false);
	let loginCode = $state("");
	let loginError = $state("");

	async function loadAgentAuth() {
		try {
			const res = await fetch(`${HARNESS}/auth/status`);
			agentAuth = (await res.json()) as { anthropic: ProviderStatus; kimi: ProviderStatus };
		} catch {
			agentAuth = null; // daemon offline
		}
	}

	async function load() {
		const s = await settings.fetch();
		relays = s.relays;
		await loadAgentAuth();
	}

	onMount(() => {
		void load();
	});

	function flashSaved(label: string) {
		agentSaved = label;
		setTimeout(() => (agentSaved = ""), 1500);
	}

	async function saveAgentKey(provider: "anthropic" | "kimi", key: string) {
		await fetch(`${HARNESS}/auth/key`, { method: "POST", body: JSON.stringify({ provider, key: key.trim() }) });
		anthropicDraft = "";
		kimiDraft = "";
		await loadAgentAuth();
		flashSaved(key.trim() ? "Saved" : "Cleared");
	}

	/** Plan sign-in: open claude.ai authorize page, then paste the code back. */
	async function startLogin() {
		loginError = "";
		const res = await fetch(`${HARNESS}/auth/anthropic/start`, { method: "POST" });
		const out = (await res.json()) as { authUrl?: string; error?: string };
		if (!out.authUrl) {
			loginError = out.error ?? "could not start login";
			return;
		}
		loginPending = true;
		window.open(out.authUrl, "_blank", "noopener");
	}

	async function finishLogin() {
		loginError = "";
		const res = await fetch(`${HARNESS}/auth/anthropic/finish`, { method: "POST", body: JSON.stringify({ code: loginCode.trim() }) });
		const out = (await res.json()) as { ok?: boolean; error?: string };
		if (!out.ok) {
			loginError = out.error ?? "exchange failed";
			return;
		}
		loginPending = false;
		loginCode = "";
		await loadAgentAuth();
		flashSaved("Signed in");
	}

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
			{#if !importing}
				<button class="action subtle" onclick={() => (importing = true)}>Sign in with existing key…</button>
			{:else}
				<p class="hint">
					<b>Replaces this device's identity.</b> Paste the nsec from your other device — after the
					sync daemon connects, your objects will backfill from the relays.
				</p>
				<form
					class="import-form"
					onsubmit={(e) => {
						e.preventDefault();
						if (importDraft.trim()) void importKey();
					}}
				>
					<input bind:value={importDraft} type="password" placeholder="nsec1… or 64-char hex" autocomplete="off" />
					<button type="submit">Import</button>
					<button type="button" onclick={() => { importing = false; importDraft = ""; importError = ""; }}>Cancel</button>
				</form>
				{#if importError}<p class="hint error">{importError}</p>{/if}
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

		<section>
			<h3>Agent {agentSaved ? `· ${agentSaved}` : ""}</h3>
			{#if agentAuth === undefined}
				<p class="hint">Checking agent daemon…</p>
			{:else if agentAuth === null}
				<p class="hint">
					Agent daemon is offline — start it to manage credentials:
					<code>cd harness && bun run serve</code>
				</p>
			{:else}
				<p class="hint">
					Sign in with your Claude <b>Pro/Max plan</b> (recommended) or paste an API key.
					Credentials live in <code>~/.glon/auth.json</code> (owner-only) and apply immediately.
				</p>
				<div class="provider">
					<span class="pname">Anthropic</span>
					{#if agentAuth.anthropic.mode === "plan"}
						<code class="masked">Signed in with Claude plan</code>
						<button onclick={() => void saveAgentKey("anthropic", "")}>Sign out</button>
					{:else if agentAuth.anthropic.mode === "api_key"}
						<code class="masked">API key set ({agentAuth.anthropic.masked})</code>
						<button onclick={() => void saveAgentKey("anthropic", "")}>Clear</button>
					{:else if loginPending}
						<form
							class="code-form"
							onsubmit={(e) => {
								e.preventDefault();
								if (loginCode.trim()) void finishLogin();
							}}
						>
							<input bind:value={loginCode} placeholder="Paste the code from claude.ai" autocomplete="off" />
							<button type="submit">Finish</button>
							<button type="button" class="subtle-btn" onclick={() => { loginPending = false; loginCode = ""; loginError = ""; }}>Cancel</button>
						</form>
					{:else}
						<button class="action" onclick={() => void startLogin()}>Sign in with Claude</button>
						{#if agentAuth.anthropic.mode === "claude_code"}
							<span class="fallback">currently using your Claude Code login</span>
						{:else if agentAuth.anthropic.mode === "env"}
							<span class="fallback">currently using ANTHROPIC_API_KEY from the environment</span>
						{/if}
					{/if}
				</div>
				{#if loginPending}
					<p class="hint">A claude.ai tab opened — approve access, copy the code it shows, and paste it above.</p>
				{/if}
				{#if loginError}
					<p class="hint error">{loginError}</p>
				{/if}
				{#if agentAuth.anthropic.mode !== "plan" && agentAuth.anthropic.mode !== "api_key" && !loginPending}
					<form
						class="keyrow-form"
						onsubmit={(e) => {
							e.preventDefault();
							if (anthropicDraft.trim()) void saveAgentKey("anthropic", anthropicDraft);
						}}
					>
						<input bind:value={anthropicDraft} type="password" placeholder="or paste an API key: sk-ant-…" autocomplete="off" />
						<button type="submit">Save</button>
					</form>
				{/if}
				<div class="provider">
					<span class="pname">Kimi (Moonshot)</span>
					{#if agentAuth.kimi.mode === "api_key"}
						<code class="masked">API key set ({agentAuth.kimi.masked})</code>
						<button onclick={() => void saveAgentKey("kimi", "")}>Clear</button>
					{:else}
						<form
							onsubmit={(e) => {
								e.preventDefault();
								if (kimiDraft.trim()) void saveAgentKey("kimi", kimiDraft);
							}}
						>
							<input bind:value={kimiDraft} type="password" placeholder="sk-…" autocomplete="off" />
							<button type="submit">Save</button>
						</form>
					{/if}
				</div>
			{/if}
		</section>
	</div>
</div>

<style>
	.import-form {
		display: flex;
		gap: 8px;
		margin-top: 6px;
	}
	.import-form input {
		flex: 1;
	}
	.fallback {
		color: var(--muted);
		font-size: 11px;
	}
	.error {
		color: #e8524a;
	}
	.code-form,
	.keyrow-form {
		display: flex;
		gap: 8px;
		flex: 1;
	}
	.keyrow-form {
		margin: 4px 0 10px 140px;
	}
	.keyrow-form input,
	.code-form input {
		flex: 1;
	}
	.subtle-btn {
		color: var(--muted);
	}
	.provider {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
	}
	.pname {
		flex: 0 0 130px;
		font-size: 13px;
	}
	.provider form {
		display: flex;
		gap: 8px;
		flex: 1;
	}
	.provider input {
		flex: 1;
	}
	.masked {
		color: var(--muted);
		font-size: 12px;
	}
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
