/**
 * Credentials as properties. Every setting of a Credential is an ordinary
 * property of its space (Account, Service, Login page, Signed-in host and
 * cookie, one property per key - CREDENTIAL_PROPERTIES), and the service
 * presets are Credential templates. This seeds both, once per space, like
 * system prompts: created once, then the objects are the truth.
 *
 * - Properties are ordinary (not bundled) relations, so an older engine on
 *   another computer never retires them or the values behind them.
 * - A template is only rewritten while nobody has edited its recipe (it
 *   still hashes to `seed_hash`).
 * - Setting Service on a credential with no recipe copies that service's
 *   template in the credential's space onto it (else the code seed).
 */

import { bv, createObject, iv, lv, mutate, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { CREDENTIAL_TYPE, pinOf } from "./credential-objects";
import { machineId } from "./roster";
import { ACTIONS_FIELD, CREDENTIAL_PROPERTIES, CREDENTIAL_SEEDS, KEY_PREFIX, legacyKeyName, recipeFieldKeys, recipeHash, recipeMissing, seedFor, seedRecipeFields } from "./credentials";

/**
 * The first shape of credential actions: one `action_<key>` field per action
 * holding its description JSON. Descriptions are code now; the object keeps
 * only which actions it allows (`actions`), so these become that list.
 */
const OLD_ACTION_PREFIX = "action_";

const TEMPLATE_TYPE = "template";
/** Shapes from before keys were properties; converted, then removed. */
const LEGACY_FIELDS = ["key_fields", "secret"] as const;

/** The per-space credential type object templates point at (the engine seeds it). */
export const credentialTypeId = (space: string): string => `bundled-type-${CREDENTIAL_TYPE}-${space.slice(0, 8)}`;

/** Make `target`'s recipe exactly `fields` (recipe keys absent from it are removed). */
async function writeRecipe(id: string, current: Record<string, ValueJSON>, fields: Record<string, ValueJSON>): Promise<void> {
	for (const key of new Set([...recipeFieldKeys(current), ...Object.keys(fields)])) {
		if (fields[key]) await setField(id, key, fields[key]);
		else if (current[key]) await mutate("delete_field", { object_id: id, key });
	}
}

/**
 * Old `key_fields` + `secret` JSON → one `key_*` field per key, values kept.
 * The old fields stay on the credential for now: a computer still running
 * the previous harness reads its keys from `secret` (the Discord bot poller
 * among them), and deleting it would cut that computer off until it updates.
 * New code never reads them. Returns whether it wrote anything.
 */
async function convertLegacyKeys(row: QueryRow): Promise<boolean> {
	if (!LEGACY_FIELDS.some((k) => row.fields[k])) return false;
	let values: Record<string, unknown> = {};
	try {
		values = JSON.parse(str(row.fields, "secret") || "{}") as Record<string, unknown>;
	} catch { /* unreadable: the keys start empty and the person pastes them again */ }
	const names = new Set<string>([
		...(row.fields["key_fields"]?.valuesValue?.items ?? []).map((i) => i.mapValue?.entries?.["key"]?.stringValue ?? "").filter(Boolean),
		...Object.keys(values),
	]);
	let wrote = false;
	for (const name of names) {
		const field = `${KEY_PREFIX}${legacyKeyName(name)}`;
		if (row.fields[field]) continue;
		const v = values[name];
		await setField(row.id, field, sv(typeof v === "string" ? v : ""));
		wrote = true;
	}
	return wrote;
}

export async function seedCredentials(): Promise<{ properties: number; templates: number; upgraded: number; deduped: number; converted: number; filled: number; stamped: number }> {
	const out = { properties: 0, templates: 0, upgraded: 0, deduped: 0, converted: 0, filled: 0, stamped: 0 };
	const spaces = await queryAll({ type: "channel" });

	// Properties first: a credential's fields show only through them.
	const relations = await queryAll({ type: "relation" });
	for (const space of spaces) {
		const have = new Set(relations.filter((r) => str(r.fields, "channel") === space.id).map((r) => str(r.fields, "key")));
		for (const p of CREDENTIAL_PROPERTIES) {
			if (have.has(p.key)) continue;
			await createObject(p.name, "relation", {
				channel: sv(space.id),
				key: sv(p.key),
				name: sv(p.name),
				format: sv(p.format),
				iconEmoji: sv(p.emoji),
				hidden: bv(false),
				readOnly: bv(false),
				maxCount: iv(0),
				options: {
					valuesValue: {
						items: (p.options ?? []).map((o, i) => ({
							mapValue: { entries: { id: sv(`${p.key}-${o.text}`), text: sv(o.text), color: sv(o.color), orderId: sv(String(i).padStart(6, "0")) } },
						})),
					},
				},
				bundled: bv(false),
			});
			out.properties += 1;
		}
	}

	let templates = (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));
	for (const space of spaces) {
		for (const seed of CREDENTIAL_SEEDS) {
			const fields = seedRecipeFields(seed);
			const hash = recipeHash(fields);
			const mine = templates
				.filter((t) => str(t.fields, "seed_key") === seed.key && str(t.fields, "channel") === space.id)
				.sort((a, b) => a.createdAt - b.createdAt);
			if (mine.length === 0) {
				await createObject(seed.label, TEMPLATE_TYPE, { ...fields, channel: sv(space.id), target_type: sv(credentialTypeId(space.id)), seed_key: sv(seed.key), seed_hash: sv(hash) });
				out.templates += 1;
				continue;
			}
			// Two computers seeding at once each made one: keep the oldest, drop untouched extras.
			const untouched = (t: QueryRow) => recipeHash(t.fields) === str(t.fields, "seed_hash");
			for (const extra of mine.slice(1)) {
				if (!untouched(extra)) continue;
				await mutate("delete", { object_id: extra.id });
				out.deduped += 1;
			}
			const keep = mine[0];
			// Templates seeded with the old key shape were never edited as properties: reseed them.
			const legacy = LEGACY_FIELDS.some((k) => keep.fields[k]);
			if (legacy || (untouched(keep) && str(keep.fields, "seed_hash") !== hash)) {
				await writeRecipe(keep.id, keep.fields, fields);
				for (const k of LEGACY_FIELDS) if (keep.fields[k]) await mutate("delete_field", { object_id: keep.id, key: k });
				await setField(keep.id, "seed_hash", sv(hash));
				out.upgraded += 1;
			}
		}
	}
	// Templates first, so a credential stamped below copies its template's Allowed actions.
	for (const tpl of (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"))) {
		if (await stampActions(tpl)) out.stamped += 1;
	}
	templates = (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));

	for (const cred of await queryAll({ type: CREDENTIAL_TYPE })) {
		if (await convertLegacyKeys(cred)) out.converted += 1;
	}
	// A credential whose Service is set but that says nothing about signing in
	// takes its space's template for that service.
	for (const cred of await queryAll({ type: CREDENTIAL_TYPE })) {
		if (await fillCredential(cred, templates)) out.filled += 1;
	}
	for (const cred of await queryAll({ type: CREDENTIAL_TYPE })) {
		if (await stampActions(cred, templates)) out.stamped += 1;
	}
	return out;
}

