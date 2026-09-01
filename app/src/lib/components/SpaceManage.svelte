<script lang="ts">
	import type { ObjectJSON, SpaceJSON } from "$lib/types";
	import { space as spaceApi, fetchQuery, note } from "$lib/api";
	import { inviteUrl } from "$lib/invite";
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
	const deleteArmed = $derived(deleteDraft.trim().toLowerCase() === "delete");
	$effect(() => {
		if (confirmDelete) deleteInputEl?.focus();
	});

	/** Vanish the space and every object in it. The ledger entry rides sync,
	 * so the deletion propagates to every device and can't resurrect. */
	async function deleteSpace() {
		deleting = true;
		try {
			const res = await fetchQuery({ filters: [{ key: "channel", condition: "equal", value: object.id }], limit: 1000 });
			const ids = [object.id, ...res.records.map((r) => r.id)];
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
		const res = await fetchQuery({ includeDeleted: true, limit: 500 });
		bin = res.records
			.filter((r) => (r as { deleted?: boolean }).deleted && (r.fields["channel"]?.stringValue ?? "") === object.id)
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
	import SetTable from "./SetTable.svelte";
	import SpaceAgents from "./SpaceAgents.svelte";
	import type { RelationDefJSON } from "$lib/types";

	let {
		object,
		spaceInfo,
		relations,
		onchanged,
	}: {
		object: ObjectJSON;
		spaceInfo: SpaceJSON | undefined;
		relations: RelationDefJSON[];
		onchanged: () => Promise<void>;
	} = $props();

	const members = $derived(spaceInfo?.members ?? []);
	let npubDraft = $state("");
	let invite = $state<string>("");
	let confirmRemove = $state("");

	// ── Invite link: the space key rides in the URL fragment ──────
	const INVITE_RELAYS = ["wss://roostr-relay.fly.dev"];
	let ownerNpub = $state("");
	let copiedInvite = $state(false);

	async function loadIdentity() {
		try {
			const res = await fetch("http://127.0.0.1:7334/identity");
			if (res.ok) ownerNpub = ((await res.json()) as { npub?: string }).npub ?? "";
		} catch {
			// Daemon offline — the invite button stays disabled with a hint.
		}
	}

	async function copyInviteLink() {
		if (!ownerNpub) return;
		const payload = await spaceApi.invitePayload(object.id, "");
		await navigator.clipboard.writeText(
			inviteUrl({
				v: 1,
				t: "space-invite",
				space: object.id,
				name: (typeof payload.name === "string" && payload.name) || object.fields["name"]?.stringValue || undefined,
				owner: ownerNpub,
				relays: INVITE_RELAYS,
				key: typeof payload.key === "string" ? payload.key : "",
				keyId: typeof payload.key_id === "number" ? payload.key_id : 1,
			}),
		);
		copiedInvite = true;
		setTimeout(() => (copiedInvite = false), 1500);
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

	async function showInvite(npub: string) {
		const payload = await spaceApi.invitePayload(object.id, npub);
		invite = JSON.stringify(payload, null, 2);
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
		Everyone holding this space's key can read and write every object in it. Invites are delivered as a
		NIP-59 gift wrap of the space key to the member's npub (ships with /nostr-sync); removing a member
		rotates the key.
	</p>

	{#each members as m (m.npub)}
		<div class="member">
			<span class="npub" title={m.npub}>{m.npub.slice(0, 20)}…</span>
			<span class="role">{m.role}</span>
			<button onclick={() => void showInvite(m.npub)}>Invite payload</button>
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
			title={ownerNpub ? "Copy a universal link that grants access to this space" : "Nostr identity unavailable — is the daemon running?"}
			onclick={() => void copyInviteLink()}>{copiedInvite ? "Copied ✓" : "Copy invite link"}</button
		>
	</form>
	<p class="hint">Anyone with this link can read the space. Rotate the key to revoke.</p>

	{#if invite}
		<div class="invite">
			<div class="invite-head">
				Invite rumor (gift-wrapped + published by /nostr-sync in Phase 4)
				<button onclick={() => (invite = "")}>×</button>
			</div>
			<pre>{invite}</pre>
		</div>
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

	<h3>Objects in this space</h3>
	<SetTable
		body={{
			filters: [
				{ key: "channel", condition: "equal", value: object.id },
				{ key: "type", condition: "notIn", value: ["agent"] },
			],
		}}
		{object}
		{relations}
		{onchanged}
	/>

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
				<h3 class="del-title">Delete {object.fields["name"]?.stringValue || "this space"}?</h3>
				<p class="hint">
					This permanently deletes the space and every object in it — on every device, forever.
					This cannot be undone.
				</p>
				<p class="hint">Type <b>delete</b> to confirm.</p>
				<input
					class="del-input"
					bind:value={deleteDraft}
					placeholder="delete"
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
	.invite {
		border: 1px solid var(--border);
		border-radius: 10px;
		overflow: hidden;
	}
	.invite-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 10px;
		font-size: 12px;
		color: var(--muted);
		border-bottom: 1px solid var(--border);
	}
	pre {
		margin: 0;
		padding: 10px;
		font-size: 11px;
		overflow-x: auto;
	}
	.keyrow {
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
