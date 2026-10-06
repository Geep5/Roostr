/**
 * Jev Skills: a property an agent fills in with TypeSafe's Jev.
 *
 * A Jev Skill is an ordinary Skill object with an Answer (`jev_answer`:
 * Score, Choice or Yes or no) and optionally Writes to (`jev_writes`, the
 * property's name; default the Skill's name). Its page is the question, in
 * Jev's terms:
 *
 * - paragraphs: the `instructions`;
 * - a numbered list: a Score's levels, lowest first (`criteria`);
 * - a bulleted list: a Choice's options, `Name: what it means` or a bare
 *   name;
 * - `Yes: …` / `No: …` lines: what a Yes/No answer means.
 *
 * An agent with the Skill in its Skills runs it on objects with the
 * `jev_score` tool (code Tools: `roostr.jev`), paying with the TypeSafe
 * credential in its own Credentials. Each object's answer becomes the
 * property - a number, a status or a checkbox, so queries sort and filter
 * on it - and next to it the object keeps a `judged` note: which Skill and
 * agent set it, when, and how sure Jev was (the row's "94% sure"; "Ask
 * again" re-runs it).
 */
import { createObject, fetchObject, plainValue, queryAll, setField, str, sv, bv, mutate, type ObjectJSON, type ValueJSON } from "./api";
import { agentCredential } from "./credential-objects";
import { objectText } from "./skills";
import { relationDefs } from "./spacemap";

/** On a scored object: property key -> which Skill and agent set it, when, and how sure. */
export const JUDGED_FIELD = "judged";
export const ANSWER_KEY = "jev_answer";
const WRITES_KEY = "jev_writes";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 30_000;
/** Objects scored at once. */
const CONCURRENCY = 8;
/** How much of an object's body goes to Jev. */
const BODY_CAP = 20_000;

export type AnswerKind = "score" | "choice" | "yes_no";
const ANSWERS: Array<[text: string, kind: AnswerKind, color: string]> = [
	["Score", "score", "blue"],
	["Choice", "choice", "purple"],
	["Yes or no", "yes_no", "teal"],
];

/** The first design's Judge type and its properties: removed wherever they still are. */
const RETIRED_RELATIONS = ["judge_answer", "judges", "judge_runs_on", "judge_writes", "email_judges"];
const RETIRED_TYPE = "judge";

/**
 * A Skill's Answer and Writes to properties in every space (ordinary
 * relations, never bundled), and the Judge system gone: its type and
 * properties deleted.
 */
export async function seedJev(): Promise<{ properties: number; retired: number }> {
	const out = { properties: 0, retired: 0 };
	const [spaces, types, relations] = await Promise.all([queryAll({ type: "channel" }), queryAll({ type: "type" }), queryAll({ type: "relation" })]);
	for (const space of spaces) {
		const mine = relations.filter((r) => str(r.fields, "channel") === space.id && r.fields["bundled"]?.boolValue !== true);
		const have = new Set(mine.map((r) => str(r.fields, "key")));
		if (!have.has(ANSWER_KEY)) {
			await createObject("Answer", "relation", relationFields(space.id, ANSWER_KEY, "Answer", "status", "⚖️", ANSWERS.map(([text, , color]) => [text, color])));
			out.properties += 1;
		}
		if (!have.has(WRITES_KEY)) {
			await createObject("Writes to", "relation", relationFields(space.id, WRITES_KEY, "Writes to", "shorttext", "✍️", []));
			out.properties += 1;
		}
		for (const r of mine) {
			if (!RETIRED_RELATIONS.includes(str(r.fields, "key"))) continue;
			await mutate("delete", { object_id: r.id });
			out.retired += 1;
		}
	}
	for (const t of types) {
		if (str(t.fields, "key") !== RETIRED_TYPE || t.fields["bundled"]?.boolValue === true) continue;
		await mutate("delete", { object_id: t.id });
		out.retired += 1;
	}
	return out;
}

function optionsValue(key: string, options: Array<[text: string, color: string]>, from = 0): ValueJSON {
	return {
		valuesValue: {
			items: options.map(([text, color], i) => ({
				mapValue: { entries: { id: sv(`${key}-${text}`), text: sv(text), color: sv(color), orderId: sv(String(from + i).padStart(6, "0")) } },
			})),
		},
	};
}

