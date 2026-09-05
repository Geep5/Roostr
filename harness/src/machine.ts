/**
 * This machine's claim, published to the DAG.
 *
 * A claim is not a heartbeat. It answers "which agents will this machine
 * serve", which is durable, changes only when a human toggles Run here or a
 * new bound agent is minted, and is the one fact that diagnoses two machines
 * answering the same message. Liveness - "is it up right now" - is
 * deliberately absent: it has a two-minute shelf life and the DAG never
 * forgets, so storing it cost 144k commits a day per hundred agents and 47%
 * of this vault before it was removed.
 *
 * "Last active" is not stored either. It is derived by readers from work the
 * agent already wrote (its conversation's updatedAt), so it costs nothing.
 *
 * Writes are guarded: publishing an unchanged claim set writes nothing, so
 * restarts are free.
 */

import { hostname } from "node:os";
import { createObject, list, lv, queryAll, setField, str, sv } from "./api";
import { machineId } from "./roster";

export const MACHINE_TYPE = "machine";

// ── Per-space serving ────────────────────────────────────────────
//
// One machine serves a space: `served_by` (a machine id) on the channel
// object decides who mints and answers for everything in it. The field
// is DAG data, so transfer never needs the old machine's cooperation -
// a takeover is one synced write, and a returning machine adopts the
// newer value before serving (sync first, serve second).

const SPACE_TTL_MS = 20_000;
let spaceCache: { at: number; mine: Set<string>; byId: Map<string, string> } | null = null;

export function invalidateSpaceServing(): void {
	spaceCache = null;
}

async function spaceServing(): Promise<{ mine: Set<string>; byId: Map<string, string> }> {
	if (spaceCache && Date.now() - spaceCache.at < SPACE_TTL_MS) return spaceCache;
	const id = await machineId();
	const channels = await queryAll({ type: "channel" });
	const byId = new Map<string, string>();
	const mine = new Set<string>();
	for (const c of channels) {
		const sb = str(c.fields, "served_by");
		byId.set(c.id, sb);
		if (sb === id) mine.add(c.id);
	}
	spaceCache = { at: Date.now(), mine, byId };
	return spaceCache;
}

/** Stamp-if-absent: the first machine to see an unclaimed space serves it.
 * Two machines racing converge via replay (deterministic winner) and the
 * gate follows the converged value on its next refresh. */
export async function convergeSpaceServing(): Promise<void> {
	const id = await machineId();
	const channels = await queryAll({ type: "channel" });
	for (const c of channels) {
		if (!str(c.fields, "served_by")) {
			await setField(c.id, "served_by", sv(id));
			console.log(`[harness] space "${str(c.fields, "name") || c.id.slice(0, 8)}" now served by this machine`);
		}
	}
	invalidateSpaceServing();
}

/** Does this machine serve the space? Unknown/unclaimed spaces read as
 * "mine" so a brand-new space answers immediately - the stamp follows. */
export async function spaceMine(channelId: string): Promise<boolean> {
	if (!channelId) return true;
	const { mine, byId } = await spaceServing();
	if (mine.has(channelId)) return true;
	if (!byId.has(channelId)) return true;
	return !byId.get(channelId);
}

/** Same set, order-insensitive - claims are a set, not a list. */
function sameClaims(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const sa = [...a].sort();
	const sb = [...b].sort();
	return sa.every((v, i) => v === sb[i]);
}

/**
 * Record which agents this machine serves. Creates this machine's object on
 * first call, then writes only when the claim set or the hostname changes.
 */
export async function publishClaims(agentIds: Set<string>): Promise<void> {
	const id = await machineId();
	const host = hostname();
	const claims = [...agentIds].sort();
	try {
		const mine = (await queryAll({ type: MACHINE_TYPE })).find((m) => str(m.fields, "machine_id") === id);
		if (!mine) {
			await createObject(host, MACHINE_TYPE, { machine_id: sv(id), claims: lv(claims) });
			console.log(`[harness] claimed ${claims.length} agent(s) as "${host}"`);
			return;
		}
		const had = list(mine.fields, "claims");
		if (str(mine.fields, "name") !== host) await setField(mine.id, "name", sv(host));
		if (sameClaims(had, claims)) return;
		await setField(mine.id, "claims", lv(claims));
		console.log(`[harness] claim updated: ${claims.length} agent(s) on "${host}"`);
	} catch (err) {
		// The claim is a convenience for readers, never a precondition for
		// serving: a daemon that is not up yet must not stop the harness.
		console.error("[harness] could not publish claim:", err instanceof Error ? err.message : err);
	}
}
