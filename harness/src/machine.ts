/**
 * Which machine serves what - this machine's view of the rule in
 * `docs/object-serving.md`.
 *
 * Responsibility is a function of DAG state that every machine evaluates
 * identically: an object is served by its `served_by` pin, else by the
 * space's default (`served_by` on the channel), unless its `requires`
 * list names capabilities the default lacks - then the lowest machine id
 * that has them. The engine owns the rule (`core/serving.odin`); the
 * daemon evaluates it over the local replica (`POST /api/serving`) and
 * this module only caches the answers and asks "is it me?".
 *
 * A machine always serves its own `machine` object, so a human can address
 * any machine through that object's discussion.
 *
 * Nothing here is liveness. The machine object carries `machine_id`,
 * `name` (hostname) and `capabilities` (catalog skills installed and
 * enabled here) - durable facts, each written only when it changes, so
 * restarts are free.
 */

import { hostname } from "node:os";
import { createObject, list, lv, queryAll, servingFor, setField, str, sv, type Serving, type ValueJSON } from "./api";
import { machineId } from "./roster";

export const MACHINE_TYPE = "machine";

const TTL_MS = 20_000;

export interface MachineRow {
	objectId: string;
	machineId: string;
	name: string;
	capabilities: string[];
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
		return { objectId: m.id, machineId: id, name: str(m.fields, "name") || id.slice(0, 8), capabilities: list(m.fields, "capabilities") };
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
	return servingCache.get(objectId)?.serving ?? { machineId: "", reason: "space", requires: [], candidates: [] };
}

/**
 * Does this machine act for the object? Its own machine object: always;
 * another machine's: never. Otherwise the resolver decides, and an object
 * with no server at all (a brand-new space before its stamp) reads as
 * mine so it answers immediately - `convergeSpaceServing` follows.
 */
export async function servesHere(objectId: string): Promise<boolean> {
	if (!objectId) return true;
	const me = await machineId();
	const own = (await machines()).find((m) => m.objectId === objectId);
	if (own) return own.machineId === me;
	const s = await serverOf(objectId);
	return s.machineId === me || (s.machineId === "" && s.reason === "space");
}

/** Agents follow their objects: a bound agent runs where its object runs, an unbound one resolves on its own row. */
export function agentServedHere(agent: { id: string; fields: Record<string, ValueJSON> }): Promise<boolean> {
	return servesHere(str(agent.fields, "bound_object") || agent.id);
}

/** Stamp-if-absent: the first machine to see an unclaimed space becomes its
 * default. Two machines racing converge via replay (deterministic winner)
 * and the gate follows the converged value on its next refresh. */
export async function convergeSpaceServing(): Promise<void> {
	const id = await machineId();
	const channels = await queryAll({ type: "channel" });
	for (const c of channels) {
		if (!str(c.fields, "served_by")) {
			await setField(c.id, "served_by", sv(id));
			console.log(`[harness] space "${str(c.fields, "name") || c.id.slice(0, 8)}" now served by this machine`);
		}
	}
	invalidateServing();
}

/** Same set, order-insensitive - capabilities are a set, not a list. */
function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((v, i) => v === sb[i]);
}

/**
 * Publish this machine's capabilities (catalog keys installed and enabled
 * here). Creates this machine's object on first call, keeps `name` at the
 * hostname, and writes `capabilities` only when the set changed.
 */
export async function publishCapabilities(keys: string[]): Promise<void> {
	const id = await machineId();
	const host = hostname();
	const caps = [...keys].sort();
	try {
		const mine = (await queryAll({ type: MACHINE_TYPE })).find((m) => str(m.fields, "machine_id") === id);
		if (!mine) {
			await createObject(host, MACHINE_TYPE, { machine_id: sv(id), capabilities: lv(caps) });
			console.log(`[harness] registered this machine as "${host}" with capabilities [${caps.join(", ")}]`);
			invalidateServing();
			return;
		}
		if (str(mine.fields, "name") !== host) await setField(mine.id, "name", sv(host));
		if (sameSet(list(mine.fields, "capabilities"), caps)) return;
		await setField(mine.id, "capabilities", lv(caps));
		invalidateServing();
		console.log(`[harness] capabilities now [${caps.join(", ")}] on "${host}"`);
	} catch (err) {
		// The published set is what OTHER machines resolve against, never a
		// precondition for serving here: a daemon that is not up yet must not
		// stop the harness.
		console.error("[harness] could not publish capabilities:", err instanceof Error ? err.message : err);
	}
}
