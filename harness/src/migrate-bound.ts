/**
 * One-time cutover: agent-side `bound_object` (1:1, the agent pointed at its
 * object) becomes object-side `agent` (N:1, the object names its agent).
 *
 * No transcript moves here: migrate-chats already placed every bound agent's
 * private thread on its object as `agent_private`, and `agentThreadOn`
 * (conv.ts) adopts that thread on first contact - including the twin case,
 * where two agent objects were minted for one object and their threads
 * merged. Only the pointer flips.
 *
 * Conflict rule: two agents bound to one object - the lower query order wins
 * the `agent` pointer, the loser's binding is dropped with a log line; its
 * transcript is still found by adoption.
 *
 * Must run AFTER migrateExchanges, which still reads `bound_object` to
 * resolve legacy a2a participant endpoints. Idempotent: a field is deleted
 * only after its pointer landed, and re-running finds no `bound_object`.
 */
import { deleteField, fetchObject, queryAll, setField, str, sv } from "./api";

export async function migrateBoundAgents(): Promise<{ moved: number; conflicts: number }> {
	let moved = 0;
	let conflicts = 0;
	for (const agent of await queryAll({ type: "agent", filters: [{ key: "bound_object", condition: "notEmpty" }] })) {
		const objectId = str(agent.fields, "bound_object");
		const name = str(agent.fields, "name") || agent.id.slice(0, 8);
		try {
			const obj = await fetchObject(objectId).catch(() => null);
			if (obj && !obj.deleted) {
				const existing = str(obj.fields, "agent");
				if (!existing) {
					await setField(obj.id, "agent", sv(agent.id));
					moved++;
					console.log(`[migrate] "${name}" -> agent of "${str(obj.fields, "name") || obj.id.slice(0, 8)}"`);
				} else if (existing !== agent.id) {
					conflicts++;
					console.log(`[migrate] "${name}" bound to ${obj.id.slice(0, 8)}, which already names agent ${existing.slice(0, 8)}; binding dropped`);
				}
			} else {
				console.log(`[migrate] "${name}" bound to vanished object ${objectId.slice(0, 8)}; binding dropped`);
			}
			await deleteField(agent.id, "bound_object");
		} catch (err) {
			console.error(`[migrate] bound_object cutover failed for "${name}":`, err instanceof Error ? err.message : err);
		}
	}
	return { moved, conflicts };
}
