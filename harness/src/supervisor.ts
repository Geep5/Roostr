/**
 * What the OS service runs (`bun run service install` sets it up): one
 * process that starts this computer's Roostr programs - the store
 * (glon-odin), sync, the harness, and the local web app when asked -
 * restarts any that exits, and reports a crash as the Error on this
 * computer's Computer object.
 *
 * The OS keeps this process alive and starts it at boot; it keeps the
 * programs alive. Being their parent is the point: it sees exactly how each
 * one ended and its last lines of output, where the OS keeps only the new
 * run's status. Nothing here is liveness: a quiet computer writes nothing,
 * a crash is one Error write, and a crash loop updates that one Error at
 * most every few minutes. Clearing the Error starts the count over.
 */

import type { Subprocess } from "bun";
import { API, setField, str, sv } from "./api";
import { ownMachine } from "./machine";

export interface Program {
	/** Log prefix. */
	name: string;
	/** How the Error names it. */
	label: string;
	cmd: string[];
	cwd: string;
}

/** One program's crashes since its Error was last cleared: how many, the first, and how the latest ended. */
export interface Crash {
	label: string;
	count: number;
	first: number;
	last: number;
	exit: string;
	tail: string[];
}

/** Keyed by label. */
export type Crashes = Map<string, Crash>;

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;
/** A program that ran this long before exiting starts over at the first delay. */
const STABLE_MS = 60_000;
/** A crash loop updates its Error at most this often. */
const REPORT_EVERY_MS = 5 * 60_000;
const TICK_MS = 5_000;
const TAIL_LINES = 20;
const SHOWN_LINES = 3;
const ERROR_MAX = 1200;
const LABELS = ["Store", "Sync", "Harness", "Web app"];
/** An Error this supervisor wrote, so a newer crash report may replace it; anything else is someone's own. */
export const CRASH_RE = new RegExp(`^(${LABELS.join("|")}) crashed `);
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Wait before restarting a program that exited: 1 s, doubling to a minute while it keeps exiting quickly. */
export function nextDelay(previous: number, uptimeMs: number): number {
	if (previous === 0 || uptimeMs >= STABLE_MS) return FIRST_DELAY_MS;
	return Math.min(previous * 2, MAX_DELAY_MS);
}

/** Fold a crash into `into`: counts add, the earliest first stays, the latest exit and output win. */
export function addCrash(into: Crashes, crash: Crash): void {
	const had = into.get(crash.label);
	into.set(crash.label, had ? { ...crash, count: had.count + crash.count, first: Math.min(had.first, crash.first) } : crash);
}

const when = (ms: number): string => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function crashText(crashes: Crashes): string {
	const parts = [...crashes.values()]
		.toSorted((a, b) => a.first - b.first)
		.map((c) => {
			const head = c.count === 1
				? `${c.label} crashed ${when(c.last)} (${c.exit}) and was restarted.`
				: `${c.label} crashed ${c.count} times since ${when(c.first)}, last ${when(c.last)} (${c.exit}); restarted each time.`;
			const tail = c.tail.slice(-SHOWN_LINES).map((line) => line.slice(0, 200));
			return tail.length > 0 ? `${head}\nLast output:\n${tail.join("\n")}` : head;
		});
	return `${parts.join("\n\n").slice(0, ERROR_MAX)}\nLogs: bun run service logs (in harness/)`;
}

/**
 * The Error to write for `fresh` crashes, or null to write nothing. `current`
 * is the Error now, `written` the last one this supervisor wrote, `shown` the
 * crashes it held. An Error changed since (cleared, or replaced by a newer
 * report) was read: the count starts over. Someone else's Error is never
 * overwritten. `urgent`: a program not in the last report, or a report after
 * a clear - written now rather than on the crash-loop pace.
 */
export function reportPlan(current: string, written: string, shown: Crashes, fresh: Crashes): { text: string; shown: Crashes; urgent: boolean } | null {
	if (fresh.size === 0) return null;
	const untouched = current === written;
	if (!untouched && current !== "" && !CRASH_RE.test(current)) return null;
	const merged: Crashes = new Map(untouched ? shown : []);
	for (const crash of fresh.values()) addCrash(merged, crash);
	return { text: crashText(merged), shown: merged, urgent: !untouched || [...fresh.keys()].some((label) => !shown.has(label)) };
}

const log = (message: string): void => console.log(`[service] ${message}`);

