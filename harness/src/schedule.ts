/**
 * The clock for recurring objects.
 *
 * The engine owns the rule and the occurrence math (`repeat` field:
 * `next` is the current occurrence, `fired_for` marks it as fired). This
 * module only decides WHEN to look and WHO gets told: one armed timer for
 * the earliest unfired `next` among recurring objects this machine serves
 * (per object, resolved by the engine - `docs/object-serving.md`; a job
 * that `requires` browserless fires on the machine that has it). Firing
 * is `occurrence_fire`, whose "already fired" / "stale occurrence"
 * refusals are the idempotency key - two machines that transiently
 * disagree, or a fire racing a re-arm, converge on exactly one dispatch
 * per occurrence.
 *
 * Dispatch: an object with an agent served here - the agent it names
 * (`agent`), else one named by `assignee` - gets a framed message in that
 * agent's chat plus one turn, recorded back onto the object with
 * `run_record`; anything else gets a one-line reminder on its own
 * discussion. Scheduler messages carry
 * `origin: "schedule"`, which keeps them out of the watermark path
 * (`pendingMessages`) - the turn is driven explicitly, never by ingestion.
 *
 * Check first: an object whose `check_first` links a Tool runs it before
 * anything else, without a model, given `{object_id}`. Nothing found (an
 * empty result) records the run as "nothing new" and completes the
 * occurrence - no turn, no message; a finding goes into the turn's frame
 * ahead of the instructions; a failing check is badged and the occurrence
 * completed, so the next one tries again.
 *
 * An occurrence only moves on when something completes it. Day-and-longer
 * repeats leave that to the run's instructions (or a person ticking Done);
 * minute/hour repeats are completed by the scheduler after each run, or
 * the first unfinished one would stop them for good.
 *
 * No state beyond the timer: a restart re-arms from the DAG, and missed
 * occurrences (sleep, downtime) fire on the next arm, each once.
 */