/**
 * A credential whose Service is set but that says nothing about signing in
 * takes its space's template for that service (else the code seed). The
 * computer that looks after it does the writing - or any, before one is set.
 * Returns whether it wrote.
 */
export async function fillCredential(cred: { id: string; fields: Record<string, ValueJSON> }, templates?: QueryRow[]): Promise<boolean> {
	const service = str(cred.fields, "service");
	if (!service || !recipeMissing(cred.fields)) return false;
	const pin = await pinOf(cred.fields);
	if (pin && pin !== (await machineId())) return false;
	const pool = templates ?? (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));
	const tpl = pool.find((t) => str(t.fields, "seed_key") === service && str(t.fields, "channel") === str(cred.fields, "channel"));
	const seed = seedFor(service);
	const source = tpl ? Object.fromEntries(recipeFieldKeys(tpl.fields).filter((k) => tpl.fields[k]).map((k) => [k, tpl.fields[k]])) : seed ? seedRecipeFields(seed) : null;
	if (!source) return false;
	// The credential's own Service stays; a template's description only fills an empty one.
	const fields = { ...source, service: cred.fields["service"], ...(cred.fields["description"] ? { description: cred.fields["description"] } : {}) };
	await writeRecipe(cred.id, cred.fields, fields);
	// An unnamed credential takes the service's name ("Kimi (Moonshot)").
	const name = str(cred.fields, "name").trim();
	const label = tpl ? str(tpl.fields, "name") : seed?.label ?? "";
	if (label && (!name || name === "New credential")) await setField(cred.id, "name", sv(label));
	return true;
}

/**
 * Give a credential (or template) its Allowed actions when it has none, and
 * retire the first shape (`action_<key>` description fields): their keys
 * become the list, then they go. With neither, it allows what its space's
 * template for the service allows, else every action the service has. A
 * list that exists - even an empty one - is the person's and is kept.
 * No pin check, unlike fillCredential: every machine writes the same
 * bytes, so concurrent stamps converge. Returns whether it wrote.
 */
export async function stampActions(cred: { id: string; fields: Record<string, ValueJSON> }, templates?: QueryRow[]): Promise<boolean> {
	const old = Object.keys(cred.fields).filter((k) => k.startsWith(OLD_ACTION_PREFIX) && k.length > OLD_ACTION_PREFIX.length);
	let wrote = false;
	if (!cred.fields[ACTIONS_FIELD]) {
		let allow: ValueJSON | undefined;
		if (old.length > 0) allow = lv(old.map((k) => k.slice(OLD_ACTION_PREFIX.length)));
		else {
			const service = str(cred.fields, "service");
			const seed = seedFor(service);
			if (service && seed?.actions?.length && !recipeMissing(cred.fields)) {
				const pool = templates ?? (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));
				const tpl = pool.find((t) => t.id !== cred.id && str(t.fields, "seed_key") === service && str(t.fields, "channel") === str(cred.fields, "channel"));
				allow = tpl?.fields[ACTIONS_FIELD] ?? seedRecipeFields(seed)[ACTIONS_FIELD];
			}
		}
		if (allow) {
			await setField(cred.id, ACTIONS_FIELD, allow);
			wrote = true;
		}
	}
	for (const k of old) await mutate("delete_field", { object_id: cred.id, key: k });
	return wrote || old.length > 0;
}
