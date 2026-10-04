/**
 * Capability objects - one catalog skill's state on one machine, and the
 * facts the serving resolver reads.
 *
 * A capability is ONE catalog skill on ONE machine: type `capability`,
 * fields `key` (catalog key), `served_by` (the machine id as a string),
 * `status`, `error`, `checked_at` and `channel` (the integration space).
 * Only the machine it names writes it. "What a machine can do" is the set
 * of capability objects that name it as `served_by` with status `active`.
 * People never pick these: an object lists Skill objects in its Skills,
 * and the resolver finds the machines with an active capability of each
 * skill's key (skills.ts, core/serving.odin).
 *
 * A capability is also the inbox for setup requests (capability-messages.ts):
 * an agent asks that machine to install, enable, disable, uninstall or
 * re-check the skill by messaging the object, and a person there approves.
 *
 * Identity is (key x machine): upsertCapability creates or updates
 * idempotently when this machine records a skill's state.
 */

import { createObject, mutate, queryAll, str, sv, iv, type QueryRow, type ValueJSON } from "./api";
import { machineId } from "./roster";
import { SKILL_TYPE, skillIds } from "./skills";

export const CAPABILITY_TYPE = "capability";

export type CapabilityStatus = "active" | "needs_auth" | "needs_approval" | "processing" | "missing" | "broken" | "disabled";

/** One capability object as agents and the harness see it. */
export interface CapabilityRow {
	id: string;
	key: string;
	/** Machine id (the roster UUID) of the machine this capability is on; "" if unset. */
	machineId: string;
	status: CapabilityStatus;
	error: string;
	checkedAt: number;
	/** The integration space the capability is filed in. */
	channel: string;
}

/** A link field value. */
export const linkValue = (targetId: string): ValueJSON => ({ linkValue: { targetId } });

/** A link-or-string field's target. */
export function linkTarget(fields: Record<string, ValueJSON>, key: string): string {
	const v = fields[key];
	return v?.linkValue?.targetId || v?.stringValue || "";
}

function rowToCapability(r: QueryRow): CapabilityRow {
	return {
		id: r.id,
		key: str(r.fields, "key"),
		machineId: linkTarget(r.fields, "served_by"),
		status: (str(r.fields, "status") || "missing") as CapabilityStatus,
		error: str(r.fields, "error"),
		checkedAt: r.fields["checked_at"]?.intValue ?? 0,
		channel: str(r.fields, "channel"),
	};
}

/** Every capability object. */
export async function fetchCapabilities(): Promise<CapabilityRow[]> {
	return (await queryAll({ type: CAPABILITY_TYPE })).map(rowToCapability);
}

/** This machine's capabilities by key; the earliest-created wins if a key has two. */
export async function myCapabilities(): Promise<Map<string, CapabilityRow>> {
	const id = await machineId();
	const out = new Map<string, CapabilityRow>();
	const rows = (await queryAll({ type: CAPABILITY_TYPE })).sort((a, b) => a.createdAt - b.createdAt);
	for (const r of rows) {
		const row = rowToCapability(r);
		if (row.machineId === id && !out.has(row.key)) out.set(row.key, row);
	}
	return out;
}

/** Active capability keys on `machine` (default: this machine) - the only ones offered. */
export async function activeCapabilityKeys(machine = ""): Promise<string[]> {
	const id = machine || (await machineId());
	return (await fetchCapabilities())
		.filter((c) => c.machineId === id && c.status === "active")
		.map((c) => c.key)
		.sort();
}

/** What a capability object is called and says, from the catalog that owns the key. */
export interface CapabilitySeed {
	key: string;
	name: string;
	description: string;
}

/**
 * The space a capability key belongs to. One vault scan: the space whose
 * objects list that skill most, then a space named like the capability,
 * else the vault's default (oldest) space.
 */
async function integrationSpace(seed: CapabilitySeed, channels: QueryRow[]): Promise<string> {
	const live = new Set(channels.map((c) => c.id));
	const skillKeyById = new Map((await queryAll({ type: SKILL_TYPE })).map((r) => [r.id, str(r.fields, "key")]));
	const byChannel = new Map<string, number>();
	for (const row of await queryAll({})) {
		const ch = str(row.fields, "channel");
		if (!ch || !live.has(ch)) continue;
		for (const id of skillIds(row.fields)) {
			if (skillKeyById.get(id) === seed.key) byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1);
		}
	}
	const best = [...byChannel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (best) return best;
	const named = channels.find((c) => {
		const n = str(c.fields, "name").toLowerCase();
		return n && (n === seed.key.toLowerCase() || n === seed.name.toLowerCase());
	});
	return named?.id ?? [...channels].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? "";
}

export interface CapabilityState {
	status: CapabilityStatus;
	error?: string;
}

/**
 * Record a skill's state on THIS machine: one capability per (key x
 * machine), created on first write, otherwise only the fields that changed
 * (plus `checked_at` when anything did - a check every minute must not be a
 * change every minute). Returns the capability id.
 */
export async function upsertCapability(seed: CapabilitySeed, state: CapabilityState): Promise<string> {
	const me = await machineId();
	const wanted = { status: state.status, error: state.error ?? "" };
	const hit = (await myCapabilities()).get(seed.key);
	if (!hit) {
		const space = await integrationSpace(seed, await queryAll({ type: "channel" }));
		const { id } = await createObject(seed.name, CAPABILITY_TYPE, {
			key: sv(seed.key),
			served_by: sv(me),
			status: sv(wanted.status),
			error: sv(wanted.error),
			checked_at: iv(Date.now()),
			...(space ? { channel: sv(space) } : {}),
			description: sv(seed.description),
		});
		return id;
	}
	const current: Record<string, string> = { status: hit.status, error: hit.error };
	const changed = Object.entries(wanted).filter(([field, value]) => current[field] !== value);
	if (changed.length === 0) return hit.id;
	for (const [field, value] of changed) await mutate("set_field", { object_id: hit.id, key: field, value: sv(value) });
	await mutate("set_field", { object_id: hit.id, key: "checked_at", value: iv(Date.now()) });
	return hit.id;
}

/**
 * Record a holdup on this machine's capability `error`, so a blocked call
 * is a row a human can see, sort and query. Status is left alone: a blocked
 * call does not change what is installed here.
 */
export async function publishHoldup(key: string, error: string): Promise<void> {
	const row = (await myCapabilities()).get(key);
	if (row && row.error !== error) await mutate("set_field", { object_id: row.id, key: "error", value: sv(error) });
}

/**
 * A healed capability retracts its blocked-object badges: the tool that
 * filed "needs <key>: …" is not around to retract it, so the sweep happens
 * where the healing is observed. There is no holdup list - the badge and
 * the capability's error are the whole record, and both clear here.
 */
export async function sweepHoldupBadges(key: string): Promise<void> {
	const rows = await queryAll({ filters: [{ key: "error", condition: "notEmpty" }] }).catch(() => []);
	for (const row of rows) {
		if (str(row.fields, "error").startsWith(`needs ${key}:`)) await mutate("delete_field", { object_id: row.id, key: "error" }).catch(() => {});
	}
}