import { deleteField, fetchObject, guestAgents, mutate, queryAll, setField, str, sv, wasDeleted, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { addConvBlock, convKey, humanRef, type ConvRef } from "./conv";
import { CREDENTIAL_BADGE, credentialBadge, takeCredentialIssues } from "./credential-issues";
import { primeServing, servesHere } from "./machine";
import { machineId } from "./roster";
import { objectText } from "./skills";
import { linkIds, runToolObject } from "./tool-objects";
import { localClock } from "./repeat";

export interface ScheduleHost {
	/** The agent's holistic transcript when this machine serves it; undefined otherwise. */
	served(agentId: string): Promise<{ agentId: string; conv: ConvRef } | undefined>;
	/** One scheduler-started turn on the agent's transcript, serialized with its other turns. Resolves to the failure message, "" on success. */
	turn(agentId: string, systemSuffix: string): Promise<string>;
}

/**
 * The scheduler's own words for a run. The object's body is the instructions
 * and wins: it once said "report briefly in this chat" here, and agents did
 * that on top of a body that said to stop - announcing what they had just
 * done in every run.
 */
const TURN_SUFFIX =
	"This turn was started by the scheduler, not a person. Follow the object's instructions exactly - they decide what to post and when the run is done. If they say to stop, end with no reply. Call occurrence_complete only when they say the run is done; if something blocks the run, say what, once, and do not call it.";

/** How much of a check's finding goes into the frame. */
const FINDING_CAP = 8000;

/** A check's result that means "nothing new": nothing, "", [] or {} - also as JSON text. */
export function isEmptyResult(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (typeof value === "object") return Object.keys(value).length === 0;
	if (typeof value !== "string") return false;
	const text = value.trim();
	if (!text) return true;
	try {
		return isEmptyResult(JSON.parse(text));
	} catch {
		return false;
	}
}

/** A minute/hour repeat: the scheduler completes its occurrences itself. */
function subDaily(obj: ObjectJSON): boolean {
	const freq = obj.fields["repeat"]?.mapValue?.entries?.["freq"]?.stringValue;
	return freq === "minute" || freq === "hour";
}

/** Complete the occurrence that fired, unless the run already did (an agent's occurrence_complete). A pushed run has no occurrence. */
async function completeOccurrence(d: Due): Promise<void> {
	if (d.next === undefined) return;
	const now = await fetchObject(d.id);
	if (now.fields["repeat"]?.mapValue?.entries?.["next"]?.intValue !== d.next) return;
	await mutate("occurrence_complete", { object_id: d.id, ...localClock() });
}

/** Error badges a clean run clears: what a failed run or check wrote - never a human's or another writer's message. */
async function clearRunBadge(obj: ObjectJSON, alsoNoAgent: boolean): Promise<void> {
	const badge = str(obj.fields, "error");
	if (badge.startsWith("run failed:") || badge.startsWith("check failed:") || badge.startsWith(CREDENTIAL_BADGE) || (alsoNoAgent && badge.startsWith("recurring object has no agent"))) await deleteField(obj.id, "error");
}

/** setTimeout's ceiling; longer waits re-arm when it elapses. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** A run's object and, for a clock-fired run, the occurrence it fires (undefined: a pushed run). */
interface Due {
	id: string;
	next: number | undefined;
	firedFor: number | undefined;
}
/** A recurring object's clock: always has an occurrence. */
interface ClockDue extends Due {
	next: number;
}

/** Runs per object, chained: a pushed run and a clock run never import the same mail twice at once. */
const runChains = new Map<string, Promise<void>>();
/** Objects with a pushed run queued but not started: more pushes meanwhile ride on it. */
const pushQueued = new Set<string>();

function serialized(id: string, work: () => Promise<void>): Promise<void> {
	const run = (runChains.get(id) ?? Promise.resolve()).then(work, work);
	const tail = run.catch(() => {});
	runChains.set(id, tail);
	void tail.then(() => {
		if (runChains.get(id) === tail) runChains.delete(id);
	});
	return run;
}

/**
 * Run an object now, outside its clock - a push said its source changed
 * (gmail-push.ts). Same path as an occurrence (Check first, then a turn
 * only when it found something) but no occurrence fires or completes.
 * Pushes that arrive while one is queued coalesce into it.
 */
export function runNow(objectId: string, why: string): Promise<void> {
	if (pushQueued.has(objectId)) return Promise.resolve();
	pushQueued.add(objectId);
	return serialized(objectId, async () => {
		pushQueued.delete(objectId);
		const me = await machineId();
		console.log(`[schedule] ${objectId.slice(0, 8)} run now: ${why}`);
		await dispatch({ id: objectId, next: undefined, firedFor: undefined }, me);
	});
}

let host: ScheduleHost | null = null;
let turnEnded: (() => void) | undefined;
let timer: Timer | undefined;
let arming = false;
let armAgain = false;
let firing = false;
/** Bumped by resetScheduler: work started under an older scheduler leaves the new one alone. */
let generation = 0;

/** `repeat.next` / `repeat.fired_for`, or null when the object does not repeat. */
function dueOf(row: { id: string; fields: Record<string, ValueJSON> }): ClockDue | null {
	const entries = row.fields["repeat"]?.mapValue?.entries;
	const next = entries?.["next"]?.intValue;
	if (next === undefined) return null;
	return { id: row.id, next, firedFor: entries?.["fired_for"]?.intValue };
}

/** Every recurring object this machine serves, with its clock. */
async function recurringMine(): Promise<ClockDue[]> {
	const rows: QueryRow[] = await queryAll({ filters: [{ key: "repeat", condition: "exists" }] });
	const dues = rows.map(dueOf).filter((d): d is ClockDue => d !== null);
	await primeServing(dues.map((d) => d.id));
	const out: ClockDue[] = [];
	for (const d of dues) if (await servesHere(d.id)) out.push(d);
	return out;
}

/** Wire the host and arm; `serve` calls this once after boot catch-up. */
export async function startScheduler(h: ScheduleHost): Promise<void> {
	host = h;
	// Nothing runs at boot: a Running… mark left by a run this computer was killed in is stale.
	for (const d of await recurringMine().catch(() => [] as Due[])) {
		const obj = await fetchObject(d.id).catch(() => null);
		if (obj?.fields[RUN_ACTIVE_KEY]) await deleteField(d.id, RUN_ACTIVE_KEY).catch(() => {});
		// A Run now asked for while this computer was off.
		if (obj?.fields[RUN_REQUEST_KEY]) await handleRunRequest(obj);
	}
	await arm();
	// An occurrence that never finished stops its object for good: say so on its Error.
	void flagStuckRuns().catch((err) => console.error("[schedule] stuck-run check:", err instanceof Error ? err.message : err));
	stuckTimer ??= setInterval(() => void flagStuckRuns().catch((err) => console.error("[schedule] stuck-run check:", err instanceof Error ? err.message : err)), STUCK_CHECK_MS);
}

/** Error-badge prefix for an occurrence that fired and never finished. */
export const STUCK_BADGE = "run never finished: ";
const STUCK_CHECK_MS = 10 * 60_000;
let stuckTimer: Timer | undefined;
const UNIT_MS: Record<string, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 28 * 86_400_000, year: 365 * 86_400_000 };

