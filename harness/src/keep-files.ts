/**
 * Keep every file: a computer whose Computer object has "Keep every file"
 * (`keep_all_files`) on holds a copy of every File's bytes, so a file stays
 * reachable while the computer that added it sleeps. It fetches what it
 * lacks when a File appears or changes, on boot, and on a slow timer - one
 * file at a time, adding itself to `available_on` as each lands. Files whose
 * holders are all offline wait with a growing delay instead of being retried
 * on every pass, and one offline holder is asked once per pass, not per file.
 * Background fetches never write a File's `error`; that is for a person
 * opening the file.
 */

import { existsSync, readdirSync } from "node:fs";
import { flag, list, queryAll, str, type QueryRow } from "./api";
import { BlobUnavailable, FILE_TYPE, blobDir, ensureBlob, filePeerRunning } from "./files";
import { KEEP_ALL_KEY, MACHINE_TYPE } from "./machine";
import { machineId } from "./roster";

const RETRY_FIRST_MS = 10 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
/** Slow sweep: picks up files whose wait ran out, and anything an event missed. */
export const KEEP_ALL_SWEEP_MS = 10 * 60_000;
const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A file whose holders were all offline: when to try again, the wait that got
 * it there, and which holders (sorted, joined) it waited on.
 */
export interface Backoff {
	at: number;
	delay: number;
	holders: string;
}

/** The next wait after another miss on `holders`: 10 minutes, doubling to at most 6 hours; a new holder set starts over. */
export function nextBackoff(previous: Backoff | undefined, now: number, holders: string[]): Backoff {
	const key = holders.toSorted().join(",");
	const delay = previous?.holders === key ? Math.min(RETRY_MAX_MS, previous.delay * 2) : RETRY_FIRST_MS;
	return { at: now + delay, delay, holders: key };
}

/**
 * What to fetch now, oldest File first: bytes this computer lacks that some
 * other computer holds - one entry per hash, with every holder any File
 * naming it lists. A file waiting out a backoff is left alone until the wait
 * runs out, or until its holders change (another computer now has it).
 */
export function keepAllPlan(files: QueryRow[], me: string, held: Set<string>, backoff: Map<string, Backoff>, now: number): Array<{ hash: string; holders: string[] }> {
	const plan = new Map<string, Set<string>>();
	for (const file of files.toSorted((a, b) => a.createdAt - b.createdAt)) {
		const hash = str(file.fields, "file_hash");
		if (!HASH_RE.test(hash) || held.has(hash)) continue;
		const others = list(file.fields, "available_on").filter((m) => m !== me);
		if (others.length === 0) continue;
		const holders = plan.get(hash) ?? new Set<string>();
		for (const m of others) holders.add(m);
		plan.set(hash, holders);
	}
	return [...plan].flatMap(([hash, set]) => {
		const holders = [...set];
		const wait = backoff.get(hash);
		return wait && wait.at > now && wait.holders === holders.toSorted().join(",") ? [] : [{ hash, holders }];
	});
}

const backoff = new Map<string, Backoff>();
let running = false;
let again = false;

async function pass(): Promise<void> {
	if (!filePeerRunning()) return;
	const me = await machineId();
	const mine = (await queryAll({ type: MACHINE_TYPE })).find((m) => str(m.fields, "machine_id") === me);
	if (!mine || !flag(mine.fields, KEEP_ALL_KEY)) return;
	const held = new Set(existsSync(blobDir()) ? readdirSync(blobDir()) : []);
	const plan = keepAllPlan(await queryAll({ type: FILE_TYPE }), me, held, backoff, Date.now());
	if (plan.length === 0) return;
	const offline = new Set<string>();
	let fetched = 0;
	let waiting = 0;
	for (const { hash, holders } of plan) {
		if (holders.every((h) => offline.has(h))) {
			backoff.set(hash, nextBackoff(backoff.get(hash), Date.now(), holders));
			waiting += 1;
			continue;
		}
		try {
			await ensureBlob(hash, { record: false });
			backoff.delete(hash);
			fetched += 1;
		} catch (err) {
			if (err instanceof BlobUnavailable) for (const h of err.tried) offline.add(h);
			backoff.set(hash, nextBackoff(backoff.get(hash), Date.now(), holders));
			waiting += 1;
			console.log(`[files] keep every file: ${hash.slice(0, 12)} - ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	console.log(`[files] keep every file: fetched ${fetched} of ${plan.length} missing; ${waiting} wait for a holder to come online`);
}

/**
 * Fetch whatever this computer lacks, if its Computer object keeps every
 * file. Calls during a pass coalesce into one more pass.
 */
export function keepAllFiles(): void {
	if (running) {
		again = true;
		return;
	}
	running = true;
	void (async () => {
		try {
			do {
				again = false;
				await pass();
			} while (again);
		} catch (err) {
			console.error("[files] keep every file:", err instanceof Error ? err.message : err);
		} finally {
			running = false;
		}
	})();
}
