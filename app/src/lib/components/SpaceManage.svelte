<script lang="ts">
	import type { ObjectJSON, SpaceJSON } from "$lib/types";
	import { space as spaceApi, note, fetchAllQuery } from "$lib/api";
	import { joinUrl } from "$lib/invite";
	import { objectIcon } from "$lib/icons";
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { store, refreshAll } from "$lib/data.svelte";
	import { activeSpace } from "$lib/space.svelte";

	let confirmDelete = $state(false);
	let deleting = $state(false);
	let confirmEmpty = $state(false);
	let emptyDraft = $state("");
	const emptyArmed = $derived(emptyDraft.trim().toLowerCase() === "delete");
	let deleteDraft = $state("");
	let deleteInputEl = $state<HTMLInputElement>();
	$effect(() => {
		if (confirmDelete) deleteInputEl?.focus();
	});

	/** Vanish the space and every object in it. The ledger entry rides sync,
	 * so the deletion propagates to every device and can't resurrect. */
	async function deleteSpace() {
		deleting = true;
		try {
			// Every object, not a page of them: the space goes with them, so
			// anything left behind is unreachable — there is no space to
			// browse it from.
			const records = await fetchAllQuery({ filters: [{ key: "channel", condition: "equal", value: object.id }] });
			const ids = [object.id, ...records.map((r) => r.id)];
			await note.vanish(ids);
			await refreshAll();
			const next = store.channels[0]?.id ?? "";
			activeSpace.id = next;
			await goto("/");
		} finally {
			deleting = false;
		}
	}

	interface BinRow {
		id: string;
		name: string;
		typeKey: string;
		icon: string;
	}
	let bin = $state<BinRow[] | null>(null);
	let binBusy = $state("");

	async function loadBin() {
		// Deleted objects of this space (query rows now carry `deleted`).
		// Read to exhaustion: "Empty bin" vanishes exactly this list, so a
		// capped read would delete a page and report the bin emptied.
		const records = await fetchAllQuery({
			includeDeleted: true,
			filters: [{ key: "channel", condition: "equal", value: object.id }],
		});
		bin = records
			.filter((r) => (r as { deleted?: boolean }).deleted)
			.map((r) => ({
				id: r.id,
				name: r.fields["name"]?.stringValue || "Untitled",
				typeKey: r.typeKey,
				icon: r.fields["iconEmoji"]?.stringValue ?? "",
			}));
	}

	onMount(() => {
		void loadBin();
		void loadIdentity();
	});

	async function restoreObject(id: string) {
		binBusy = id;
		try {
			await note.restore(id);
			await loadBin();
			await onchanged();
			await invalidateAll();
		} finally {
			binBusy = "";
		}
	}

	/** Empty bin: vanish every deleted object in this space at once. */
	async function emptyBin() {
		if (!bin || bin.length === 0) return;
		binBusy = "__all__";
		await note.vanish(bin.map((b) => b.id));
		bin = [];
		confirmEmpty = false;
		binBusy = "";
	}

	async function vanishObject(id: string, name: string) {
		if (!confirm(`Permanently delete "${name}"? This cannot be undone — on any device.`)) return;
		binBusy = id;
		await note.vanish(id);
		await loadBin();
		binBusy = "";
	}
	import { invalidateAll } from "$app/navigation";
	import SpaceAgents from "./SpaceAgents.svelte";

	let {
		object,
		spaceInfo,
		onchanged,
	}: {
		object: ObjectJSON;
		spaceInfo: SpaceJSON | undefined;
		onchanged: () => Promise<void>;
	} = $props();

	const members = $derived(spaceInfo?.members ?? []);
	const spaceName = $derived(object.fields["name"]?.stringValue?.trim() ?? "");
	/** The space's own name, not the word "delete": the gate should cost a
	 * look at WHICH space this is, and muscle memory from every other
	 * confirm box shouldn't clear it. A space with no name has nothing to
	 * type, so it keeps the word. */
	const deletePhrase = $derived(spaceName || "delete");
	const deleteArmed = $derived(deleteDraft.trim().toLowerCase() === deletePhrase.toLowerCase());
	let npubDraft = $state("");
	let confirmRemove = $state("");

	// ── Join links + requests: the link carries NO key - it only lets
	// someone knock. Requests land here (gift-wrapped to the owner) and
	// wait for explicit approval, which delivers the key to that npub. ──
	const JOIN_RELAYS = ["wss://roostr-relay.fly.dev"];
	const HARNESS = "http://127.0.0.1:7334";
	let ownerNpub = $state("");
	let copiedJoin = $state(false);
	interface JoinRequestRow {
		key: string;
		space: string;
		requesterNpub: string;
		name?: string;
		picture?: string;
		at: number;
	}
	let joinRequests = $state<JoinRequestRow[]>([]);

	async function loadIdentity() {
		try {
			const res = await fetch(`${HARNESS}/identity`);
			if (res.ok) ownerNpub = ((await res.json()) as { npub?: string }).npub ?? "";
		} catch {
			// Daemon offline — the join-link button stays disabled with a hint.
		}
		await loadJoinRequests();
	}

	async function loadJoinRequests() {
		try {
			const res = await fetch(`${HARNESS}/join-requests`);
			const out = (await res.json()) as { requests?: JoinRequestRow[] };
			joinRequests = (out.requests ?? []).filter((r) => r.space === object.id);
		} catch {
			joinRequests = [];
		}
	}

	async function copyJoinLink() {
		if (!ownerNpub) return;
		await navigator.clipboard.writeText(
			joinUrl({
				v: 2,
				t: "space-join",
				space: object.id,
				name: object.fields["name"]?.stringValue || undefined,
				owner: ownerNpub,
				relays: JOIN_RELAYS,
			}),
		);
		copiedJoin = true;
		setTimeout(() => (copiedJoin = false), 1500);
	}

	async function approveRequest(r: JoinRequestRow) {
		await spaceApi.memberAdd(object.id, r.requesterNpub);
		await fetch(`${HARNESS}/join-requests/clear`, { method: "POST", body: JSON.stringify({ key: r.key }) });
		await loadJoinRequests();
		await onchanged();
		await invalidateAll();
	}

	async function denyRequest(r: JoinRequestRow) {
		await fetch(`${HARNESS}/join-requests/clear`, { method: "POST", body: JSON.stringify({ key: r.key }) });
		await loadJoinRequests();
	}

	async function addMember() {
		const npub = npubDraft.trim();
		if (!npub) return;
		await spaceApi.memberAdd(object.id, npub);
		npubDraft = "";
		await onchanged();
		await invalidateAll();
	}

	async function removeMember(npub: string) {
		if (confirmRemove !== npub) {
			confirmRemove = npub; // first click arms, second executes — key rotates, member loses future access
			return;
		}
		confirmRemove = "";
		await spaceApi.memberRemove(object.id, npub);
		await onchanged();
		await invalidateAll();
	}