/**
 * How long after an occurrence the next one is due, roughly (the rule's
 * unit x interval, divided among its times of day). Null for minute/hour
 * repeats, which the scheduler completes itself.
 */
export function occurrenceGap(rule: Record<string, ValueJSON>): number | null {
	const unit = UNIT_MS[rule["freq"]?.stringValue ?? ""];
	if (!unit) return null;
	const interval = Math.max(1, rule["interval"]?.intValue ?? 1);
	const times = Math.max(1, rule["times"]?.valuesValue?.items?.length ?? 1);
	return (unit * interval) / times;
}

/** The newest message in an object's chat - usually what stopped the run. */
function lastChatLine(obj: ObjectJSON): { author: string; text: string } {
	let best = { ts: -1, author: "", text: "" };
	for (const b of obj.blocks) {
		const m = b.content.custom?.meta;
		if (b.content.custom?.contentType !== "chat" || !m?.text || m.author === "scheduler") continue;
		const ts = Number(m.ts ?? 0);
		if (ts > best.ts) best = { ts, author: m.author ?? "", text: m.text };
	}
	return { author: best.author, text: best.text.replace(/\s+/g, " ").trim() };
}

/**
 * Whom a stuck run waits on: an agent the last message @-mentions (one of
 * the object's guests, not its author) - "Marco Dev Bot (runs on
 * geepOmenComp)" - else "".
 */
async function waitingOn(obj: ObjectJSON, last: { author: string; text: string }): Promise<string> {
	for (const id of guestAgents(obj.fields)) {
		if (id === last.author) continue;
		const agent = await fetchObject(id).catch(() => null);
		const name = agent ? str(agent.fields, "name") : "";
		if (!name || !last.text.includes(`@${name}`)) continue;
		const pin = str(agent!.fields, "served_by");
		const machine = pin ? (await queryAll({ type: "machine" })).find((m) => str(m.fields, "machine_id") === pin) : undefined;
		return machine ? `${name} (runs on ${str(machine.fields, "name")})` : name;
	}
	return "";
}

/**
 * A day-or-longer occurrence that fired but is still open once the next one
 * would have been due is stuck: the schedule waits on it for good. Its
 * object's Error says so - when, whom it waits on (an agent the last message
 * asked) or else the last thing said in its chat - and how to fix it: Retry
 * run (Run now on an open occurrence retries it) or Skip this run. Cleared
 * once it finishes. Only this badge is touched: another Error (a person's, a
 * signed-out login) stays.
 */
