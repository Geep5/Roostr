/**
 * Credential templates: the service presets as objects. Each space gets one
 * Credential template per seed (X, Matcherino, LinkedIn, Discord bot,
 * Anthropic, Kimi); a person starts a credential from one, edits it, or
 * writes a new one - a new login needs no code.
 *
 * Seeded like system prompts: created once, then the object is the truth.
 * A template is only rewritten while nobody has edited its recipe (its
 * recipe still hashes to `seed_hash`), so a seed fix reaches untouched
 * templates and never clobbers a person's change.
 *
 * Credentials made before recipes lived on objects get their seed's recipe
 * once (they have a `service` and no recipe of their own).
 */

import { createObject, mutate, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { CREDENTIAL_TYPE } from "./credential-objects";
import { CREDENTIAL_SEEDS, RECIPE_KEYS, recipeHash, recipeMissing, seedFor, seedRecipeFields } from "./credentials";

const TEMPLATE_TYPE = "template";

/** The per-space credential type object templates point at (the engine seeds it). */
export const credentialTypeId = (space: string): string => `bundled-type-${CREDENTIAL_TYPE}-${space.slice(0, 8)}`;

async function writeRecipe(id: string, fields: Record<string, ValueJSON>): Promise<void> {
	for (const key of RECIPE_KEYS) {
		if (fields[key]) await setField(id, key, fields[key]);
		else await mutate("delete_field", { object_id: id, key }).catch(() => {});
	}
}

export async function seedCredentials(): Promise<{ created: number; upgraded: number; deduped: number; backfilled: number }> {
	let created = 0;
	let upgraded = 0;
	let deduped = 0;
	let backfilled = 0;
	const spaces = await queryAll({ type: "channel" });
	const templates = (await queryAll({ type: TEMPLATE_TYPE })).filter((t) => str(t.fields, "seed_key"));
	for (const space of spaces) {
		for (const seed of CREDENTIAL_SEEDS) {
			const fields = seedRecipeFields(seed);
			const hash = recipeHash(fields);
			const mine = templates
				.filter((t) => str(t.fields, "seed_key") === seed.key && str(t.fields, "channel") === space.id)
				.sort((a, b) => a.createdAt - b.createdAt);
			if (mine.length === 0) {
				await createObject(seed.label, TEMPLATE_TYPE, {
					...fields,
					channel: sv(space.id),
					target_type: sv(credentialTypeId(space.id)),
					seed_key: sv(seed.key),
					seed_hash: sv(hash),
				});
				created += 1;
				continue;
			}
			// Two computers seeding at once each made one: keep the oldest, drop untouched extras.
			const untouched = (t: QueryRow) => recipeHash(t.fields) === str(t.fields, "seed_hash");
			for (const extra of mine.slice(1)) {
				if (!untouched(extra)) continue;
				await mutate("delete", { object_id: extra.id });
				deduped += 1;
			}
			const keep = mine[0];
			if (untouched(keep) && str(keep.fields, "seed_hash") !== hash) {
				await writeRecipe(keep.id, fields);
				await setField(keep.id, "seed_hash", sv(hash));
				upgraded += 1;
			}
		}
	}
	for (const cred of await queryAll({ type: CREDENTIAL_TYPE })) {
		const seed = seedFor(str(cred.fields, "service"));
		if (!seed || !recipeMissing(cred.fields)) continue;
		await writeRecipe(cred.id, seedRecipeFields(seed));
		backfilled += 1;
	}
	return { created, upgraded, deduped, backfilled };
}
