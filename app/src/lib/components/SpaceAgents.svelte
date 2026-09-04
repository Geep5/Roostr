<script lang="ts">
	/**
	 * Agents section of space settings. Agents are space infrastructure
	 * (like members), not objects OF the space — they're hidden from every
	 * object surface and managed only here. You TALK to an agent through its
	 * chat or any object's discussion; you MANAGE it here. "Runs here" is
	 * this machine's harness roster — the one local fact this panel needs.
	 * There is no presence indicator: liveness is not in the DAG, and this
	 * app shows what the DAG holds.
	 */
	import { onMount } from "svelte";
	import EmojiPicker from "./EmojiPicker.svelte";
	import { goto } from "$app/navigation";
	import { fetchQuery, note, chat, fetchAllQuery } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import { typeGlyph } from "$lib/create";

	let { channelId }: { channelId: string } = $props();

	const HARNESS = "http://127.0.0.1:7334";

	interface SystemPart {
		label: string;
		text: string;
		tokens: number;
	}

	interface AgentRow {
		id: string;
		name: string;
		icon: string;
		model: string;
		/** Responsible type keys; "*" = everything else. */
		types: string[];
		/** The editable base prompt (agent field `system`). */
		system: string;
		/** "configurator" marks the agent that rewrites the others in this space. */
		role: string;
		/** What the harness last actually assembled and sent, section by section. */
		effective: SystemPart[];
		/** Object-bound agents: the object this agent belongs to. */
		bound: string;
		boundName: string;
		updatedAt: number;
	}

	let agents = $state<AgentRow[]>([]);
	let roster = $state<string[] | null>(null); // null = no local daemon
	/** agentId → hostnames of every machine claiming it (2+ = the bug shape). */
	let claimedBy = $state<Record<string, string[]>>({});
	/** agentId → newest activity in its own conversation, derived, never stored. */
	let lastActive = $state<Record<string, number>>({});
	let now = $state(Date.now());

	function ago(ms: number): string {
		const s = Math.floor((now - ms) / 1000);
		if (s < 90) return `${s}s ago`;
		if (s < 5400) return `${Math.round(s / 60)}m ago`;
		if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
		return `${Math.round(s / 86_400)}d ago`;
	}

	let assigning = $state(""); // agent id whose responsibility editor is open
	let avatarPick = $state(""); // agent id whose avatar picker is open

	async function setAvatar(id: string, emoji: string) {
		avatarPick = "";
		await note.setField(id, "iconEmoji", { stringValue: emoji });
		await load();
	}

	const defaultChannelId = $derived(store.channels[0]?.id ?? "");

	async function load() {
		await loadOwnSkills();
		const records = await fetchAllQuery({ type: "agent" });
		agents = records
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
				types: (r.fields["responsible_types"]?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean),
				system: r.fields["system"]?.stringValue ?? "",
				role: r.fields["role"]?.stringValue ?? "",
				effective: parseEffective(r.fields["system_effective"]?.stringValue ?? ""),
				bound: r.fields["bound_object"]?.stringValue ?? "",
				boundName: "",
				updatedAt: r.updatedAt,
			}));
		// Claims and last-activity, both already in the DAG. Machines publish a
		// claim when it changes; activity is the agent's own conversation's
		// updatedAt, so neither costs a write. Two machines claiming one agent
		// is the shape of a double-answer bug, so the row says so.
		const [machines, chats] = await Promise.all([fetchAllQuery({ type: "machine" }), fetchAllQuery({ type: "chat" })]);
		// Built locally, assigned once. Pushing into a nested array through the
		// state proxy mutates the raw array without signalling, so the template
		// keeps whatever it read first - which was nothing.
		const claims: Record<string, string[]> = {};
		for (const m of machines) {
			const host = m.fields["name"]?.stringValue || "a machine";
			for (const item of m.fields["claims"]?.valuesValue?.items ?? []) {
				const id = item.stringValue ?? "";
				if (id) (claims[id] ??= []).push(host);
			}
		}
		claimedBy = claims;
		const active: Record<string, number> = {};
		for (const c of chats) {
			const owner = c.fields["agent"]?.stringValue ?? "";
			if (owner) active[owner] = Math.max(active[owner] ?? 0, c.updatedAt);
		}
		lastActive = active;
		// Object agents list under their object's name.
		for (const a of agents) {
			if (!a.bound) continue;
			const o = store.summaries.find((x) => x.id === a.bound);
			a.boundName = o?.name || "";
		}
		// Definitions nudge: how many defs in this space say nothing.
		const [types, props] = await Promise.all([
			fetchAllQuery({ type: "type", filters: [{ key: "channel", condition: "equal", value: channelId }] }),
			fetchAllQuery({ type: "relation", filters: [{ key: "channel", condition: "equal", value: channelId }] }),
		]);
		undefinedTypes = types.filter((t) => !(t.fields["description"]?.stringValue ?? "").trim() && !(t.fields["hidden"]?.boolValue === true)).length;
		undefinedProps = props.filter((t) => !(t.fields["description"]?.stringValue ?? "").trim() && !(t.fields["hidden"]?.boolValue === true)).length;
	}

	let undefinedTypes = $state(0);
	let undefinedProps = $state(0);
	const spaceAgents = $derived(agents.filter((a) => !a.bound));
	const boundAgents = $derived(agents.filter((a) => a.bound).toSorted((a, b) => b.updatedAt - a.updatedAt));

	/** Retire an object agent: the agent and its holistic chat go; the
	 *  object and any pair chats (shared history) stay. */
	async function retire(a: AgentRow) {
		if (!confirm(`Retire the agent of "${a.boundName || a.name}"? Its private chat goes with it; the object and shared conversations stay.`)) return;
		const chats = await fetchQuery({ type: "chat", filters: [{ key: "agent", condition: "equal", value: a.id }], limit: 10 });
		for (const c of chats.records) {
			if (c.fields["a2a_pair"]?.stringValue) continue;
			await note.del(c.id);
		}
		await note.del(a.id);
		await load();
	}

	/** The harness publishes this as a JSON string field; a stale shape must
	 * never break the panel. */
	function parseEffective(raw: string): SystemPart[] {
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as SystemPart[];
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	}

	// ── System prompt ───────────────────────────────────────────────
	//
	// The agent re-reads its own object every tool iteration, so an edit here
	// lands on the next iteration with no restart. The editor is disabled
	// mid-turn as a courtesy, not a lock.
	let promptOpen = $state("");
	let promptDraft = $state<Record<string, string>>({});
	let promptSaved = $state("");

	// ── Ask the configurator ────────────────────────────────────────
	//
	// One instruction, one edit, no thread: the human types what they want
	// changed and the configurator agent rewrites this agent's fields. It
	// runs on whichever machine serves it, so the round trip is the same
	// sync path as everything else — hence the poll rather than a response.
	//
	// An agent is a citizen of exactly one space, so the configurator must
	// live in this one: every id-taking tool refuses a target outside its
	// own space. Hence one configurator per space, found among these agents
	// rather than across the vault.
	const configurator = $derived(agents.find((x) => x.role === "configurator"));
	let askDraft = $state<Record<string, string>>({});
	let asking = $state("");
	let addingConfig = $state(false);

	/** The configurator's own instructions. It reads the configure-agents
	 * skill for the field reference, so this stays short. */
	const CONFIG_SYSTEM = [
		"You are the configuration assistant for this space. You do not chat and you do not do the humans' work — you change how the other agents in this space are set up, one instruction at a time.",
		"Every instruction you receive names a target agent and includes that agent's current prompt. Apply the change to that agent and stop. There is no conversation: the human is watching the target's prompt panel, not this thread, and will send another instruction if they want more.",
		"Read the configure-agents skill before your first change. It lists which fields are writable, which are the harness's to own, and how to author a skill object.",
		"Rewrite the whole `system` field rather than appending, folding the request into the prompt that is already there. Never drop an existing instruction because this request did not mention it.",
		"You can only touch objects in your own space. If asked about an agent elsewhere, say so instead of trying.",
		"Finish with exactly one line naming what you changed.",
	].join("\n\n");

	async function addConfigurator() {
		addingConfig = true;
		try {
			const { id } = await note.create("Config", "agent", {
				channel: { stringValue: channelId },
				model: { stringValue: "claude-sonnet-4-5" },
				system: { stringValue: CONFIG_SYSTEM },
				role: { stringValue: "configurator" },
				iconEmoji: { stringValue: "⚙️" },
			});
			await toggle(id, true); // useless unless something serves it
			await load();
		} finally {
			addingConfig = false;
		}
	}

	async function askConfigurator(a: AgentRow) {
		const instruction = (askDraft[a.id] ?? "").trim();
		const cfg = configurator;
		if (!instruction || !cfg) return;
		asking = a.id;
		try {
			const chats = await fetchQuery({
				type: "chat",
				filters: [{ key: "agent", condition: "equal", value: cfg.id }],
				limit: 1,
			});
			const chatId = chats.records[0]?.id;
			if (!chatId) {
				asking = "";
				return; // no chat yet: the harness creates it when it first serves the agent
			}
			// Everything the configurator needs, since it never sees this screen.
			const framed = [
				`Target agent: ${a.name} (id ${a.id})`,
				`Model: ${a.model || "(default)"}`,
				`Current prompt:\n${a.system || "(empty — using the harness default)"}`,
				`Instruction: ${instruction}`,
			].join("\n\n");
			await chat.post(chatId, framed);
			askDraft[a.id] = "";
			// The edit lands on the target object; watch for it rather than
			// waiting on a reply we do not display.
			const before = a.system;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				await load();
				if ((agents.find((x) => x.id === a.id)?.system ?? "") !== before) break;
			}
		} finally {
			asking = "";
		}
	}

	// ── This agent's own skills ─────────────────────────────────────
	//
	// The global set is hardcoded — the device capabilities in the
	// harness catalog, marked `scope: global`, listed to every agent and
	// never claimable by one. Everything else is settable here: a skill
	// owned via its `agent` field is listed and readable by that agent
	// alone, so a specialist's procedure costs every other agent nothing.
	// The body is only loaded when that agent calls skill_read.
	interface OwnedSkill {
		id: string;
		name: string;
		description: string;
	}
	let ownSkills = $state<Record<string, OwnedSkill[]>>({});

	async function loadOwnSkills() {
		const res = await fetchQuery({ type: "skill", limit: 100 });
		const next: Record<string, OwnedSkill[]> = {};
		for (const r of res.records) {
			const owner = r.fields["agent"]?.stringValue ?? "";
			if (!owner) continue;
			(next[owner] ??= []).push({
				id: r.id,
				name: r.fields["name"]?.stringValue || "Untitled",
				description: r.fields["description"]?.stringValue ?? "",
			});
		}
		ownSkills = next;
		unassigned = res.records
			.filter((r) => !(r.fields["agent"]?.stringValue ?? "") && r.fields["scope"]?.stringValue !== "global")
			.map((r) => ({
				id: r.id,
				name: r.fields["name"]?.stringValue || "Untitled",
				description: r.fields["description"]?.stringValue ?? "",
			}));
	}

	async function newOwnSkill(a: AgentRow) {
		const name = prompt(`New skill for ${a.name}:`);
		if (!name?.trim()) return;
		const { id } = await note.create(name.trim(), "skill", {
			channel: { stringValue: channelId },
			agent: { stringValue: a.id },
		});
		await goto(`/object/${id}`);
	}

	/** Dropping the owner returns it to the unassigned pool. It does not
	 * become a global skill: that set is the hardcoded catalog. */
	async function unassignSkill(id: string) {
		await note.setField(id, "agent", { stringValue: "" });
		await loadOwnSkills();
	}

	/** Skills with no owner yet — assignable to exactly one agent. */
	let unassigned = $state<OwnedSkill[]>([]);
	let adoptPick = $state<Record<string, string>>({});

	async function assignSkill(a: AgentRow) {
		const id = adoptPick[a.id];
		if (!id) return;
		await note.setField(id, "agent", { stringValue: a.id });
		adoptPick[a.id] = "";
		await loadOwnSkills();
	}

	async function savePrompt(a: AgentRow) {
		const next = promptDraft[a.id] ?? a.system;
		await note.setField(a.id, "system", { stringValue: next });
		promptSaved = a.id;
		setTimeout(() => (promptSaved = promptSaved === a.id ? "" : promptSaved), 1500);
		await load();
	}

	// ── Responsibility (one owner per type; one "everything else") ──
	//
	// A type key is claimable by exactly ONE agent in the space, and only
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

	/** Every space owns its own copies of the default types, so the
	 * vault-wide list repeats each key once per space. Responsibility
	 * matches on the key, and an agent only ever serves this space. */
	const spaceTypes = $derived(
		store.types.filter((t) => t.space === channelId || (t.space === "" && channelId === defaultChannelId)),
	);

	function describe(a: AgentRow): string {
		if (a.types.includes("*")) return "Everything else";
		if (a.types.length === 0) return agents.length === 1 ? "Everything (sole agent)" : "Nothing assigned";
		return a.types.map((t) => spaceTypes.find((x) => x.key === t)?.name ?? t).join(", ");
	}

	async function loadRoster() {
		try {
			const res = await fetch(`${HARNESS}/agents`);
			roster = ((await res.json()) as { roster: string[] }).roster;
		} catch {
			roster = null;
		}
	}

	// ── Provider readiness ───────────────────────────────────────────
	//
	// "Run here" only means anything if this machine can actually
	// authenticate the agent's model, so the button reflects the harness's
	// credential state rather than letting the first turn discover it.
	interface ProviderStatus {
		mode: string;
		ready: boolean;
		expires?: number;
	}
	let auth = $state<{ anthropic: ProviderStatus; kimi: ProviderStatus } | null>(null);

	async function loadAuth() {
		try {
			const res = await fetch(`${HARNESS}/auth/status`);
			auth = (await res.json()) as { anthropic: ProviderStatus; kimi: ProviderStatus };
		} catch {
			auth = null;
		}
	}

	/** Which credential a model needs — mirrors callLLM's dispatch. */
	function provider(model: string): "anthropic" | "kimi" | "none" {
		if (model === "mock") return "none";
		return model.startsWith("kimi") ? "kimi" : "anthropic";
	}

	/** Empty when the agent can run here; otherwise why it can't. */
	function authBlock(model: string): string {
		const need = provider(model);
		if (need === "none" || auth === null) return "";
		const p = auth[need];
		if (p.ready) return "";
		const label = need === "anthropic" ? "Claude" : "Kimi";
		if (p.mode === "none") return `No ${label} credentials on this machine`;
		if (p.mode === "claude_code") return "Claude Code login expired";
		return `${label} credentials expired`;
	}

	onMount(() => {
		void loadRoster();
		void loadAuth();
		// Ages the "active 3m ago" labels and catches a credential expiry that
		// lands while this page is open. Claims change too rarely to poll for.
		const t = setInterval(() => {
			now = Date.now();
			void loadAuth();
		}, 15_000);
		return () => clearInterval(t);
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
</script>

<h3>Agents</h3>
<p class="hint">
	Agents serve this space: one holistic chat each, reachable from any object's discussion. Enable an
	agent on the machine whose harness should run it.
</p>

{#each spaceAgents as a (a.id)}
	{@const runsHere = roster?.includes(a.id) ?? false}
	{@const blocked = roster === null ? "" : authBlock(a.model)}
	{@const claims = claimedBy[a.id] ?? []}
	{@const active = lastActive[a.id] ?? 0}
	<div class="agent-wrap">
		<div class="agent">
			<!-- The agent's avatar: shows in chat next to its messages. -->
			<button class="avatar-btn" title="Set avatar" onclick={() => (avatarPick = avatarPick === a.id ? "" : a.id)}>
				{#if a.icon}{a.icon}{:else}🤖{/if}
			</button>
			<span class="name">{a.name}</span>
			<span class="claim" class:contested={claims.length > 1}>
				{#if claims.length > 1}
					⚠ claimed by {claims.join(" and ")}
				{:else if claims.length === 1}
					{claims[0]}
				{:else}
					unclaimed
				{/if}
				{#if active > 0}· active {ago(active)}{/if}
			</span>
			<button class="resp" class:unset={a.types.length === 0 && agents.length > 1} onclick={() => (assigning = assigning === a.id ? "" : a.id)}>
				{describe(a)}
			</button>
			<button onclick={() => void openChat(a.id)}>💬 Chat</button>
			<button class:active={promptOpen === a.id} onclick={() => (promptOpen = promptOpen === a.id ? "" : a.id)}>Prompt</button>
			{#if roster !== null}
				<button
					class:active={runsHere}
					class:warn={blocked !== ""}
					title={blocked ? `${blocked} — this agent's turns will fail until you sign in` : ""}
					onclick={() => void toggle(a.id, !runsHere)}
				>
					{blocked ? "⚠ " : ""}{runsHere ? "Runs here" : "Run here"}
				</button>
			{/if}
			<button class="danger" onclick={() => void removeAgent(a)}>
				{confirmRemove === a.id ? "Confirm remove" : "Remove"}
			</button>
		</div>
		{#if blocked}
			<p class="auth-warn">
				⚠ {blocked}. {runsHere
					? "This agent runs here but its turns will fail"
					: "Running it here will fail"} until you sign in under Settings → Agent.
			</p>
		{/if}
		{#if promptOpen === a.id}
			{@const draft = promptDraft[a.id] ?? a.system}
			<div class="prompt">
				<p class="hint">
					The agent rebuilds its prompt from this object every tool iteration, so an edit lands on
					its next iteration — nothing to restart.
				</p>
				<textarea
					rows="8"
					placeholder="Empty — the agent uses the built-in default prompt."
					value={draft}
					oninput={(e) => (promptDraft[a.id] = (e.currentTarget as HTMLTextAreaElement).value)}
				></textarea>
				<div class="prompt-actions">
					<button disabled={draft === a.system} onclick={() => void savePrompt(a)}>
						{promptSaved === a.id ? "Saved" : "Save prompt"}
					</button>
					{#if draft !== a.system}
						<button class="subtle" onclick={() => (promptDraft[a.id] = a.system)}>Discard</button>
					{/if}
				</div>
				<div class="own-skills">
					{#each ownSkills[a.id] ?? [] as k (k.id)}
						<div class="own-skill">
							<a href={`/object/${k.id}`}>{k.name}</a>
							<span class="sk-desc">{k.description || "no description — this agent picks skills by it"}</span>
							<button class="subtle nowrap" title="Return it to the unassigned pool" onclick={() => void unassignSkill(k.id)}>Unassign</button>
						</div>
					{/each}
					<button class="subtle" onclick={() => void newOwnSkill(a)}>+ New skill for {a.name}</button>
					{#if unassigned.length > 0}
						<select
							value={adoptPick[a.id] ?? ""}
							onchange={(e) => {
								adoptPick[a.id] = (e.currentTarget as HTMLSelectElement).value;
								void assignSkill(a);
							}}
						>
							<option value="">Assign a skill to {a.name}…</option>
							{#each unassigned as g (g.id)}
								<option value={g.id}>{g.name}</option>
							{/each}
						</select>
					{/if}
					<span class="sk-desc">only {a.name} lists these; the hardcoded global skills are in Settings → Skills</span>
				</div>
				{#if !configurator}
					<div class="ask-row">
						<button class="subtle" disabled={addingConfig} onclick={() => void addConfigurator()}>
							{addingConfig ? "Adding…" : "+ Add a Config agent for this space"}
						</button>
						<span class="hint ask-hint">then tell it what to change here, instead of writing prompts by hand</span>
					</div>
				{:else if configurator.id !== a.id}
					<div class="ask-row">
						<input
							placeholder={asking === a.id ? "Applying…" : `Tell ${configurator.name} what to change about ${a.name}…`}
							disabled={asking === a.id}
							value={askDraft[a.id] ?? ""}
							oninput={(e) => (askDraft[a.id] = (e.currentTarget as HTMLInputElement).value)}
							onkeydown={(e) => {
								if (e.key === "Enter") void askConfigurator(a);
							}}
						/>
						<button disabled={asking === a.id || !(askDraft[a.id] ?? "").trim()} onclick={() => void askConfigurator(a)}>
							{asking === a.id ? "…" : "Apply"}
						</button>
					</div>
				{/if}
				{#if a.effective.length > 0}
					{@const total = a.effective.reduce((n, p) => n + p.tokens, 0)}
					<p class="hint">
						What the serving harness last actually sent — {total} tokens across {a.effective.length}
						sections. Read-only: only the base prompt above is yours to edit; the rest is assembled
						from skills, memory, and space instructions.
					</p>
					{#each a.effective as part, i (part.label)}
						<!-- The base prompt is the thing you came to read, so it is open;
						     the assembled sections stay folded. -->
						<details class="part" open={i === 0}>
							<summary><span class="plabel">{part.label}</span><span class="ptok">{part.tokens} tok</span></summary>
							<pre>{part.text}</pre>
						</details>
					{/each}
				{:else}
					<p class="hint">
						No prompt published yet. It appears once a machine serving this agent has
						reported in — the assembled prompt (including the built-in default this
						agent uses when the box above is empty) is written by the harness, not
						guessed here.
					</p>
				{/if}
			</div>
		{/if}
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
				{#each spaceTypes as t (t.id)}
					{@const owner = claimed.get(t.key)}
					<label class="opt" class:disabled={!!owner || a.types.includes("*")}>
						<input
							type="checkbox"
							checked={a.types.includes(t.key)}
							disabled={!!owner || a.types.includes("*")}
							onchange={() => void toggleType(a, t.key)}
						/>
						<span class="obj-icon">{t.icon || typeGlyph(t.key)}</span>{t.name}
						{#if owner}<span class="opt-hint">— {owner.name}</span>{/if}
					</label>
				{/each}
			</div>
		{/if}
	</div>
{/each}
{#if agents.length === 0}
	<p class="hint">No agents in this space yet.</p>
{/if}

<button class="new-agent" onclick={() => void newAgent()}>＋ New agent</button>

{#if boundAgents.length > 0}
	<details class="bound-agents">
		<summary>Object agents · {boundAgents.length}</summary>
		<p class="hint">Minted when you start a discussion on an object. Idle ones cost nothing.</p>
		{#each boundAgents as a (a.id)}
			{@const claims = claimedBy[a.id] ?? []}
			<div class="bound-row">
				<a class="bound-link" href="/object/{a.bound}">
					<span class="obj-icon">{a.icon || "🛰️"}</span>{a.boundName || a.name}
				</a>
				<!-- Bound agents are where a double claim actually bites: each one
				     answers its own object's discussion, so two machines serving it
				     answer the human twice. -->
				<span class="claim" class:contested={claims.length > 1}>
					{#if claims.length > 1}⚠ {claims.join(" and ")}{:else if claims.length === 1}{claims[0]}{:else}unclaimed{/if}
				</span>
				<span class="bound-when">{new Date(a.updatedAt).toLocaleDateString()}</span>
				<button class="danger" onclick={() => void retire(a)}>Retire</button>
			</div>
		{/each}
	</details>
{/if}

{#if undefinedTypes + undefinedProps > 0}
	<p class="def-nudge">
		{undefinedTypes} type{undefinedTypes === 1 ? "" : "s"} and {undefinedProps}
		propert{undefinedProps === 1 ? "y" : "ies"} in this space have no definition — agents guess
		without them. Open a type or property page and fill in "what is this for".
	</p>
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
	/* Component styles are scoped, so the shared .obj-icon rule in the
	   layout does not reach this row: without a fixed column the glyphs
	   keep their own widths and the names step in and out. */
	.opt .obj-icon {
		flex: none;
		width: 20px;
		text-align: center;
		color: var(--accent);
	}
	.opt.disabled {
		opacity: 0.45;
		cursor: default;
	}
	.opt-hint {
		color: var(--muted);
		font-size: 11px;
	}
	.name {
		color: var(--fg);
		font-weight: 600;
	}
	/* Holds the slack so the controls stay right-aligned. */
	.claim {
		flex: 1;
		color: var(--muted);
		font-size: 12px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.claim.contested {
		color: var(--orange);
	}
	button.danger:hover {
		border-color: #e05555;
		color: #e05555;
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
	/* After .active so a warned agent that already runs here reads as a
	   warning, not as healthy. */
	button.warn {
		border-color: var(--orange);
		color: var(--orange);
		background: rgb(255 159 10 / 0.12);
	}
	.auth-warn {
		color: var(--orange);
		font-size: 11.5px;
		margin: 2px 0 8px 30px;
	}
	.prompt {
		padding: 2px 10px 10px 30px;
	}
	.prompt textarea {
		width: 100%;
		box-sizing: border-box;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 8px 10px;
		resize: vertical;
	}
	.prompt textarea:disabled {
		opacity: 0.55;
	}
	.prompt-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 0 10px;
	}
	.prompt .subtle {
		border-color: transparent;
		color: var(--muted);
	}
	.own-skills {
		border-top: 1px solid var(--border);
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 10px;
		margin: 8px 0 10px;
		padding-top: 8px;
	}
	.own-skill {
		display: flex;
		align-items: baseline;
		gap: 6px;
		width: 100%;
	}
	.own-skill a {
		color: var(--fg);
		font-size: 12px;
		white-space: nowrap;
	}
	.sk-desc {
		color: var(--muted);
		font-size: 11.5px;
		margin-right: auto;
	}
	.own-skills .nowrap {
		white-space: nowrap;
	}
	.ask-row {
		display: flex;
		gap: 6px;
		margin: 0 0 10px;
	}
	.ask-row input {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 12px;
		padding: 6px 10px;
		outline: none;
	}
	.ask-row input:focus {
		border-color: var(--accent);
	}
	.ask-row .ask-hint {
		margin: 0;
		align-self: center;
	}
	.part {
		border-top: 1px solid var(--border);
		padding: 5px 0;
	}
	.part summary {
		display: flex;
		gap: 10px;
		cursor: pointer;
		font-size: 12px;
	}
	.plabel {
		flex: 1;
	}
	.ptok {
		color: var(--muted);
		font-size: 11px;
	}
	.part pre {
		white-space: pre-wrap;
		word-break: break-word;
		background: var(--bg);
		border-radius: 6px;
		padding: 8px 10px;
		margin: 6px 0 2px;
		font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--muted);
	}
	.new-agent {
		margin-top: 2px;
	}
	.avatar-btn {
		background: var(--hl-light, rgba(255, 255, 255, 0.06));
		/* A bare emoji on a near-invisible fill reads as decoration, so the
		   one control that sets an agent's avatar looked absent. A resting
		   hairline says "button"; hover still promotes to accent. */
		border: 1px solid var(--border);
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
	.bound-agents {
		margin-top: 14px;
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px 12px;
	}
	.bound-agents summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
		color: var(--fg);
	}
	.bound-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 0;
		border-top: 1px solid var(--border);
		font-size: 13px;
	}
	.bound-row:first-of-type {
		border-top: none;
	}
	.bound-link {
		flex: 1;
		color: var(--fg);
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.bound-link:hover {
		text-decoration: underline;
	}
	.bound-when {
		color: var(--muted);
		font-size: 12px;
	}
	.bound-row .danger {
		background: none;
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--red);
		font-size: 12px;
		padding: 3px 9px;
		cursor: pointer;
	}
	.def-nudge {
		margin-top: 12px;
		font-size: 12.5px;
		color: var(--orange);
		line-height: 1.5;
	}
</style>
