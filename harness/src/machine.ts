/**
 * Which machine serves what - this machine's view of the rule in
 * `docs/object-serving.md`.
 *
 * Responsibility is a function of DAG state that every machine evaluates
 * identically: an object is served by its `served_by` pin, else by the pin
 * of the first agent on its guest list (`agent`) that has one, unless its
 * `requires` list names capabilities that machine lacks - then the lowest
 * machine id that has them. Nothing pinned and nothing required: nobody.
 * The engine owns the rule (`core/serving.odin`); the daemon evaluates it
 * over the local replica (`POST /api/serving`) and this module only caches
 * the answers and asks "is it me?".
 *
 * A machine always serves its own `machine` object, so a human can address
 * any machine through that object's discussion.
 *
 * Nothing here is liveness. The machine object carries `machine_id` and
 * `name` (hostname) - durable facts, each written only when it changes, so
 * restarts are free. What the machine can DO is no longer a field here: it
 * is the capability objects (type `capability`, capabilities.ts) that name
 * it as `served_by` and whose install is active.
 */

import { execSync } from "node:child_process";
import { hostname, platform } from "node:os";
import { createObject, queryAll, servingFor, setField, str, sv, type Serving, type ValueJSON } from "./api";
import { machineId } from "./roster";
import { agentSubject } from "./conv";

/**
 * The computer's stable display name: the human-chosen ComputerName on
 * macOS, the hostname elsewhere. `os.hostname()` on a Mac is the mDNS
 * name, which grows a -842/-874 suffix every time the router reassigns it -
 * the machine object looked "newly renamed" on every boot.
 */
function stableHostName(): string {
	if (platform() === "darwin") {
		try {
			return execSync("scutil --get ComputerName", { encoding: "utf8" }).trim() || hostname();
		} catch {
			return hostname();
		}
	}
	return hostname();
}

export const MACHINE_TYPE = "machine";

const TTL_MS = 20_000;

export interface MachineRow {
	objectId: string;
	machineId: string;
	name: string;
}

let rosterCache: { at: number; rows: MachineRow[] } | null = null;
const servingCache = new Map<string, { at: number; serving: Serving }>();

/** Forget cached answers; called on any commit that can move responsibility. */
export function invalidateServing(): void {
	rosterCache = null;
	servingCache.clear();
}

/** Every machine object in the DAG (cached). */
export async function machines(): Promise<MachineRow[]> {
	if (rosterCache && Date.now() - rosterCache.at < TTL_MS) return rosterCache.rows;
	const rows = (await queryAll({ type: MACHINE_TYPE })).map((m) => {
		const id = str(m.fields, "machine_id");
		return { objectId: m.id, machineId: id, name: str(m.fields, "name") || id.slice(0, 8) };
	});
	rosterCache = { at: Date.now(), rows };
	return rows;
}

/** Warm the cache for many objects in one round trip. */
export async function primeServing(objectIds: string[]): Promise<void> {
	const now = Date.now();
	const missing = objectIds.filter((id) => {
		const hit = servingCache.get(id);
		return !hit || now - hit.at >= TTL_MS;
	});
	if (missing.length === 0) return;
	const at = Date.now();
	for (const [id, serving] of Object.entries(await servingFor(missing))) servingCache.set(id, { at, serving });
}

/** The engine's resolution for one object. */
export async function serverOf(objectId: string): Promise<Serving> {
	await primeServing([objectId]);
	return servingCache.get(objectId)?.serving ?? { machineId: "", reason: "unserved", requires: [], candidates: [] };
}

/**
 * Does this machine act for the object? Its own machine object: always;
 * another machine's: never. Otherwise the resolver decides; an unserved
 * object is nobody's.
 */
export async function servesHere(objectId: string): Promise<boolean> {
	if (!objectId) return true;
	const me = await machineId();
	const own = (await machines()).find((m) => m.objectId === objectId);
	if (own) return own.machineId === me;
	return (await serverOf(objectId)).machineId === me;
}

/** An agent's own page is served where the agent is pinned (`served_by`). */
export function agentServedHere(agent: { id: string; fields: Record<string, ValueJSON> }): Promise<boolean> {
	return servesHere(agentSubject(agent));
}

/** Whether the object's own placement decides, whoever the agent is. */
const OBJECT_PLACED: Record<Serving["reason"], boolean> = {
	self: true,
	pinned: true,
	"pinned-uncapable": true,
	capability: true,
	agent: false,
	"agent-capable": false,
	unsatisfied: false,
	unserved: false,
};

/**
 * The machine that runs an agent on an object ("" = none). Object pin >
 * agent pin > nothing:
 *   - the object is placed on purpose (a machine or install, an explicit
 *     pin, a capability only another machine has) → the object's server,
 *     for every agent on it;
 *   - otherwise → the agent's own pin (`agentPin`, its `served_by`), even
 *     when another guest's pin serves the object; an unpinned agent runs
 *     nowhere.
 */
export function agentRunsOn(serving: Serving, agentPin: string): string {
	return OBJECT_PLACED[serving.reason] ? serving.machineId : agentPin;
}

/**
 * Register this machine: create its object on first call, keep `name` at
 * the hostname. Capabilities no longer ride on the machine object - the
 * capability objects that name it as `served_by` carry them.
 */
export async function publishMachine(): Promise<void> {
	const id = await machineId();
	const host = stableHostName();
	try {
		const mine = (await queryAll({ type: MACHINE_TYPE })).find((m) => str(m.fields, "machine_id") === id);
		if (!mine) {
			await createObject(host, MACHINE_TYPE, { machine_id: sv(id) });
			console.log(`[harness] registered this machine as "${host}"`);
			invalidateServing();
			return;
		}
		// Rename only a transient (mDNS) or empty name - never a custom one.
		const current = str(mine.fields, "name");
		if (current !== host && (current === "" || current === hostname())) {
			await setField(mine.id, "name", sv(host));
			invalidateServing();
		}
	} catch (err) {
		// Registration is what OTHER machines resolve against, never a
		// precondition for serving here: a daemon that is not up yet must not
		// stop the harness.
		console.error("[harness] could not register this machine:", err instanceof Error ? err.message : err);
	}
}