</script>

<!-- Escape cancels the typed-confirmation modals, matching every other
     overlay. Mirrors each modal's Cancel affordance: the delete flow stays
     put once the vanish is in flight. -->
<svelte:window onkeydown={(e) => { if (e.key !== "Escape") return; if (confirmEmpty) confirmEmpty = false; else if (confirmDelete && !deleting) confirmDelete = false; }} />

<section class="manage">
	<SpaceAgents channelId={object.id} />

	<h3>Members</h3>
	<p class="hint">
		Everyone holding this space's key can read and write every object in it. Adding an npub gift-wraps
		the space key to it over your relays (NIP-59) — nothing to copy, their device just receives the
		space. Removing a member rotates the key.
	</p>

	{#each members as m (m.npub)}
		<div class="member">
			<span class="npub" title={m.npub}>{m.npub.slice(0, 20)}…</span>
			<span class="role">{m.role}</span>
			<button class="danger" onclick={() => void removeMember(m.npub)}>{confirmRemove === m.npub ? "Confirm: rotate key" : "Remove"}</button>
		</div>
	{/each}
	{#if members.length === 0}
		<p class="hint">No members yet — it's just you.</p>
	{/if}

	<form
		class="add"
		onsubmit={(e) => {
			e.preventDefault();
			void addMember();
		}}
	>
		<input bind:value={npubDraft} placeholder="npub1… of the person to invite" />
		<button type="submit">Add member</button>
		<button
			type="button"
			disabled={!ownerNpub}
			title={ownerNpub ? "Copy a public link that lets anyone REQUEST to join — you approve each request here" : "Nostr identity unavailable — is the daemon running?"}
			onclick={() => void copyJoinLink()}>{copiedJoin ? "Copied ✓" : "Copy join link"}</button
		>
	</form>
	<p class="hint">The join link carries no key — it only lets someone knock. You approve each request below.</p>

	{#if joinRequests.length > 0}
		<h3>Join requests</h3>
		{#each joinRequests as r (r.key)}
			<div class="member joinreq">
				{#if r.picture}
					<img class="req-avatar" src={r.picture} alt="" referrerpolicy="no-referrer" />
				{:else}
					<span class="req-avatar req-glyph">👤</span>
				{/if}
				<span class="req-id">
					<span class="req-name">{r.name || r.requesterNpub.slice(0, 20) + "…"}</span>
					{#if r.name}<span class="npub req-npub" title={r.requesterNpub}>{r.requesterNpub.slice(0, 20)}…</span>{/if}
				</span>
				<span class="role">{new Date(r.at).toLocaleDateString()}</span>
				<button onclick={() => void approveRequest(r)}>Approve</button>
				<button class="danger" onclick={() => void denyRequest(r)}>Deny</button>
			</div>
		{/each}
	{/if}

	<div class="keyrow">
		<span class="hint">Space key #{spaceInfo?.keyId ?? "?"}</span>
		<button
			onclick={async () => {
				await spaceApi.keyRotate(object.id);
				await onchanged();
				await invalidateAll();
			}}>Rotate key</button
		>
	</div>

	<div class="bin-head">
		<h3>Bin</h3>
		{#if bin && bin.length > 0}
			<button class="danger" onclick={() => { confirmEmpty = true; emptyDraft = ""; }}>Empty bin…</button>
		{/if}
	</div>
	{#if bin === null}
		<p class="hint">Loading…</p>
	{:else if bin.length === 0}
		<p class="hint">Nothing in the bin.</p>
	{:else}
		<div class="bin">
			{#each bin as b (b.id)}
				<div class="bin-row">
					<span class="obj-icon">{objectIcon(b.icon, b.typeKey)}</span>
					<span class="bin-name">{b.name}</span>
					<button disabled={binBusy === b.id} onclick={() => void restoreObject(b.id)}>Restore</button>
					<button class="danger" disabled={binBusy === b.id} onclick={() => void vanishObject(b.id, b.name)}>Delete forever</button>
				</div>
			{/each}
		</div>
	{/if}
	{#if store.channels.length > 1}
		<h3>Danger zone</h3>
		<button class="danger" onclick={() => { confirmDelete = true; deleteDraft = ""; }}>Delete this space…</button>
	{/if}

	{#if confirmEmpty}
		<div class="del-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) confirmEmpty = false; }}>
			<div class="del-modal" role="dialog" aria-label="Empty bin">
				<h3 class="del-title">Empty the bin?</h3>
				<p class="hint">
					Permanently deletes {bin?.length ?? 0} object{(bin?.length ?? 0) === 1 ? "" : "s"} — on every device, forever.
					This cannot be undone.
				</p>
				<p class="hint">Type <b>delete</b> to confirm.</p>
				<input
					class="del-input"
					bind:value={emptyDraft}
					placeholder="delete"
					autocomplete="off"
					onkeydown={(e) => {
						if (e.key === "Enter" && emptyArmed && binBusy === "") void emptyBin();
					}}
				/>
				<div class="del-actions">
					<button class="subtle-btn" onclick={() => (confirmEmpty = false)}>Cancel</button>
					<button class="del-btn" disabled={!emptyArmed || binBusy !== ""} onclick={() => void emptyBin()}>
						{binBusy === "__all__" ? "Deleting…" : "Delete forever"}
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if confirmDelete}
		<div class="del-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget && !deleting) confirmDelete = false; }}>
			<div class="del-modal" role="dialog" aria-label="Delete space">
				<h3 class="del-title">Delete {spaceName || "this space"}?</h3>
				<p class="hint">
					This permanently deletes the space and every object in it — on every device, forever.
					This cannot be undone.
				</p>
				<p class="hint">Type <b>{deletePhrase}</b> to confirm.</p>
				<input
					class="del-input"
					bind:value={deleteDraft}
					placeholder={deletePhrase}
					autocomplete="off"
					bind:this={deleteInputEl}
					onkeydown={(e) => {
						if (e.key === "Enter" && deleteArmed && !deleting) void deleteSpace();
					}}
				/>
				<div class="del-actions">
					<button class="subtle-btn" disabled={deleting} onclick={() => (confirmDelete = false)}>Cancel</button>
					<button class="del-btn" disabled={!deleteArmed || deleting} onclick={() => void deleteSpace()}>
						{deleting ? "Deleting…" : "Delete forever"}
					</button>
				</div>
			</div>
		</div>
	{/if}
</section>

<style>
	.manage {
		display: flex;
		flex-direction: column;
		gap: 10px;
		/* Align with the page header's content edge (icon at 44, title at 48). */
		margin: 8px 24px 24px 48px;
	}
	@media (max-width: 720px) {
		.manage {
			margin: 8px 16px 24px;
		}
	}
	.del-overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 300;
	}
	.del-modal {
		width: 380px;
		max-width: calc(100vw - 48px);
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 18px;
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
	}
	.del-title {
		margin: 0 0 6px;
		font-size: 15px;
		text-transform: none;
		letter-spacing: 0;
		color: var(--fg);
	}
	.del-input {
		box-sizing: border-box;
		width: 100%;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		padding: 7px 10px;
		font-size: 14px;
		outline: none;
		margin: 8px 0 14px;
	}
	.del-input:focus {
		border-color: var(--red);
		box-shadow: 0 0 0 3px rgb(255 69 58 / 0.25);
	}
	.del-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.del-btn {
		background: var(--red);
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 7px 14px;
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
	}
	.del-btn:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.bin-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.bin-head h3 {
		margin-bottom: 0;
	}
	.bin-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 13px;
	}
	.bin-row .bin-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bin-row button {
		font-size: 11px;
	}
	h3 {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin: 14px 0 2px;
	}
	.hint {
		color: var(--muted);
		font-size: 12px;
		margin: 0;
		max-width: 560px;
	}
	.member {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13px;
	}
	.npub {
		font-family: ui-monospace, monospace;
	}
	.role {
		color: var(--muted);
		font-size: 12px;
	}
	button {
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 7px;
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button.danger:hover {
		border-color: #f55522;
		color: #f55522;
	}
	.add {
		display: flex;
		gap: 8px;
	}
	.add input {
		background: var(--panel);
		border: 1px solid var(--border);
		color: var(--fg);
		border-radius: 7px;
		padding: 5px 10px;
		font-size: 13px;
		width: 340px;
	}
	.keyrow {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.joinreq {
		align-items: center;
	}
	.req-avatar {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		object-fit: cover;
		flex: none;
	}
	.req-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--hover, #2a2a2a);
		font-size: 14px;
	}
	.req-id {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.req-name {
		font-size: 13px;
		font-weight: 500;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.req-npub {
		font-size: 11px;
		color: var(--muted);
	}
</style>
