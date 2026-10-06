/**
 * Judges: a property filled in by TypeSafe's Jev, set up as an object.
 *
 * A Judge (typeKey `judge`) is one Jev question, and its name is the
 * property it fills in: a Judge called "Spam meter" writes "Spam meter".
 * The question is the page of the System prompt its Prompt property links
 * (the same `prompt` link and object type an agent uses), in Jev's terms:
 *
 * - paragraphs: the `instructions`;
 * - a numbered list: a Score's levels, lowest first (`criteria`);
 * - a bulleted list: a Choice's options, `Name: what it means` or a bare
 *   name;
 * - `Yes: …` / `No: …` lines: what a Yes/No answer means.
 *
 * Its properties: Prompt, Answer (Score / Choice / Yes or no), Credentials
 * (a TypeSafe credential carries the key) and optionally Served by.
 *
 * Any object lists the Judges that score it in its Judges property, the
 * way Agent lists who works on it. The computer that runs a Judge - its
 * Served by, else the computer keeping its credential - scores each object
 * listing it when the object appears and whenever its content changes:
 * the Judge keeps a hash of what it sent per object (`judge_seen`), and
 * the state it sends leaves out every Judge-written property, so Judges
 * writing to the same object don't make each other re-run. "Ask again"
 * scores one object regardless.
 *
 * The answer is an ordinary property (a number for a Score, a status for
 * a Choice, a checkbox for Yes/No), so queries, tables and sorting work on
 * it. Next to it each judged object keeps `judged`: per property, which
 * Judge set it, when, and how sure Jev was - the row's "94% sure".
 */
import { createObject, fetchObject, mutate, plainValue, queryAll, setField, deleteField, str, sv, bv, type ObjectJSON, type ValueJSON } from "./api";
import { credentialKeys } from "./credentials";
import { machineId } from "./roster";
import { objectText } from "./skills";
import { relationDefs } from "./spacemap";
import { linkIds } from "./tool-objects";

export const JUDGE_TYPE = "judge";
/** On any object: the Judges that score it. */
export const JUDGES_KEY = "judges";
/** On a judged object: property key -> who set it and how sure. */
export const JUDGED_FIELD = "judged";
/** On a Judge: object id -> hash of the state last judged. */
const SEEN_FIELD = "judge_seen";
/** On a Judge: the key of the property it writes (its name can change; the key can't). */
const PROPERTY_FIELD = "judge_property";
/** A Judge's own error badge starts with this, so a clean run clears only what a run wrote. */
const BADGE = "Jev failed:";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 30_000;
/** The Judge's Prompt: a System prompt object - the agents' prompt type - whose page is the question. */
const PROMPT_KEY = "prompt";
const PROMPT_TYPE = "system_prompt";

/** The question a Judge asks: its linked System prompt's page. */
async function judgeQuestion(judge: ObjectJSON): Promise<string> {
	const promptId = linkIds(judge.fields, PROMPT_KEY)[0];
	if (!promptId) throw new Error("pick a Prompt: the System prompt whose page is this Judge's question");
	const prompt = await fetchObject(promptId).catch(() => null);
	if (!prompt || prompt.deleted) throw new Error("this Judge's Prompt was deleted - pick another");
	return objectText(prompt);
}
/** Objects judged at once. */
const CONCURRENCY = 8;
/** How much of an object's body goes to Jev. */
const BODY_CAP = 20_000;

export type AnswerKind = "score" | "choice" | "yes_no";
const ANSWERS: Array<[text: string, kind: AnswerKind, color: string]> = [
	["Score", "score", "blue"],
	["Choice", "choice", "purple"],
	["Yes or no", "yes_no", "teal"],
];

/** Settings the first design had: Runs on / Writes to. Their property defs go. */
const RETIRED_PROPERTIES = ["judge_runs_on", "judge_writes"];

/**
 * The Judge type, its Answer property and the Judges property in every
 * space, made once: ordinary relations (never bundled). The Judges picker
 * is limited to the space's Judge type.
 */
