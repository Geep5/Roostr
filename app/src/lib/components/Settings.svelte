<script lang="ts">
	import { onMount } from "svelte";
	import { fetchQuery, settings, fetchAllQuery } from "$lib/api";
	import { goto } from "$app/navigation";
	import { exportAll } from "$lib/export";
	import { ignoredWords, removeFromDictionary } from "$lib/spell";

	let { onclose }: { onclose: () => void } = $props();

	let relays = $state<string[]>([]);
	let newRelay = $state("");
	let nsec = $state("");
	let revealed = $state(false);
	let npub = $state("");
	let copied = $state("");
	let saveState = $state("");
	let importing = $state(false);
	let confirmLogout = $state(false);
	let importDraft = $state("");
	let importError = $state("");

	async function doLogout() {
		await settings.logout();
		location.reload();
	}

	async function importKey() {
		importError = "";
		try {
			await settings.importKey(importDraft.trim());
			importing = false;
			importDraft = "";
			revealed = false;
			nsec = "";
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
		// Public identity comes from the harness (the Odin server has no
		// secp256k1); shareable, shown without a reveal step.
		try {
			const res = await fetch(`${HARNESS}/identity`);
			const out = (await res.json()) as { npub?: string };
			npub = out.npub ?? "";
		} catch {
			npub = "";
		}
	}


	// ── Profile picture (kind 0 via the harness, which owns the key) ──
	const HARNESS_URL = "http://127.0.0.1:7334";
	let profilePicture = $state("");
	let avatarBusy = $state(false);
	let avatarState = $state("");
	let avatarFileEl = $state<HTMLInputElement>();

	async function loadProfile() {
		try {
			profilePicture = ((JSON.parse(localStorage.getItem("roostr-profile") ?? "{}") as { picture?: string }).picture ?? "");
		} catch {
			/* no cache */
		}
		try {
			const p = (await (await fetch(`${HARNESS_URL}/profile`)).json()) as { picture?: string };
			profilePicture = p.picture ?? "";
			localStorage.setItem("roostr-profile", JSON.stringify(p));
		} catch {
			/* harness offline - cache stands */
		}
	}
	void loadProfile();

	async function shrinkAvatar(file: File, size = 256): Promise<string> {
		const url = URL.createObjectURL(file);
		try {
			const img = await new Promise<HTMLImageElement>((resolve, reject) => {
				const el = new Image();
				el.onload = () => resolve(el);
				el.onerror = () => reject(new Error("unreadable image"));
				el.src = url;
			});
			const side = Math.min(img.width, img.height);
			const canvas = document.createElement("canvas");
			canvas.width = size;
			canvas.height = size;
			canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
			return canvas.toDataURL("image/jpeg", 0.85);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	async function pushProfile(picture: string) {
		avatarBusy = true;
		avatarState = "saving…";
		try {
			const p = (await (
				await fetch(`${HARNESS_URL}/profile`, { method: "POST", body: JSON.stringify({ picture }) })
			).json()) as { picture?: string };
			profilePicture = p.picture ?? "";
			localStorage.setItem("roostr-profile", JSON.stringify(p));
			avatarState = "saved";
		} catch {
			avatarState = "failed - is the harness running?";
		} finally {
			avatarBusy = false;
			setTimeout(() => (avatarState = ""), 2000);
		}
	}

	async function pickAvatar(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		await pushProfile(await shrinkAvatar(file));
	}

	async function removeAvatar() {
		await pushProfile("");
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

	/** Relays offered as toggles: ours on by default, public ones off. */
	const KNOWN_RELAYS = [
		{ url: "wss://roostr-relay.fly.dev", label: "Roostr relay", note: "self-hosted default" },
		{ url: "wss://relay.damus.io", label: "Damus", note: "public" },
		{ url: "wss://nos.lol", label: "nos.lol", note: "public" },
		{ url: "wss://relay.nostr.band", label: "nostr.band", note: "public aggregator - often read-only" },
	];
	const KNOWN_URLS = new Set(KNOWN_RELAYS.map((k) => k.url));

	function toggleRelay(url: string, on: boolean) {
		void saveRelays(on ? [...relays.filter((r) => r !== url), url] : relays.filter((r) => r !== url));
	}

	// ── Spellcheck ignore list ──────────────────────────────────────
	let ignored = $state<string[]>([]);
	$effect(() => {
		ignored = ignoredWords();
	});
	function unignore(w: string) {
		removeFromDictionary(w);
		ignored = ignoredWords();
	}

	// ── Export (Anytype popup/export.tsx: Markdown | Any-Block) ─────
	let exportFormat = $state<"markdown" | "json">("markdown");
	let exporting = $state(false);
	let exportNote = $state("");

	async function runExport() {
		exporting = true;
		exportNote = "";
		try {
			const n = await exportAll(exportFormat, (done, total) => {
				exportNote = `Preparing ${done}/${total}…`;
			});
			exportNote = `Exported ${n} objects.`;
		} catch (err) {
			exportNote = err instanceof Error ? err.message : String(err);
		} finally {
			exporting = false;
		}
	}

	// ── Mobile bottom-sheet drag-to-close ────────────────────────────
	// Anytype's sheet idiom: grab anywhere in the header/grabber zone
	// and pull down past the threshold to dismiss; otherwise it springs
	// back. Content scrolling is untouched (drag starts only from the
	// grabber/header, which has touch-action: none).
	let sheetY = $state(0);
	let sheetDragging = $state(false);
	let sheetStartY = 0;

	function sheetStart(e: TouchEvent) {
		sheetStartY = e.touches[0].clientY;
		sheetDragging = true;
	}
	function sheetMove(e: TouchEvent) {
		if (!sheetDragging) return;
		sheetY = Math.max(0, e.touches[0].clientY - sheetStartY);
	}
	function sheetEnd() {
		if (!sheetDragging) return;
		sheetDragging = false;
		if (sheetY > 110) onclose();
		else sheetY = 0;
	}
</script>

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div
		class="modal sheet"
		role="dialog"
		aria-label="Settings"
		style={sheetY ? `transform: translateY(${sheetY}px); transition: ${sheetDragging ? "none" : "transform 0.18s ease"}` : ""}
	>
		<div class="grab-zone" role="presentation" ontouchstart={sheetStart} ontouchmove={sheetMove} ontouchend={sheetEnd} ontouchcancel={sheetEnd}>
			<div class="grabber"></div>
		</div>
		<header role="presentation" ontouchstart={sheetStart} ontouchmove={sheetMove} ontouchend={sheetEnd} ontouchcancel={sheetEnd}>
			<h2><span class="cog">⚙️</span> Settings</h2>
			<button class="x close-x" onclick={onclose}>×</button>
		</header>

		<section>
			<h3>Profile</h3>
			<p class="hint">Your avatar - shown on the Spaces screen and synced to every device holding this key.</p>
			<div class="profile-row">
				{#if profilePicture}
					<img class="profile-avatar" src={profilePicture} alt="" />
				{:else}
					<span class="profile-avatar placeholder">⚙</span>
				{/if}
				<input type="file" accept="image/*" bind:this={avatarFileEl} onchange={(e) => void pickAvatar(e)} hidden />
				<button class="action" disabled={avatarBusy} onclick={() => avatarFileEl?.click()}>{profilePicture ? "Change picture" : "Upload picture"}</button>
				{#if profilePicture}
					<button disabled={avatarBusy} onclick={() => void removeAvatar()}>Remove</button>
				{/if}
				{#if avatarState}<span class="hint">{avatarState}</span>{/if}
			</div>
		</section>
		<section>
			<h3>Nostr identity</h3>
			<p class="hint">
				This key encrypts and signs everything you sync. Anyone holding it has your full identity —
				export it only to back it up or to log in on another device.
			</p>
			{#if npub}
				<div class="keylabel">Public key <span class="enc">npub</span> <span class="share">shareable</span></div>
				<div class="keyrow">
					<code>{npub}</code>
					<button onclick={() => void copy(npub, "npub")}>{copied === "npub" ? "Copied" : "Copy"}</button>
				</div>
			{/if}
			{#if !revealed}
				<button class="action" onclick={() => void reveal()}>Reveal private key</button>
			{:else}
				<div class="keylabel">Private key <span class="enc">nsec</span> <span class="secret">secret</span></div>
				<div class="keyrow">
					<code>{nsec}</code>
					<button onclick={() => void copy(nsec, "nsec")}>{copied === "nsec" ? "Copied" : "Copy"}</button>
				</div>
				<p class="hint">Paste this nsec into "Sign in with existing key" on another Roostr to log in as you.</p>
				<button class="action subtle" onclick={() => { revealed = false; nsec = ""; }}>Hide</button>
			{/if}
			{#if !importing}
				<button class="action subtle" onclick={() => (importing = true)}>Sign in with existing key…</button>
				<button
					class="action subtle"
					class:danger={confirmLogout}
					onclick={() => {
						if (!confirmLogout) {
							confirmLogout = true;
							return;
						}
						void doLogout();
					}}>{confirmLogout ? "Archive local data & log out?" : "Log out on this device"}</button
				>
				{#if confirmLogout}
					<p class="hint">
						Parks this device's key and local objects in an archive folder and starts a fresh identity.
						Your encrypted history stays on your relays — sign in with any nsec afterwards, then
						relaunch Roostr so sync reconnects under the new key.
					</p>
				{/if}
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
			{#each KNOWN_RELAYS as k (k.url)}
				<div class="relay known">
					<span class="relay-main">
						<span class="relay-label">{k.label}</span>
						<span class="relay-url">{k.url.replace("wss://", "")} · {k.note}</span>
					</span>
					<label class="switch">
						<input type="checkbox" checked={relays.includes(k.url)} onchange={(e) => toggleRelay(k.url, (e.currentTarget as HTMLInputElement).checked)} />
						<span class="slider"></span>
					</label>
				</div>
			{/each}
			{#each relays.filter((r) => !KNOWN_URLS.has(r)) as r (r)}
				<div class="relay">
					<span>{r}</span>
					<button class="x" onclick={() => void saveRelays(relays.filter((x) => x !== r))}>×</button>
				</div>
			{/each}
			{#if relays.length === 0}
				<p class="hint none">No relays enabled - nothing syncs until one is on.</p>
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
		</section>

		<section>
			<h3>Dictionary</h3>
			<p class="hint">Words you added to the dictionary from the editor's spellcheck. Remove one to flag it again.</p>
			{#if ignored.length === 0}
				<p class="hint none">Nothing added yet — right-click a flagged word and choose "Add to dictionary".</p>
			{:else}
				<div class="dict-words">
					{#each ignored as w (w)}
						<span class="dict-word">{w} <button class="x" title="Remove" onclick={() => unignore(w)}>×</button></span>
					{/each}
				</div>
			{/if}
		</section>

		<section>
			<h3>Export</h3>
			<p class="hint">
				Download everything as a zip — one file per object, grouped by type. Markdown for reading
				and portability; JSON for a complete structural backup (fields, blocks, provenance).
			</p>
			<div class="export-row">
				<select bind:value={exportFormat}>
					<option value="markdown">Markdown</option>
					<option value="json">JSON</option>
				</select>
				<button class="action" disabled={exporting} onclick={() => void runExport()}>
					{exporting ? "Exporting…" : "Export everything"}
				</button>
				{#if exportNote}<span class="hint export-note">{exportNote}</span>{/if}
			</div>
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

		<p class="build-stamp">Build {__BUILD_STAMP__} — if this is older than the last code change, reload this window (⌘R).</p>
	</div>
</div>

<style>
	.switch {
		position: relative;
		width: 38px;
		height: 22px;
		flex: none;
	}
	.switch input {
		opacity: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		cursor: pointer;
	}
	.slider {
		position: absolute;
		inset: 0;
		border-radius: 999px;
		background: var(--hover);
		pointer-events: none;
		transition: background 0.15s;
	}
	.slider::before {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
		transition: transform 0.15s;
	}
	.switch input:checked + .slider {
		background: var(--accent);
	}
	.switch input:checked + .slider::before {
		transform: translateX(16px);
	}
	.switch input:disabled {
		cursor: default;
	}
	.import-form {
		display: flex;
		gap: 8px;
		margin-top: 6px;
	}
	.import-form input {
		flex: 1;
	}
	.modal input {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		padding: 6px 9px;
		font-size: 13px;
		outline: none;
	}
	.modal input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.fallback {
		color: var(--muted);
		font-size: 11px;
	}
	.error {
		color: var(--red);
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
		box-sizing: border-box;
		width: 580px;
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
	section {
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 14px 16px 16px;
		margin-top: 14px;
	}
	.cog {
		font-size: 15px;
		margin-right: 2px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin: 0 0 6px;
	}
	.keylabel {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 500;
		margin: 10px 0 4px;
	}
	.keylabel .enc {
		color: var(--muted);
		font-weight: 400;
		font-family: ui-monospace, monospace;
		font-size: 11px;
	}
	.dict-words {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.dict-word {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 2px 4px 2px 12px;
		font-size: 13px;
		font-family: ui-monospace, monospace;
	}
	.export-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.export-row select {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 8px;
		padding: 6px 10px;
		font-size: 13px;
	}
	.export-note {
		margin: 0;
	}
	.keylabel .share {
		color: #35b57f;
		border: 1px solid rgba(53, 181, 127, 0.45);
		border-radius: 999px;
		font-size: 10px;
		line-height: 16px;
		padding: 0 8px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.keylabel .secret {
		color: var(--red);
		border: 1px solid rgba(232, 82, 74, 0.45);
		border-radius: 999px;
		font-size: 10px;
		line-height: 16px;
		padding: 0 8px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
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
	.profile-row {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.profile-avatar {
		width: 56px;
		height: 56px;
		border-radius: 50%;
		object-fit: cover;
		flex: none;
	}
	.profile-avatar.placeholder {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--hover);
		border: 1px solid var(--border);
		font-size: 22px;
	}
	.grab-zone {
		display: none;
	}
	@media (max-width: 720px) {
		/* Bottom sheet: pinned to the bottom edge, rounded top, grabber
		   bar, drag-to-close; the × hides (the sheet IS the affordance). */
		.overlay {
			align-items: flex-end;
		}
		.modal {
			width: 100%;
			max-width: none;
			max-height: calc(100vh - 48px);
			max-height: calc(100dvh - max(48px, env(safe-area-inset-top) + 32px));
			border-radius: 18px 18px 0 0;
			border-bottom: none;
			padding-top: 0;
		}
		.grab-zone {
			/* Sticky: the grabber must never scroll away with the content -
			   it IS the close affordance. */
			position: sticky;
			top: 0;
			z-index: 5;
			background: var(--panel);
			display: flex;
			justify-content: center;
			padding: 10px 0 6px;
			margin: 0 -22px;
			touch-action: none;
		}
		.grabber {
			width: 40px;
			height: 4px;
			border-radius: 2px;
			background: var(--border);
		}
		header {
			touch-action: none;
		}
		.close-x {
			display: none;
		}
	}
	@media (max-width: 720px) {
		.modal {
			scrollbar-width: none;
		}
		.modal::-webkit-scrollbar {
			display: none;
		}
	}
	.action.danger {
		color: #f55522;
		border-color: rgb(245 85 34 / 0.4);
	}
	.relay.known {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.relay-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.relay-label {
		font-size: 13px;
	}
	.relay-url {
		font-size: 11px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.build-stamp {
		font-size: 11px;
		color: var(--muted);
		text-align: center;
		margin: 4px 0 10px;
	}
</style>
