<script lang="ts">
	/**
	 * Agents section of channel settings. Agents are channel infrastructure
	 * (like members), not objects OF the channel — they're hidden from every
	 * object surface and managed only here. You TALK to an agent through its
	 * chat or any object's discussion; you MANAGE it here. Presence comes
	 * from the synced heartbeat fields; "runs here" is this machine's
	 * harness roster.
	 */
	import { onMount } from "svelte";
	import EmojiPicker from "./EmojiPicker.svelte";
	import { goto } from "$app/navigation";
	import { fetchQuery, note } from "$lib/api";
	import { store } from "$lib/data.svelte";

	let { channelId }: { channelId: string } = $props();

	const HARNESS = "http://127.0.0.1:7334";
	const ONLINE_MS = 300_000; // two missed 120s heartbeats

	interface AgentRow {
		id: string;
		name: string;
		icon: string;
		model: string;
		seenAt: number;
		host: string;
		/** Responsible type keys; "*" = everything else. */
		types: string[];
	}

	let agents = $state<AgentRow[]>([]);
	let roster = $state<string[] | null>(null); // null = no local daemon

	interface SkillRow {
		key: string;
		name: string;
		phase: "off" | "installing" | "needs-auth" | "on" | "failed" | "uninstalling";
	}
	/** Device-local capabilities (installed on the machine whose harness serves
	 * these agents). Compact mirror of Settings -> Skills. */
	let skills = $state<SkillRow[] | null>(null);
	let coordinator = $state("");
	let skillPoll: ReturnType<typeof setInterval> | undefined;

	async function loadSkills() {
		try {
			const res = await fetch(`${HARNESS}/skills`);
			const out = (await res.json()) as { skills: SkillRow[]; coordinator: string };
			skills = out.skills;
			coordinator = out.coordinator;
			const busy = skills.some((k) => k.phase === "installing" || k.phase === "uninstalling");
			if (busy && !skillPoll) skillPoll = setInterval(() => void loadSkills(), 2000);
			if (!busy && skillPoll) {
				clearInterval(skillPoll);
				skillPoll = undefined;
			}
		} catch {
			skills = null;
		}
	}

	async function skillOp(key: string, op: "enable" | "disable" | "recheck") {
		try {
			await fetch(`${HARNESS}/skills/${op}`, { method: "POST", body: JSON.stringify({ key }) });
		} catch {
			/* daemon offline */
		}
		await loadSkills();
	}
	let now = $state(Date.now());
	let assigning = $state(""); // agent id whose responsibility editor is open
	let avatarPick = $state(""); // agent id whose avatar picker is open

	async function setAvatar(id: string, emoji: string) {
		avatarPick = "";
		await note.setField(id, "iconEmoji", { stringValue: emoji });
		await load();
	}

	const defaultChannelId = $derived(store.channels[0]?.id ?? "");

	async function load() {
		const res = await fetchQuery({ type: "agent", limit: 100 });
		agents = res.records
			.filter((r) => {
				if (r.fields["spawn_parent"]?.stringValue) return false; // subagents are ephemeral
				const ch = r.fields["channel"]?.stringValue ?? "";
				return ch === channelId || (ch === "" && channelId === defaultChannelId);
			})
			.map((r) => ({
				id: r.id,
				name: r.fields["name"]?.stringValue || "Agent",
				icon: r.fields["iconEmoji"]?.stringValue ?? "",
				model: r.fields["model"]?.stringValue ?? "",
				seenAt: r.fields["harness_seen_at"]?.intValue ?? 0,
				host: r.fields["harness_host"]?.stringValue ?? "",
				types: (r.fields["responsible_types"]?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean),
			}));
	}

	// ── Responsibility (one owner per type; one "everything else") ──
	//
	// A type key is claimable by exactly ONE agent in the channel, and only
	// one agent may hold "*" (whatever isn't explicitly claimed). The
	// checkboxes below enforce it: claimed elsewhere = disabled, with the
	// claimant named.

	/** typeKey → claiming agent (excluding `except`). */
	function claimants(except: string): Map<string, AgentRow> {
		const m = new Map<string, AgentRow>();
		for (const a of agents) {
			if (a.id === except) continue;
			for (const t of a.types) m.set(t, a);
		}
		return m;
	}

	async function saveTypes(a: AgentRow, next: string[]): Promise<void> {
		await note.setField(a.id, "responsible_types", { valuesValue: { items: next.map((t) => ({ stringValue: t })) } });
		await load();
	}

	async function toggleType(a: AgentRow, typeKey: string): Promise<void> {
		const has = a.types.includes(typeKey);
		// Claiming a specific type while holding "*" drops "*" only if
		// explicit types are chosen alongside — "*" plus explicit is
		// redundant; keep the model clean: explicit set XOR "*".
		const base = a.types.filter((t) => t !== "*");
		await saveTypes(a, has ? base.filter((t) => t !== typeKey) : [...base, typeKey]);
	}

	async function toggleRest(a: AgentRow): Promise<void> {
		await saveTypes(a, a.types.includes("*") ? [] : ["*"]);
	}

	function describe(a: AgentRow): string {
		if (a.types.includes("*")) return "Everything else";
		if (a.types.length === 0) return agents.length === 1 ? "Everything (sole agent)" : "Nothing assigned";
		return a.types.map((t) => store.types.find((x) => x.key === t)?.name ?? t).join(", ");
	}

	async function loadRoster() {
		try {
			const res = await fetch(`${HARNESS}/agents`);
			roster = ((await res.json()) as { roster: string[] }).roster;
		} catch {
			roster = null;
		}
	}

	onMount(() => {
		void loadRoster();
		void loadSkills();
		const t = setInterval(() => (now = Date.now()), 15_000);
		return () => {
			clearInterval(t);
			if (skillPoll) clearInterval(skillPoll);
		};
	});

	$effect(() => {
		void channelId;
		void load();
	});

	async function toggle(id: string, enabled: boolean) {
		await fetch(`${HARNESS}/agents/toggle`, { method: "POST", body: JSON.stringify({ id, enabled }) });
		await loadRoster();
	}

	async function openChat(id: string) {
		const res = await fetchQuery({
			filters: [
				{ key: "type", condition: "equal", value: "chat" },
				{ key: "agent", condition: "equal", value: id },
			],
			limit: 1,
		});
		const chat = res.records[0];
		if (chat) await goto(`/object/${chat.id}`);
		else alert("No chat yet — enable the agent on a machine running the harness first.");
	}

	let confirmRemove = $state("");

	/** Tombstone the agent and its chats. Two-click confirm. */
	async function removeAgent(a: AgentRow) {
		if (confirmRemove !== a.id) {
			confirmRemove = a.id;
			setTimeout(() => (confirmRemove = ""), 4000);
			return;
		}
		confirmRemove = "";
		if (roster?.includes(a.id)) await toggle(a.id, false);
		const chats = await fetchQuery({
			filters: [
				{ key: "type", condition: "equal", value: "chat" },
				{ key: "agent", condition: "equal", value: a.id },
			],
			limit: 10,
		});
		for (const c of chats.records) await note.del(c.id);
		await note.del(a.id);
		await load();
	}

	async function newAgent() {
		const name = prompt("Agent name:");
		if (!name?.trim()) return;
		await note.create(name.trim(), "agent", {
			channel: { stringValue: channelId },
			model: { stringValue: "claude-sonnet-4-5" },
		});
		await load();
	}

	function ago(ms: number): string {
		const s = Math.floor((now - ms) / 1000);
		if (s < 90) return `${s}s ago`;
		if (s < 5400) return `${Math.round(s / 60)}m ago`;
		return `${Math.round(s / 3600)}h ago`;
	}