/** Forward a child's output line by line under its prefix, keeping its last lines for a crash report. */
async function pump(stream: ReadableStream<Uint8Array>, prefix: string, out: NodeJS.WriteStream, tail: string[]): Promise<void> {
	const decoder = new TextDecoder();
	let rest = "";
	const emit = (line: string): void => {
		out.write(`${prefix}${line}\n`);
		const plain = line.replace(ANSI_RE, "").replace(/\r/g, "").trimEnd();
		if (!plain) return;
		tail.push(plain);
		if (tail.length > TAIL_LINES) tail.shift();
	};
	for await (const chunk of stream) {
		const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
		rest = lines.pop() ?? "";
		for (const line of lines) emit(line);
	}
	if (rest) emit(rest);
}

async function listening(port: number): Promise<boolean> {
	try {
		const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
		socket.end();
		return true;
	} catch {
		return false;
	}
}

/** Run `programs` until SIGTERM/SIGINT; the first is the store, which the others wait for. */
export async function supervise(programs: Program[]): Promise<void> {
	const running = new Map<string, Subprocess>();
	const stopped = Promise.withResolvers<void>();
	let stopping = false;

	const fresh: Crashes = new Map();
	let shown: Crashes = new Map();
	let written = "";
	let lastWrite = 0;
	let reporting = false;

	async function report(): Promise<void> {
		if (reporting || fresh.size === 0) return;
		reporting = true;
		try {
			// Not registered yet: the harness registers this computer on its first start.
			const mine = await ownMachine();
			if (!mine) return;
			const current = str(mine.fields, "error");
			const plan = reportPlan(current, written, shown, fresh);
			if (!plan || (!plan.urgent && Date.now() - lastWrite < REPORT_EVERY_MS)) return;
			if (plan.text !== current) await setField(mine.id, "error", sv(plan.text));
			written = plan.text;
			shown = plan.shown;
			fresh.clear();
			lastWrite = Date.now();
		} catch (err) {
			// The store is down or restarting: the next tick tries again.
			log(`crash report waits for the store: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			reporting = false;
		}
	}

	async function keep(program: Program): Promise<void> {
		const prefix = `${program.name.padEnd(7)}| `;
		let delay = 0;
		while (!stopping) {
			const started = Date.now();
			const tail: string[] = [];
			let exit: string;
			let clean = false;
			try {
				const child = Bun.spawn({ cmd: program.cmd, cwd: program.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
				running.set(program.name, child);
				const pumps = [pump(child.stdout, prefix, process.stdout, tail), pump(child.stderr, prefix, process.stderr, tail)];
				await child.exited;
				running.delete(program.name);
				// The last lines a crashing program wrote, without waiting on a grandchild that still holds the pipe.
				await Promise.race([Promise.all(pumps), Bun.sleep(300)]);
				exit = child.signalCode ? `killed by ${child.signalCode}` : `exit code ${child.exitCode}`;
				clean = child.exitCode === 0;
			} catch (err) {
				exit = `could not start: ${err instanceof Error ? err.message : String(err)}`;
			}
			if (stopping) return;
			delay = nextDelay(delay, Date.now() - started);
			if (clean) {
				log(`${program.label} exited; restarting in ${delay / 1000}s`);
			} else {
				log(`${program.label} crashed (${exit}); restarting in ${delay / 1000}s`);
				const at = Date.now();
				addCrash(fresh, { label: program.label, count: 1, first: at, last: at, exit, tail: [...tail] });
				void report();
			}
			await Promise.race([Bun.sleep(delay), stopped.promise]);
		}
	}

	async function terminate(children: Subprocess[], graceMs: number): Promise<void> {
		for (const child of children) child.kill("SIGTERM");
		await Promise.race([Promise.all(children.map((child) => child.exited)), Bun.sleep(graceMs)]);
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}

	async function stop(signal: string): Promise<void> {
		if (stopping) return;
		stopping = true;
		stopped.resolve();
		log(`${signal}: stopping`);
		// The store last, so the others' final writes land.
		const [store, ...rest] = programs.map((p) => running.get(p.name));
		await terminate(rest.filter((child) => child !== undefined), 10_000);
		if (store) await terminate([store], 5_000);
		process.exit(0);
	}

	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	setInterval(() => void report(), TICK_MS);

	const [store, ...rest] = programs;
	log(`starting ${programs.map((p) => p.label).join(", ")}`);
	void keep(store);
	const port = Number(new URL(API).port || 7333);
	const deadline = Date.now() + 30_000;
	while (!stopping && Date.now() < deadline && !(await listening(port))) await Bun.sleep(250);
	for (const program of rest) void keep(program);
	await stopped.promise;
}
