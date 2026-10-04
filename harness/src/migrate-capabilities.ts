/**
 * Boot migration into the three-type model (capabilities.ts): a
 * capability object is one catalog skill's state on one machine, and the
 * old `install` rows and `machine.capabilities` lists fold into it.
 *
 *  1. Every install row in the vault (any machine): rows keyed by an
 *     account (Google accounts - Credentials now) vanish; the rest upsert
 *     the capability for (key x machine_id), copying status, error,
 *     checked_at and channel, then vanish. Pending requests in their
 *     inboxes go with them.
 *  2. A machine's legacy `capabilities` list becomes capability objects
 *     (status `missing` unless step 1 already wrote one); the field goes.
 *  3. Capabilities converge: one per (key x machine), keeping the
 *     earliest-created; `served_by` as the machine id string; no `install`,
 *     `account` or `auth` fields; none for a sign-in (credential seed) key.
 *
 * Runs after migrateLoginInstalls, which turns this machine's login rows
 * into Credentials first. Idempotent: a re-run finds nothing to fold.
 */
import { createObject, deleteField, iv, list, mutate, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { CAPABILITY_TYPE, linkTarget } from "./capabilities";
import { seedFor } from "./credentials";
import { MACHINE_TYPE } from "./machine";
import { CATALOG } from "./skillmgr";

/** The retired per-(key x machine x account) status row. Read only by the boot migrations. */
export interface LegacyInstall {
	id: string;
	key: string;
	machineId: string;
	account: string;
	status: string;
	error: string;
	checkedAt: number;
	channel: string;
}

export async function legacyInstalls(): Promise<LegacyInstall[]> {
	return (await queryAll({ type: "install" })).map((r) => ({
		id: r.id,
		key: str(r.fields, "key"),
		machineId: str(r.fields, "machine_id"),
		account: str(r.fields, "account"),
		status: str(r.fields, "status") || "missing",
		error: str(r.fields, "error"),
		checkedAt: r.fields["checked_at"]?.intValue ?? 0,
		channel: str(r.fields, "channel"),
	}));
}

/** A sign-in key (a Credential seed) that is not catalog software. */
const loginKey = (key: string): boolean => !!seedFor(key) && !CATALOG.some((c) => c.key === key);

function capabilityFields(key: string, machine: string, state: { status: string; error: string; checkedAt: number; channel: string }): Record<string, ValueJSON> {
	const entry = CATALOG.find((c) => c.key === key);
	return {
		key: sv(key),
		served_by: sv(machine),
		status: sv(state.status),
		error: sv(state.error),
		checked_at: iv(state.checkedAt || Date.now()),
		...(state.channel ? { channel: sv(state.channel) } : {}),
		description: sv(entry?.description ?? ""),
	};
}

export async function migrateCapabilities(): Promise<{ folded: number; created: number; machinesCleared: number; vanished: number; normalized: number }> {
	let folded = 0;
	let created = 0;
	let machinesCleared = 0;
	let normalized = 0;
	const vanish: string[] = [];

	// The earliest capability per (key x machine), across the whole vault.
	const firstCap = new Map<string, QueryRow>();
	const capRows = (await queryAll({ type: CAPABILITY_TYPE })).sort((a, b) => a.createdAt - b.createdAt);
	for (const r of capRows) {
		const id = `${str(r.fields, "key")}@${linkTarget(r.fields, "served_by")}`;
		if (!firstCap.has(id)) firstCap.set(id, r);
	}

	// 1. Fold install rows.
	const installs = await legacyInstalls();
	for (const row of installs) {
		vanish.push(row.id);
		if (row.account || !row.key || !row.machineId || loginKey(row.key)) continue;
		const id = `${row.key}@${row.machineId}`;
		const cap = firstCap.get(id);
		if (!cap) {
			const made = await createObject(CATALOG.find((c) => c.key === row.key)?.name ?? row.key, CAPABILITY_TYPE, capabilityFields(row.key, row.machineId, row));
			firstCap.set(id, { id: made.id, fields: {}, createdAt: Date.now() } as QueryRow);
			created += 1;
		} else {
			await setField(cap.id, "status", sv(row.status));
			await setField(cap.id, "error", sv(row.error));
			await setField(cap.id, "checked_at", iv(row.checkedAt || Date.now()));
			if (!str(cap.fields, "channel") && row.channel) await setField(cap.id, "channel", sv(row.channel));
		}
		folded += 1;
	}

	// 2. Machine `capabilities` lists.
	for (const m of await queryAll({ type: MACHINE_TYPE })) {
		if (m.fields["capabilities"] === undefined) continue;
		const mid = str(m.fields, "machine_id");
		for (const key of list(m.fields, "capabilities")) {
			const id = `${key}@${mid}`;
			if (!mid || loginKey(key) || firstCap.has(id)) continue;
			const made = await createObject(CATALOG.find((c) => c.key === key)?.name ?? key, CAPABILITY_TYPE, capabilityFields(key, mid, { status: "missing", error: "", checkedAt: 0, channel: "" }));
			firstCap.set(id, { id: made.id, fields: {}, createdAt: Date.now() } as QueryRow);
			created += 1;
		}
		await deleteField(m.id, "capabilities");
		machinesCleared += 1;
	}

	// 3. Converge the capabilities that existed before this run.
	const keep = new Set([...firstCap.values()].map((r) => r.id));
	for (const r of capRows) {
		if (!keep.has(r.id) || loginKey(str(r.fields, "key"))) {
			vanish.push(r.id);
			continue;
		}
		const served = r.fields["served_by"];
		if (served?.linkValue) {
			await setField(r.id, "served_by", sv(served.linkValue.targetId));
			normalized += 1;
		}
		for (const field of ["install", "account", "auth"]) {
			if (r.fields[field] === undefined) continue;
			await deleteField(r.id, field);
			normalized += 1;
		}
	}

	if (vanish.length > 0) await mutate("vanish", { object_ids: vanish });
	return { folded, created, machinesCleared, vanished: vanish.length, normalized };
}