export async function flagStuckRuns(now = Date.now()): Promise<number> {
	let stuck = 0;
	for (const d of await recurringMine()) {
		const obj = await fetchObject(d.id).catch(() => null);
		if (!obj) continue;
		const rule = obj.fields["repeat"]?.mapValue?.entries ?? {};
		const gap = occurrenceGap(rule);
		const badge = str(obj.fields, "error");
		const isStuck = gap !== null && d.firedFor === d.next && !running.has(d.id) && now > d.next + gap;
		if (isStuck) {
			stuck += 1;
			const when = new Date(d.next).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
			const last = lastChatLine(obj);
			const waiting = last.text ? await waitingOn(obj, last) : "";
			const why = waiting ? ` It is waiting for a reply from ${waiting}.` : last.text ? ` Last message: "${last.text.slice(0, 120)}".` : "";
			const next = `${STUCK_BADGE}the ${when} run is still open, so this hasn't run since.${why} Fix that, then Retry run (under Repeat) or Skip this run.`.slice(0, 300);
			if ((!badge || badge.startsWith(STUCK_BADGE)) && badge !== next) {
				await setField(d.id, "error", sv(next));
				console.log(`[schedule] "${str(obj.fields, "name")}" (${d.id.slice(0, 8)}) stuck since ${when}${waiting ? `, waiting for ${waiting}` : ""}`);
			}
		} else if (badge.startsWith(STUCK_BADGE)) {
			await deleteField(d.id, "error");
		}
	}
	return stuck;
}
/** Completion signal for deterministic tests; production ignores it. */
export function waitForTurnEnd(): Promise<void> {
	return new Promise((resolve) => {
		turnEnded = resolve;
	});
}
/** Test seam: drop host/timer without touching exported behavior. */
export function resetScheduler(): void {
	turnEnded = undefined;
	clearTimeout(timer);
	timer = undefined;
	host = null;
	arming = false;
	armAgain = false;
	firing = false;
<<<<<<< Updated upstream
	running.clear();
	generation += 1;
	clearInterval(stuckTimer);
	stuckTimer = undefined;
=======
	runChains.clear();
	pushQueued.clear();
>>>>>>> Stashed changes
}

/**
 * Point the timer at the earliest unfired occurrence. Cheap to call on
 * every commit that could move it (a `repeat` edit, a `served_by` or
 * `requires` change, a capability or install flip): concurrent calls
 * coalesce into one re-query.
 */
export async function arm(): Promise<void> {
	if (arming) {
		armAgain = true;
		return;
	}
	arming = true;
	try {
		do {
			armAgain = false;
			let soonest = Infinity;
			for (const d of await recurringMine()) {
				if (d.firedFor !== d.next && d.next < soonest) soonest = d.next;
			}
			clearTimeout(timer);
			timer = undefined;
			// Not started, or stopped (tests) while the query ran: nothing to point at.
			if (soonest === Infinity || !host) continue;
			const delay = Math.min(Math.max(0, soonest - Date.now()), MAX_DELAY_MS);
			timer = setTimeout(() => void fire(), delay);
			console.log(`[schedule] next occurrence at ${new Date(soonest).toISOString()} (in ${Math.round(delay / 1000)}s)`);
		} while (armAgain);
	} catch (err) {
		console.error("[schedule] arm failed:", err instanceof Error ? err.message : err);
	} finally {
		arming = false;
	}
}