function relationFields(space: string, key: string, name: string, format: string, emoji: string, options: Array<[string, string]>): Record<string, ValueJSON> {
	return {
		channel: sv(space),
		key: sv(key),
		name: sv(name),
		format: sv(format),
		iconEmoji: sv(emoji),
		hidden: bv(false),
		readOnly: bv(false),
		maxCount: { intValue: format === "status" ? 1 : 0 },
		options: optionsValue(key, options),
		bundled: bv(false),
	};
}

// ── The question ─────────────────────────────────────────────────

export type JevQuestion =
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

/** The Skill's Answer, or null for an ordinary (instructions-only) Skill. */
export function answerKind(fields: Record<string, ValueJSON>): AnswerKind | null {
	const v = fields[ANSWER_KEY];
	const text = v?.stringValue ?? v?.valuesValue?.items?.[0]?.stringValue ?? "";
	return ANSWERS.find(([t]) => t === text)?.[1] ?? null;
}

/** "Name: what it means" / "Name - what it means" → [name, meaning]; a bare name has none. */
function splitOption(item: string): [string, string | null] {
	const m = item.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
	return m ? [m[1].trim(), m[2].trim()] : [item.trim(), null];
}

/**
 * The Jev question a Skill's page asks (its text as `objectText` lines).
 * Throws a sentence the agent can relay when the page can't be one.
 */
export function parseQuestion(text: string, kind: AnswerKind): JevQuestion {
	const instructions: string[] = [];
	const numbered: string[] = [];
	const bullets: string[] = [];
	const yesNo: { true?: string; false?: string } = {};
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const num = line.match(/^\d+\.\s+(.+)$/);
		if (num) { numbered.push(num[1].trim()); continue; }
		const bullet = line.match(/^- (?!\[[ x]\] )(.+)$/);
		if (bullet) { bullets.push(bullet[1].trim()); continue; }
		const yn = kind === "yes_no" ? line.match(/^(yes|no)\s*[:\-–—]\s*(.+)$/i) : null;
		if (yn) { yesNo[yn[1].toLowerCase() === "yes" ? "true" : "false"] = yn[2].trim(); continue; }
		instructions.push(line.replace(/^(#{1,3}|>)\s+/, ""));
	}
	const question = instructions.join("\n");
	if (!question) throw new Error("the Skill's page has no question - write it there");
	if (kind === "score") {
		if (numbered.length < 2) throw new Error("a Score needs a numbered list of 2 to 10 levels under the question, lowest first");
		if (numbered.length > 10) throw new Error(`a Score takes at most 10 levels; this one has ${numbered.length}`);
		return { type: "score", instructions: question, criteria: numbered };
	}
	if (kind === "choice") {
		const options = bullets.map(splitOption);
		if (options.length < 2) throw new Error("a Choice needs a bulleted list of at least 2 options under the question");
		if (options.length > 255) throw new Error(`a Choice takes at most 255 options; this one has ${options.length}`);
		const names = new Set<string>();
		for (const [name] of options) {
			if (names.has(name)) throw new Error(`the option "${name}" is listed twice`);
			names.add(name);
		}
		return { type: "choice", instructions: question, criteria: Object.fromEntries(options) };
	}
	return Object.keys(yesNo).length > 0 ? { type: "noul", instructions: question, criteria: yesNo } : { type: "noul", instructions: question };
}

// ── Jev ──────────────────────────────────────────────────────────

export type JevAnswer =
	| { type: "score"; score: number; confidence: number; legend: Record<string, string> }
	| { type: "choice"; choice: string; confidence: number }
	| { type: "noul"; noul: number };

/** One Jev call: `state` against named questions. Throws TypeSafe's own message on failure. */
export async function jevAsk(apiKey: string, state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
	const res = await fetch(JEV_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ model: JEV_MODEL, state, questions }),
		signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
	});
	const body = (await res.json().catch(() => null)) as { answers?: Record<string, JevAnswer>; detail?: { message?: string } | string } | null;
	if (!res.ok || !body?.answers) {
		const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message;
		throw new Error(`TypeSafe ${res.status}: ${detail || "no answer"}`);
	}
	return body.answers;
}

// ── What Jev reads ───────────────────────────────────────────────

/** Never part of what's scored: bookkeeping, links, and anything Jev wrote. */
const SKIPPED_FIELDS = new Set(["name", "channel", "error", "done", "repeat", "served_by", "agent", "credentials", "featuredRelations", JUDGED_FIELD]);
const SKIPPED_FORMATS = new Set(["object", "file", "date", "checkbox", "repeat"]);

