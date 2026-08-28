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
 */

import { API, chatPost, fetchObject, list, query, setField, str, subscribe, sv, createObject } from "./api";
import { runTurn } from "./runner";
import { spawnSubagent } from "./spawn";
import { startAuthServer } from "./authserver";
import { readRoster, setEnabled, syncHeartbeats } from "./roster";
import { startNostrSync } from "./nostrsync";
import { ensureChat, frameMessage, ingestIntoChat, pendingMessages, setMark } from "./surfaces";

function argValue(flagName: string): string {
	const idx = process.argv.indexOf(flagName);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

/** Agents THIS machine serves: local roster ∩ live agent objects. */
async function servedAgents(): Promise<Set<string>> {
	const roster = new Set(await readRoster());
	if (roster.size === 0) return roster;
	const rows = await query({ type: "agent", limit: 200 });
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
}

/** Unassigned (pre-channel) objects live in the default channel — UI rule. */
let defaultChannelId = "";

/** agentId → Served; rebuilt on roster change. */
async function buildServed(agents: Set<string>): Promise<Map<string, Served>> {
	const out = new Map<string, Served>();
	// Same source + order as the UI: /api/channels, first entry is default.
	const channels = (await (await fetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	const defaultChannel = channels[0]?.id ?? "";
	defaultChannelId = defaultChannel;
	for (const agentId of agents) {
		try {
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
			out.set(agentId, { agentId, chatId, channelId, types: list(agent.fields, "responsible_types") });
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
	const agents = await servedAgents();
	let served = await buildServed(agents);
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
		try {
			await handleSurface(s, surfaceId);
		} catch (err) {
			console.error(`[harness] turn failed for ${s.agentId.slice(0, 8)}:`, err);
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
		const s = responsibleFor(channelId, obj.typeKey);
		if (!s) return;
		const pending = await pendingMessages(obj, s.agentId);
		if (pending.length > 0) void drive(s, objectId);
	}

	startAuthServer(agents, (next) => {
		agents.clear();
		for (const id of next) agents.add(id);
		syncHeartbeats(agents);
		void buildServed(agents).then((next) => {
			served = next;
			for (const s of served.values()) void drive(s, s.chatId);
		});
	});
	console.log(`[harness] serving ${agents.size} agent(s): ${[...agents].map((a) => a.slice(0, 8)).join(", ") || "(none — enable one from an agent page)"}`);
	syncHeartbeats(agents);
	// Catch up on chat messages that arrived while the harness was down.
	// (Origin surfaces catch up on their next event.)
	for (const s of served.values()) void drive(s, s.chatId);
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

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "serve") await serve();
else if (cmd === "ask") await ask();
else {
	console.log("commands: setup --name X [--model m] [--channel id] | serve | ask <agentId> <msg>");
}