export async function seedJudges(): Promise<{ types: number; properties: number; retired: number }> {
	const out = { types: 0, properties: 0, retired: 0 };
	const [spaces, types, relations] = await Promise.all([queryAll({ type: "channel" }), queryAll({ type: "type" }), queryAll({ type: "relation" })]);
	for (const space of spaces) {
		let typeId = types.find((t) => str(t.fields, "key") === JUDGE_TYPE && str(t.fields, "channel") === space.id)?.id;
		if (!typeId) {
			typeId = (await createObject("Judge", "type", { key: sv(JUDGE_TYPE), name: sv("Judge"), iconEmoji: sv("⚖️"), layout: sv("page"), channel: sv(space.id) })).id;
			out.types += 1;
		}
		const mine = relations.filter((r) => str(r.fields, "channel") === space.id && r.fields["bundled"]?.boolValue !== true);
		const have = new Set(mine.map((r) => str(r.fields, "key")));
		if (!have.has("judge_answer")) {
			await createObject("Answer", "relation", relationFields(space.id, "judge_answer", "Answer", "status", "⚖️", ANSWERS.map(([text, , color]) => [text, color])));
			out.properties += 1;
		}
		if (!have.has(JUDGES_KEY)) {
			await createObject("Judges", "relation", { ...relationFields(space.id, JUDGES_KEY, "Judges", "object", "⚖️", []), object_types: { valuesValue: { items: [sv(typeId)] } } });
			out.properties += 1;
		}
		for (const r of mine) {
			if (!RETIRED_PROPERTIES.includes(str(r.fields, "key"))) continue;
			await mutate("delete", { object_id: r.id });
			out.retired += 1;
		}
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
	if (!question) throw new Error("write the question on this Judge's Prompt page");
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
const SKIPPED_FIELDS = new Set(["name", "channel", "error", "done", "repeat", "served_by", "agent", "credentials", "featuredRelations", JUDGES_KEY, JUDGED_FIELD, SEEN_FIELD]);
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

/** The TypeSafe credential among the Judge's Credentials, or null. */
async function judgeCredential(judge: ObjectJSON): Promise<ObjectJSON | null> {
	for (const id of linkIds(judge.fields, "credentials")) {
		const cred = await fetchObject(id).catch(() => null);
		if (cred && !cred.deleted && str(cred.fields, "service") === "typesafe") return cred;
	}
	return null;
}

/** The TypeSafe key from the Judge's Credentials. */
function judgeKey(judge: ObjectJSON, cred: ObjectJSON | null): string {
	if (!cred) throw new Error("add a TypeSafe (Jev) credential to this Judge's Credentials");
	const key = credentialKeys(cred.fields)?.["api_key"];
	if (!key) throw new Error(`the TypeSafe credential "${str(cred.fields, "name") || cred.id.slice(0, 8)}" has no API key yet`);
	return key;
}

/** The computer that runs a Judge: its Served by, else the computer keeping its credential. */
export function judgeMachine(judge: ObjectJSON, cred: ObjectJSON | null): string {
	return str(judge.fields, "served_by") || (cred ? str(cred.fields, "served_by") : "");
}

// ── Writing the answer ───────────────────────────────────────────

const FORMAT_FOR: Record<AnswerKind, string> = { score: "number", choice: "status", yes_no: "checkbox" };
const KIND_WORD: Record<AnswerKind, string> = { score: "a Score", choice: "a Choice", yes_no: "a Yes/No" };

function slug(name: string): string {
	return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "judged";
}

/**
 * The property a Judge writes, named after it: the one it made before
 * (renamed along with the Judge), else one of that name in its space, else
 * a new one in the format its answer needs. A Choice's options are kept on
 * it, so every answer shows as a known option.
 */
export async function ensureProperty(judge: ObjectJSON, kind: AnswerKind, question: JevQuestion): Promise<string> {
	const space = str(judge.fields, "channel");
	const name = str(judge.fields, "name").trim();
	if (!name) throw new Error("name this Judge - its name is the property it fills in");
	const format = FORMAT_FOR[kind];
	const relations = (await queryAll({ type: "relation" })).filter((r) => str(r.fields, "channel") === space);
	const madeKey = str(judge.fields, PROPERTY_FIELD);
	const existing = (madeKey && relations.find((r) => str(r.fields, "key") === madeKey)) || relations.find((r) => str(r.fields, "name").toLowerCase() === name.toLowerCase());
	const choices = question.type === "choice" ? Object.keys(question.criteria) : [];
	if (existing) {
		const key = str(existing.fields, "key");
		const has = str(existing.fields, "format");
		if (has !== format) throw new Error(`"${str(existing.fields, "name")}" is already a ${has} property; ${KIND_WORD[kind]} needs a ${format} property - rename this Judge`);
		if (str(existing.fields, "name") !== name) await setField(existing.id, "name", sv(name));
		if (choices.length > 0) {
			const items = existing.fields["options"]?.valuesValue?.items ?? [];
			const known = new Set(items.map((i) => i.mapValue?.entries?.["text"]?.stringValue ?? ""));
			const missing = choices.filter((c) => !known.has(c));
			if (missing.length > 0) await setField(existing.id, "options", { valuesValue: { items: [...items, ...optionsValue(key, missing.map((c) => [c, "grey"]), items.length).valuesValue!.items] } });
		}
		if (madeKey !== key) await setField(judge.id, PROPERTY_FIELD, sv(key));
		return key;
	}
	const taken = new Set(relations.map((r) => str(r.fields, "key")));
	let key = slug(name);
	for (let n = 2; taken.has(key); n++) key = `${slug(name)}_${n}`;
	await createObject(name, "relation", relationFields(space, key, name, format, kind === "score" ? "📊" : kind === "choice" ? "🏷️" : "☑️", choices.map((c) => [c, "grey"])));
	await setField(judge.id, PROPERTY_FIELD, sv(key));
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

/** One chain per key: writes to the same object (two Judges' `judged` notes) or the same Judge (its ledger) never interleave here. */
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

async function writeVerdict(objectId: string, key: string, judgeId: string, verdict: Verdict): Promise<void> {
	await serial(objectId, async () => {
		await setField(objectId, key, verdict.value);
		const now = await fetchObject(objectId);
		const entries = { ...(now.fields[JUDGED_FIELD]?.mapValue?.entries ?? {}) };
		const note: Record<string, ValueJSON> = { judge: sv(judgeId), at: { intValue: Date.now() } };
		if (verdict.confidence !== undefined) note.confidence = { floatValue: verdict.confidence };
		if (verdict.probability !== undefined) note.probability = { floatValue: verdict.probability };
		entries[key] = { mapValue: { entries: note } };
		await setField(objectId, JUDGED_FIELD, { mapValue: { entries } });
	});
}

// ── Judging ──────────────────────────────────────────────────────

export interface JudgeRun {
	judged: number;
	unchanged: number;
	failed: number;
	/** The first failure, in words. */
	firstError?: string;
}

async function eachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
		while (next < items.length) await fn(items[next++]);
	}));
}

