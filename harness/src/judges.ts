/**
 * Judges: a property filled in by TypeSafe's Jev, set up as an object.
 *
 * A Judge (typeKey `judge`) is one Jev question. Its body is the question,
 * in Jev's terms:
 *
 * - paragraphs: the `instructions`;
 * - a numbered list: a Score's levels, lowest first (`criteria`);
 * - a bulleted list: a Choice's options, `Name: what it means` or a bare
 *   name;
 * - `Yes: …` / `No: …` lines: what a Yes/No answer means.
 *
 * Its properties are the settings: Answer (Score / Choice / Yes or no),
 * Runs on (a saved query or collection - every object in it - or one
 * object), Writes to (the property the answer goes in, made when missing:
 * a number for a Score, a status for a Choice, a checkbox for Yes/No),
 * Credentials (a TypeSafe credential carries the key), Served by and
 * Repeat. No agent: on each occurrence the scheduler calls `runJudge`.
 *
 * A run asks Jev only about objects whose content changed since this
 * Judge last judged them: the Judge keeps a hash of what it sent per
 * object (`judge_seen`), and the state it sends leaves out every
 * Judge-written property, so Judges writing to the same object don't
 * make each other re-run.
 *
 * Next to the value, each judged object keeps `judged`: per property,
 * which Judge set it, when, and how sure Jev was - the property row's
 * "94% sure".
 */
import { createObject, fetchObject, plainValue, queryAll, setField, str, sv, bv, type ObjectJSON, type ValueJSON } from "./api";
import { credentialKeys } from "./credentials";
import { objectText } from "./skills";
import { relationDefs, savedViewBody } from "./spacemap";
import { linkIds } from "./tool-objects";

export const JUDGE_TYPE = "judge";
/** On a judged object: property key -> who set it and how sure. */
export const JUDGED_FIELD = "judged";
/** On a Judge: object id -> hash of the state last judged. */
const SEEN_FIELD = "judge_seen";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 30_000;
/** Objects judged at once in a run. */
const CONCURRENCY = 8;
/** How much of an object's body goes to Jev. */
const BODY_CAP = 20_000;

export type AnswerKind = "score" | "choice" | "yes_no";
const ANSWERS: Array<[text: string, kind: AnswerKind, color: string]> = [
	["Score", "score", "blue"],
	["Choice", "choice", "purple"],
	["Yes or no", "yes_no", "teal"],
];

/** The Judge type's own properties: ordinary relations of each space (never bundled). */
const JUDGE_PROPERTIES: Array<{ key: string; name: string; format: string; emoji: string; options?: Array<[string, string]> }> = [
	{ key: "judge_answer", name: "Answer", format: "status", emoji: "⚖️", options: ANSWERS.map(([text, , color]) => [text, color]) },
	{ key: "judge_runs_on", name: "Runs on", format: "object", emoji: "🎯" },
	{ key: "judge_writes", name: "Writes to", format: "shorttext", emoji: "✍️" },
];

/** The Judge type and its properties in every space, made once. */
export async function seedJudges(): Promise<{ types: number; properties: number }> {
	const out = { types: 0, properties: 0 };
	const [spaces, types, relations] = await Promise.all([queryAll({ type: "channel" }), queryAll({ type: "type" }), queryAll({ type: "relation" })]);
	for (const space of spaces) {
		if (!types.some((t) => str(t.fields, "key") === JUDGE_TYPE && str(t.fields, "channel") === space.id)) {
			await createObject("Judge", "type", { key: sv(JUDGE_TYPE), name: sv("Judge"), iconEmoji: sv("⚖️"), layout: sv("page"), channel: sv(space.id) });
			out.types += 1;
		}
		const have = new Set(relations.filter((r) => str(r.fields, "channel") === space.id).map((r) => str(r.fields, "key")));
		for (const p of JUDGE_PROPERTIES) {
			if (have.has(p.key)) continue;
			await createObject(p.name, "relation", relationFields(space.id, p.key, p.name, p.format, p.emoji, p.options ?? []));
			out.properties += 1;
		}
	}
	return out;
}

