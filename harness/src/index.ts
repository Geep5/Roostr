/**
 * Roostr harness daemon. Each agent's private work stays on its owning
 * object. Human discussions feed that transcript; addressed exchanges use
 * durable inbox/outbox copies on every participant's own object DAG.
 * Delivery retries independently of agent execution and machine liveness.
 *
 *   bun run src/index.ts setup --name Gracie [--kind assistant|marco] [--model claude-…] [--channel id] [--<kind field> value…]
 *   bun run src/index.ts serve
 *   bun run src/index.ts ask <agentId> "message"
 *   bun run src/index.ts vanish <objectId…> | --trash   [--yes]
 */

import { API, apiFetch, chatPost, deleteField, fetchObject, list, lv, mutate, query, setField, str, subscribe, sv, createObject, queryAll } from "./api";
import { AGENT_KINDS, agentKind } from "./kinds";
import type { ObjectJSON, ValueJSON } from "./api";
import { publishSystemSnapshot, runTurn } from "./runner";
import { spawnSubagent } from "./spawn";
import { capabilities, convergeCatalogScope, publishInstallationState } from "./skillmgr";
import { fileCapabilityHoldup } from "./tools";
import { startAuthServer } from "./authserver";
import { machineId, readRoster, setEnabled } from "./roster";
import { vanishOnRelays } from "./nostrsync";
import { MACHINE_TYPE, agentServedHere, convergeSpaceServing, invalidateServing, publishCapabilities, servesHere } from "./machine";
import { publishDescriptors } from "./descriptors";
import { validateBindings } from "./workspace";
import { startDiscordManager } from "./discord";
import { chatBlocks, frameMessage, ingestIntoChat, ingestedOriginBlocks, isAgentAuthor, pendingMessages, setMark } from "./surfaces";
import { agentSubject, agentThread, convKey, humanRef, parseConvKey, postTo, type ConvRef } from "./conv";
import { deliverOutbox, pendingInbox, recoverInbox } from "./mailbox";
import { migrateExchanges } from "./migrate-exchanges";
import { processInboxMessage } from "./message-turn";
import { receiveCapabilityRequests, setCapabilityRequestOwner } from "./capability-messages";
import { arm as armScheduler, startScheduler } from "./schedule";

