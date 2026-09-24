/**
 * Boot migration into the capability-object model (capabilities.ts):
 *
 *  1. `machine.capabilities` (the retired flat string list) becomes one
 *     capability object per (key x machine): `served_by` links the machine
 *     id, `install` links the install row for that key on that machine when
 *     one exists. The machine's `capabilities` field is then deleted.
 *  2. Every object's `requires` string items become links to the matching
 *     capability object: key + the machine that would serve the object (its
 *     `served_by` pin, else its space's), else by key alone. Keys no
 *     machine offers stay strings and convert on a later boot.
 *
 * Runs with the other boot migrations, after publishCapabilityObjects, so
 * this machine's own capabilities already exist and only legacy rows from
 * other machines (and legacy requires) are converted here. Idempotent: a
 * re-run finds no `capabilities` field and no string requires.
 */
import { createObject, deleteField, fetchObject, list, queryAll, setField, str, sv, type ValueJSON } from "./api";
import { CAPABILITY_TYPE, chooseCapability, fetchCapabilities, linkTarget, linkValue, requiresItems, type CapabilityRow } from "./capabilities";
import { CREDENTIALS } from "./credentials";
import { fetchInstallations } from "./descriptors";
import { MACHINE_TYPE } from "./machine";
import { CATALOG } from "./skillmgr";

/** Name/description for a capability object, from the catalog that owns the key. */
function seedFor(key: string): { name: string; description: string } {
	const skill = CATALOG.find((c) => c.key === key);
	if (skill) return { name: skill.name, description: skill.description };
	const credential = CREDENTIALS.find((c) => c.key === key);
	if (credential) return { name: credential.label, description: credential.note };
	return { name: key, description: "" };
}

export async function migrateCapabilities(): Promise<{ created: number; machinesCleared: number; requiresConverted: number }> {
	let created = 0;
	let machinesCleared = 0;
	let requiresConverted = 0;

	// 1. machine.capabilities -> capability objects.
	const installs = await fetchInstallations();
	const installIdFor = (key: string, machine: string) => installs.find((i) => i.key === key && i.machineId === machine && !i.account)?.id ?? "";
	const have = new Set((await queryAll({ type: CAPABILITY_TYPE })).map((r) => `${str(r.fields, "key")}@${linkTarget(r.fields, "served_by")}`));
	for (const m of await queryAll({ type: MACHINE_TYPE })) {
		if (m.fields["capabilities"] === undefined) continue;
		const mid = str(m.fields, "machine_id");
		for (const key of list(m.fields, "capabilities")) {
			if (!mid || have.has(`${key}@${mid}`)) continue;
			const seed = seedFor(key);
			const installId = installIdFor(key, mid);
			await createObject(seed.name, CAPABILITY_TYPE, {
				key: sv(key),
				served_by: linkValue(mid),
				...(installId ? { install: linkValue(installId) } : {}),
				description: sv(seed.description),
			});
			have.add(`${key}@${mid}`);
			created += 1;
		}
		await deleteField(m.id, "capabilities");
		machinesCleared += 1;
	}

	// 2. requires string items -> capability links.
	const caps = await fetchCapabilities();
	const byKeyMachine = new Map(caps.map((c) => [`${c.key}@${c.servedBy}`, c]));
	const byKey = new Map<string, CapabilityRow[]>();
	for (const c of caps) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
	for (const row of await queryAll({ filters: [{ key: "requires", condition: "notEmpty" }] })) {
		const items = requiresItems(row.fields);
		if (!items.some((i) => i.stringValue)) continue;
		// The machine that would serve the object: its own pin, else its space's.
		let server = linkTarget(row.fields, "served_by");
		const channel = str(row.fields, "channel");
		if (!server && channel) {
			const space = await fetchObject(channel).catch(() => null);
			if (space) server = linkTarget(space.fields, "served_by");
		}
		let changed = false;
		const next = items.map((item) => {
			const key = item.stringValue;
			if (!key) return item;
			const cap = (server && byKeyMachine.get(`${key}@${server}`)) || chooseCapability(byKey.get(key) ?? [], server);
			if (!cap) return item;
			changed = true;
			return linkValue(cap.id);
		});
		if (!changed) continue;
		await setField(row.id, "requires", { valuesValue: { items: next } });
		requiresConverted += 1;
	}

	return { created, machinesCleared, requiresConverted };
}