/**
 * Score `objectIds` with one Judge: each whose content changed since this
 * Judge last scored it (every one, with `force`). The Judge's setup problem
 * - no question, no key, a clashing property - throws; one object's failure
 * is counted and the rest go on. A run that judged clears the Judge's own
 * badge; a failing one sets it.
 */
export async function judgeObjects(judgeId: string, objectIds: string[], force = false): Promise<JudgeRun> {
	return serial(judgeId, async () => {
		const judge = await fetchObject(judgeId);
		const out: JudgeRun = { judged: 0, unchanged: 0, failed: 0 };
		try {
			if (judge.deleted || judge.typeKey !== JUDGE_TYPE) throw new Error(`${judgeId.slice(0, 8)} is not a Judge`);
			const kind = answerKind(judge.fields);
			if (!kind) throw new Error("pick an Answer: Score, Choice, or Yes or no");
			const question = parseJudge(await judgeQuestion(judge), kind);
			const apiKey = judgeKey(judge, await judgeCredential(judge));
			const key = await ensureProperty(judge, kind, question);
			const rels = await relationDefs(str(judge.fields, "channel"));
			const seen = { ...(judge.fields[SEEN_FIELD]?.mapValue?.entries ?? {}) };
			await eachLimited(objectIds, async (id) => {
				const obj = await fetchObject(id).catch(() => null);
				if (!obj || obj.deleted) return;
				const state = judgedState(obj, rels);
				const hash = stateHash({ question, state });
				if (!force && seen[id]?.stringValue === hash && obj.fields[key] !== undefined) {
					out.unchanged += 1;
					return;
				}
				try {
					const answers = await jevAsk(apiKey, state, { [key]: question });
					await writeVerdict(id, key, judge.id, verdictOf(answers[key]));
					seen[id] = sv(hash);
					out.judged += 1;
				} catch (err) {
					out.failed += 1;
					out.firstError ??= `${str(obj.fields, "name") || id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
				}
			});
			if (out.judged > 0) await setField(judge.id, SEEN_FIELD, { mapValue: { entries: seen } });
		} catch (err) {
			out.failed = Math.max(out.failed, 1);
			out.firstError = err instanceof Error ? err.message : String(err);
		}
		const badge = str(judge.fields, "error");
		// Written only when it changes: the write is an edit of the Judge, which re-runs it.
		const failure = out.firstError ? `${BADGE} ${out.firstError}`.slice(0, 300) : "";
		if (failure && failure !== badge) await setField(judge.id, "error", sv(failure)).catch(() => {});
		// A clean run - nothing failed, scored or not - means what the badge said is fixed.
		else if (!out.firstError && badge.startsWith(BADGE)) await deleteField(judge.id, "error");
		return out;
	});
}

/** The Judges an object lists in its Judges property. */
export function listedJudges(obj: ObjectJSON | { fields: Record<string, ValueJSON> }): string[] {
	return linkIds(obj.fields, JUDGES_KEY);
}

/** Which of these Judges this computer runs. */
async function judgesHere(judgeIds: string[]): Promise<string[]> {
	const me = await machineId();
	const out: string[] = [];
	for (const id of judgeIds) {
		const judge = await fetchObject(id).catch(() => null);
		if (!judge || judge.deleted || judge.typeKey !== JUDGE_TYPE) continue;
		if (judgeMachine(judge, await judgeCredential(judge)) === me) out.push(id);
	}
	return out;
}

/**
 * Score these objects with every Judge they list that this computer runs
 * (unchanged ones are skipped). The scheduler awaits this for what a Check
 * first brought in, so the agent's turn sees the scores.
 */
export async function judgeListed(objectIds: string[]): Promise<void> {
	const byJudge = new Map<string, string[]>();
	for (const id of objectIds) {
		const obj = await fetchObject(id).catch(() => null);
		if (!obj || obj.deleted) continue;
		for (const j of listedJudges(obj)) byJudge.set(j, [...(byJudge.get(j) ?? []), id]);
	}
	const mine = await judgesHere([...byJudge.keys()]);
	await Promise.all(mine.map(async (j) => {
		const run = await judgeObjects(j, byJudge.get(j)!);
		if (run.judged || run.failed) console.log(`[judges] ${j.slice(0, 8)}: ${runSummary(run)}${run.firstError ? ` - ${run.firstError}` : ""}`);
	}));
}

/** Every object listing a Judge, scored where it changed: at boot and on a slow timer, for anything an event missed. */
export async function sweepJudges(): Promise<void> {
	const rows = await queryAll({ filters: [{ key: JUDGES_KEY, condition: "exists" }] });
	await judgeListed(rows.map((r) => r.id));
}

/** A Judge's own edit (its question, Answer, credential): re-score what lists it. */
export async function judgeEdited(judgeId: string): Promise<void> {
	if ((await judgesHere([judgeId])).length === 0) return;
	const rows = (await queryAll({ filters: [{ key: JUDGES_KEY, condition: "exists" }] })).filter((r) => listedJudges(r).includes(judgeId));
	if (rows.length > 0) await judgeListed(rows.map((r) => r.id));
}

/** Edits come in bursts (typing, an import's block adds): judge once they settle. */
const SETTLE_MS = 2_000;
const settling = new Map<string, Timer>();

/**
 * Something changed on `obj`: a Judge re-scores what lists it, and so does
 * every Judge asking the question a changed System prompt holds; anything
 * listing Judges is scored.
 */
export function judgeOnChange(obj: ObjectJSON): void {
	if (obj.typeKey === PROMPT_TYPE) {
		void judgesAsking(obj.id).then((ids) => { for (const id of ids) settle(id, () => judgeEdited(id)); });
		return;
	}
	if (obj.typeKey === JUDGE_TYPE) settle(obj.id, () => judgeEdited(obj.id));
	else if (listedJudges(obj).length > 0) settle(obj.id, () => judgeListed([obj.id]));
}

function settle(id: string, run: () => Promise<void>): void {
	clearTimeout(settling.get(id));
	settling.set(id, setTimeout(() => {
		settling.delete(id);
		void run().catch((err) => console.error(`[judges] ${id.slice(0, 8)}:`, err instanceof Error ? err.message : err));
	}, SETTLE_MS));
}

/** The Judges whose Prompt links this System prompt. */
async function judgesAsking(promptId: string): Promise<string[]> {
	return (await queryAll({ type: JUDGE_TYPE })).filter((j) => linkIds(j.fields, PROMPT_KEY).includes(promptId)).map((j) => j.id);
}

/** A run in words: "judged 3, 52 unchanged, 1 failed". */
export function runSummary(run: JudgeRun): string {
	const parts = [`judged ${run.judged}`];
	if (run.unchanged > 0) parts.push(`${run.unchanged} unchanged`);
	if (run.failed > 0) parts.push(`${run.failed} failed`);
	return parts.join(", ");
}