function optionsValue(key: string, options: Array<[text: string, color: string]>): ValueJSON {
	return {
		valuesValue: {
			items: options.map(([text, color], i) => ({
				mapValue: { entries: { id: sv(`${key}-${text}`), text: sv(text), color: sv(color), orderId: sv(String(i).padStart(6, "0")) } },
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

export function answerKind(fields: Record<string, ValueJSON>): AnswerKind | null {
	const text = str(fields, "judge_answer");
	return ANSWERS.find(([t]) => t === text)?.[1] ?? null;
}

/** "Name: what it means" / "Name - what it means" → [name, meaning]; a bare name has none. */
function splitOption(item: string): [string, string | null] {
	const m = item.match(/^(.+?)\s*(?::|\s[-–—]\s)\s*(.+)$/);
	return m ? [m[1].trim(), m[2].trim()] : [item.trim(), null];
}

/**
 * The Jev question a Judge's body asks (its text as `objectText` lines).
 * Throws a sentence for the Judge's error badge when the body can't be one.
 */
export function parseJudge(text: string, kind: AnswerKind): JevQuestion {
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
	if (!question) throw new Error("write the question in the Judge's page");
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

// ── What a Judge reads ───────────────────────────────────────────

/** Never part of what's judged: bookkeeping, links, and anything a Judge writes. */
const SKIPPED_FIELDS = new Set(["name", "channel", "error", "done", "repeat", "served_by", "agent", "credentials", "featuredRelations", JUDGED_FIELD, SEEN_FIELD]);
const SKIPPED_FORMATS = new Set(["object", "file", "date", "checkbox", "repeat"]);

/** What Jev is shown about an object: its name, its plain properties by name, its body. */
export function judgedState(obj: ObjectJSON, rels: Map<string, { name: string; format: string }>): Record<string, unknown> {
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

function stateHash(state: unknown): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 16);
}

/** The TypeSafe key from the Judge's Credentials. */
async function judgeKey(judge: ObjectJSON): Promise<string> {
	for (const id of linkIds(judge.fields, "credentials")) {
		const cred = await fetchObject(id).catch(() => null);
		if (!cred || cred.deleted || str(cred.fields, "service") !== "typesafe") continue;
		const key = credentialKeys(cred.fields)?.["api_key"];
		if (!key) throw new Error(`the TypeSafe credential "${str(cred.fields, "name") || id.slice(0, 8)}" has no API key yet`);
		return key;
	}
	throw new Error("add a TypeSafe (Jev) credential to this Judge's Credentials");
}

/** The objects a Judge's Runs on names: a saved view's rows, or the one object. */
async function judgeTargets(judge: ObjectJSON, space: string): Promise<ObjectJSON[]> {
	const targetId = linkIds(judge.fields, "judge_runs_on")[0];
	if (!targetId) throw new Error("pick what this Judge runs on in Runs on: a saved query, a collection, or one object");
	const target = await fetchObject(targetId);
	if (target.deleted) throw new Error("what Runs on names was deleted");
	if (!["query", "set", "collection"].includes(target.typeKey)) return [target];
	const body = await savedViewBody(target, space, await relationDefs(space));
	if (!body) return [];
	const rows = await queryAll(body);
	return Promise.all(rows.filter((r) => r.id !== judge.id).map((r) => fetchObject(r.id)));
}

// ── Writing the answer ───────────────────────────────────────────

const FORMAT_FOR: Record<AnswerKind, string> = { score: "number", choice: "status", yes_no: "checkbox" };
const KIND_WORD: Record<AnswerKind, string> = { score: "a Score", choice: "a Choice", yes_no: "a Yes/No" };

function slug(name: string): string {
	return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "judged";
}

/**
 * The property a Judge writes: Writes to (else the Judge's name), found by
 * name in its space or made with the format its answer needs. A Choice's
 * options are kept on it, so every answer shows as a known option.
 */
export async function ensureTarget(judge: ObjectJSON, kind: AnswerKind, question: JevQuestion): Promise<string> {
	const space = str(judge.fields, "channel");
	const name = str(judge.fields, "judge_writes").trim() || str(judge.fields, "name").trim();
	if (!name) throw new Error("name the property this Judge writes in Writes to");
	const format = FORMAT_FOR[kind];
	const relations = (await queryAll({ type: "relation" })).filter((r) => str(r.fields, "channel") === space || r.fields["bundled"]?.boolValue === true);
	const existing = relations.find((r) => str(r.fields, "name").toLowerCase() === name.toLowerCase());
	const choices = question.type === "choice" ? Object.keys(question.criteria) : [];
	if (existing) {
		const has = str(existing.fields, "format");
		if (has !== format) throw new Error(`Writes to "${name}" is a ${has} property; ${KIND_WORD[kind]} needs a ${format} property - pick another name`);
		if (choices.length > 0) {
			const items = existing.fields["options"]?.valuesValue?.items ?? [];
			const known = new Set(items.map((i) => i.mapValue?.entries?.["text"]?.stringValue ?? ""));
			const missing = choices.filter((c) => !known.has(c));
			if (missing.length > 0) {
				const key = str(existing.fields, "key");
				const added = optionsValue(key, missing.map((c) => [c, "grey"])).valuesValue!.items.map((item, i) => {
					item.mapValue!.entries!["orderId"] = sv(String(items.length + i).padStart(6, "0"));
					return item;
				});
				await setField(existing.id, "options", { valuesValue: { items: [...items, ...added] } });
			}
		}
		return str(existing.fields, "key");
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
		// Jev counts levels from 0; the Judge's numbered list counts from 1.
		const value = Math.round((answer.score + 1) * 10) / 10;
		const levels = Object.keys(answer.legend).length;
		const nearest = splitOption(answer.legend[String(Math.round(answer.score))] ?? "")[0];
		return { value: { floatValue: value }, text: `${value} of ${levels}${nearest ? ` (${nearest})` : ""}`, confidence: answer.confidence };
	}
	if (answer.type === "choice") return { value: sv(answer.choice), text: answer.choice, confidence: answer.confidence };
	return { value: bv(answer.noul >= 0.5), text: answer.noul >= 0.5 ? "yes" : "no", probability: answer.noul };
}

/** Writes to judged objects go one at a time per object, so two Judges' `judged` notes never overwrite each other here. */
const writing = new Map<string, Promise<unknown>>();

async function writeVerdict(objectId: string, key: string, judgeId: string, verdict: Verdict): Promise<void> {
	const prev = writing.get(objectId) ?? Promise.resolve();
	const next = prev.catch(() => {}).then(async () => {
		await setField(objectId, key, verdict.value);
		const now = await fetchObject(objectId);
		const entries = { ...(now.fields[JUDGED_FIELD]?.mapValue?.entries ?? {}) };
		const note: Record<string, ValueJSON> = { judge: sv(judgeId), at: { intValue: Date.now() } };
		if (verdict.confidence !== undefined) note.confidence = { floatValue: verdict.confidence };
		if (verdict.probability !== undefined) note.probability = { floatValue: verdict.probability };
		entries[key] = { mapValue: { entries: note } };
		await setField(objectId, JUDGED_FIELD, { mapValue: { entries } });
	});
	writing.set(objectId, next);
	try {
		await next;
	} finally {
		if (writing.get(objectId) === next) writing.delete(objectId);
	}
}

// ── A run ────────────────────────────────────────────────────────

export interface JudgeRun {
	judged: number;
	unchanged: number;
	failed: number;
	/** The first object's failure, for the run record. */
	firstError?: string;
}

export interface TrialRow {
	id: string;
	name: string;
	text: string;
	confidence?: number;
	probability?: number;
	error?: string;
}

/** Everything a run needs from the Judge itself; throws its setup problem as a sentence. */
async function prepare(judgeId: string) {
	const judge = await fetchObject(judgeId);
	if (judge.typeKey !== JUDGE_TYPE) throw new Error(`${judgeId.slice(0, 8)} is a ${judge.typeKey}, not a Judge`);
	const kind = answerKind(judge.fields);
	if (!kind) throw new Error("pick an Answer: Score, Choice, or Yes or no");
	const question = parseJudge(objectText(judge), kind);
	const space = str(judge.fields, "channel");
	const apiKey = await judgeKey(judge);
	const rels = await relationDefs(space);
	return { judge, kind, question, space, apiKey, rels };
}

async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]);
	}));
}