/** What Jev is shown about an object: its name, its plain properties by name, its body. */
export function scoredState(obj: ObjectJSON, rels: Map<string, { name: string; format: string }>): Record<string, unknown> {
	const written = new Set(Object.keys(obj.fields[JUDGED_FIELD]?.mapValue?.entries ?? {}));
	const properties: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj.fields)) {
		const rel = rels.get(key);
		if (!rel || SKIPPED_FIELDS.has(key) || written.has(key) || SKIPPED_FORMATS.has(rel.format)) continue;
		const plain = plainValue(value);
		if (plain === null || plain === "" || (Array.isArray(plain) && plain.length === 0)) continue;
		properties[rel.name] = plain;
	}
	const body = objectText(obj);
	return {
		name: str(obj.fields, "name"),
		...(Object.keys(properties).length > 0 ? { properties } : {}),
		body: body.length > BODY_CAP ? `${body.slice(0, BODY_CAP)}\n… (cut)` : body,
	};
}

// ── Writing the answer ───────────────────────────────────────────

const FORMAT_FOR: Record<AnswerKind, string> = { score: "number", choice: "status", yes_no: "checkbox" };
const KIND_WORD: Record<AnswerKind, string> = { score: "a Score", choice: "a Choice", yes_no: "a Yes/No" };

function slug(name: string): string {
	return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "scored";
}

/**
 * The property `name` in `space`, made in the format the answer needs when
 * missing. A Choice's options are kept on it, so every answer shows as a
 * known option.
 */
export async function ensureProperty(space: string, name: string, kind: AnswerKind, question: JevQuestion): Promise<string> {
	const format = FORMAT_FOR[kind];
	const relations = (await queryAll({ type: "relation" })).filter((r) => str(r.fields, "channel") === space);
	const existing = relations.find((r) => str(r.fields, "name").toLowerCase() === name.toLowerCase());
	const choices = question.type === "choice" ? Object.keys(question.criteria) : [];
	if (existing) {
		const key = str(existing.fields, "key");
		const has = str(existing.fields, "format");
		if (has !== format) throw new Error(`"${str(existing.fields, "name")}" is a ${has} property; ${KIND_WORD[kind]} needs a ${format} property - set the Skill's Writes to another name`);
		if (choices.length > 0) {
			const items = existing.fields["options"]?.valuesValue?.items ?? [];
			const known = new Set(items.map((i) => i.mapValue?.entries?.["text"]?.stringValue ?? ""));
			const missing = choices.filter((c) => !known.has(c));
			if (missing.length > 0) await setField(existing.id, "options", { valuesValue: { items: [...items, ...optionsValue(key, missing.map((c) => [c, "grey"]), items.length).valuesValue!.items] } });
		}
		return key;
	}
	const taken = new Set(relations.map((r) => str(r.fields, "key")));
	let key = slug(name);
	for (let n = 2; taken.has(key); n++) key = `${slug(name)}_${n}`;
	await createObject(name, "relation", relationFields(space, key, name, format, kind === "score" ? "📊" : kind === "choice" ? "🏷️" : "☑️", choices.map((c) => [c, "grey"])));
	return key;
}

/** One object's answer, as the property value and the "how sure" note beside it. */
export interface Verdict {
	value: ValueJSON;
	/** The answer in words: "2.1 of 4 (Rude)", "Payout", "yes". */
	text: string;
	/** Choice/Score: Jev's confidence; Yes/No: the probability of yes. */
	confidence?: number;
	probability?: number;
}

export function verdictOf(answer: JevAnswer): Verdict {
	if (answer.type === "score") {
		// Jev counts levels from 0; the Skill's numbered list counts from 1.
		const value = Math.round((answer.score + 1) * 10) / 10;
		const levels = Object.keys(answer.legend).length;
		const nearest = splitOption(answer.legend[String(Math.round(answer.score))] ?? "")[0];
		return { value: { floatValue: value }, text: `${value} of ${levels}${nearest ? ` (${nearest})` : ""}`, confidence: answer.confidence };
	}
	if (answer.type === "choice") return { value: sv(answer.choice), text: answer.choice, confidence: answer.confidence };
	return { value: bv(answer.noul >= 0.5), text: answer.noul >= 0.5 ? "yes" : "no", probability: answer.noul };
}

/** One chain per object: two scorings of the same object never interleave their `judged` notes here. */
const chains = new Map<string, Promise<unknown>>();
async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
	chains.set(key, next);
	try {
		return await next;
	} finally {
		if (chains.get(key) === next) chains.delete(key);
	}
}

