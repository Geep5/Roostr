/**
 * Boot migration into the capability-object model (capabilities.ts):
 * `machine.capabilities` (the retired flat string list) becomes one
 * capability object per (key x machine): `served_by` links the machine id,
 * `install` links the install row for that key on that machine when one
 * exists. The machine's `capabilities` field is then deleted.
 *
 * Runs with the other boot migrations, after publishCapabilityObjects, so
 * this machine's own capabilities already exist and only legacy rows from
 * other machines are converted here. Idempotent: a re-run finds no
 * `capabilities` field.
 */
import { createObject, deleteField, list, queryAll, str, sv } from "./api";
import { CAPABILITY_TYPE, linkTarget, linkValue } from "./capabilities";
import { fetchInstallations } from "./descriptors";
import { MACHINE_TYPE } from "./machine";
import { CATALOG } from "./skillmgr";

/** Name/description for a capability object, from the catalog that owns the key. */
function seedFor(key: string): { name: string; description: string } {
	const skill = CATALOG.find((c) => c.key === key);
	return skill ? { name: skill.name, description: skill.description } : { name: key, description: "" };
}

export async function migrateCapabilities(): Promise<{ created: number; machinesCleared: number }> {
	let created = 0;
	let machinesCleared = 0;
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

	return { created, machinesCleared };
}
