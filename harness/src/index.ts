/**
 * Roostr harness daemon. Each agent's private work stays on its owning
 * object. Human discussions feed that transcript; addressed exchanges use
 * durable inbox/outbox copies on every participant's own object DAG.
 * Delivery retries independently of agent execution and machine liveness.
 *
 *   bun run src/index.ts setup --name Gracie [--kind <kind key, e.g. assistant>] [--channel id] [--<field> value…]
 *   bun run src/index.ts serve
 *   bun run src/index.ts ask <agentId> "message"
 *   bun run src/index.ts vanish <objectId…> | --trash   [--yes]
 */

// First: private extensions (harness/private/) register their seeds before anything reads them.
import "./extensions";
import { API, VANISH_LOG_ID, apiFetch, chatPost, deleteField, fetchObject, guestAgents, mutate, query, setField, str, subscribe, sv, createObject, queryAll, vanishedEntries, wasDeleted } from "./api";
import { TEMPLATE_OWN, kindTemplates, seedCatalog } from "./catalog-seeds";
import { PROMPT_SEEDS } from "./prompts";
import type { ObjectJSON, ValueJSON } from "./api";
import { publishSystemSnapshot, runTurn } from "./runner";
import { spawnSubagent } from "./spawn";
import { migrateLoginInstalls, refreshCredentials, CREDENTIAL_TYPE } from "./credential-objects";
import { installGwsAs } from "./google-credentials";
import { fillCredential, seedCredentials } from "./credential-seeds";
import { seedJev } from "./jev";
import { seedGuide } from "./guide";
import { capabilities } from "./skillmgr";
import { fileCapabilityHoldup } from "./tool-harness";
import { startAuthServer } from "./authserver";
import { FILE_TYPE, startFilePeer } from "./files";
import { KEEP_ALL_SWEEP_MS, keepAllFiles } from "./keep-files";
import { holdSingleInstance } from "./single-instance";
import { machineId, readRoster, setEnabled } from "./roster";
import { vanishOnRelays } from "./nostrsync";
import { MACHINE_TYPE, agentRunsOn, agentServedHere, invalidateServing, publishMachine, seedComputerProperties, serverOf, servesHere } from "./machine";
import { CAPABILITY_TYPE } from "./capabilities";
import { SKILLS_KEY, machineSkillKeys } from "./skills";
import { TOOLS_KEY, ensureBuiltinTools, ensureBuiltinToolsEverywhere, linkList } from "./tool-objects";
import { migrateToolGrants } from "./migrate-tool-grants";
import { migrateSkills } from "./migrate-skills";
import { migrateCapabilities } from "./migrate-capabilities";
import { migratePrompts } from "./migrate-prompts";
import { startDiscordManager } from "./discord";
import { answersGuestQuestion, chatBlocks, frameMessage, ingestIntoChat, ingestedOriginBlocks, mentions, pendingMessages, setMark } from "./surfaces";
import { agentSubject, agentThread, agentThreadOn, convKey, humanRef, parseConvKey, postTo, type ConvRef } from "./conv";
import { deliverOutbox, pendingInbox, recoverInbox } from "./mailbox";
import { migrateExchanges } from "./migrate-exchanges";
import { migrateAgentLists, migrateBoundAgents, migrateSpaceComputers, migrateSpaceDefaults } from "./migrate-bound";
import { processInboxMessage } from "./message-turn";
import { receiveCapabilityRequests, setCapabilityRequestOwner } from "./capability-messages";
import { arm as armScheduler, handleRunRequest, RUN_REQUEST_KEY, startScheduler } from "./schedule";
import { startGmailPush } from "./gmail-push";
import { badgeSignedOut, takeCredentialIssues } from "./credential-issues";

