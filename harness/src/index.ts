/**
 * Roostr harness daemon — the /holdfast analog, surface model ported from
 * GrantAgentSetup's bot.odin. Each served agent owns one holistic chat per
 * channel (a `chat` object); the agent is also reachable through ANY
 * object's discussion in its channel — those messages are copied into the
 * chat framed with their origin + the object's body, and the reply posts
 * back to the surface that asked. One turn answers one surface; messages
 * arriving elsewhere mid-turn wait (same-chat follow-ups steer in via the
 * runner's per-iteration refetch).
 *
 *   bun run src/index.ts setup --name Gracie [--model claude-…] [--channel id]
 *   bun run src/index.ts serve
 *   bun run src/index.ts ask <agentId> "message"
 *   bun run src/index.ts vanish <objectId…> | --trash   [--yes]
 */

import { API, chatPost, fetchObject, list, mutate, query, setField, str, subscribe, sv, createObject, queryAll } from "./api";
import { publishSystemSnapshot, runTurn } from "./runner";
import { spawnSubagent } from "./spawn";
import { convergeCatalogScope } from "./skillmgr";
import { startAuthServer } from "./authserver";
import { readRoster, setEnabled, syncHeartbeats } from "./roster";
import { startNostrSync, vanishOnRelays } from "./nostrsync";
import { chatBlocks, ensureChat, frameMessage, ingestIntoChat, pendingMessages, setMark } from "./surfaces";

