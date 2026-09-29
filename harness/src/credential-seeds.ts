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
import { ACTION_PREFIX, CREDENTIAL_PROPERTIES, CREDENTIAL_SEEDS, KEY_PREFIX, legacyKeyName, recipeFieldKeys, recipeHash, recipeMissing, seedFor, seedRecipeFields } from "./credentials";

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
				options: lv([]),
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
			// Same for one seeded before actions existed: untouched, just actionless.
			const legacy = LEGACY_FIELDS.some((k) => keep.fields[k]);
			const actionless = (seed.actions?.length ?? 0) > 0 && !Object.keys(keep.fields).some((k) => k.startsWith(ACTION_PREFIX));
			if (legacy || (untouched(keep) && (str(keep.fields, "seed_hash") !== hash || actionless))) {
				await writeRecipe(keep.id, keep.fields, fields);
				for (const k of LEGACY_FIELDS) if (keep.fields[k]) await mutate("delete_field", { object_id: keep.id, key: k });
				await setField(keep.id, "seed_hash", sv(hash));
				out.upgraded += 1;
			}
		}
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
	// Credentials filled before actions existed carry none: stamp the service's
	// set from its space template. Add-only - an action field someone edited
	// is never rewritten, and one they deleted stays deleted while any other
	// action field remains (removing them ALL reads as a pre-actions object).
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
 * A credential with a recipe but no action declarations predates them: copy
 * the `action_*` fields from its service's template in its space (else the
 * code seed). Add-only, so it never overwrites; a credential that already
 * declares any action is its owner's. Returns whether it wrote.
 */
export async function stampActions(cred: { id: string; fields: Record<string, ValueJSON> }, templates?: QueryRow[]): Promise<boolean> {
	const service = str(cred.fields, "service");
	if (!service || recipeMissing(cred.fields)) return false;
	if (Object.keys(cred.fields).some((k) => k.startsWith(ACTION_PREFIX))) return false;
	const pin = await pinOf(cred.fields);
	if (pin && pin !== (await machineId())) return false;
	const pool = templates ?? (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));
	const tpl = pool.find((t) => str(t.fields, "seed_key") === service && str(t.fields, "channel") === str(cred.fields, "channel"));
	const seed = seedFor(service);
	const actions = Object.entries(tpl?.fields ?? (seed ? seedRecipeFields(seed) : {})).filter(([k]) => k.startsWith(ACTION_PREFIX));
	if (actions.length === 0) return false;
	for (const [key, value] of actions) await setField(cred.id, key, value);
	return true;
}
