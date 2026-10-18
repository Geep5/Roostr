/**
 * Skills live in spaces (skills.ts listSkills): a Skill with no space is
 * folded into the spaces that use it, once, by whichever computer gets
 * there first.
 *
 * - A default (a catalog Skill with a `key`, or the Roostr Guide): each
 *   space already holds its own copy (catalog-seeds.ts, guide.ts).
 * - Hand-written: copied into every space you own - or, when it is one
 *   agent's own playbook, into that agent's space only - under a fixed id
 *   per space, so two computers folding at once make one copy.
 *
 * Every object that lists the spaceless Skill then lists its own space's
 * copy instead (or drops it, when its space has none), and the spaceless
 * one is deleted - deleted, not vanished: vanishing a Skill would take the
 * agents that list it along.
 */
import { createDefault, fetchObject, mutate, ownedSpaces, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { appendMarkdown } from "./markdown";
import { GUIDE_SEED_KEY, objectText, SKILL_TYPE, SKILLS_KEY, skillIds } from "./skills";

/** The fixed id of a hand-written spaceless Skill's copy in a space. */
const copyId = (skill: string, space: string): string => `skill-copy-${skill}-${space}`;

/** Fields a Skill's copy does not take over: its space is the copy's own; `scope` is retired. */
const NOT_COPIED = new Set(["channel", "scope"]);

/** A spaceless Skill's fields for its copy in `space` (its name is the create's own). */
export function copyFields(source: { fields: Record<string, ValueJSON> }, space: string): Record<string, ValueJSON> {
	const fields: Record<string, ValueJSON> = { channel: sv(space) };
	for (const [k, v] of Object.entries(source.fields)) if (!NOT_COPIED.has(k) && k !== "name") fields[k] = v;
	return fields;
}

/** Write `sourceId`'s page onto the new copy `id`. */
export async function copyBody(sourceId: string, id: string): Promise<void> {
	const text = objectText(await fetchObject(sourceId));
	if (text.trim()) await appendMarkdown(id, text);
}

/** The spaceless Skill `match` picks among `rows` (the oldest), whose page a space's new default copy starts from. */
export function spacelessSource(rows: QueryRow[], match: (r: QueryRow) => boolean): QueryRow | undefined {
	return rows.filter((r) => !str(r.fields, "channel") && match(r)).sort((a, b) => a.createdAt - b.createdAt)[0];
}

export async function foldSpacelessSkills(): Promise<{ folded: number; copies: number; relinked: number }> {
	const out = { folded: 0, copies: 0, relinked: 0 };
	const skills = await queryAll({ type: SKILL_TYPE });
	const spaceless = skills.filter((s) => !str(s.fields, "channel"));
	if (spaceless.length === 0) return out;
	const owned = (await ownedSpaces()).map((s) => s.id);
	const agentSpace = new Map((await queryAll({ type: "agent" })).map((a) => [a.id, str(a.fields, "channel")]));

	// Spaceless Skill id → space → the Skill that stands in for it there.
	const standIns = new Map<string, Map<string, string>>();
	for (const s of spaceless) {
		const here = new Map<string, string>();
		const key = str(s.fields, "key");
		if (key || str(s.fields, "seed_key") === GUIDE_SEED_KEY) {
			// A default: the space's own copy (the oldest, should two computers each have made one).
			for (const r of skills.filter((r) => str(r.fields, "channel")).sort((a, b) => a.createdAt - b.createdAt)) {
				const same = key ? str(r.fields, "key") === key : str(r.fields, "seed_key") === GUIDE_SEED_KEY;
				const space = str(r.fields, "channel");
				if (same && !here.has(space)) here.set(space, r.id);
			}
		} else {
			const owner = str(s.fields, "agent");
			const spaces = owner ? [agentSpace.get(owner) ?? ""].filter(Boolean) : owned;
			const source = await fetchObject(s.id);
			for (const space of spaces) {
				const id = copyId(s.id, space);
				if (skills.some((r) => r.id === id) || (await made(id))) {
					here.set(space, id);
					continue;
				}
				if (!(await createDefault(str(source.fields, "name") || "Skill", SKILL_TYPE, copyFields(source, space), id))) continue;
				await copyBody(s.id, id);
				here.set(space, id);
				out.copies += 1;
			}
		}
		standIns.set(s.id, here);
	}

	// Whatever lists a spaceless Skill lists its own space's stand-in instead.
	const listing = (await queryAll({ filters: [{ key: SKILLS_KEY, condition: "notEmpty" }] })) as QueryRow[];
	for (const o of listing) {
		const ids = skillIds(o.fields);
		if (!ids.some((id) => standIns.has(id))) continue;
		const space = str(o.fields, "channel");
		const next = [...new Set(ids.flatMap((id) => (standIns.has(id) ? (standIns.get(id)!.get(space) ?? []) : [id])))];
		// The links written in place: importing tool-objects here would close a module cycle through skillmgr.
		await setField(o.id, SKILLS_KEY, { valuesValue: { items: next.map((targetId) => ({ linkValue: { relationKey: SKILLS_KEY, targetId } })) } });
		out.relinked += 1;
	}

	for (const s of spaceless) {
		await mutate("delete", { object_id: s.id });
		out.folded += 1;
	}
	return out;
}

/** Whether an object is still there under `id` (in the bin included). */
async function made(id: string): Promise<boolean> {
	return fetchObject(id).then(() => true, () => false);
}