function argValue(flagName: string): string {
	const idx = process.argv.indexOf(flagName);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

/**
 * Agents THIS machine serves: local roster ∩ live agent objects, plus any
 * agent assigned here by `served_by` (setup from another client), which
 * joins the roster on sight so the agent page shows it enabled here.
 */
async function servedAgents(): Promise<Set<string>> {
	const roster = new Set(await readRoster());
	const me = await machineId();
	const rows = await queryAll({ type: "agent" });
	const out = new Set<string>();
	for (const r of rows) {
		if (str(r.fields, "spawn_parent")) continue;
		const assigned = str(r.fields, "served_by") === me;
		if (!roster.has(r.id) && !assigned) continue;
		if (!roster.has(r.id)) await setEnabled(r.id, true);
		out.add(r.id);
	}
	return out;
}

/**
 * Backfill `kind` on agents minted before kinds existed: they were all
 * assistants, and the runner's defaults key on the field being present.
 */
async function convergeAgentKinds(): Promise<void> {
	for (const a of await queryAll({ type: "agent" })) {
		if (str(a.fields, "spawn_parent") || str(a.fields, "kind")) continue;
		await setField(a.id, "kind", sv("assistant"));
	}
}

async function setup(): Promise<void> {
	const name = argValue("--name") || "Agent";
	const kindKey = argValue("--kind") || "assistant";
	const kind = AGENT_KINDS.find((k) => k.key === kindKey);
	if (!kind) {
		console.log(`unknown kind "${kindKey}"; kinds: ${AGENT_KINDS.map((k) => k.key).join(", ")}`);
		return;
	}
	const existing = await query({ type: "agent", filters: [{ key: "name", condition: "equal", value: name }] });
	if (existing.length > 0) {
		console.log(`agent "${name}" already exists: ${existing[0].id}`);
		return;
	}
	// Same shape the website's /setup writes: the kind's defaults copied
	// onto the object, this machine pinned as its server, non-secret kind
	// fields as plain strings. Secrets go to the credential store, never here.
	const fields: Record<string, ValueJSON> = {
		kind: sv(kind.key),
		model: sv(argValue("--model") || kind.model),
		served_by: sv(await machineId()),
		requires: lv(kind.requires),
		responsible_types: lv(kind.responsibleTypes),
	};
	if (argValue("--channel")) fields.channel = sv(argValue("--channel"));
	for (const f of kind.fields) {
		if (f.secret) continue;
		const value = argValue(`--${f.key}`) || kind.defaults[f.key];
		if (value) fields[f.key] = sv(value);
	}
	const { id } = await createObject(name, "agent", fields);
	// Setup on this machine claims serving responsibility here — "mine"
	// is a local fact, not a synced one.
	await setEnabled(id, true);
	console.log(`created ${kind.key} agent "${name}": ${id} (enabled on this machine${kind.requires.length ? `; requires ${kind.requires.join(", ")}` : ""})`);
}

interface Served {
	agentId: string;
	/** The agent's own transcript: a thread on the object it is about. */
	conv: ConvRef;
	channelId: string;
	/** Type keys this agent is responsible for; "*" = everything else. Its kind's list when the object has none. */
	types: string[];
	/** Object-bound agents: the one object this agent belongs to. */
	bound: string;
	name: string;
	icon: string;
}

/**
 * Live per-agent turn state, served to the discussion UI via /agent/status
 * so an open conversation can show the agent composing. In memory only: the
 * DAG is the single source of truth for everything that outlives a turn, and
 * this outlives nothing.
 */
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

/**
 * Prepare one agent for serving (chat ensured, channel pinned), or null
 * when this machine does not serve it: per-object serving
 * (docs/object-serving.md) resolves the agent's bound object, else its
 * own row. Null is the stand-down every caller honours.
 */
async function buildServedOne(agentId: string, defaultChannel: string): Promise<Served | null> {
	const agent = await fetchObject(agentId);
	if (str(agent.fields, "external_responder")) return null;
	if (!(await agentServedHere(agent))) {
		console.log(`[harness] standing down for ${str(agent.fields, "name") || agentId.slice(0, 8)} - served by another machine`);
		return null;
	}
	let channelId = str(agent.fields, "channel");
	// A bound agent lives wherever its OBJECT lives: space migrations
	// re-stamp objects, and the agent must follow or it becomes a ghost
	// of a vanished space.
	const boundId = str(agent.fields, "bound_object");
	if (boundId) {
		const obj = await fetchObject(boundId).catch(() => null);
		const objChannel = obj ? str(obj.fields, "channel") : "";
		if (objChannel && objChannel !== channelId) {
			channelId = objChannel;
			await setField(agentId, "channel", sv(objChannel));
		}
	}
	if (!channelId) {
		// Never let an agent float on channel ordering: bind it to the
		// current default PERMANENTLY. (An ordering flip once moved every
		// floating agent - and their chats - into a duplicate channel.)
		channelId = defaultChannel;
		if (channelId) await setField(agentId, "channel", sv(channelId));
	}
	// The transcript lives on the object the agent is about (its bound
	// object, else the agent object itself), so one object carries its work
	// and every conversation about it.
	const conv = await agentThread(agent);
	return {
		agentId,
		conv,
		channelId,
		types: responsibleTypes(agent),
		bound: str(agent.fields, "bound_object"),
		name: str(agent.fields, "name") || agentId.slice(0, 8),
		icon: str(agent.fields, "iconEmoji"),
	};
}

/** The object's own list when set (even empty), else the kind's default. */
function responsibleTypes(agent: ObjectJSON): string[] {
	return agent.fields["responsible_types"] ? list(agent.fields, "responsible_types") : agentKind(str(agent.fields, "kind")).responsibleTypes;
}

/** agentId → Served; rebuilt on roster change. */
async function buildServed(agents: Set<string>): Promise<Map<string, Served>> {
	const out = new Map<string, Served>();
	// Same source + order as the UI: /api/channels, first entry is default.
	const channels = (await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	const defaultChannel = channels[0]?.id ?? "";
	defaultChannelId = defaultChannel;
	for (const agentId of agents) {
		try {
			const one = await buildServedOne(agentId, defaultChannel);
			if (!one) continue; // served elsewhere (logged inside)
			out.set(agentId, one);
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

/** Fetch → pending → advance mark → copy the human's words into the transcript. */
async function ingestSurface(s: Served, origin: ConvRef): Promise<boolean> {
	const lock = convKey(origin);
	if (ingesting.has(lock)) return false;
	ingesting.add(lock);
	try {
		const surface = await fetchObject(origin.objectId);
		// Only a human discussion is a surface. Addressed exchanges have
		// durable processing receipts instead of local discussion watermarks.
		const pending = await pendingMessages(surface, origin, s.agentId);
		if (pending.length === 0) return false;
		await setMark(origin, pending[pending.length - 1].blockId);
		// Idempotence by identity, not marks: a message whose copy is already
		// in the transcript was handled - by this machine before a mark was
		// lost, or by ANOTHER machine whose reply hasn't synced into our view
		// yet (the spirit-dragon double-ingest). Skip it; an empty remainder
		// means no turn at all.
		const transcript = await fetchObject(s.conv.objectId).catch(() => null);
		// No transcript object in view means no idempotence check is possible;
		// ingesting blind is how the double-post happened, so stand down and
		// let the next event retry.
		if (!transcript) return false;
		const copied = ingestedOriginBlocks(transcript, s.conv);
		const fresh = pending.filter((p) => !copied.has(p.blockId));
		if (fresh.length === 0) return false;
		const framed = frameMessage(surface, origin, fresh);
		await ingestIntoChat(s.conv, origin, fresh[fresh.length - 1].author || "user", framed, fresh[fresh.length - 1].blockId);
		return true;
	} finally {
		ingesting.delete(lock);
	}
}

/**
 * Handle a message on one surface: ingest, run the turn on the chat, reply
 * where asked.
 */
async function handleSurface(s: Served, surface: ConvRef): Promise<boolean> {
	if (!(await ingestSurface(s, surface))) return false;
	const reply = await runTurn(s.agentId, s.conv, { spawn: spawnSubagent });
	if (reply.trim()) {
		await postTo(surface, reply.trim(), s.agentId);
	}
	console.log(`[${new Date().toISOString()}] ${s.agentId.slice(0, 8)} answered in ${convKey(surface).slice(0, 26)}: ${reply.slice(0, 120)}`);
	return true;
}

async function serve(): Promise<void> {
	const inboxOwner = `${await machineId()}:${crypto.randomUUID()}`;
	setCapabilityRequestOwner(inboxOwner);
	await publishCapabilities(await capabilities()); // register this machine before serving resolves against the roster
	// Publish what a skill or login IS, as data, so a client can render its
	// setup form without a compiled-in table (docs/descriptors.md).
	await publishDescriptors();
	// And what is TRUE here per skill and login: one row per (thing ×
	// machine), carrying `error` where a view can see it.
	await publishInstallationState();
	await convergeCatalogScope();
	await convergeSpaceServing();
	await convergeAgentKinds();
	const migration = await migrateExchanges({ apply: true });
	console.log("[harness] exchange migration:", JSON.stringify(migration));
	// Checkout bindings: statuses refresh at boot and on every UI write.
	validateBindings().catch((err) => console.error("[harness] binding validation failed:", err?.message ?? err));
	const agents = await servedAgents();
	let served = await buildServed(agents);

	// ── Object-bound agents ─────────────────────────────────────────
	// objectId → its bound agent. Minted ONLY from a human discussion
	// message; agents can never create other minds. Lazily adopted into
	// `served` when their surface first stirs.
	const boundBy = new Map<string, string>();
	// Objects whose bound agent names an external responder: the harness
	// stays silent on their discussion (no serving, no adoption) so the
	// external bot is the only voice. The field travels with the vault,
	// so every machine honors it.
	const externallyAnswered = new Set<string>();
	for (const a of await queryAll({ type: "agent" })) {
		const b = str(a.fields, "bound_object");
		if (!b) continue;
		boundBy.set(b, a.id);
		if (str(a.fields, "external_responder")) externallyAnswered.add(b);
	}
	console.log(`[harness] ${boundBy.size} object-bound agent(s) known`);

	// ── Default space agent: every space served here gets one mind of its
	// own, so "ask the space" works before any object has an agent. Marked
	// space_default = channel id; responsible_types stays empty so it
	// answers its own chat and never steals surfaces from bound agents.
	// Its space_activity tool is how it knows what's new when a human
	// opens the conversation cold. ──
	async function ensureSpaceAgents(): Promise<void> {
		const channels = (await queryAll({ type: "channel" })).map((c) => ({ id: c.id, name: str(c.fields, "name") || "Space" }));
		for (const c of channels) {
			if (!(await servesHere(c.id))) continue;
			let minted = false;
			let id = (await queryAll({ type: "agent", filters: [{ key: "space_default", condition: "equal", value: c.id }] }))[0]?.id;
			if (!id) {
				minted = true;
				const kind = agentKind("assistant");
				id = (
					await createObject(c.name, "agent", {
						channel: sv(c.id),
						space_default: sv(c.id),
						kind: sv(kind.key),
						iconEmoji: sv("🛰️"),
						model: sv(kind.model),
					})
				).id;
				console.log(`[harness] minted default agent for space "${c.name}" → ${id.slice(0, 8)}`);
			}
			if (!agents.has(id)) {
				agents.add(id);
				await setEnabled(id, true);
			}
			if (!served.has(id)) {
				const one = await buildServedOne(id, defaultChannelId);
				if (one) served.set(id, one);
			}
			// The front door used to be a `chat` object pinned in the
			// sidebar. The space's own discussion is that front door now, so
			// there is nothing to pin: a space is already in the sidebar.
		}
	}
	await ensureSpaceAgents();

	/**
	 * Kinds that never get their own mind.
	 *
	 * A machine object is NOT one of them: the resolver answers "self" for
	 * it, so the only harness that can mint or answer is the box the object
	 * describes - which is the point. That is how "install browserless" or
	 * "why did last night's run fail" get answered by the machine that
	 * knows, rather than by whichever agent happened to be nearby.
	 */
	const UNMINTABLE = new Set(["agent", "channel", "relation", "type", "template", "skill", "descriptor", "install", "program", "typescript", "json", "proto", "pinned_fact", "milestone"]);

	/** Only an ordinary human discussion can cause an object agent to be minted. */
	function lastMessageIsHumanIn(obj: ObjectJSON, ref: ConvRef): boolean {
		const msgs = chatBlocks(obj, ref);
		if (msgs.length === 0) return false;
		const last = msgs[msgs.length - 1].block.content.custom?.meta ?? {};
		if (last["origin"]) return false;
		const author = last["author"] ?? "";
		return !isAgentAuthor(author);
	}

	/** Object ids with a mint in flight. Claimed synchronously by the caller,
	 * because the decision to mint and the create that follows are separated
	 * by an await while one human message arrives as several commit events. */
	const minting = new Set<string>();

	async function mintBoundAgent(obj: ObjectJSON, channelId: string): Promise<string> {
		// Ask the DAG before creating. `boundBy` only knows what this process
		// has seen, and another machine can mint for the same object between
		// our check and this call - twin agents on one object then answer
		// every message twice and eventually answer each other.
		const existing = await queryAll({ type: "agent", filters: [{ key: "bound_object", condition: "equal", value: obj.id }] });
		if (existing.length > 0) {
			const keep = existing.map((a) => a.id).sort()[0]; // every device picks the same twin
			boundBy.set(obj.id, keep);
			return keep;
		}
		// Model follows the space's existing agents so quality is uniform.
		const sibling = [...served.values()].find((x) => x.channelId === channelId);
		const model = sibling ? str((await fetchObject(sibling.agentId)).fields, "model") : "";
		const name = str(obj.fields, "name") || obj.typeKey;
		const { id } = await createObject(name, "agent", {
			channel: sv(channelId),
			bound_object: sv(obj.id),
			kind: sv("assistant"),
			iconEmoji: sv(str(obj.fields, "iconEmoji") || "🛰️"),
			model: sv(model || agentKind("assistant").model),
		});
		boundBy.set(obj.id, id);
		// Minting is also an assignment: this machine answers for what it
		// minted, and the agent page shows it enabled here. Required now that
		// the bound path honours the roster - otherwise a freshly minted agent
		// would be served by nobody after the next restart.
		agents.add(id);
		await setEnabled(id, true);
		console.log(`[harness] minted agent for "${name}" (${obj.id.slice(0, 8)}) → ${id.slice(0, 8)}`);
		return id;
	}

	const busy = new Set<string>();
	const active = new Map<string, string>(); // agentId → convKey of the in-flight turn
	const dirty = new Map<string, Set<string>>(); // agentId → convKeys awaiting a turn
	const idleWaiters = new Map<string, Array<() => void>>(); // agentId → scheduled turns waiting for the slot

	// Only work waiting on delivery/processing is kept here; the DAG owns
	// the queue. SSE and reconnect scans repopulate this disposable index.
	const mailboxObjects = new Set<string>();
	const mailboxInFlight = new Set<string>();
	const recoveredObjects = new Set<string>();
	let mailboxScan: Promise<void> | undefined;

	const me = await machineId();

	/**
	 * An agent this machine may take into its roster on first contact: a
	 * bound agent (follows its object), a space default (follows its
	 * space), or one assigned here by `served_by` (setup from any client).
	 */
	function adoptable(agent: ObjectJSON): boolean {
		return !!str(agent.fields, "bound_object") || !!str(agent.fields, "space_default") || str(agent.fields, "served_by") === me;
	}

	async function mailboxAgent(endpoint: { objectId: string; agentId: string }): Promise<Served | null> {
		const agent = await fetchObject(endpoint.agentId);
		if (agent.typeKey !== "agent" || str(agent.fields, "spawn_parent") || str(agent.fields, "external_responder")) return null;
		if (agentSubject(agent) !== endpoint.objectId || !(await agentServedHere(agent))) return null;
		if (!agents.has(agent.id) && !adoptable(agent)) return null;
		if (!agents.has(agent.id)) {
			await setEnabled(agent.id, true);
			agents.add(agent.id);
		}
		const known = served.get(agent.id);
		if (known?.conv.objectId === endpoint.objectId) return known;
		const one = await buildServedOne(agent.id, defaultChannelId);
		if (one) served.set(agent.id, one);
		return one;
	}

	async function driveInbox(s: Served, object: ObjectJSON): Promise<void> {
		if (busy.has(s.agentId) || !(await servesHere(object.id))) return;
		// Another turn may have acquired the slot while serving was checked.
		if (busy.has(s.agentId)) return;
		const entry = pendingInbox(object, s.agentId)[0];
		if (!entry) return;
		await withTurn(s, { objectId: object.id, threadId: entry.threadId }, () =>
			processInboxMessage(s.agentId, s.conv, entry, inboxOwner));
	}

	async function pumpMailbox(objectId: string, snapshot?: ObjectJSON): Promise<void> {
		if (mailboxInFlight.has(objectId)) return;
		mailboxInFlight.add(objectId);
		try {
			let object = snapshot ?? await fetchObject(objectId);
			if (!object.mailbox?.length) { mailboxObjects.delete(objectId); return; }
			const live = object.mailbox.filter((entry) => !entry.message.historical);
			const waiting = live.some((entry) =>
				entry.outgoing && entry.message.recipients.some((recipient) => !entry.deliveries.some((delivery) => delivery.recipient.objectId === recipient.objectId && delivery.status === "delivered")) ||
				entry.incoming && (entry.message.operation || entry.message.recipients.some((recipient) => recipient.objectId === objectId && recipient.agentId)) &&
				["pending", "awaiting_approval", "processing"].includes(entry.processing.status));
			if (!waiting) { mailboxObjects.delete(objectId); return; }
			mailboxObjects.add(objectId);
			// Copying an immutable message is safe on any replica. Only the
			// owning machine may execute its addressed work.
			if (live.some((entry) => entry.outgoing && entry.message.recipients.some((recipient) => !entry.deliveries.some((delivery) => delivery.recipient.objectId === recipient.objectId && delivery.status === "delivered")))) {
				await deliverOutbox(object);
				object = await fetchObject(objectId);
			}
			if (!(await servesHere(objectId))) return;
			// An external responder owns this object's inbox as well: it claims,
			// answers and delivers on its own. Outgoing copies were still pumped
			// above, and a harness restart must not mark its claims interrupted.
			if (externallyAnswered.has(objectId)) return;
			if (object.typeKey === "install") {
				await receiveCapabilityRequests(object, inboxOwner);
				return;
			}
			if (!recoveredObjects.has(objectId)) {
				await recoverInbox(object, inboxOwner);
				recoveredObjects.add(objectId);
				object = await fetchObject(objectId);
			}
			const recipients = new Map<string, { objectId: string; agentId: string }>();
			for (const entry of object.mailbox ?? []) {
				if (!entry.incoming || entry.message.historical || entry.message.operation || entry.processing.status !== "pending") continue;
				for (const endpoint of entry.message.recipients) {
					if (endpoint.objectId === objectId && endpoint.agentId) recipients.set(endpoint.agentId, endpoint);
				}
			}
			for (const endpoint of recipients.values()) {
				const s = await mailboxAgent(endpoint);
				if (s) void driveInbox(s, object).catch((error) => console.error("[harness] inbox turn:", error));
			}
		} catch (error) {
			console.error(`[harness] mailbox ${objectId}:`, error);
		} finally {
			mailboxInFlight.delete(objectId);
		}
	}

	function scanMailboxes(): Promise<void> {
		if (mailboxScan) return mailboxScan;
		mailboxScan = (async () => {
			const objects = await queryAll({});
			for (let offset = 0; offset < objects.length; offset += 8) {
				await Promise.all(objects.slice(offset, offset + 8).map((object) => pumpMailbox(object.id)));
			}
		})().finally(() => { mailboxScan = undefined; });
		return mailboxScan;
	}

	/**
	 * Why the agent cannot run here, or "" when it can: its kind's
	 * `requires` (and its own) name capabilities this machine lacks. The
	 * resolver still says "pinned-uncapable" for it, so the agent stays
	 * ours - it just does not take turns, and the holdup says why: filed
	 * once per distinct reason (the ledger and the installation row are the
	 * places a human looks), mirrored onto the agent's Error badge, and
	 * cleared from the badge the moment the requirement is met.
	 */
	const heldUp = new Map<string, string>(); // agentId → reason last filed
	async function requirementsHoldup(s: Served): Promise<string> {
		const agent = await fetchObject(s.agentId).catch(() => null);
		if (!agent) return "";
		const required = [...new Set([...agentKind(str(agent.fields, "kind")).requires, ...list(agent.fields, "requires")])];
		const have = required.length > 0 ? await capabilities() : [];
		const missing = required.filter((k) => !have.includes(k));
		if (missing.length === 0) {
			if (heldUp.delete(s.agentId) || str(agent.fields, "error").startsWith("needs ")) await deleteField(s.agentId, "error").catch(() => {});
			return "";
		}
		const reason = `needs ${missing.join(", ")}: not active on this machine`;
		if (heldUp.get(s.agentId) !== reason) {
			heldUp.set(s.agentId, reason);
			console.log(`[harness] holding ${s.name} (${s.agentId.slice(0, 8)}): ${reason}`);
			for (const capability of missing) {
				await fileCapabilityHoldup(capability, `${s.name} requires ${capability} to run here`, { agentId: s.agentId, channelId: s.channelId, boundObject: agentSubject(agent), depth: 0, touched: new Set() });
			}
		}
		return reason;
	}

	/**
	 * Hold the agent's turn slot around `body`: status reporting, error
	 * capture, then the drain (chat first, queued surfaces after). Resolves
	 * to the failure message, "" on success - the scheduler records it.
	 * A held-up agent never enters the slot: nothing is ingested, so the
	 * work waits on the surface until the machine can do it.
	 */
	async function withTurn(s: Served, surface: ConvRef, body: () => Promise<unknown>): Promise<string> {
		// Turn state is local: /agents and /agent/status read this map. It used
		// to be mirrored onto the agent object for remote clients, at two or
		// three permanent commits per turn; a local surface answers the same
		// question for free, and only the machine running the turn can answer
		// it truthfully anyway.
		const report = (state: "idle" | "working" | "error", detail = "") => {
			agentTurnStatus.set(s.agentId, { id: s.agentId, name: s.name, icon: s.icon, state, surface: surface.objectId, detail, ts: Date.now() });
		};
		const held = await requirementsHoldup(s);
		if (held) {
			report("error", held);
			return held;
		}
		busy.add(s.agentId);
		active.set(s.agentId, convKey(surface));
		report("working");
		let failure = "";
		try {
			await body();
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
			failure = msg.slice(0, 200);
			report("error", failure);
		} finally {
			busy.delete(s.agentId);
			active.delete(s.agentId);
			// A waiting scheduled turn claims the slot before the drain below
			// yields; whatever the drain then finds pending queues behind it.
			for (const wake of idleWaiters.get(s.agentId) ?? []) wake();
			idleWaiters.delete(s.agentId);
			// Drain: the chat first (its own messages), then queued surfaces.
			const queued = [...(dirty.get(s.agentId) ?? [])];
			dirty.delete(s.agentId);
			// The transcript object's own discussion first (a human may have
			// written there), then whatever queued behind the turn.
			for (const key of [convKey(humanRef(s.conv.objectId)), ...queued]) {
				const ref = parseConvKey(key);
				const surface = await fetchObject(ref.objectId).catch(() => null);
				if (surface && (await pendingMessages(surface, ref, s.agentId)).length > 0) {
					void drive(s, ref);
					break;
				}
			}
			void pumpMailbox(s.conv.objectId);
		}
		return failure;
	}

	async function drive(s: Served, surface: ConvRef): Promise<void> {
		if (!(await servesHere(s.conv.objectId))) return;
		const key = convKey(surface);
		if (busy.has(s.agentId)) {
			if (key === active.get(s.agentId)) {
				// Same-conversation follow-up: fold into the in-flight turn
				// (steer); the runner refetches, so nothing else is needed.
				await ingestSurface(s, surface);
			} else {
				// Another conversation mid-turn: wait for the next turn
				// (bot.odin rule).
				let set = dirty.get(s.agentId);
				if (!set) dirty.set(s.agentId, (set = new Set()));
				set.add(key);
			}
			return;
		}
		await withTurn(s, surface, () => handleSurface(s, surface));
	}

	/** Wait for the agent's turn slot; the holder's drain wakes us before it yields. */
	async function awaitSlot(s: Served): Promise<void> {
		while (busy.has(s.agentId)) {
			const { promise, resolve } = Promise.withResolvers<void>();
			let waiters = idleWaiters.get(s.agentId);
			if (!waiters) idleWaiters.set(s.agentId, (waiters = []));
			waiters.push(resolve);
			await promise;
		}
	}

	/**
	 * A scheduler-started turn on the agent's chat. The framed occurrence is
	 * already posted (origin-tagged, so no watermark path ever ingests it);
	 * this waits for the agent's slot rather than queueing a surface, then
	 * runs one turn. Not human-rooted: no agent_ask.
	 */
	async function driveScheduled(s: Served, systemSuffix: string, requirementsObjectId?: string): Promise<string> {
		await awaitSlot(s);
		return withTurn(s, s.conv, () => runTurn(s.agentId, s.conv, { spawn: spawnSubagent, systemSuffix, requirementsObjectId, a2aTurn: true }));
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
		// A bound agent speaks for its own object, never for the space. When it
		// was the only agent served here, this fallback handed it every new
		// object in the space - so a person's agent answered a fresh task, and
		// the task never got the agent of its own that minting would have given
		// it. Two machines each with a different lone agent then answered the
		// same task, and the pair talked past the human in their own thread.
		if (inChannel.length === 1 && inChannel[0].types.length === 0 && !inChannel[0].bound) return inChannel[0];
		return undefined;
	}

	/** Route an SSE object event to the agent whose surface it is. */
	async function route(objectId: string): Promise<void> {
		await pumpMailbox(objectId);
		// An event on the object that holds an agent's transcript: the human
		// may have written in its discussion.
		for (const s of served.values()) {
			if (objectId === s.conv.objectId) {
				const here = await fetchObject(objectId).catch(() => null);
				const ref = humanRef(objectId);
				if (here && (await pendingMessages(here, ref, s.agentId)).length > 0) void drive(s, ref);
				// The same object can also carry incoming/outgoing envelopes.
			}
		}
		if (agents.has(objectId)) {
			// Responsibility edits sync through the agent object — keep the
			// served entry current without a roster round-trip.
			const s = served.get(objectId);
			if (s) {
				const agent = await fetchObject(objectId).catch(() => null);
				if (agent) s.types = responsibleTypes(agent);
			}
			return; // agent objects are not surfaces
		}
		// Any agent object event (incl. one minted on another machine)
		// keeps the bound index current - and an agent assigned here by
		// `served_by` (a /setup from any client) is adopted on sight, so
		// its first message needs no restart.
		if (!agents.has(objectId)) {
			const maybe = await fetchObject(objectId).catch(() => null);
			if (maybe?.typeKey === "agent") {
				const b = str(maybe.fields, "bound_object");
				if (b) boundBy.set(b, objectId);
				if (!b && !str(maybe.fields, "spawn_parent") && str(maybe.fields, "served_by") === me) {
					agents.add(objectId);
					await setEnabled(objectId, true);
					const one = await buildServedOne(objectId, defaultChannelId).catch((err) => {
						console.error(`[harness] failed to adopt assigned agent ${objectId.slice(0, 8)}:`, err);
						return null;
					});
					if (one) {
						served.set(objectId, one);
						console.log(`[harness] adopted ${one.name} (${objectId.slice(0, 8)}) - assigned to this machine`);
						void publishSystemSnapshot(one.agentId, one.conv);
						void drive(one, humanRef(one.conv.objectId));
					}
				}
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
		if (obj.typeKey === "channel") {
			// served_by edits (takeovers) and brand-new spaces sync as channel
			// commits: refresh the gate now, stamp unclaimed spaces.
			invalidateServing();
			// A daemon blip (ECONNRESET mid-restart) must not kill the harness -
			// the next channel event or boot reconcile converges again.
			// The scheduler follows the gate: a space handed over moves its
			// occurrences to the new server.
			convergeSpaceServing()
				.catch((err) => console.error("[harness] converge failed:", err?.message ?? err))
				.then(armScheduler);
			return;
		}
		// A rule edit (repeat_set/clear, an occurrence completed or fired)
		// may move the earliest occurrence.
		if (obj.fields["repeat"]) void armScheduler();
		// Serving inputs changed: capabilities on a machine object, a pin
		// (served_by) or requires on any object. Refresh the resolver cache
		// and re-arm, so the next event and the clock follow the new answer.
		if (obj.typeKey === MACHINE_TYPE || obj.fields["served_by"] || obj.fields["requires"]) {
			invalidateServing();
			void armScheduler();
		}
		if (obj.typeKey === "agent") return; // other agents' brains
		const channelId = objectId === defaultChannelId || obj.typeKey === "channel" ? objectId : str(obj.fields, "channel") || defaultChannelId;

		// ── Bound agent takes its own object's surface - if it is ours. ──
		const boundAgent = boundBy.get(objectId);
		if (boundAgent && externallyAnswered.has(objectId)) return;
		if (boundAgent) {
			// The object's server answers, nobody else - per-object serving
			// replaces per-agent adoption races with one synced fact.
			if (!(await servesHere(objectId))) return;
			// Serving the space means serving ALL its bound agents: a takeover
			// adopts them into the local roster on first contact, so transfer
			// needs no per-agent toggling.
			if (!agents.has(boundAgent)) {
				agents.add(boundAgent);
				await setEnabled(boundAgent, true);
				console.log(`[harness] adopted bound agent ${boundAgent.slice(0, 8)} - this machine serves its object`);
			}
			let s2 = served.get(boundAgent);
			if (!s2) {
				try {
					const built = await buildServedOne(boundAgent, defaultChannelId);
					if (!built) return;
					s2 = built;
					served.set(boundAgent, s2);
				} catch (err) {
					console.error(`[harness] failed to adopt bound agent ${boundAgent.slice(0, 8)}:`, err);
					return;
				}
			}
			const pending2 = await pendingMessages(obj, humanRef(obj.id), s2.agentId);
			if (pending2.length > 0) void drive(s2, humanRef(obj.id));
			return;
		}

		// ── Explicitly responsible space agent answers, as before. ──
		const s = responsibleFor(channelId, obj.typeKey);
		if (s && !(await servesHere(s.bound || s.agentId))) return;
		if (s) {
			const pending = await pendingMessages(obj, humanRef(obj.id), s.agentId);
			if (pending.length > 0) void drive(s, humanRef(obj.id));
			return;
		}

		// ── Nobody claims it: a HUMAN message on a discussable object
		// mints the object's own agent and serves this very message. ──
		if (UNMINTABLE.has(obj.typeKey)) return;
		// Only the object's server mints - other machines stay silent, so
		// a brand-new object gets exactly one agent.
		if (!(await servesHere(objectId))) return;
		// A stub read (no type) would mint a nameless agent stamped to the
		// default space instead of the object's own - and a bound agent in
		// the wrong space cannot even read the object it speaks for.
		if (!obj.typeKey) return;
		if (!lastMessageIsHumanIn(obj, humanRef(obj.id))) return;
		// Claim the object before the first await: one message arrives as
		// several events, and every one of them reaches this line.
		if (minting.has(objectId)) return;
		minting.add(objectId);
		try {
			const minted = await mintBoundAgent(obj, channelId);
			const s3 = served.get(minted) ?? (await buildServedOne(minted, defaultChannelId));
			if (!s3) return;
			served.set(minted, s3);
			void publishSystemSnapshot(s3.agentId, s3.conv);
			const pending3 = await pendingMessages(obj, humanRef(obj.id), s3.agentId);
			if (pending3.length > 0) void drive(s3, humanRef(obj.id));
		} finally {
			minting.delete(objectId);
		}
	}

	startAuthServer(agents, (next) => {
		agents.clear();
		for (const id of next) agents.add(id);
		void buildServed(agents).then((next) => {
			served = next;
			for (const s of served.values()) {
				void publishSystemSnapshot(s.agentId, s.conv);
				// Only if the chat is actually waiting on us. An unconditional
				// turn here made enabling an agent start one, and a message
				// arriving during that turn gets folded into it by drive's
				// steer branch - which ingested it a second time and drew a
				// second answer. Every other drive call site checks first.
				void (async () => {
					const chat = await fetchObject(s.conv.objectId).catch(() => null);
					if (!chat) return;
					if ((await pendingMessages(chat, humanRef(s.conv.objectId), s.agentId)).length > 0) void drive(s, humanRef(s.conv.objectId));
					void pumpMailbox(chat.id, chat);
				})();
			}
		});
	});
	console.log(`[harness] serving ${agents.size} agent(s): ${[...agents].map((a) => a.slice(0, 8)).join(", ") || "(none — enable one from an agent page)"}`);

	// Catch up on chat messages that arrived while the harness was down.
	// (Origin surfaces catch up on their next event.)
	// Publishing the prompt here rather than only mid-turn is what lets a
	// never-messaged agent show a real prompt instead of an empty panel.
	for (const s of served.values()) {
		void publishSystemSnapshot(s.agentId, s.conv);
		void drive(s, humanRef(s.conv.objectId));
	}
	subscribe((objectId) => void route(objectId), () => {
		void scanMailboxes().catch((error) => console.error("[harness] mailbox catch-up:", error));
	});
	setInterval(() => {
		for (const id of mailboxObjects) void pumpMailbox(id);
	}, 5_000);
	await scanMailboxes();
	console.log("[harness] SSE connected; serving.");

	// The clock: fires occurrences due now (missed while down) and arms for
	// the next. Only for spaces this machine serves - the gate is inside.
	await startScheduler({
		async served(agentId) {
			const known = served.get(agentId);
			if (known) return known;
			// An agent not in the local roster (a bound agent nobody has
			// spoken to since boot) still answers its own schedule where its
			// object resolves; buildServedOne stands down otherwise.
			const agent = await fetchObject(agentId).catch(() => null);
			if (!agent || agent.typeKey !== "agent" || str(agent.fields, "spawn_parent")) return undefined;
			const one = await buildServedOne(agentId, defaultChannelId);
			if (!one) return undefined;
			served.set(agentId, one);
			return one;
		},
		turn(agentId, systemSuffix, requirementsObjectId) {
			const s = served.get(agentId);
			if (!s) return Promise.resolve("agent no longer served on this machine");
			return driveScheduled(s, systemSuffix, requirementsObjectId);
		},
	});

	// Discord channels are surfaces too: one poller per served agent whose
	// kind talks to Discord, following `served` as agents come and go. The
	// turn goes through withTurn, so a held-up agent answers nothing and
	// the failure text is what the channel sees.
	startDiscordManager({
		served: () => [...served.values()].map((s) => ({ agentId: s.agentId, objectId: s.conv.objectId })),
		async turn(agentId, ref) {
			const s = served.get(agentId);
			if (!s) return "agent no longer served on this machine";
			await awaitSlot(s);
			return withTurn(s, ref, () => runTurn(s.agentId, ref, { spawn: spawnSubagent }));
		},
	});
}

async function ask(): Promise<void> {
	const agentId = process.argv[3];
	const text = process.argv[4];
	if (!agentId || !text) {
		console.error("usage: ask <agentId> <message>");
		process.exit(1);
	}
	const agent = await fetchObject(agentId);
	const channels = (await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
	const conv = await agentThread(agent);
	await postTo(conv, text);
	const reply = await runTurn(agentId, conv, { spawn: spawnSubagent });
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
	console.log("commands: setup --name X [--kind assistant|marco] [--model m] [--channel id] [--<kind field> v] | serve | ask <agentId> <msg> | vanish <objectId…>|--trash [--yes]");
}
