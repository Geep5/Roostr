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
