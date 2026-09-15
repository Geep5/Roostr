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
 * Dispatch: an object with an agent served here - its own bound agent, or
 * one named by `assignee` / `agent` - gets a framed message in that
 * agent's chat plus one turn, recorded back onto the object with
 * `run_record`; anything else gets a one-line reminder on its own
 * discussion. Scheduler messages carry
 * `origin: "schedule"`, which keeps them out of the watermark path
 * (`pendingMessages`) - the turn is driven explicitly, never by ingestion.
 *
 * No state beyond the timer: a restart re-arms from the DAG, and missed
 * occurrences (sleep, downtime) fire on the next arm, each once.
 */

import { addBlock, deleteField, fetchObject, mutate, queryAll, setField, str, sv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { primeServing, servesHere } from "./machine";
import { machineId } from "./roster";
import { objectText } from "./skills";

export interface ScheduleHost {
	/** The agent's holistic chat when this machine serves it; undefined otherwise. */
	served(agentId: string): Promise<{ agentId: string; chatId: string } | undefined>;
	/** One scheduler-started turn on the agent's chat, serialized with its other turns. Resolves to the failure message, "" on success. */
	turn(agentId: string, systemSuffix: string): Promise<string>;
}

const TURN_SUFFIX =
	"This turn was started by the scheduler, not a person. Do the task described, report briefly in this chat, and call occurrence_complete when done. If you cannot complete it, say why and do not call occurrence_complete.";

/** setTimeout's ceiling; longer waits re-arm when it elapses. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** A scheduled object's clock fields. */
interface Due {
	id: string;
	next: number;
	firedFor: number | undefined;
}

let host: ScheduleHost | null = null;
let timer: Timer | undefined;
let arming = false;
let armAgain = false;
let firing = false;

/** `repeat.next` / `repeat.fired_for`, or null when the object does not repeat. */
function dueOf(row: { id: string; fields: Record<string, ValueJSON> }): Due | null {
	const entries = row.fields["repeat"]?.mapValue?.entries;
	const next = entries?.["next"]?.intValue;
	if (next === undefined) return null;
	return { id: row.id, next, firedFor: entries?.["fired_for"]?.intValue };
}

/** Every recurring object this machine serves, with its clock. */
async function recurringMine(): Promise<Due[]> {
	const rows: QueryRow[] = await queryAll({ filters: [{ key: "repeat", condition: "exists" }] });
	const dues = rows.map(dueOf).filter((d): d is Due => d !== null);
	await primeServing(dues.map((d) => d.id));
	const out: Due[] = [];
	for (const d of dues) if (await servesHere(d.id)) out.push(d);
	return out;
}

/** Wire the host and arm; `serve` calls this once after boot catch-up. */
export async function startScheduler(h: ScheduleHost): Promise<void> {
	host = h;
	await arm();
}

/**
 * Point the timer at the earliest unfired occurrence. Cheap to call on
 * every commit that could move it (a `repeat` edit, a `served_by` or
 * `requires` change, a machine's capabilities): concurrent calls coalesce
 * into one re-query.
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
			if (soonest === Infinity) continue;
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
		const due = (await recurringMine()).filter((d) => d.next <= now && d.firedFor !== d.next).sort((a, b) => a.next - b.next);
		const me = await machineId();
		for (const d of due) {
			try {
				await mutate("occurrence_fire", { object_id: d.id, for_ms: d.next, machine: me, now_ms: Date.now() });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Another writer won this occurrence (or advanced past it).
				if (msg.includes("occurrence already fired") || msg.includes("stale occurrence")) continue;
				console.error(`[schedule] fire ${d.id.slice(0, 8)} failed: ${msg}`);
				continue;
			}
			// Turns run for as long as the agent needs; the next due object
			// must not wait on them. `fired_for` is already committed, so a
			// re-arm mid-turn cannot fire this occurrence twice.
			void dispatch(d, me).catch((err) => console.error(`[schedule] dispatch ${d.id.slice(0, 8)} failed:`, err instanceof Error ? err.message : err));
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
	if (!v) return [];
	if (v.stringValue) return [v.stringValue];
	if (v.linkValue?.targetId) return [v.linkValue.targetId];
	return (v.valuesValue?.items ?? []).flatMap(agentIdsOf);
}

/**
 * The served agent responsible for the object, if any. The object's own
 * bound agent first - the mind minted from its discussion is the one that
 * has read it - then whoever `assignee` / `agent` name.
 */
async function ownerOf(obj: ObjectJSON): Promise<{ agentId: string; chatId: string } | undefined> {
	if (!host) return undefined;
	const bound = await queryAll({ type: "agent", filters: [{ key: "bound_object", condition: "equal", value: obj.id }] });
	const candidates = [...bound.map((a) => a.id).sort(), ...agentIdsOf(obj.fields["assignee"]), ...agentIdsOf(obj.fields["agent"])];
	for (const id of candidates) {
		const s = await host.served(id);
		if (s) return s;
	}
	return undefined;
}

/** A scheduler message: same block shape as an ingested copy, tagged with its occurrence. */
async function postScheduled(surfaceId: string, text: string, d: Due, me: string): Promise<void> {
	await addBlock(
		surfaceId,
		{
			id: crypto.randomUUID(),
			childrenIds: [],
			content: {
				custom: {
					contentType: "chat",
					meta: { author: "scheduler", text, ts: String(Date.now()), origin: "schedule", origin_object: d.id, occurrence: String(d.next), fired_by: me },
				},
			},
		},
		"__discussion__",
		5, // INNER
	);
}

/** Tell the owner: an agent gets the instructions and a turn, a person gets a reminder. */
async function dispatch(d: Due, me: string): Promise<void> {
	if (!host) return;
	const obj = await fetchObject(d.id);
	const name = str(obj.fields, "name") || "(untitled)";
	const when = new Date(d.next).toLocaleString();
	const owner = await ownerOf(obj);
	if (!owner) {
		await postScheduled(obj.id, `\u21bb "${name}" is due (${when})`, d, me);
		console.log(`[schedule] reminded "${name}" (${obj.id.slice(0, 8)}) - no served agent owns it`);
		return;
	}
	const body = objectText(obj).slice(0, 4000);
	const frame = [
		`Scheduled occurrence of "${name}" (${obj.typeKey || "object"}), due ${when}. Instructions follow. When you have finished, call occurrence_complete on object ${obj.id}.`,
		body || "(this object has no body text)",
	].join("\n");
	await postScheduled(owner.chatId, frame, d, me);
	console.log(`[schedule] "${name}" (${obj.id.slice(0, 8)}) → agent ${owner.agentId.slice(0, 8)}`);
	const error = await host.turn(owner.agentId, TURN_SUFFIX);
	const run: Record<string, unknown> = { at: Date.now(), machine: me, conversation: owner.chatId };
	if (error) run.error = error;
	await mutate("run_record", { object_id: obj.id, run });
	// The error badge: a failed run sets it; a clean run clears what a
	// failed run wrote - never a human's or another writer's message.
	const badge = str(obj.fields, "error");
	if (error) await setField(obj.id, "error", sv(`run failed: ${error}`.slice(0, 300)));
	else if (badge.startsWith("run failed:")) await deleteField(obj.id, "error");
}
