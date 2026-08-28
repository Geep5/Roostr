<script lang="ts">
	import type { ObjectJSON, ChannelJSON } from "$lib/types";
	import { channel as channelApi } from "$lib/api";
	import { invalidateAll } from "$app/navigation";
	import SetTable from "./SetTable.svelte";
	import ChannelAgents from "./ChannelAgents.svelte";
	import type { RelationDefJSON } from "$lib/types";

	let {
		object,
		channelInfo,
		relations,
		onchanged,
	}: {
		object: ObjectJSON;
		channelInfo: ChannelJSON | undefined;
		relations: RelationDefJSON[];
		onchanged: () => Promise<void>;
	} = $props();

	const members = $derived(channelInfo?.members ?? []);
	let npubDraft = $state("");
	let invite = $state<string>("");
	let confirmRemove = $state("");

	async function addMember() {
		const npub = npubDraft.trim();
		if (!npub) return;
		await channelApi.memberAdd(object.id, npub);
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
		await channelApi.memberRemove(object.id, npub);
		await onchanged();
		await invalidateAll();
	}

	async function showInvite(npub: string) {
		const payload = await channelApi.invitePayload(object.id, npub);
		invite = JSON.stringify(payload, null, 2);
	}
</script>

<section class="manage">
	<ChannelAgents channelId={object.id} />

	<h3>Members</h3>
	<p class="hint">
		Everyone holding this channel's key can read and write every object in it. Invites are delivered as a
		NIP-59 gift wrap of the channel key to the member's npub (ships with /nostr-sync); removing a member
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
	</form>

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
		<span class="hint">Channel key #{channelInfo?.keyId ?? "?"}</span>
		<button
			onclick={async () => {
				await channelApi.keyRotate(object.id);
				await onchanged();
				await invalidateAll();
			}}>Rotate key</button
		>
	</div>

	<h3>Objects in this channel</h3>
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
</section>

<style>
	.manage {
		display: flex;
		flex-direction: column;
		gap: 10px;
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
