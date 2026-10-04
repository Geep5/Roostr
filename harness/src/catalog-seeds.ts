/**
 * The catalogs as objects. `CATALOG` (skillmgr.ts) and `PROMPT_SEEDS`
 * (prompts.ts) are seeds, not runtime lookups; once per boot they converge
 * onto the vault, like Credential templates (credential-seeds.ts):
 *
 * - **Skills**: one shared Skill object per catalog key - what the software
 *   is and how an agent uses it. Its name is every display of the key.
 * - **Agent kinds**: one Template per kind per space, targeting the space's
 *   agent type: the kind's system prompt, its Skills and its setting
 *   defaults. Creating an agent from it (the website's template picker, or
 *   `setup --kind`) copies those onto the agent. Each setting the kind names
 *   is a property of the space. A template is only rewritten while nobody
 *   has edited it (it still hashes to `seed_hash`).
 *
 * The retired `descriptor` cards these replaced are vanished.
 */

import { bv, createObject, deleteField, iv, lv, mutate, plainValue, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { PROMPT_SEEDS, ensureSystemPrompt, type AgentKindEntry } from "./prompts";
import { CATALOG, upsertSkillObject } from "./skillmgr";
import { SKILL_TYPE, SKILLS_KEY } from "./skills";
import { linkList } from "./tool-objects";

const TEMPLATE_TYPE = "template";
const PROMPT_KEY = "prompt";
/** The card objects Skills and agent Templates replaced. */
const DESCRIPTOR_TYPE = "descriptor";

/**
 * A template's own identity and bookkeeping, never copied onto what it
 * creates. Mirrors the website's TEMPLATE_OWN (src/lib/create.ts).
 */
export const TEMPLATE_OWN: Record<string, true> = { name: true, target_type: true, channel: true, error: true, createdDate: true, modifiedDate: true, type_key: true, repeat: true, seed_key: true, seed_hash: true };

/** The per-space agent type object agent-kind templates point at (the engine seeds it). */
export const agentTypeId = (space: string): string => `bundled-type-agent-${space.slice(0, 8)}`;

/** A space's agent-kind templates for `kind`, oldest first. */
export function kindTemplates(templates: QueryRow[], kind: string, space: string): QueryRow[] {
	return templates
		.filter((t) => str(t.fields, "seed_key") === kind && str(t.fields, "channel") === space && str(t.fields, "target_type") === agentTypeId(space))
		.sort((a, b) => a.createdAt - b.createdAt);
}

/** The keys a kind's template seeds: prompt, Skills, and every setting it names - blank ones too, so filling one in is an edit. */
const seededKeys = (seed: AgentKindEntry): string[] => [PROMPT_KEY, SKILLS_KEY, ...seed.fields.map((f) => f.key)];

/** A value as its targets/scalars, a one-item list the same as its item, so a link and a one-link list compare equal. */
function canon(v: ValueJSON | undefined): unknown {
	const plain = plainValue(v);
	return Array.isArray(plain) && plain.length === 1 ? plain[0] : plain;
}

/** What `fields` hold at the seed's keys: equal to a template's `seed_hash` while nobody has edited it. */
export function kindHash(seed: AgentKindEntry, fields: Record<string, ValueJSON>): string {
	return Bun.hash(JSON.stringify(seededKeys(seed).map((k) => [k, canon(fields[k])]))).toString(16);
}

/** The template fields `seed` wants: its space's prompt object, its Skill objects (`skillIds` by catalog key), its defaults. */
export function kindFields(seed: AgentKindEntry, promptId: string, skillIds: Map<string, string>): Record<string, ValueJSON> {
	const out: Record<string, ValueJSON> = { [PROMPT_KEY]: { linkValue: { targetId: promptId } } };
	const skills = seed.skills.flatMap((k) => skillIds.get(k) ?? []);
	if (skills.length > 0) out[SKILLS_KEY] = linkList(SKILLS_KEY, skills);
	for (const f of seed.fields) {
		const value = seed.defaults[f.key];
		if (value) out[f.key] = sv(value);
	}
	return out;
}

/** Make the template's seeded keys exactly `fields`, writing only what differs. */
async function writeKind(tpl: QueryRow, seed: AgentKindEntry, fields: Record<string, ValueJSON>): Promise<void> {
	for (const k of seededKeys(seed)) {
		if (fields[k]) {
			if (JSON.stringify(canon(fields[k])) !== JSON.stringify(canon(tpl.fields[k]))) await setField(tpl.id, k, fields[k]);
		} else if (tpl.fields[k]) await deleteField(tpl.id, k);
	}
}

/**
 * Converge the catalogs onto the vault: Skill objects, then each space's
 * kind properties and agent-kind templates, then vanish descriptor cards.
 * Idempotent - with nothing changed it writes nothing.
 */
export async function seedCatalog(): Promise<void> {
	const out = { skills: 0, properties: 0, templates: 0, upgraded: 0, deduped: 0, descriptors: 0 };

	const skillRows = await queryAll({ type: SKILL_TYPE });
	for (const entry of CATALOG) if (await upsertSkillObject(entry, skillRows)) out.skills += 1;
	// Two computers seeding at once may each have made one: link the oldest.
	const skillIds = new Map<string, string>();
	for (const r of (await queryAll({ type: SKILL_TYPE })).sort((a, b) => a.createdAt - b.createdAt)) {
		const key = str(r.fields, "key");
		if (key && !skillIds.has(key)) skillIds.set(key, r.id);
	}

	const spaces = await queryAll({ type: "channel" });
	const relations = await queryAll({ type: "relation" });
	for (const space of spaces) {
		const have = new Set(relations.filter((r) => str(r.fields, "channel") === space.id).map((r) => str(r.fields, "key")));
		for (const f of PROMPT_SEEDS.flatMap((s) => s.fields)) {
			if (have.has(f.key)) continue;
			await createObject(f.label, "relation", {
				channel: sv(space.id),
				key: sv(f.key),
				name: sv(f.label),
				description: sv(f.note),
				format: sv("shorttext"),
				iconEmoji: sv("⚙️"),
				hidden: bv(false),
				readOnly: bv(false),
				maxCount: iv(1),
				options: lv([]),
				bundled: bv(false),
			});
			have.add(f.key);
			out.properties += 1;
		}
	}

	const templates = await queryAll({ type: TEMPLATE_TYPE });
	for (const space of spaces) {
		for (const seed of PROMPT_SEEDS) {
			const prompt = await ensureSystemPrompt(seed, space.id);
			const fields = kindFields(seed, prompt.id, skillIds);
			const hash = kindHash(seed, fields);
			const mine = kindTemplates(templates, seed.key, space.id);
			if (mine.length === 0) {
				await createObject(seed.name, TEMPLATE_TYPE, { ...fields, channel: sv(space.id), target_type: sv(agentTypeId(space.id)), seed_key: sv(seed.key), seed_hash: sv(hash) });
				out.templates += 1;
				continue;
			}
			const untouched = (t: QueryRow) => kindHash(seed, t.fields) === str(t.fields, "seed_hash");
			for (const extra of mine.slice(1)) {
				if (!untouched(extra)) continue;
				await mutate("delete", { object_id: extra.id });
				out.deduped += 1;
			}
			const keep = mine[0];
			if (untouched(keep) && str(keep.fields, "seed_hash") !== hash) {
				await writeKind(keep, seed, fields);
				await setField(keep.id, "seed_hash", sv(hash));
				out.upgraded += 1;
			}
		}
	}

	const cards = await queryAll({ type: DESCRIPTOR_TYPE });
	if (cards.length > 0) {
		await mutate("vanish", { object_ids: cards.map((c) => c.id) });
		out.descriptors = cards.length;
	}

	if (Object.values(out).some((n) => n > 0)) console.log("[harness] catalog seed:", JSON.stringify(out));
}
