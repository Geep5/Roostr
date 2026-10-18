/**
 * The Roostr Guide as a Skill: how Roostr works, for agents.
 *
 * `docs/roostr-guide.md` is the one source. Each space you own holds its own
 * copy, a Skill under a fixed id (two computers seeding at once make one;
 * a copy a person deleted stays deleted), which that space's agents list
 * and read with `skill_read`. The body is real blocks (headings, lists), so
 * it also reads well in the app.
 *
 * When the file changes, an untouched copy is rewritten; a copy someone
 * edited in the app keeps their edit. `seed_hash` is the file the copy was
 * made from; `seed_text` the copy's text right after it was written - equal
 * to its text now while nobody has edited it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefault, fetchObject, mutate, ownedSpaces, queryAll, setField, str, sv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { appendMarkdown } from "./markdown";
import { copyBody, copyFields, spacelessSource } from "./skill-spaces";
import { GUIDE_SEED_KEY as SEED_KEY, objectText, SKILL_TYPE } from "./skills";

const GUIDE_FILE = join(import.meta.dir, "../../docs/roostr-guide.md");
const NAME = "Roostr Guide";
// An instruction, not a table of contents: a description that named topics
// ("Judges, Repeat...") let an agent guess an answer from the words - wrongly -
// instead of reading the guide.
const DESCRIPTION =
	"The manual for Roostr itself. Roostr works differently from what you would guess, so call skill_read on it BEFORE answering any question about how Roostr works and before setting anything up (agents, repeats, templates, queries, credentials, scores) - never answer those from memory.";

const hash = (text: string): string => Bun.hash(text).toString(16);

/** The file's body: everything under its `# Roostr Guide` title (the Skill's name is the title). */
function guideBody(markdown: string): string {
	return markdown.replace(/^# .*\n+/, "").trim();
}

/** The page's own blocks, top level: not the discussion, not chat. */
function bodyRoots(obj: ObjectJSON): string[] {
	const referenced = new Set(obj.blocks.flatMap((b) => b.childrenIds));
	return obj.blocks
		.filter((b) => !referenced.has(b.id) && b.id !== "__discussion__" && !["chat", "discussion"].includes(b.content.custom?.contentType ?? ""))
		.map((b) => b.id);
}

async function writeBody(id: string, markdown: string, fileHash: string): Promise<void> {
	await appendMarkdown(id, guideBody(markdown));
	await setField(id, "seed_hash", sv(fileHash));
	await setField(id, "seed_text", sv(hash(objectText(await fetchObject(id)))));
}

/** The fixed id of the guide's copy in a space. */
export const guideId = (space: string): string => `roostr-guide-${space}`;

type GuideResult = "created" | "updated" | "kept" | "edited" | "deleted";

/** Make each space's guide Skill, or bring an untouched one up to the file. Returns how many copies did what. */
export async function seedGuide(): Promise<Partial<Record<GuideResult, number>> | "no file"> {
	const markdown = await readFile(GUIDE_FILE, "utf8").catch(() => "");
	if (!markdown) return "no file";
	const rows = (await queryAll({ type: SKILL_TYPE })).filter((r) => str(r.fields, "seed_key") === SEED_KEY);
	const out: Partial<Record<GuideResult, number>> = {};
	for (const space of await ownedSpaces()) {
		const did = await seedSpaceGuide(space.id, rows, markdown);
		out[did] = (out[did] ?? 0) + 1;
	}
	return out;
}

async function seedSpaceGuide(space: string, rows: QueryRow[], markdown: string): Promise<GuideResult> {
	const fileHash = hash(markdown);
	const mine = rows.filter((r) => str(r.fields, "channel") === space).sort((a, b) => a.createdAt - b.createdAt);
	if (mine.length === 0) {
		// A spaceless one from before Skills had spaces: the copy starts as it is - an edited one stays edited (its seed_text no longer matches).
		const source = spacelessSource(rows, () => true);
		const fields: Record<string, ValueJSON> = source ? { ...copyFields(source, space), description: sv(DESCRIPTION) } : { channel: sv(space), description: sv(DESCRIPTION), seed_key: sv(SEED_KEY) };
		if (!(await createDefault(NAME, SKILL_TYPE, fields, guideId(space)))) return "deleted";
		if (source) await copyBody(source.id, guideId(space));
		else await writeBody(guideId(space), markdown, fileHash);
		return "created";
	}
	const guide = await fetchObject(mine[0].id);
	// The description is how agents know to read it: always the shipped one, whatever the page.
	if (str(guide.fields, "description") !== DESCRIPTION) await setField(guide.id, "description", sv(DESCRIPTION));
	if (str(guide.fields, "seed_hash") === fileHash) return "kept";
	// Someone edited it in the app: their page wins over a newer file.
	if (hash(objectText(guide)) !== str(guide.fields, "seed_text")) return "edited";
	for (const id of bodyRoots(guide)) await mutate("block_remove", { object_id: guide.id, block_id: id });
	await writeBody(guide.id, markdown, fileHash);
	return "updated";
}