</script>

<h3>Agents</h3>
<p class="hint">
	Agents serve this channel: one holistic chat each, reachable from any object's discussion. Enable an
	agent on the machine whose harness should run it.
</p>

{#each agents as a (a.id)}
	{@const online = a.seenAt > 0 && now - a.seenAt < ONLINE_MS}
	{@const runsHere = roster?.includes(a.id) ?? false}
	<div class="agent-wrap">
		<div class="agent">
			<span class="dot" class:online></span>
			<!-- The agent's avatar: shows in chat next to its messages. -->
			<button class="avatar-btn" title="Set avatar" onclick={() => (avatarPick = avatarPick === a.id ? "" : a.id)}>
				{#if a.icon}{a.icon}{:else}🤖{/if}
			</button>
			<span class="name">{a.name}</span>
			<span class="meta">
				{#if online}{a.host || "online"} · {ago(a.seenAt)}{:else if a.seenAt > 0}last seen {ago(a.seenAt)}{:else}never ran{/if}
			</span>
			<button class="resp" class:unset={a.types.length === 0 && agents.length > 1} onclick={() => (assigning = assigning === a.id ? "" : a.id)}>
				{describe(a)}
			</button>
			<button onclick={() => void openChat(a.id)}>💬 Chat</button>
			{#if roster !== null}
				<button class:active={runsHere} onclick={() => void toggle(a.id, !runsHere)}>
					{runsHere ? "Runs here" : "Run here"}
				</button>
			{/if}
			<button class="danger" onclick={() => void removeAgent(a)}>
				{confirmRemove === a.id ? "Confirm remove" : "Remove"}
			</button>
		</div>
		{#if avatarPick === a.id}
			<div class="avatar-pop">
				<EmojiPicker onpick={(e) => void setAvatar(a.id, e)} onclose={() => (avatarPick = "")} />
			</div>
		{/if}
		{#if assigning === a.id}
			{@const claimed = claimants(a.id)}
			{@const restHolder = [...claimed.entries()].find(([k]) => k === "*")?.[1]}
			<div class="assign">
				<div class="assign-title">Responsible for</div>
				<label class="opt" class:disabled={!!restHolder}>
					<input type="checkbox" checked={a.types.includes("*")} disabled={!!restHolder} onchange={() => void toggleRest(a)} />
					Everything else <span class="opt-hint">{restHolder ? `— ${restHolder.name} has it` : "(whatever isn't explicitly assigned)"}</span>
				</label>
				<div class="assign-sep"></div>
				{#each store.types as t (t.id)}
					{@const owner = claimed.get(t.key)}
					<label class="opt" class:disabled={!!owner || a.types.includes("*")}>
						<input
							type="checkbox"
							checked={a.types.includes(t.key)}
							disabled={!!owner || a.types.includes("*")}
							onchange={() => void toggleType(a, t.key)}
						/>
						{t.name}
						{#if owner}<span class="opt-hint">— {owner.name}</span>{/if}
					</label>
				{/each}
			</div>
		{/if}
	</div>
{/each}
{#if agents.length === 0}
	<p class="hint">No agents in this channel yet.</p>
{/if}

<button class="new-agent" onclick={() => void newAgent()}>＋ New agent</button>

{#if skills !== null}
	<h3>Device skills</h3>
	<p class="hint">
		Capabilities installed on this machine. The coordinator agent
		{#if coordinator}
			({agents.find((a) => a.id === coordinator)?.name ?? "set in Settings"})
		{:else}
			(none set — all agents)
		{/if}
		fronts them; manage install/uninstall in global Settings → Skills.
	</p>
	<div class="skill-list">
		{#each skills as k (k.key)}
			<div class="skill-row">
				<span class="sname">{k.name}</span>
				<span class="chip {k.phase}">
					{k.phase === "on"
						? "on"
						: k.phase === "installing"
							? "installing…"
							: k.phase === "uninstalling"
								? "removing…"
								: k.phase === "needs-auth"
									? "auth needed"
									: k.phase === "failed"
										? "failed"
										: "off"}
				</span>
				{#if k.phase === "needs-auth" || k.phase === "failed"}
					<button class="recheck" onclick={() => void skillOp(k.key, "recheck")}>Re-check</button>
				{/if}
				<label class="switch">
					<input
						type="checkbox"
						checked={k.phase === "on" || k.phase === "installing"}
						disabled={k.phase === "installing" || k.phase === "uninstalling"}
						onchange={(e) => void skillOp(k.key, (e.currentTarget as HTMLInputElement).checked ? "enable" : "disable")}
					/>
					<span class="slider"></span>
				</label>
			</div>
		{/each}
	</div>
{/if}

<style>
	h3 {
		font-size: 13px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin: 24px 0 6px;
	}
	.hint {
		color: var(--muted);
		font-size: 12px;
		margin: 0 0 10px;
	}
	.agent-wrap {
		border: 1px solid var(--border);
		border-radius: 10px;
		margin-bottom: 6px;
	}
	.agent {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		font-size: 13px;
	}
	.resp {
		max-width: 240px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--muted);
	}
	.resp.unset {
		color: var(--accent);
		border-color: var(--accent);
	}
	.assign {
		border-top: 1px solid var(--border);
		padding: 8px 12px 10px;
	}
	.assign-title {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--muted);
		margin-bottom: 6px;
	}
	.assign-sep {
		height: 1px;
		background: var(--border);
		margin: 6px 0;
	}
	.opt {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		padding: 3px 0;
		cursor: pointer;
	}
	.opt.disabled {
		opacity: 0.45;
		cursor: default;
	}
	.opt-hint {
		color: var(--muted);
		font-size: 11px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--muted);
		flex: none;
	}
	.dot.online {
		background: #4caf78;
	}
	.name {
		color: var(--fg);
		font-weight: 600;
	}
	button.danger:hover {
		border-color: #e05555;
		color: #e05555;
	}
	.meta {
		color: var(--muted);
		font-size: 12px;
		flex: 1;
	}
	button {
		background: none;
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 12px;
		padding: 4px 10px;
		cursor: pointer;
	}
	button:hover {
		border-color: var(--accent);
	}
	button.active {
		border-color: var(--accent);
		color: var(--accent);
	}
	.skill-list {
		margin-bottom: 8px;
	}
	.skill-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 2px;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.skill-row:first-child {
		border-top: none;
	}
	.sname {
		font-weight: 600;
		flex: 1;
	}
	.chip {
		font-size: 11px;
		padding: 2px 8px;
		border-radius: 10px;
		background: var(--hover, #2a2a2a);
		color: var(--muted);
	}
	.chip.on {
		background: rgba(80, 180, 100, 0.18);
		color: #6fcf7f;
	}
	.chip.installing,
	.chip.uninstalling {
		background: rgba(120, 150, 240, 0.15);
		color: #8ea8f0;
	}
	.chip.needs-auth {
		background: rgba(240, 180, 60, 0.16);
		color: #f0b43c;
	}
	.chip.failed {
		background: rgba(232, 82, 74, 0.15);
		color: #e8524a;
	}
	.recheck {
		font-size: 11px;
	}
	.switch {
		position: relative;
		width: 34px;
		height: 18px;
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
		border-radius: 10px;
		background: var(--hover, #333);
		pointer-events: none;
		transition: background 0.15s;
	}
	.slider::before {
		content: "";
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--muted, #999);
		transition: transform 0.15s;
	}
	.switch input:checked + .slider {
		background: rgba(80, 180, 100, 0.4);
	}
	.switch input:checked + .slider::before {
		transform: translateX(16px);
		background: #6fcf7f;
	}
	.switch input:disabled {
		cursor: default;
	}
	.new-agent {
		margin-top: 2px;
	}
	.avatar-btn {
		background: var(--hl-light, rgba(255, 255, 255, 0.06));
		border: 1px solid transparent;
		border-radius: 50%;
		width: 28px;
		height: 28px;
		font-size: 16px;
		line-height: 1;
		cursor: pointer;
		padding: 0;
		flex: none;
	}
	.avatar-btn:hover {
		border-color: var(--accent);
	}
	.avatar-pop {
		position: relative;
		margin: 4px 0 8px 24px;
	}
</style>