/** Fire everything due, oldest first, then re-arm. */
async function fire(): Promise<void> {
	if (firing) return;
	firing = true;
	try {
		const now = Date.now();
		// An object mid-run waits: it fires when that run ends (runExclusive re-arms).
		const due = (await recurringMine()).filter((d) => d.next <= now && d.firedFor !== d.next && !running.has(d.id)).sort((a, b) => a.next - b.next);
		const me = await machineId();
		for (const d of due) {
			try {
				await mutate("occurrence_fire", { object_id: d.id, for_ms: d.next, machine: me, now_ms: Date.now() });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Another writer won this occurrence (or advanced past it).
				if (msg.includes("occurrence already fired") || msg.includes("stale occurrence")) continue;
				// Deleted (or its space was) since the query: it has no next occurrence.
				if (wasDeleted(err)) console.log(`[schedule] ${d.id.slice(0, 8)} skipped: ${msg}`);
				else console.error(`[schedule] fire ${d.id.slice(0, 8)} failed: ${msg}`);
				continue;
			}
			// Turns run for as long as the agent needs; the next due object
			// must not wait on them. `fired_for` is already committed, so a
			// re-arm mid-turn cannot fire this occurrence twice.
<<<<<<< Updated upstream
			void runExclusive(d, me, "scheduled").catch((err) => {
=======
			void serialized(d.id, () => dispatch(d, me)).catch((err) => {
>>>>>>> Stashed changes
				// Deleted mid-run: the run has nowhere left to be recorded.
				if (wasDeleted(err)) console.log(`[schedule] dispatch ${d.id.slice(0, 8)} stopped: ${err.message}`);
				else console.error(`[schedule] dispatch ${d.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
			});
		}
	} catch (err) {
		console.error("[schedule] fire failed:", err instanceof Error ? err.message : err);
	} finally {
		firing = false;
	}
	await arm();
}

/** Agent ids a field may name: a string, a link, or a list of either. */
function agentIdsOf(v: ValueJSON | undefined): string[] {
	return guestAgents({ agent: v as ValueJSON });
}

/**
 * The served agent responsible for the object, if any: the agent it names
 * first (that's the mind with its transcript), then `assignee`.
 */
async function ownerOf(obj: ObjectJSON): Promise<{ agentId: string; conv: ConvRef } | undefined> {
	if (!host) return undefined;
	const candidates = [...agentIdsOf(obj.fields["agent"]), ...agentIdsOf(obj.fields["assignee"])];
	for (const id of candidates) {
		const s = await host.served(id);
		if (s) return s;
	}
	// No agent named at all: there is no default mind to fall back to. Say
	// so on the object's Error badge (the same honest-error convention as
	// capability holdups) and do not fire.
	if (candidates.length === 0) await setField(obj.id, "error", sv("recurring object has no agent; add one to its Agent property"));
	return undefined;
}

/** A scheduler message: same block shape as an ingested copy, tagged with its occurrence. */
async function postScheduled(ref: ConvRef, text: string, d: Due, me: string): Promise<void> {
	await addConvBlock(ref, {
		id: crypto.randomUUID(),
		childrenIds: [],
		content: {
			custom: {
				contentType: "chat",
				meta: { author: "scheduler", text, ts: String(Date.now()), origin: "schedule", origin_object: d.id, occurrence: d.next === undefined ? "push" : String(d.next), fired_by: me },
			},
		},
	});
}

/**
 * Which run this is: the clock's occurrence, a person retrying the open
 * occurrence that never finished (it may complete it), or an extra run
 * outside the schedule (it must not).
 */
type RunKind = "scheduled" | "retry" | "extra";

/**
 * Tell the owner: an agent gets the instructions and a turn, a person gets
 * a reminder - unless the object's Check first finds nothing to do.
 */
async function dispatch(d: Due, me: string, kind: RunKind = "scheduled"): Promise<void> {
	if (!host) return;
	try {
		const obj = await fetchObject(d.id);
		const name = str(obj.fields, "name") || "(untitled)";
		const when = new Date(d.next ?? Date.now()).toLocaleString();
		const owner = await ownerOf(obj);
		const checkId = linkIds(obj.fields, "check_first")[0];
		let finding = "";
		if (checkId) {
			let check: { name: string; value: unknown };
			try {
				check = await runToolObject(checkId, { object_id: obj.id }, { agentId: owner?.agentId ?? "", channelId: str(obj.fields, "channel"), boundObject: obj.id, depth: 0, touched: new Set() });
			} catch (err) {
				const failure = `check failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
				await mutate("run_record", { object_id: obj.id, run: { at: Date.now(), machine: me, error: failure } });
				await setField(obj.id, "error", sv(failure));
				// Completed anyway: the next occurrence is the retry.
				await completeOccurrence(d);
				console.log(`[schedule] "${name}" (${obj.id.slice(0, 8)}) ${failure}`);
				return;
			}
			if (isEmptyResult(check.value)) {
				await mutate("run_record", { object_id: obj.id, run: { at: Date.now(), machine: me, result: "nothing new" } });
				await clearRunBadge(obj, false);
				await completeOccurrence(d);
				console.log(`[schedule] "${name}" (${obj.id.slice(0, 8)}) - ${check.name} found nothing new; no turn`);
				return;
			}
			const shown = typeof check.value === "string" ? check.value : JSON.stringify(check.value, null, 1);
			finding = `Check first (${check.name}) found:\n${shown.length > FINDING_CAP ? `${shown.slice(0, FINDING_CAP)}\n… (cut at ${FINDING_CAP} characters)` : shown}`;
		}
		if (!owner) {
<<<<<<< Updated upstream
			await postScheduled(humanRef(obj.id), kind === "extra" ? `\u21bb "${name}" was run now` : kind === "retry" ? `\u21bb "${name}" (due ${when}) was retried` : `\u21bb "${name}" is due (${when})`, d, me);
=======
			// A push with no agent to tell: the check already did the work.
			if (d.next === undefined) return;
			await postScheduled(humanRef(obj.id), `\u21bb "${name}" is due (${when})`, d, me);
>>>>>>> Stashed changes
			if (subDaily(obj)) await completeOccurrence(d);
			console.log(`[schedule] reminded "${name}" (${obj.id.slice(0, 8)}) - no served agent owns it`);
			return;
		}
		const body = objectText(obj).slice(0, 4000);
		const ending = kind === "extra"
			? "this is an extra run started by a person with Run now, not a scheduled occurrence - don't call occurrence_complete."
			: subDaily(obj)
				? "the scheduler completes this run when your turn ends - don't call occurrence_complete."
				: `occurrence_complete on object ${obj.id} ends the run when they say it is done.`;
		const header =
			kind === "extra"
				? `Run now of "${name}" (${obj.typeKey || "object"})`
				: kind === "retry"
					? `Retry of "${name}" (${obj.typeKey || "object"}): the occurrence due ${when} never finished, and a person pressed Retry - do it again now, from the start`
					: `Scheduled occurrence of "${name}" (${obj.typeKey || "object"}), due ${when}`;
		const frame = [
<<<<<<< Updated upstream
			`${header}. ${finding ? "What its check found, then its instructions" : "Its instructions"} follow; ${ending}`,
=======
			d.next === undefined
				? `Run of "${name}" (${obj.typeKey || "object"}) started now because its source changed (a push), not by its clock - don't call occurrence_complete. ${finding ? "What its check found, then its instructions" : "Its instructions"} follow.`
				: `Scheduled occurrence of "${name}" (${obj.typeKey || "object"}), due ${when}. ${finding ? "What its check found, then its instructions" : "Its instructions"} follow; ${ending}`,
>>>>>>> Stashed changes
			...(finding ? [finding, "Instructions:"] : []),
			body || "(this object has no body text)",
		].join("\n");
		await postScheduled(owner.conv, frame, d, me);
		console.log(`[schedule] "${name}" (${obj.id.slice(0, 8)}) → agent ${owner.agentId.slice(0, 8)}`);
		takeCredentialIssues(owner.agentId); // a chat turn's leftovers are not this run's
		const error = await host.turn(owner.agentId, kind === "extra" ? RUN_NOW_SUFFIX : TURN_SUFFIX);
		const deadLogins = takeCredentialIssues(owner.agentId);
		const run: Record<string, unknown> = { at: Date.now(), machine: me, conversation: convKey(owner.conv) };
		if (error) run.error = error;
		else if (deadLogins.length > 0) run.error = credentialBadge(deadLogins);
		await mutate("run_record", { object_id: obj.id, run });
		// The error badge: a failed run sets it, and so does a run that hit a
		// signed-out credential (the turn itself "succeeds" - the agent just
		// says why it couldn't); a clean run clears what either wrote (or the
		// no-agent badge, once the object names one).
		if (error) await setField(obj.id, "error", sv(`run failed: ${error}`.slice(0, 300)));
		else if (deadLogins.length > 0) await setField(obj.id, "error", sv(credentialBadge(deadLogins)));
		else await clearRunBadge(obj, true);
		if (subDaily(obj)) await completeOccurrence(d);
	} finally {
		turnEnded?.();
	}
}

/** A Run now turn's own words: the object's instructions as usual, but the schedule is not this run's to move. */
const RUN_NOW_SUFFIX =
	"This turn was started by a person pressing Run now on the object - an extra run, not a scheduled occurrence. Follow the object's instructions exactly - they decide what to post. If they say to stop, end with no reply. Never call occurrence_complete in this run; if something blocks it, say what, once.";

/** On a repeating object: a person asked for Run now ({at}); the computer that serves it starts the run and deletes this. */
export const RUN_REQUEST_KEY = "run_now";
/** On a repeating object while a run of it is in progress ({at, machine, manual}): every device shows it; another run waits. */
const RUN_ACTIVE_KEY = "run_active";

/** Objects with a run in progress on this computer. */
const running = new Set<string>();

/** Mark the run on the object, run it, then clear the mark and look again for what waited on it. */
async function runExclusive(d: Due, me: string, kind: RunKind): Promise<void> {
	const gen = generation;
	running.add(d.id);
	try {
		await setField(d.id, RUN_ACTIVE_KEY, { mapValue: { entries: { at: { intValue: Date.now() }, machine: sv(me), manual: { boolValue: kind !== "scheduled" } } } }).catch(() => {});
		await dispatch(d, me, kind);
	} finally {
		// A run that outlived its scheduler (tests reset it) neither frees nor re-arms the new one.
		if (gen === generation) {
			running.delete(d.id);
			await deleteField(d.id, RUN_ACTIVE_KEY).catch(() => {});
			// An occurrence that came due mid-run was held back: fire it now (unless reset meanwhile).
			if (gen === generation) {
				void arm();
				// The Error says where things stand now - stuck, waiting on whom, or fine.
				void flagStuckRuns().catch(() => {});
			}
		}
	}
}

/**
 * A Run now request on `obj` (its `run_now` field, written by any device):
 * the computer that serves the object claims it - deletes the request - and
 * starts a run exactly as an occurrence runs (Check first, the agent's turn
 * with the page as instructions, the run record). While an occurrence is
 * open (fired, never finished) that run is a Retry of it - finishing it
 * moves the schedule on, which is how a stuck object is fixed; otherwise
 * it is an extra run outside the schedule. A request while a run is in
 * progress is dropped; the app shows Running… and offers no Run now then.
 */
export async function handleRunRequest(obj: ObjectJSON): Promise<void> {
	if (!host || !obj.fields[RUN_REQUEST_KEY] || !obj.fields["repeat"]) return;
	if (!(await servesHere(obj.id))) return;
	// Check and claim with no await between: two events for one click can't both start a run.
	if (running.has(obj.id)) {
		await deleteField(obj.id, RUN_REQUEST_KEY).catch(() => {});
		console.log(`[schedule] run now of ${obj.id.slice(0, 8)} skipped: a run is in progress`);
		return;
	}
	running.add(obj.id);
	try {
		await deleteField(obj.id, RUN_REQUEST_KEY);
		const me = await machineId();
		const due = dueOf(obj);
		const open = !!due && due.firedFor === due.next && !subDaily(obj);
		console.log(`[schedule] ${open ? "retry" : "run now"} of "${str(obj.fields, "name")}" (${obj.id.slice(0, 8)})`);
		// A retry is the open occurrence itself; an extra run has no `next` to match, so it completes nothing.
		const d: Due = open ? due! : { id: obj.id, next: -1, firedFor: undefined };
		void runExclusive(d, me, open ? "retry" : "extra").catch((err) => console.error(`[schedule] run now ${obj.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
	} catch (err) {
		running.delete(obj.id);
		throw err;
	}
}