function argValue(flagName: string): string {
	const idx = process.argv.indexOf(flagName);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

/** Agents THIS machine serves: local roster ∩ live agent objects. */
async function servedAgents(): Promise<Set<string>> {
	const roster = new Set(await readRoster());
	if (roster.size === 0) return roster;
	const rows = await queryAll({ type: "agent" });
	return new Set(rows.filter((r) => roster.has(r.id) && !str(r.fields, "spawn_parent")).map((r) => r.id));
}

async function setup(): Promise<void> {
	const name = argValue("--name") || "Agent";
	const existing = await query({ type: "agent", filters: [{ key: "name", condition: "equal", value: name }] });
	if (existing.length > 0) {
		console.log(`agent "${name}" already exists: ${existing[0].id}`);
		return;
	}
	const fields: Record<string, ReturnType<typeof sv>> = {
		model: sv(argValue("--model") || "claude-sonnet-4-5"),
	};
	if (argValue("--channel")) fields.channel = sv(argValue("--channel"));
	const { id } = await createObject(name, "agent", fields);
	// Setup on this machine claims serving responsibility here — "mine"
	// is a local fact, not a synced one.
	await setEnabled(id, true);
	console.log(`created agent "${name}": ${id} (enabled on this machine)`);
}

interface Served {
	agentId: string;
	chatId: string;
	channelId: string;
	/** Type keys this agent is responsible for; "*" = everything else. */
	types: string[];
	/** Object-bound agents: the one object this agent belongs to. */
	bound: string;
	name: string;
	icon: string;
}

/** Live per-agent turn state, served to the discussion UI via /agent/status. */
export interface AgentTurnStatus {
	id: string;
	name: string;
	icon: string;
	state: "idle" | "working" | "error";
	/** Surface of the in-flight (or failed) turn. */
	surface: string;
	/** Error detail, present when state === "error". */
	detail: string;
	ts: number;
}

export const agentTurnStatus = new Map<string, AgentTurnStatus>();

/** Unassigned (pre-channel) objects live in the default channel — UI rule. */
let defaultChannelId = "";

/** Prepare one agent for serving (chat ensured, channel pinned). */
async function buildServedOne(agentId: string, defaultChannel: string): Promise<Served> {
	const agent = await fetchObject(agentId);
	let channelId = str(agent.fields, "channel");
	if (!channelId) {
		// Never let an agent float on channel ordering: bind it to the
		// current default PERMANENTLY. (An ordering flip once moved every
		// floating agent - and their chats - into a duplicate channel.)
		channelId = defaultChannel;
		if (channelId) await setField(agentId, "channel", sv(channelId));
	}
	const chatId = await ensureChat(agent, channelId);
	return {
		agentId,
		chatId,
		channelId,
		types: list(agent.fields, "responsible_types"),
		bound: str(agent.fields, "bound_object"),
		name: str(agent.fields, "name") || agentId.slice(0, 8),
		icon: str(agent.fields, "iconEmoji"),
	};
}

/** agentId → Served; rebuilt on roster change. */
async function buildServed(agents: Set<string>): Promise<Map<string, Served>> {
	const out = new Map<string, Served>();
	// Same source + order as the UI: /api/channels, first entry is default.
	const channels = (await (await fetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	const defaultChannel = channels[0]?.id ?? "";
	defaultChannelId = defaultChannel;
	for (const agentId of agents) {
		try {
			out.set(agentId, await buildServedOne(agentId, defaultChannel));
		} catch (err) {
			console.error(`[harness] failed to prepare agent ${agentId.slice(0, 8)}:`, err);
		}
	}
	return out;
}

// Ingest sections (fetch → pending → mark → copy) must not interleave for
// one surface: two SSE events for the same commit would both read the old
// mark and double-ingest. Guarded by a per-surface in-flight set; a skipped
// event is safe because the drain loop re-checks after the turn.
const ingesting = new Set<string>();

/** Fetch → pending → advance mark → (origin surfaces) copy into the chat. */
async function ingestSurface(s: Served, surfaceId: string): Promise<boolean> {
	if (ingesting.has(surfaceId)) return false;
	ingesting.add(surfaceId);
	try {
		const surface = await fetchObject(surfaceId);
		const pending = await pendingMessages(surface, s.agentId);
		if (pending.length === 0) return false;
		await setMark(surfaceId, pending[pending.length - 1].blockId);
		if (surfaceId !== s.chatId) {
			const framed = frameMessage(surface, pending);
			await ingestIntoChat(s.chatId, surfaceId, pending[pending.length - 1].author || "user", framed);
		}
		return true;
	} finally {
		ingesting.delete(surfaceId);
	}
}

/**
 * Handle a message on one surface: ingest, run the turn on the chat, reply
 * where asked.
 */
async function handleSurface(s: Served, surfaceId: string): Promise<boolean> {
	if (!(await ingestSurface(s, surfaceId))) return false;
	const reply = await runTurn(s.agentId, s.chatId, { spawn: spawnSubagent });
	if (surfaceId !== s.chatId && reply.trim()) {
		await chatPost(surfaceId, reply.trim(), s.agentId);
	}
	console.log(`[${new Date().toISOString()}] ${s.agentId.slice(0, 8)} answered in ${surfaceId.slice(0, 8)}: ${reply.slice(0, 120)}`);
	return true;
}

async function serve(): Promise<void> {
	await convergeCatalogScope();
	const agents = await servedAgents();
	let served = await buildServed(agents);

	// ── Object-bound agents ─────────────────────────────────────────
	// objectId → its bound agent. Minted ONLY from a human discussion
	// message; agents can never create other minds. Lazily adopted into
	// `served` when their surface first stirs.
	const boundBy = new Map<string, string>();
	for (const a of await queryAll({ type: "agent" })) {
		const b = str(a.fields, "bound_object");
		if (b) boundBy.set(b, a.id);
	}
	console.log(`[harness] ${boundBy.size} object-bound agent(s) known`);

	/** Kinds that never get their own mind. */
	const UNMINTABLE = new Set(["agent", "chat", "channel", "relation", "type", "template", "skill", "program", "typescript", "json", "proto", "pinned_fact", "milestone"]);

	/** True when the newest discussion message is human-authored - the
	 * ONLY trigger that may mint an agent. */
	function lastMessageIsHuman(obj: Parameters<typeof chatBlocks>[0]): boolean {
		const msgs = chatBlocks(obj);
		if (msgs.length === 0) return false;
		const last = msgs[msgs.length - 1].block.content.custom?.meta ?? {};
		if (last["origin"]) return false;
		const author = last["author"] ?? "";
		return !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(author); // uuid author = an agent
	}

	async function mintBoundAgent(obj: Awaited<ReturnType<typeof fetchObject>>, channelId: string): Promise<string> {
		// Model follows the space's existing agents so quality is uniform.
		const sibling = [...served.values()].find((x) => x.channelId === channelId);
		const model = sibling ? str((await fetchObject(sibling.agentId)).fields, "model") : "";
		const name = str(obj.fields, "name") || obj.typeKey;
		const { id } = await createObject(name, "agent", {
			channel: sv(channelId),
			bound_object: sv(obj.id),
			iconEmoji: sv(str(obj.fields, "iconEmoji") || "🛰️"),
			model: sv(model || process.env.GLON_AGENT_MODEL || "claude-sonnet-4-5"),
		});
		boundBy.set(obj.id, id);
		console.log(`[harness] minted agent for "${name}" (${obj.id.slice(0, 8)}) → ${id.slice(0, 8)}`);
		return id;
	}

	const busy = new Set<string>();
	const active = new Map<string, string>(); // agentId → surface of the in-flight turn
	const dirty = new Map<string, Set<string>>(); // agentId → surfaces awaiting a turn

	async function drive(s: Served, surfaceId: string): Promise<void> {
		if (busy.has(s.agentId)) {
			if (surfaceId === active.get(s.agentId) && surfaceId !== s.chatId) {
				// Same-surface follow-up: fold into the in-flight turn (steer).
				// Chat-surface follow-ups need nothing — the runner refetches.
				await ingestSurface(s, surfaceId);
			} else if (surfaceId !== active.get(s.agentId)) {
				// Another surface mid-turn: wait for the next turn (bot.odin rule).
				let set = dirty.get(s.agentId);
				if (!set) dirty.set(s.agentId, (set = new Set()));
				set.add(surfaceId);
			}
			return;
		}
		busy.add(s.agentId);
		active.set(s.agentId, surfaceId);
		// Local status drives /agent/status; the same transition is written to
		// the agent object so remote clients (which cannot reach this
		// machine's harness) can tell a turn is in flight — e.g. to disable
		// prompt editing while the agent is mid-run.
		const report = (state: "idle" | "working" | "error", detail = "") => {
			agentTurnStatus.set(s.agentId, { id: s.agentId, name: s.name, icon: s.icon, state, surface: surfaceId, detail, ts: Date.now() });
			void setField(s.agentId, "turn_state", sv(state)).catch(() => {
				/* server down; the next transition re-reports */
			});
		};
		report("working");
		try {
			await handleSurface(s, surfaceId);
			report("idle");
		} catch (err) {
			console.error(`[harness] turn failed for ${s.agentId.slice(0, 8)}:`, err);
			let msg = (err instanceof Error ? err.message : String(err)).split("\n")[0];
			// API errors carry a JSON body - surface the human message, not the payload.
			const jsonStart = msg.indexOf("{");
			if (jsonStart > 0) {
				try {
					const inner = (JSON.parse(msg.slice(jsonStart)) as { error?: { message?: string } }).error?.message;
					if (inner) msg = msg.slice(0, jsonStart) + inner;
				} catch {
					/* keep raw */
				}
			}
			report("error", msg.slice(0, 200));
		} finally {
			busy.delete(s.agentId);
			active.delete(s.agentId);
			// Drain: the chat first (its own messages), then queued surfaces.
			const queued = [...(dirty.get(s.agentId) ?? [])];
			dirty.delete(s.agentId);
			for (const q of [s.chatId, ...queued]) {
				const surface = await fetchObject(q).catch(() => null);
				if (surface && (await pendingMessages(surface, s.agentId)).length > 0) {
					void drive(s, q);
					break;
				}
			}
		}
	}

	/**
	 * The channel agent responsible for a type: explicit claim wins, else the
	 * "*" (everything-else) agent, else a sole unconfigured agent handles all
	 * (single-agent channels keep working without any assignment).
	 */
	function responsibleFor(channelId: string, typeKey: string): Served | undefined {
		const inChannel = [...served.values()].filter((s) => s.channelId === channelId);
		const explicit = inChannel.find((s) => s.types.includes(typeKey));
		if (explicit) return explicit;
		const rest = inChannel.find((s) => s.types.includes("*"));
		if (rest) return rest;
		if (inChannel.length === 1 && inChannel[0].types.length === 0) return inChannel[0];
		return undefined;
	}

	/** Route an SSE object event to the agent whose surface it is. */
	async function route(objectId: string): Promise<void> {
		for (const s of served.values()) {
			if (objectId === s.chatId) return void drive(s, objectId);
		}
		if (agents.has(objectId)) {
			// Responsibility edits sync through the agent object — keep the
			// served entry current without a roster round-trip.
			const s = served.get(objectId);
			if (s) {
				const agent = await fetchObject(objectId).catch(() => null);
				if (agent) s.types = list(agent.fields, "responsible_types");
			}
			return; // agent objects are not surfaces
		}
		// Any agent object event (incl. one minted on another machine)
		// keeps the bound index current.
		if (!agents.has(objectId)) {
			const maybe = await fetchObject(objectId).catch(() => null);
			if (maybe?.typeKey === "agent") {
				const b = str(maybe.fields, "bound_object");
				if (b) boundBy.set(b, objectId);
				return;
			}
		}
		// Any other object in a served agent's channel is a surface; the
		// responsible agent (by type) answers.
		let obj;
		try {
			obj = await fetchObject(objectId);
		} catch {
			return;
		}
		if (obj.typeKey === "chat" || obj.typeKey === "agent") return; // other agents' chats/brains
		const channelId = objectId === defaultChannelId || obj.typeKey === "channel" ? objectId : str(obj.fields, "channel") || defaultChannelId;

		// ── Bound agent takes its own object's surface, always. ──
		const boundAgent = boundBy.get(objectId);
		if (boundAgent) {
			let s2 = served.get(boundAgent);
			if (!s2) {
				try {
					s2 = await buildServedOne(boundAgent, defaultChannelId);
					served.set(boundAgent, s2);
				} catch (err) {
					console.error(`[harness] failed to adopt bound agent ${boundAgent.slice(0, 8)}:`, err);
					return;
				}
			}
			const pending2 = await pendingMessages(obj, s2.agentId);
			if (pending2.length > 0) void drive(s2, objectId);
			return;
		}

		// ── Explicitly responsible space agent answers, as before. ──
		const s = responsibleFor(channelId, obj.typeKey);
		if (s) {
			const pending = await pendingMessages(obj, s.agentId);
			if (pending.length > 0) void drive(s, objectId);
			return;
		}

		// ── Nobody claims it: a HUMAN message on a discussable object
		// mints the object's own agent and serves this very message. ──
		if (UNMINTABLE.has(obj.typeKey)) return;
		if (!lastMessageIsHuman(obj)) return;
		const minted = await mintBoundAgent(obj, channelId);
		const s3 = await buildServedOne(minted, defaultChannelId);
		served.set(minted, s3);
		void publishSystemSnapshot(s3.agentId, s3.chatId);
		const pending3 = await pendingMessages(obj, s3.agentId);
		if (pending3.length > 0) void drive(s3, objectId);
	}

	startAuthServer(agents, (next) => {
		agents.clear();
		for (const id of next) agents.add(id);
		syncHeartbeats(agents);
		void buildServed(agents).then((next) => {
			served = next;
			for (const s of served.values()) {
				void publishSystemSnapshot(s.agentId, s.chatId);
				void drive(s, s.chatId);
			}
		});
	});
	console.log(`[harness] serving ${agents.size} agent(s): ${[...agents].map((a) => a.slice(0, 8)).join(", ") || "(none — enable one from an agent page)"}`);
	syncHeartbeats(agents);
	// Catch up on chat messages that arrived while the harness was down.
	// (Origin surfaces catch up on their next event.)
	// Publishing the prompt here rather than only mid-turn is what lets a
	// never-messaged agent show a real prompt instead of an empty panel.
	for (const s of served.values()) {
		void publishSystemSnapshot(s.agentId, s.chatId);
		void drive(s, s.chatId);
	}
	subscribe((objectId) => void route(objectId));
	console.log("[harness] SSE connected; serving.");
	void startNostrSync();
}

async function ask(): Promise<void> {
	const agentId = process.argv[3];
	const text = process.argv[4];
	if (!agentId || !text) {
		console.error("usage: ask <agentId> <message>");
		process.exit(1);
	}
	const agent = await fetchObject(agentId);
	const channels = (await (await fetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	const chatId = await ensureChat(agent, str(agent.fields, "channel") || channels[0]?.id || "");
	await chatPost(chatId, text);
	const reply = await runTurn(agentId, chatId, { spawn: spawnSubagent });
	console.log(reply);
}

/**
 * Real deletion. `delete` only tombstones: the change files stay on disk and
 * on the relays, and the union reconcile keeps bringing them back. `vanish`
 * purges the files, records the object in the synced ledger (so no device
 * republishes it and no relay copy is accepted back), then asks the relays to
 * drop the events with NIP-09.
 */
async function vanish(): Promise<void> {
	const args = process.argv.slice(3).filter((a) => a !== "--yes");
	const trash = args.includes("--trash");
	let ids = args.filter((a) => !a.startsWith("--"));
	if (trash) {
		const rows = await query({ includeDeleted: true, filters: [{ key: "deleted", condition: "equal", value: true }], limit: 10_000 });
		ids = rows.map((r) => r.id);
	}
	if (ids.length === 0) {
		console.error("usage: vanish <objectId…> | --trash [--yes]\n  --trash vanishes every object already marked deleted");
		process.exit(1);
	}
	if (!process.argv.includes("--yes")) {
		console.log(`${ids.length} object(s) would be vanished — irreversible locally. Re-run with --yes:`);
		for (const id of ids.slice(0, 10)) console.log(`  ${id}`);
		if (ids.length > 10) console.log(`  … and ${ids.length - 10} more`);
		return;
	}
	// One ledger change and one relay pass for the whole set: a per-object
	// loop would mean a store rebuild and three relay round trips each.
	const VANISH_CHUNK = 250;
	let purged = 0;
	for (let i = 0; i < ids.length; i += VANISH_CHUNK) {
		const batch = ids.slice(i, i + VANISH_CHUNK);
		try {
			const res = (await mutate("vanish", { object_ids: batch })) as { vanished?: number };
			purged += res.vanished ?? 0;
		} catch (err) {
			console.error(`[vanish] batch of ${batch.length} failed: ${err instanceof Error ? err.message : err}`);
		}
	}
	console.log(`[vanish] purged ${purged}/${ids.length} object(s) locally; ledger updated`);
	const { events, requests } = await vanishOnRelays(ids);
	console.log(`[vanish] relays: ${events} event(s) found, ${requests} NIP-09 request(s) published`);
	console.log("[vanish] note: kind 5 is advisory — relays SHOULD honour it, archival indexers may not.");
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "serve") await serve();
else if (cmd === "ask") await ask();
else if (cmd === "vanish") await vanish();
else {
	console.log("commands: setup --name X [--model m] [--channel id] | serve | ask <agentId> <msg> | vanish <objectId…>|--trash [--yes]");
}