function argValue(flagName: string): string {
	const idx = process.argv.indexOf(flagName);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

/**
 * Agents THIS machine serves: every live top-level agent whose `served_by`
 * names it. The local roster mirrors that set; it never adds an agent on
 * its own - an agent with no Served by runs nowhere.
 */
async function servedAgents(): Promise<Set<string>> {
	const roster = new Set(await readRoster());
	const me = await machineId();
	const out = new Set<string>();
	for (const r of await queryAll({ type: "agent" })) {
		if (str(r.fields, "spawn_parent") || str(r.fields, "served_by") !== me) continue;
		if (!roster.has(r.id)) await setEnabled(r.id, true);
		out.add(r.id);
	}
	for (const id of roster) if (!out.has(id)) await setEnabled(id, false);
	return out;
}

/** setup's own flags; every other `--<field> value` sets that field on the agent. */
const SETUP_FLAGS: Record<string, true> = { name: true, kind: true, channel: true };

async function setup(): Promise<void> {
	const name = argValue("--name") || "Agent";
	const kindKey = argValue("--kind") || "assistant";
	const existing = await query({ type: "agent", filters: [{ key: "name", condition: "equal", value: name }] });
	if (existing.length > 0) {
		console.log(`agent "${name}" already exists: ${existing[0].id}`);
		return;
	}
	// No --channel = the default space, where serving binds it.
	const space = argValue("--channel") || ((await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>)[0]?.id || "";
	if (!space) {
		console.log("no space to create the agent in");
		return;
	}
	// The kind is the space's agent Template seeded from it (seeded here too:
	// setup may run before this vault was ever served), applied like the
	// website applies a template: every field but the template's own.
	await seedCatalog();
	const templates = await queryAll({ type: "template" });
	const template = kindTemplates(templates, kindKey, space)[0];
	if (!template) {
		const kinds = [...new Set(templates.filter((t) => str(t.fields, "channel") === space).map((t) => str(t.fields, "seed_key")).filter(Boolean))];
		console.log(`no "${kindKey}" agent template in space ${space.slice(0, 8)}; kinds: ${kinds.join(", ")}`);
		return;
	}
	const fields: Record<string, ValueJSON> = {};
	for (const [key, value] of Object.entries(template.fields)) if (!TEMPLATE_OWN[key]) fields[key] = value;
	fields.channel = sv(space);
	fields.served_by = sv(await machineId());
	// A normal agent can run commands and fetch the web: list both built-ins
	// in its Tools (its space's Tool objects).
	const builtins = await ensureBuiltinTools(space);
	fields[TOOLS_KEY] = linkList(TOOLS_KEY, ["shell_exec", "web_fetch"].flatMap((tool) => builtins.get(tool) ?? []));
	// Flags override the template: --model, a kind's settings, any field.
	const args = process.argv.slice(process.argv.indexOf("setup") + 1);
	for (let i = 0; i < args.length - 1; i++) {
		const key = args[i].startsWith("--") ? args[i].slice(2) : "";
		if (!key || SETUP_FLAGS[key]) continue;
		fields[key] = sv(args[i + 1]);
		i++;
	}
	const { id } = await createObject(name, "agent", fields);
	// Setup on this machine claims serving responsibility here — "mine"
	// is a local fact, not a synced one.
	await setEnabled(id, true);
	console.log(`created ${kindKey} agent "${name}": ${id} from template "${str(template.fields, "name") || template.id.slice(0, 8)}" (enabled on this machine)`);
}

interface Served {
	agentId: string;
	/** The agent's home transcript on its own object. Turns on objects that name it run on those objects. */
	conv: ConvRef;
	channelId: string;
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
 * Prepare one agent for serving (transcript claimed, channel pinned), or
 * null when this machine does not serve it (per-object serving,
 * docs/object-serving.md) - the stand-down every caller honours.
 * `forObject`: the agent is wanted because this machine serves an object
 * that names it (`object.agent`), so the object's server answers even when
 * the agent's own page is served elsewhere.
 */
async function buildServedOne(agentId: string, defaultChannel: string, forObject = false): Promise<Served | null> {
	const agent = await fetchObject(agentId);
	if (str(agent.fields, "external_responder")) return null;
	if (!forObject && !(await agentServedHere(agent))) {
		console.log(`[harness] standing down for ${str(agent.fields, "name") || agentId.slice(0, 8)} - served by another machine`);
		return null;
	}
	let channelId = str(agent.fields, "channel");
	if (!channelId) {
		// Never let an agent float on channel ordering: bind it to the
		// current default PERMANENTLY. (An ordering flip once moved every
		// floating agent - and their chats - into a duplicate channel.)
		channelId = defaultChannel;
		if (channelId) await setField(agentId, "channel", sv(channelId));
	}
	// This computer now serves an agent of this space: its built-ins as Tool objects there (once per process).
	if (channelId) void ensureBuiltinTools(channelId).catch((err) => console.error(`[tools] built-in Tool objects for ${channelId.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
	const conv = await agentThread(agent);
	return {
		agentId,
		conv,
		channelId,
		name: str(agent.fields, "name") || agentId.slice(0, 8),
		icon: str(agent.fields, "iconEmoji"),
	};
}

/**
 * The transcript a turn on `surface` runs in: on the object itself when it
 * names this agent (`object.agent`), so one object carries its work and every
 * conversation about it; else the agent's home.
 */
async function transcriptFor(s: Served, surface: ObjectJSON): Promise<ConvRef> {
	if (!guestAgents(surface.fields).includes(s.agentId)) return s.conv;
	return agentThreadOn(await fetchObject(s.agentId), surface.id);
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

/**
 * The name an agent answers to on `ref`: on an object it is a guest of,
 * only messages @-mentioning it are its; on its own page, none needed.
 * Read fresh, so a renamed agent answers to its new name.
 */
async function addressedAs(s: Served, ref: ConvRef): Promise<string | undefined> {
	if (ref.objectId === s.agentId) return undefined;
	const agent = await fetchObject(s.agentId).catch(() => null);
	return (agent && str(agent.fields, "name")) || s.name;
}

/** Fetch → pending → advance mark → copy the human's words into the transcript. Returns the transcript to run the turn in, or null when nothing was ingested. */
async function ingestSurface(s: Served, origin: ConvRef): Promise<ConvRef | null> {
	const lock = convKey(origin);
	if (ingesting.has(lock)) return null;
	ingesting.add(lock);
	try {
		const surface = await fetchObject(origin.objectId);
		// Only a human discussion is a surface. Addressed exchanges have
		// durable processing receipts instead of local discussion watermarks.
		const pending = await pendingMessages(surface, origin, s.agentId, await addressedAs(s, origin));
		if (pending.length === 0) return null;
		await setMark(origin, pending[pending.length - 1].blockId);
		// Idempotence by identity, not marks: a message whose copy is already
		// in the transcript was handled - by this machine before a mark was
		// lost, or by ANOTHER machine whose reply hasn't synced into our view
		// yet (the spirit-dragon double-ingest). Skip it; an empty remainder
		// means no turn at all.
		const conv = await transcriptFor(s, surface);
		const transcript = conv.objectId === surface.id ? surface : await fetchObject(conv.objectId).catch(() => null);
		// No transcript object in view means no idempotence check is possible;
		// ingesting blind is how the double-post happened, so stand down and
		// let the next event retry.
		if (!transcript) return null;
		const copied = ingestedOriginBlocks(transcript, conv);
		const fresh = pending.filter((p) => !copied.has(p.blockId));
		if (fresh.length === 0) return null;
		const framed = frameMessage(surface, origin, fresh);
		await ingestIntoChat(conv, origin, fresh[fresh.length - 1].author || "user", framed, fresh[fresh.length - 1].blockId);
		return conv;
	} finally {
		ingesting.delete(lock);
	}
}

/**
 * Handle a message on one surface: ingest, run the turn on the chat, reply
 * where asked.
 */
async function handleSurface(s: Served, surface: ConvRef): Promise<boolean> {
	const conv = await ingestSurface(s, surface);
	if (!conv) return false;
	const reply = await runTurn(s.agentId, conv, { spawn: spawnSubagent });
	if (reply.trim()) {
		await postTo(surface, reply.trim(), s.agentId);
	}
	console.log(`[${new Date().toISOString()}] ${s.agentId.slice(0, 8)} answered in ${convKey(surface).slice(0, 26)}: ${reply.slice(0, 120)}`);
	return true;
}

async function serve(): Promise<void> {
	// First, before any boot work: a second copy would answer every agent twice.
	await holdSingleInstance("harness");
	const inboxOwner = `${await machineId()}:${crypto.randomUUID()}`;
	setCapabilityRequestOwner(inboxOwner);
	await publishMachine(); // register this machine before serving resolves against the roster
	installGwsAs();
	// Service logins are Credential objects: move this machine's old login
	// rows over once, then check the credentials this machine looks after.
	console.log("[harness] login migration:", JSON.stringify(await migrateLoginInstalls()));
	// install rows and machine.capabilities fold into capability objects, one
	// per (key x machine); after the login migration has read its rows.
	console.log("[harness] capability migration:", JSON.stringify(await migrateCapabilities()));
	// A Skill object per catalog key and the agent-kind Templates per space.
	await seedCatalog();
	// The Roostr Guide (docs/roostr-guide.md) as a Skill every agent can read.
	console.log("[harness] roostr guide:", await seedGuide());
	// Service presets become Credential templates, and credentials carry their
	// own recipe - before the check below reads those recipes.
	console.log("[harness] credential seeds:", JSON.stringify(await seedCredentials()));
	await refreshCredentials();
	// The Computer page's "Keep every file" and "Starts automatically" checkboxes, in every space with computers.
	console.log("[harness] computer properties:", JSON.stringify({ seeded: await seedComputerProperties() }));
	// Jev Skills' Answer / Writes to properties in every space; the retired Judge type and properties removed.
	console.log("[harness] jev seeds:", JSON.stringify(await seedJev()));
	const migration = await migrateExchanges({ apply: true });
	console.log("[harness] exchange migration:", JSON.stringify(migration));
	// bound_object -> object.agent, after the exchange migration has read
	// the legacy field for the last time.
	console.log("[harness] bound-agent migration:", JSON.stringify(await migrateBoundAgents()));
	console.log("[harness] agent-list migration:", JSON.stringify(await migrateAgentLists()));
	// space_default -> the space's own guest list; spaces no longer imply a mind.
	console.log("[harness] space-default migration:", JSON.stringify(await migrateSpaceDefaults()));
	// channel served_by -> each agent's own pin; spaces no longer serve, and
	// their checkout bindings give way to the agent's Project folder.
	console.log("[harness] space-computer migration:", JSON.stringify(await migrateSpaceComputers()));
	// agent.kind -> a linked system_prompt object.
	console.log("[harness] prompt migration:", JSON.stringify(await migratePrompts()));
	// requires (capability links) and prompt skills -> each object's Skills;
	// after the login migration so a required login becomes a Credential link.
	console.log("[harness] skills migration:", JSON.stringify(await migrateSkills()));
	// Shell and web moved from the 'shell'/'web' skills to each agent's Tools.
	console.log("[harness] tool-grant migration:", JSON.stringify(await migrateToolGrants()));
	void ensureBuiltinToolsEverywhere();
	const agents = await servedAgents();
	let served = await buildServed(agents);

	// `no machine serves this agent` is the engine's own error on an agent
	// with no served_by (core/agent_serving.odin); markRunError leaves it be.
	const RUN_FAILED = "run failed: ";

	/**
	 * A failed turn names its reason on the agent's Error property ("run
	 * failed: <provider message>"); the next successful turn clears it. Only
	 * this badge is ours: holdup and unserved errors are never touched, and
	 * the badge write can never fail the turn it reports on.
	 */
	async function markRunError(agentId: string, failure: string): Promise<void> {
		try {
			const current = str((await fetchObject(agentId)).fields, "error");
			const ours = current.startsWith(RUN_FAILED);
			if (failure) {
				const next = (RUN_FAILED + failure).slice(0, 300);
				if ((!current || ours) && current !== next) await setField(agentId, "error", sv(next));
			} else if (ours) {
				await deleteField(agentId, "error");
			}
		} catch (err) {
			console.error(`[harness] run error badge failed for ${agentId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}

	// ── External responders ─────────────────────────────────────────
	// Agents another bot answers for: the harness stays silent on every
	// object that names one (`object.agent`) - no serving, no adoption - so
	// the external bot is the only voice. The field travels with the vault,
	// so every machine honors it. Kept current from agent object events.
	const externalAgents = new Set<string>();
	// agentId → its `served_by` as last seen: an agent's pin serves every
	// object naming it, so a pin edit is a serving change (`notePin`).
	const agentPins = new Map<string, string>();
	for (const a of await queryAll({ type: "agent" })) {
		if (str(a.fields, "external_responder")) externalAgents.add(a.id);
		agentPins.set(a.id, str(a.fields, "served_by"));
	}
	const externallyAnswered = (obj: ObjectJSON): boolean => guestAgents(obj.fields).some((id) => externalAgents.has(id));
	console.log(`[harness] ${externalAgents.size} externally answered agent(s) known`);

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
	 * An agent this machine may take into its roster on first contact: one
	 * assigned here by `served_by` (setup from any client). Agents named by
	 * objects served here are adopted per object instead (`adoptForObject`).
	 */
	function adoptable(agent: ObjectJSON): boolean {
		return str(agent.fields, "served_by") === me;
	}

	/**
	 * Does THIS machine run `agent` on `object`? Exactly one machine answers:
	 * the agent's own `served_by` (`agentRunsOn`), on every object - except
	 * a computer or capability object, whose work stays on that computer.
	 * An unpinned agent runs nowhere. Every machine evaluates the same DAG
	 * state, so two harnesses never both answer one message. Pin swaps take
	 * effect on the next event: served_by commits invalidate the cache.
	 */
	async function runsAgentHere(objectId: string, agentId: string): Promise<boolean> {
		const [serving, agent] = await Promise.all([serverOf(objectId), fetchObject(agentId).catch(() => null)]);
		return agentRunsOn(serving, agent ? str(agent.fields, "served_by") : "") === me;
	}

	/**
	 * An agent's `served_by` edit moves every object that follows its pin:
	 * refresh the resolver and re-arm the clock (occurrences follow the pin).
	 * The engine keeps the agent's unserved error in step with the pin.
	 */
	function notePin(agent: ObjectJSON): void {
		const pin = str(agent.fields, "served_by");
		if (agentPins.get(agent.id) === pin) return;
		agentPins.set(agent.id, pin);
		invalidateServing();
		void armScheduler();
	}

	/**
	 * One agent on an object's guest list (`object.agent`), served here
	 * because this machine runs it on the object - adopted into the local
	 * roster on first contact, so it needs no per-agent toggling. Null when
	 * the pointer is dangling or another bot answers for the agent.
	 */
	async function adoptForObject(obj: ObjectJSON, aid: string): Promise<Served | null> {
		if (!aid || !guestAgents(obj.fields).includes(aid) || externalAgents.has(aid)) return null;
		// Only the computer that runs the agent here takes it in.
		if (!(await runsAgentHere(obj.id, aid))) return null;
		const known = served.get(aid);
		if (known) return known;
		const agent = await fetchObject(aid).catch(() => null);
		if (agent?.typeKey !== "agent") return null;
		if (!agents.has(aid)) {
			agents.add(aid);
			await setEnabled(aid, true);
			console.log(`[harness] adopted ${str(agent.fields, "name") || aid.slice(0, 8)} (${aid.slice(0, 8)}) - this machine serves "${str(obj.fields, "name") || obj.id.slice(0, 8)}"`);
		}
		try {
			const one = await buildServedOne(aid, defaultChannelId, true);
			if (one) served.set(aid, one);
			return one;
		} catch (err) {
			console.error(`[harness] failed to adopt agent ${aid.slice(0, 8)} for ${obj.id.slice(0, 8)}:`, err);
			return null;
		}
	}

	/** The agent behind a mailbox endpoint: the agent's home, or an object that names it. */
	async function mailboxAgent(object: ObjectJSON, endpoint: { objectId: string; agentId: string }): Promise<Served | null> {
		if (guestAgents(object.fields).includes(endpoint.agentId)) return adoptForObject(object, endpoint.agentId);
		const agent = await fetchObject(endpoint.agentId);
		if (agent.typeKey !== "agent" || str(agent.fields, "spawn_parent") || str(agent.fields, "external_responder")) return null;
		if (agentSubject(agent) !== endpoint.objectId || !(await agentServedHere(agent))) return null;
		if (!agents.has(agent.id) && !adoptable(agent)) return null;
		if (!agents.has(agent.id)) {
			await setEnabled(agent.id, true);
			agents.add(agent.id);
		}
		const known = served.get(agent.id);
		if (known) return known;
		const one = await buildServedOne(agent.id, defaultChannelId);
		if (one) served.set(agent.id, one);
		return one;
	}

	async function driveInbox(s: Served, object: ObjectJSON): Promise<void> {
		if (busy.has(s.agentId) || !(await runsAgentHere(object.id, s.agentId))) return;
		// Another turn may have acquired the slot while serving was checked.
		if (busy.has(s.agentId)) return;
		const entry = pendingInbox(object, s.agentId)[0];
		if (!entry) return;
		const conv = await transcriptFor(s, object);
		await withTurn(s, { objectId: object.id, threadId: entry.threadId }, () =>
			processInboxMessage(s.agentId, conv, entry, inboxOwner));
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
			// Gate per recipient, not per object: an agent pinned to this
			// machine answers even on an object that follows another guest's
			// pin, while an object placed on purpose runs every recipient on
			// its server. Recover only when this machine serves the object itself.
			const objectServedHere = await servesHere(objectId);
			if (objectServedHere) {
				// An external responder owns this object's inbox as well: it claims,
				// answers and delivers on its own. Outgoing copies were still pumped
				// above, and a harness restart must not mark its claims interrupted.
				if (externallyAnswered(object)) return;
				if (object.typeKey === CAPABILITY_TYPE) {
					await receiveCapabilityRequests(object, inboxOwner);
					return;
				}
				if (!recoveredObjects.has(objectId)) {
					await recoverInbox(object, inboxOwner);
					recoveredObjects.add(objectId);
					object = await fetchObject(objectId);
				}
			}
			const recipients = new Map<string, { objectId: string; agentId: string }>();
			for (const entry of object.mailbox ?? []) {
				if (!entry.incoming || entry.message.historical || entry.message.operation || (entry.processing.status !== "pending" && entry.processing.status !== "held")) continue;
				for (const endpoint of entry.message.recipients) {
					if (endpoint.objectId === objectId && endpoint.agentId) recipients.set(endpoint.agentId, endpoint);
				}
			}
			for (const endpoint of recipients.values()) {
				const s = await mailboxAgent(object, endpoint);
				if (s) void driveInbox(s, object).catch((error) => console.error("[harness] inbox turn:", error));
			}
		} catch (error) {
			console.error(`[harness] mailbox ${objectId}:`, error);
		} finally {
			// Always release: an early return (no mailbox, not waiting, served
			// elsewhere) used to leave the id set, so no event or rescan ever
			// pumped this object again - a fresh envelope stalled until restart.
			mailboxInFlight.delete(objectId);
		}
	}

	function scanMailboxes(): Promise<void> {
		if (mailboxScan) return mailboxScan;
		mailboxScan = (async () => {
			const objects = await queryAll({});
			for (let offset = 0; offset < objects.length; offset += 8) {
				// One hung or failing pump must not stall the scan (or, via the
				// mailboxScan guard, every later scan). Bound each and keep going.
				await Promise.all(objects.slice(offset, offset + 8).map((object) =>
					Promise.race([
						pumpMailbox(object.id),
						new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
					]).catch((error) => console.error(`[harness] mailbox ${object.id.slice(0, 8)}:`, error)),
				));
			}
		})().finally(() => { mailboxScan = undefined; });
		return mailboxScan;
	}

	/**
	 * Why the agent cannot run here, or "" when it can: its Skills name
	 * catalog software this machine does not have working. The
	 * resolver still says "pinned-uncapable" for it, so the agent stays
	 * ours - it just does not take turns, and the holdup says why: filed
	 * once per distinct reason (the ledger and the capability object are the
	 * places a human looks), mirrored onto the agent's Error badge, and
	 * cleared from the badge the moment the requirement is met.
	 */
	const heldUp = new Map<string, string>(); // agentId → reason last filed
	async function requirementsHoldup(s: Served): Promise<string> {
		const agent = await fetchObject(s.agentId).catch(() => null);
		if (!agent) return "";
		const required = await machineSkillKeys(agent.fields);
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
				await fileCapabilityHoldup(capability, `${s.name} uses the ${capability} skill, which is not working here`, { agentId: s.agentId, channelId: s.channelId, boundObject: agentSubject(agent), depth: 0, touched: new Set() });
			}
		}
		return reason;
	}

	/**
	 * A held turn still owes the reader its reason: stamp it on the pending
	 * inbox entry's processing receipt (stays pending - the work runs when
	 * the requirement heals and a claim overwrites the receipt).
	 */
	async function holdInboxEntry(surface: ConvRef, agentId: string, reason: string): Promise<void> {
		const object = await fetchObject(surface.objectId).catch(() => null);
		const entry = object ? pendingInbox(object, agentId)[0] : undefined;
		if (!entry) return;
		await mutate("message_processing", { object_id: surface.objectId, message_id: entry.message.id, status: "held", owner: "", error: reason }).catch(() => {});
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
			await holdInboxEntry(surface, s.agentId, held);
			return held;
		}
		busy.add(s.agentId);
		active.set(s.agentId, convKey(surface));
		// What the agent last really did: a turn that finds nothing to answer
		// must not paint over it - an unanswered failure would vanish from the
		// chat and the agent's Error the moment any event re-checked a surface.
		const before = agentTurnStatus.get(s.agentId);
		report("working");
		let failure = "";
		try {
			const ran = await body();
			if (ran === false) {
				if (before) agentTurnStatus.set(s.agentId, before);
				else report("idle");
			} else {
				report("idle");
				await markRunError(s.agentId, "");
			}
		} catch (err) {
			// Its object or space was deleted mid-turn: one quiet line, and no badge on an agent that may be gone.
			const deleted = wasDeleted(err);
			if (deleted) console.log(`[harness] turn for ${s.agentId.slice(0, 8)} stopped: ${err.message}`);
			else console.error(`[harness] turn failed for ${s.agentId.slice(0, 8)}:`, err);
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
			if (!deleted) await markRunError(s.agentId, failure);
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
				if (surface && (await pendingMessages(surface, ref, s.agentId, await addressedAs(s, ref))).length > 0) {
					void drive(s, ref);
					break;
				}
			}
			void pumpMailbox(s.conv.objectId);
		}
		return failure;
	}

	async function drive(s: Served, surface: ConvRef): Promise<void> {
		if (!(await runsAgentHere(surface.objectId, s.agentId))) return;
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
		await withTurn(s, surface, async () => {
			takeCredentialIssues(s.agentId); // another turn's leftovers are not this one's
			await handleSurface(s, surface);
			// A signed-out login this turn hit goes on the object it was about, as a
			// scheduled run's does - else only a chat line says why the work stopped.
			const dead = takeCredentialIssues(s.agentId);
			if (dead.length > 0) await badgeSignedOut(surface.objectId, dead).catch(() => {});
		});
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
	async function driveScheduled(s: Served, systemSuffix: string): Promise<string> {
		await awaitSlot(s);
		return withTurn(s, s.conv, () => runTurn(s.agentId, s.conv, { spawn: spawnSubagent, systemSuffix, a2aTurn: true }));
	}

	/**
	 * The vanish ledger changed: an agent that was deleted, lives in a
	 * deleted (vanished or left) space or holds its transcript on a deleted
	 * object stops being served here, and a deleted default space is
	 * replaced, so nothing this harness does writes into one.
	 */
	async function releaseVanished(): Promise<void> {
		const gone = new Set((await vanishedEntries()).map((entry) => entry.objectId));
		for (const s of [...served.values()]) {
			if (!gone.has(s.agentId) && !gone.has(s.channelId) && !gone.has(s.conv.objectId)) continue;
			served.delete(s.agentId);
			agents.delete(s.agentId);
			heldUp.delete(s.agentId);
			await setEnabled(s.agentId, false);
			console.log(`[harness] released ${s.name} (${s.agentId.slice(0, 8)}) - deleted with its space`);
		}
		if (gone.has(defaultChannelId)) {
			const channels = (await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string }>;
			defaultChannelId = channels[0]?.id ?? "";
		}
	}

	/** Route an SSE object event to the agent whose surface it is. */
	async function route(objectId: string): Promise<void> {
		if (objectId === VANISH_LOG_ID) {
			await releaseVanished().catch((err) => console.error("[harness] releasing deleted agents:", err instanceof Error ? err.message : err));
			return;
		}
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
			// Pin edits sync through the agent object: keep the resolver
			// current without a roster round-trip.
			const agent = await fetchObject(objectId).catch(() => null);
			if (agent) {
				notePin(agent);
				// Its Served by was cleared or moved to another computer: this
				// one stops answering now, not at the next restart.
				const pin = str(agent.fields, "served_by");
				if (!str(agent.fields, "spawn_parent") && pin !== me) {
					agents.delete(objectId);
					served.delete(objectId);
					heldUp.delete(objectId);
					await setEnabled(objectId, false);
					console.log(`[harness] released ${str(agent.fields, "name") || objectId.slice(0, 8)} (${objectId.slice(0, 8)}) - ${pin ? `now served by ${pin.slice(0, 8)}` : "its Served by is empty"}`);
					return;
				}
			}
			return; // agent objects are not surfaces
		}
		// An agent assigned here by `served_by` (from any client) is
		// adopted on sight, so its first message needs no restart; any agent
		// event keeps the external-responder set current.
		if (!agents.has(objectId)) {
			const maybe = await fetchObject(objectId).catch(() => null);
			if (maybe?.typeKey === "agent") {
				notePin(maybe);
				if (str(maybe.fields, "external_responder")) externalAgents.add(objectId);
				else externalAgents.delete(objectId);
				if (!str(maybe.fields, "spawn_parent") && str(maybe.fields, "served_by") === me) {
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
		// A space (a new one included) holds the built-ins as Tool objects.
		if (obj.typeKey === "channel" && !obj.deleted) void ensureBuiltinTools(obj.id).catch((err) => console.error(`[tools] built-in Tool objects for ${obj.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
		// A rule edit (repeat_set/clear, an occurrence completed or fired)
		// may move the earliest occurrence.
		if (obj.fields["repeat"]) void armScheduler();
		// Run now, asked for from any device: the computer that serves the object starts it.
		if (obj.fields[RUN_REQUEST_KEY] && !obj.deleted) void handleRunRequest(obj).catch((err) => console.error(`[schedule] run request ${obj.id.slice(0, 8)}:`, err instanceof Error ? err.message : err));
		// Serving inputs changed: a machine or capability object (its status
		// included), a pin (served_by) or Skills on any object. Refresh
		// the resolver cache and re-arm, so the next event and the clock
		// follow the new answer.
		if (obj.typeKey === MACHINE_TYPE || obj.typeKey === CAPABILITY_TYPE || obj.fields["served_by"] || obj.fields[SKILLS_KEY]) {
			invalidateServing();
			void armScheduler();
		}
		// A File appeared or gained a holder, or a computer's "Keep every
		// file" flipped: a computer that keeps every file fetches what it lacks.
		if (obj.typeKey === FILE_TYPE || obj.typeKey === MACHINE_TYPE) keepAllFiles();
		if (obj.typeKey === CREDENTIAL_TYPE) {
			// Service just set on a blank credential: take its template, then check it.
			void fillCredential(obj)
				.then(() => refreshCredentials())
				.catch((error) => console.error("[harness] credential refresh:", error));
			return;
		}
		if (obj.typeKey === "agent") return; // other agents' brains
		// ── One conversation per object (`__discussion__`). Humans and agents
		// post there; an @-mention of a guest is the wake signal for that
		// guest. A post with no tag wakes nobody; the reply lands in the same
		// thread. Exchanges are only for explicit group/agent-to-agent asks. ──
		if (guestAgents(obj.fields).length === 0 || externallyAnswered(obj)) return;
		// Per guest, not per object: a guest pinned to another machine is that
		// machine's to run even here; a guest pinned HERE runs even when the
		// object follows another guest's pin.
		const mine: string[] = [];
		for (const aid of guestAgents(obj.fields)) if (await runsAgentHere(objectId, aid)) mine.push(aid);
		void pumpMailbox(objectId, obj);
		if (mine.length === 0) return;
		for (const aid of mine) void adoptForObject(obj, aid);

		// ── @-mentions in the human thread: wake each tagged guest. ──
		await wakeMentionedGuests(obj);
	}

	/** Wake every guest the newest discussion message @-mentions, or answers (an agent replying to that guest's question). */
	async function wakeMentionedGuests(obj: ObjectJSON): Promise<void> {
		const msgs = chatBlocks(obj, humanRef(obj.id))
			.map((row, index) => ({ ...row, index, ts: Number(row.block.content.custom?.meta?.["ts"] ?? 0) }))
			.sort((a, b) => a.ts - b.ts || a.index - b.index);
		if (msgs.length === 0) return;
		const newest = msgs[msgs.length - 1].block.content.custom?.meta?.["text"] ?? "";
		for (const aid of guestAgents(obj.fields)) {
			if (!(await runsAgentHere(obj.id, aid))) continue;
			const agent = await fetchObject(aid).catch(() => null);
			if (!agent) continue;
			const name = str(agent.fields, "name");
			if (!name) continue;
			if (!mentions(newest, name) && !(await answersGuestQuestion(msgs, msgs.length - 1, aid))) continue;
			const s2 = await adoptForObject(obj, aid);
			if (s2) void drive(s2, humanRef(obj.id));
		}
	}

	startAuthServer(agents);
	void startFilePeer()
		.then(() => keepAllFiles())
		.catch((err) => console.error("[files] peer failed to start:", err));
	setInterval(() => keepAllFiles(), KEEP_ALL_SWEEP_MS);
	console.log(`[harness] serving ${agents.size} agent(s): ${[...agents].map((a) => a.slice(0, 8)).join(", ") || "(none — set an agent's Served by to this computer)"}`);

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
	// Live work, not only what the index already holds: a full rescan on a
	// slow timer, so an envelope lands a turn even when its SSE event was
	// missed (a quiet feed, a reconnect gap). scanMailboxes is cheap - it
	// skips anything with nothing waiting.
	// Sign-ins expire on their own; notice within a few minutes.
	setInterval(() => {
		void refreshCredentials().catch((error) => console.error("[harness] credential refresh:", error));
	}, 5 * 60_000);
	setInterval(() => {
		void scanMailboxes().catch((error) => console.error("[harness] mailbox rescan:", error));
	}, 15_000);
	await scanMailboxes();
	console.log("[harness] SSE connected; serving.");

	// The clock: fires occurrences due now (missed while down) and arms for
	// the next. Only for objects this machine serves - the gate is inside.
	await startScheduler({
		async served(agentId) {
			const known = served.get(agentId);
			if (known) return known;
			// An agent not in the local roster (one an object names, quiet
			// since boot) still answers its own schedule where its object
			// resolves; buildServedOne stands down otherwise.
			const agent = await fetchObject(agentId).catch(() => null);
			if (!agent || agent.typeKey !== "agent" || str(agent.fields, "spawn_parent")) return undefined;
			const one = await buildServedOne(agentId, defaultChannelId);
			if (!one) return undefined;
			served.set(agentId, one);
			return one;
		},
		turn(agentId, systemSuffix) {
			const s = served.get(agentId);
			if (!s) return Promise.resolve("agent no longer served on this machine");
			return driveScheduled(s, systemSuffix);
		},
	});
	// Push, not polling, for inboxes: new mail runs its inbox object at once.
	startGmailPush();

	// Discord channels are surfaces too: one poller per served agent whose
	// prompt talks to Discord, following `served` as agents come and go. The
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
else if (cmd === "import-kb") {
	// import-kb <dir> --space <id>
	const { importKb } = await import("./kb");
	const dir = process.argv[3] ?? "";
	if (!dir || !argValue("--space")) throw new Error("usage: import-kb <dir> --space <spaceId>");
	const res = await importKb({ dir, space: argValue("--space") as string });
	console.log(`[kb] created ${res.created.length}, skipped ${res.skipped}`);
	process.exit(0);
}
else {
	console.log(`commands: setup --name X [--kind ${PROMPT_SEEDS.map((s) => s.key).join("|")}] [--model m] [--channel id] [--<kind field> v] | serve | ask <agentId> <msg> | vanish <objectId…>|--trash [--yes] | import-kb <dir> --space <id>`);
}
