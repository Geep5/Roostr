<script lang="ts">
	/**
	 * Presence + assignment bar for agent objects. "Runs here" is a local
	 * fact owned by this machine's harness daemon (roster in harness.json);
	 * presence for agents living elsewhere comes from the heartbeat fields
	 * (harness_seen_at / harness_host) synced with the object.
	 */
	import { onMount } from "svelte";
	import type { ObjectJSON } from "$lib/types";

	let { object }: { object: ObjectJSON } = $props();

	const HARNESS = "http://127.0.0.1:7334";
	/** Heartbeat is 120s; allow two misses before calling it offline. */
	const ONLINE_MS = 300_000;

	let daemon = $state<{ roster: string[] } | null | undefined>(undefined);
	let now = $state(Date.now());

	onMount(() => {
		void loadDaemon();
		const t = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(t);
	});

	async function loadDaemon() {
		try {
			const res = await fetch(`${HARNESS}/agents`);
			daemon = (await res.json()) as { roster: string[] };
		} catch {
			daemon = null; // no local daemon
		}
	}

	const seenAt = $derived(object.fields["harness_seen_at"]?.intValue ?? 0);
	const host = $derived(object.fields["harness_host"]?.stringValue ?? "");
	const online = $derived(seenAt > 0 && now - seenAt < ONLINE_MS);
	const runsHere = $derived(daemon !== null && daemon !== undefined && daemon.roster.includes(object.id));

	async function toggle() {
		await fetch(`${HARNESS}/agents/toggle`, { method: "POST", body: JSON.stringify({ id: object.id, enabled: !runsHere }) });
		await loadDaemon();
	}

	function ago(ms: number): string {
		const s = Math.floor((now - ms) / 1000);
		if (s < 90) return `${s}s ago`;
		if (s < 5400) return `${Math.round(s / 60)}m ago`;
		return `${Math.round(s / 3600)}h ago`;
	}
</script>

<div class="agent-bar">
	<span class="dot" class:on={online}></span>
	{#if online}
		<span>runs on <b>{host}</b>{runsHere ? " (this machine)" : ""}</span>
	{:else if seenAt > 0}
		<span>last seen {ago(seenAt)} on <b>{host}</b> — replies will wait until it's back</span>
	{:else}
		<span>not running anywhere yet</span>
	{/if}
	<span class="spacer"></span>
	{#if daemon === null}
		<span class="muted">no local daemon</span>
	{:else if daemon !== undefined}
		<button class="toggle" onclick={() => void toggle()}>
			{runsHere ? "Stop running here" : "Run on this machine"}
		</button>
	{/if}
</div>

<style>
	.agent-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px 12px;
		margin-bottom: 14px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--border);
		flex: none;
	}
	.dot.on {
		background: #5dd400;
	}
	.spacer {
		flex: 1;
	}
	.toggle {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 8px;
		padding: 3px 10px;
		cursor: pointer;
		font-size: 12px;
	}
	.toggle:hover {
		border-color: var(--accent);
	}
	.muted {
		color: var(--muted);
	}
</style>