async function writeVerdict(objectId: string, key: string, by: { skill: string; agent: string }, verdict: Verdict): Promise<void> {
	await serial(objectId, async () => {
		await setField(objectId, key, verdict.value);
		const now = await fetchObject(objectId);
		const entries = { ...(now.fields[JUDGED_FIELD]?.mapValue?.entries ?? {}) };
		const note: Record<string, ValueJSON> = { skill: sv(by.skill), agent: sv(by.agent), at: { intValue: Date.now() } };
		if (verdict.confidence !== undefined) note.confidence = { floatValue: verdict.confidence };
		if (verdict.probability !== undefined) note.probability = { floatValue: verdict.probability };
		entries[key] = { mapValue: { entries: note } };
		await setField(objectId, JUDGED_FIELD, { mapValue: { entries } });
	});
}

// ── Scoring ──────────────────────────────────────────────────────

/** One object's result, as the tool returns it. */
export interface ScoreRow {
	id: string;
	name: string;
	/** The property written ("Spam meter"). */
	property?: string;
	/** The value as stored: a number, an option, true/false. */
	value?: unknown;
	/** The answer in words. */
	answer?: string;
	confidence?: number;
	probability?: number;
	error?: string;
}

async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]);
	}));
}

/**
 * Run a Jev Skill on objects for an agent: its question to Jev with the
 * agent's TypeSafe credential, each answer into the Skill's property with
 * its note. The Skill's setup problems (not a Jev Skill, no question, no
 * key, a clashing property) throw; one object's failure is its row's error.
 */
export async function scoreWithSkill(skill: ObjectJSON, objectIds: string[], agentId: string): Promise<ScoreRow[]> {
	const kind = answerKind(skill.fields);
	if (!kind) throw new Error(`"${str(skill.fields, "name")}" is not a Jev Skill - it has no Answer (Score, Choice or Yes or no)`);
	const question = parseQuestion(objectText(skill), kind);
	const cred = await agentCredential(await fetchObject(agentId), "typesafe");
	const apiKey = cred.keys?.["api_key"];
	if (!apiKey) throw new Error(`the TypeSafe credential "${cred.row.name}" has no API key yet`);
	const property = str(skill.fields, WRITES_KEY).trim() || str(skill.fields, "name").trim();
	const rows: ScoreRow[] = objectIds.map((id) => ({ id, name: "" }));
	const keys = new Map<string, Promise<string>>();
	const relsBySpace = new Map<string, ReturnType<typeof relationDefs>>();
	await eachLimited(objectIds.map((id, i) => [id, i] as const), async ([id, i]) => {
		try {
			const obj = await fetchObject(id);
			if (obj.deleted) throw new Error("deleted");
			rows[i].name = str(obj.fields, "name") || "Untitled";
			// The property lives in the object's own space: one per space, made once.
			const space = str(obj.fields, "channel");
			if (!keys.has(space)) keys.set(space, ensureProperty(space, property, kind, question));
			if (!relsBySpace.has(space)) relsBySpace.set(space, relationDefs(space));
			const key = await keys.get(space)!;
			const answers = await jevAsk(apiKey, scoredState(obj, await relsBySpace.get(space)!), { [key]: question });
			const verdict = verdictOf(answers[key]);
			await writeVerdict(id, key, { skill: skill.id, agent: agentId }, verdict);
			rows[i] = { ...rows[i], property, value: plainValue(verdict.value), answer: verdict.text, confidence: verdict.confidence, probability: verdict.probability };
		} catch (err) {
			rows[i] = { ...rows[i], error: err instanceof Error ? err.message : String(err) };
		}
	});
	return rows;
}

/**
 * "Ask again": the Skill and agent that set `key` on the object run it
 * there once more. Throws when the value has no note to follow.
 */
export async function scoreAgain(objectId: string, key: string): Promise<ScoreRow> {
	const obj = await fetchObject(objectId);
	const note = obj.fields[JUDGED_FIELD]?.mapValue?.entries?.[key]?.mapValue?.entries;
	const skillId = note?.["skill"]?.stringValue ?? "";
	const agentId = note?.["agent"]?.stringValue ?? "";
	if (!skillId || !agentId) throw new Error("this value has no Jev note to re-run");
	const [row] = await scoreWithSkill(await fetchObject(skillId), [objectId], agentId);
	if (row.error) throw new Error(row.error);
	return row;
}
