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
import { deleteField, fetchObject, guestAgents, lv, queryAll, setField, str, sv, type QueryRow } from "./api";
import { MACHINE_TYPE } from "./machine";
import { defaultSpaceId } from "./spacemap";

/**
 * `agent` became a link list (the object's guest list). An object still
 * holding the older single string is rewritten to a one-element list.
 * Idempotent: a list value is left alone.
 */
export async function migrateAgentLists(): Promise<{ converted: number }> {
	let converted = 0;
	for (const row of await queryAll({ filters: [{ key: "agent", condition: "notEmpty" }] })) {
		const single = row.fields["agent"]?.stringValue;
		if (!single) continue;
		try {
			await setField(row.id, "agent", lv([single]));
			converted++;
		} catch (err) {
			console.error(`[migrate] agent list cutover failed for ${row.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	return { converted };
}

/**
 * `space_default` (agent-side: this agent is the space's default mind) is
 * retired - a space's agents are named on the space object's own `agent`
 * guest list like any other object's. Each agent still carrying the field
 * joins that space's guest list, then loses the field. Idempotent: a
 * re-run finds no `space_default`.
 */
export async function migrateSpaceDefaults(): Promise<{ moved: number }> {
	let moved = 0;
	for (const agent of await queryAll({ type: "agent", filters: [{ key: "space_default", condition: "notEmpty" }] })) {
		const spaceId = str(agent.fields, "space_default");
		const name = str(agent.fields, "name") || agent.id.slice(0, 8);
		try {
			const space = await fetchObject(spaceId).catch(() => null);
			if (space && !space.deleted) {
				const guests = guestAgents(space.fields);
				if (!guests.includes(agent.id)) {
					await setField(space.id, "agent", lv([...guests, agent.id]));
					moved++;
					console.log(`[migrate] "${name}" -> guest of space "${str(space.fields, "name") || space.id.slice(0, 8)}"`);
				}
			} else {
				console.log(`[migrate] "${name}" defaulted to vanished space ${spaceId.slice(0, 8)}; field dropped`);
			}
			await deleteField(agent.id, "space_default");
		} catch (err) {
			console.error(`[migrate] space_default cutover failed for "${name}":`, err instanceof Error ? err.message : err);
		}
	}
	return { moved };
}

/**
 * A space's default computer (`served_by` on the channel) is retired:
 * machines are chosen per agent. Every top-level agent with no pin of its
 * own takes its space's computer (an agent with no `channel` lives in the
 * default space), then the space field goes - with the space-scoped
 * checkout bindings (channel `repo_url`, machine `paths`/`paths_status`),
 * which the agent's own `repo_path` replaced. Spaces keep their computers
 * until every pin has landed, so a failed or interrupted run re-pins on
 * the next boot. Idempotent: a re-run finds nothing to pin and nothing to
 * delete.
 */
export async function migrateSpaceComputers(): Promise<{ pinned: number; spacesCleared: number; machinesCleared: number }> {
	const channels = await queryAll({ type: "channel" });
	const computerOf = new Map(channels.map((c) => [c.id, str(c.fields, "served_by")]));
	const fallbackSpace = await defaultSpaceId();
	let pinned = 0;
	let pinFailed = false;
	for (const agent of await queryAll({ type: "agent" })) {
		if (str(agent.fields, "spawn_parent") || str(agent.fields, "served_by")) continue;
		const computer = computerOf.get(str(agent.fields, "channel") || fallbackSpace);
		if (!computer) continue;
		const name = str(agent.fields, "name") || agent.id.slice(0, 8);
		try {
			await setField(agent.id, "served_by", sv(computer));
			pinned++;
			console.log(`[migrate] "${name}" -> served by ${computer.slice(0, 8)} (its space's computer)`);
		} catch (err) {
			pinFailed = true;
			console.error(`[migrate] space computer pin failed for "${name}":`, err instanceof Error ? err.message : err);
		}
	}
	const drop = async (row: QueryRow, keys: string[]): Promise<boolean> => {
		const present = keys.filter((k) => row.fields[k] !== undefined);
		for (const key of present) await deleteField(row.id, key);
		return present.length > 0;
	};
	let spacesCleared = 0;
	for (const channel of channels) {
		try {
			if (await drop(channel, pinFailed ? ["repo_url"] : ["served_by", "repo_url"])) spacesCleared++;
		} catch (err) {
			console.error(`[migrate] space computer cleanup failed for space ${channel.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	let machinesCleared = 0;
	for (const machine of await queryAll({ type: MACHINE_TYPE })) {
		try {
			if (await drop(machine, ["paths", "paths_status"])) machinesCleared++;
		} catch (err) {
			console.error(`[migrate] checkout binding cleanup failed for machine ${machine.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	return { pinned, spacesCleared, machinesCleared };
}

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
					await setField(obj.id, "agent", lv([agent.id]));
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