/** Judge every object in Runs on whose content changed since last time, writing each answer. */
export async function runJudge(judgeId: string): Promise<JudgeRun> {
	const { judge, kind, question, space, apiKey, rels } = await prepare(judgeId);
	const key = await ensureTarget(judge, kind, question);
	const targets = await judgeTargets(judge, space);
	const seen = { ...(judge.fields[SEEN_FIELD]?.mapValue?.entries ?? {}) };
	const out: JudgeRun = { judged: 0, unchanged: 0, failed: 0 };
	await eachLimited(targets, async (obj) => {
		const state = judgedState(obj, rels);
		const hash = stateHash({ question, state });
		if (seen[obj.id]?.stringValue === hash && obj.fields[key] !== undefined) {
			out.unchanged += 1;
			return;
		}
		try {
			const answers = await jevAsk(apiKey, state, { [key]: question });
			await writeVerdict(obj.id, key, judge.id, verdictOf(answers[key]));
			seen[obj.id] = sv(hash);
			out.judged += 1;
		} catch (err) {
			out.failed += 1;
			out.firstError ??= `${str(obj.fields, "name") || obj.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
		}
	});
	// Objects no longer in Runs on drop out of the ledger.
	const live = new Set(targets.map((t) => t.id));
	for (const id of Object.keys(seen)) if (!live.has(id)) delete seen[id];
	if (out.judged > 0 || Object.keys(seen).length !== Object.keys(judge.fields[SEEN_FIELD]?.mapValue?.entries ?? {}).length) {
		await setField(judge.id, SEEN_FIELD, { mapValue: { entries: seen } });
	}
	return out;
}

/** Try it: the Judge's answers for the newest objects in Runs on, written nowhere. */
export async function tryJudge(judgeId: string, limit = 5): Promise<TrialRow[]> {
	const { judge, question, space, apiKey, rels } = await prepare(judgeId);
	const targets = (await judgeTargets(judge, space)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
	const rows: TrialRow[] = targets.map((t) => ({ id: t.id, name: str(t.fields, "name") || "Untitled", text: "" }));
	await eachLimited(targets.map((t, i) => [t, i] as const), async ([obj, i]) => {
		try {
			const answers = await jevAsk(apiKey, judgedState(obj, rels), { q: question });
			const v = verdictOf(answers["q"]);
			rows[i] = { ...rows[i], text: v.text, confidence: v.confidence, probability: v.probability };
		} catch (err) {
			rows[i] = { ...rows[i], error: err instanceof Error ? err.message : String(err) };
		}
	});
	return rows;
}

/** For the scheduler's run record: what a run did, in words. */
export function runSummary(run: JudgeRun): string {
	const parts = [`judged ${run.judged}`];
	if (run.unchanged > 0) parts.push(`${run.unchanged} unchanged`);
	if (run.failed > 0) parts.push(`${run.failed} failed`);
	return parts.join(", ");
}
