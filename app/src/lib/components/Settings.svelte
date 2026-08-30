<script lang="ts">
	import { onMount } from "svelte";
	import { settings } from "$lib/api";
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

	interface SkillRow {
		key: string;
		name: string;
		description: string;
		phase: "off" | "installing" | "needs-auth" | "on" | "failed" | "uninstalling";
		installed: boolean;
		log: string;
		authHint?: string;
	}
	let skillRows = $state<SkillRow[] | null>(null);
	let skillOpen = $state<string>("");
	let skillConfirm = $state<string>("");
	let skillPoll: ReturnType<typeof setInterval> | undefined;
	let skillAgents = $state<{ id: string; name: string }[]>([]);
	let coordinator = $state<string>("");

	async function loadSkills() {
		try {
			const res = await fetch(`${HARNESS}/skills`);
			const out = (await res.json()) as { skills: SkillRow[]; coordinator: string; agents: { id: string; name: string }[] };
			skillRows = out.skills;
			coordinator = out.coordinator;
			skillAgents = out.agents;
			const busy = skillRows.some((s) => s.phase === "installing" || s.phase === "uninstalling");
			if (busy && !skillPoll) skillPoll = setInterval(() => void loadSkills(), 2000);
			if (!busy && skillPoll) {
				clearInterval(skillPoll);
				skillPoll = undefined;
			}
		} catch {
			skillRows = null;
		}
	}

	async function skillOp(key: string, op: "enable" | "disable" | "recheck" | "uninstall") {
		skillConfirm = "";
		try {
			await fetch(`${HARNESS}/skills/${op}`, { method: "POST", body: JSON.stringify({ key }) });
		} catch {
			/* daemon offline; reload shows it */
		}
		await loadSkills();
	}

	async function setSkillCoordinator(id: string) {
		try {
			await fetch(`${HARNESS}/skills/coordinator`, { method: "POST", body: JSON.stringify({ id }) });
		} catch {
			/* daemon offline */
		}
		await loadSkills();
	}

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
		await loadSkills();
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

	onMount(() => {
		void load();
		return () => {
			if (skillPoll) clearInterval(skillPoll);
		};
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

	const SUGGESTED = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band"];

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
</script>

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div class="modal" role="dialog" aria-label="Settings">
		<header>
			<h2><span class="cog">⚙️</span> Settings</h2>
			<button class="x" onclick={onclose}>×</button>
		</header>

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

		<section>
			<h3>Skills</h3>
			{#if skillRows === null}
				<p class="hint">Agent daemon is offline — skills are managed on the machine that runs it.</p>
			{:else}
				<p class="hint">
					Device-local capabilities. Toggling one on runs a one-shot install agent; the coordinator
					agent fronts them all — other agents are told to ask it in chat.
				</p>
				<div class="coord-row">
					<span class="pname">Coordinator</span>
					<select
						value={coordinator}
						onchange={(e) => void setSkillCoordinator((e.currentTarget as HTMLSelectElement).value)}
					>
						<option value="">Everyone (no coordinator)</option>
						{#each skillAgents as a (a.id)}
							<option value={a.id}>{a.name}</option>
						{/each}
					</select>
				</div>
				{#each skillRows as s (s.key)}
					<div class="skill">
						<div class="skill-row">
							<button
								class="skill-name"
								onclick={() => {
									skillOpen = skillOpen === s.key ? "" : s.key;
									skillConfirm = "";
								}}>{s.name}</button
							>
							<span class="chip {s.phase}">
								{s.phase === "on"
									? "on"
									: s.phase === "installing"
										? "installing…"
										: s.phase === "uninstalling"
											? "removing…"
											: s.phase === "needs-auth"
												? "auth needed"
												: s.phase === "failed"
													? "failed"
													: "off"}
							</span>
							{#if s.phase === "needs-auth" || s.phase === "failed"}
								<button class="subtle-btn" onclick={() => void skillOp(s.key, "recheck")}>Re-check</button>
							{/if}
							<label class="switch">
								<input
									type="checkbox"
									checked={s.phase === "on" || s.phase === "installing"}
									disabled={s.phase === "installing" || s.phase === "uninstalling"}
									onchange={(e) =>
										void skillOp(s.key, (e.currentTarget as HTMLInputElement).checked ? "enable" : "disable")}
								/>
								<span class="slider"></span>
							</label>
						</div>
						{#if skillOpen === s.key}
							<div class="skill-detail">
								<p class="hint">{s.description}</p>
								{#if s.phase === "needs-auth" && s.authHint}
									<p class="hint auth-hint">{s.authHint}</p>
								{/if}
								{#if s.log}
									<pre class="skill-log">{s.log.slice(-2000)}</pre>
								{/if}
								{#if s.installed && s.phase !== "installing" && s.phase !== "uninstalling"}
									{#if skillConfirm === s.key}
										<p class="hint">
											Remove {s.name}? This uninstalls it from this device.
											<button class="danger-btn" onclick={() => void skillOp(s.key, "uninstall")}>Remove</button>
											<button class="subtle-btn" onclick={() => (skillConfirm = "")}>Cancel</button>
										</p>
									{:else}
										<button class="remove-link" onclick={() => (skillConfirm = s.key)}>Remove from this device</button>
									{/if}
								{/if}
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</section>
	</div>
</div>

<style>
	.coord-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}
	.skill {
		border-top: 1px solid var(--border, #2a2a2a);
		padding: 6px 0;
	}
	.skill:first-of-type {
		border-top: none;
	}
	.skill-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.skill-name {
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		padding: 0;
		flex: 1;
		text-align: left;
	}
	.chip {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 10px;
		background: var(--hover, #2a2a2a);
		color: var(--muted);
	}
	.chip.on {
		background: rgb(48 209 88 / 0.16);
		color: var(--green);
	}
	.chip.installing,
	.chip.uninstalling {
		background: rgb(125 122 255 / 0.16);
		color: var(--indigo);
	}
	.chip.needs-auth {
		background: rgb(255 159 10 / 0.16);
		color: var(--orange);
	}
	.chip.failed {
		background: rgb(255 69 58 / 0.16);
		color: var(--red);
	}
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
	.skill-detail {
		padding: 4px 0 4px 2px;
	}
	.auth-hint {
		color: var(--orange);
	}
	.skill-log {
		max-height: 140px;
		overflow: auto;
		font-size: 11px;
		background: var(--hover, #1d1d1d);
		border-radius: 6px;
		padding: 8px;
		white-space: pre-wrap;
	}
	.remove-link {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 11px;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
	}
	.remove-link:hover {
		color: var(--red);
	}
	.danger-btn {
		color: var(--red);
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
