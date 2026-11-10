/**
 * Live progress in chats: while an agent answers an object's chat, the
 * people watching that chat see its thinking and its tool steps as they
 * happen. Events go out through ONE seam, `publishLive`, which paces them
 * per run (at most one every LIVE_INTERVAL_MS, deltas coalesced while they
 * wait) and hands them to the transport: the store's `live_publish`, which
 * puts them on its change stream and lets the sync daemon carry them to the
 * account's other devices as encrypted ephemeral relay events (kind 25078,
 * core/live.odin). The harness swaps in rtc.ts, which sends them down direct
 * WebRTC lines first and keeps the relay copy for viewers without one.
 * Nothing is stored; a publish that fails costs the viewer a line of
 * progress, never the turn.
 *
 * What lasts is the record on the reply itself: `LiveRun.record()` (the
 * thinking and steps, merged and capped) and `thoughtMs()`, which the
 * reply's chat_post carries as `thinking` / `thought_ms`.
 */

import { mutate } from "./api";
import type { LiveEvent, LiveKind } from "./types";

export const LIVE_INTERVAL_MS = 250;
/** One coalesced delta stays well under the engine's 32 KiB per event. */
const LIVE_DELTA_CHARS = 16 * 1024;
/** The reply's `thinking` record, at most. */
export const RECORD_CAP_BYTES = 64 * 1024;
export const TRIMMED_MARKER = "(earlier thinking trimmed)";

/** How a live event leaves this computer (rtc.ts's direct lines in the harness). */
export type LiveTransport = (event: LiveEvent) => Promise<void>;

const storeTransport: LiveTransport = async (event) => {
	await mutate("live_publish", { event });
};
let transport: LiveTransport = storeTransport;

/** Swap the transport (tests, a peer-to-peer path); null restores the store's. */
export function setLiveTransport(next: LiveTransport | null): void {
	transport = next ?? storeTransport;
}

export type LiveInput = Pick<LiveEvent, "run" | "agent" | "object" | "thread" | "kind" | "text">;

interface Pacer {
	queue: Array<{ kind: LiveKind; text: string; ts: number }>;
	seq: number;
	lastSent: number;
	draining: Promise<void> | null;
	failures: number;
	base: Pick<LiveEvent, "run" | "agent" | "object" | "thread">;
}

const pacers = new Map<string, Pacer>();

/**
 * Publish one piece of a run's progress. Thinking and text are deltas: while
 * an event waits for its slot, the next delta of the same kind joins it. A
 * run ends with `done` or `error`; its pacer goes once that is out.
 */
export function publishLive(input: LiveInput): void {
	let pacer = pacers.get(input.run);
	if (!pacer) {
		pacer = { queue: [], seq: 0, lastSent: 0, draining: null, failures: 0, base: { run: input.run, agent: input.agent, object: input.object, thread: input.thread } };
		pacers.set(input.run, pacer);
	}
	const tail = pacer.queue[pacer.queue.length - 1];
	const delta = input.kind === "thinking" || input.kind === "text";
	if (delta && tail?.kind === input.kind && tail.text.length + input.text.length <= LIVE_DELTA_CHARS) tail.text += input.text;
	else pacer.queue.push({ kind: input.kind, text: input.text, ts: Date.now() });
	if (!pacer.draining) pacer.draining = drain(pacer);
}

async function drain(pacer: Pacer): Promise<void> {
	while (pacer.queue.length > 0) {
		const wait = pacer.lastSent + LIVE_INTERVAL_MS - Date.now();
		if (wait > 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, wait);
			await promise;
		}
		const next = pacer.queue.shift()!;
		pacer.lastSent = Date.now();
		const event: LiveEvent = { v: 1, ...pacer.base, seq: pacer.seq++, kind: next.kind, text: next.text, ts: next.ts };
		try {
			await transport(event);
		} catch (err) {
			if (pacer.failures++ === 0) console.error(`[live] publishing progress of run ${pacer.base.run.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
		}
		if (next.kind === "done" || next.kind === "error") {
			pacers.delete(pacer.base.run);
			pacer.queue.length = 0;
		}
	}
	pacer.draining = null;
}

/** Resolves once everything published so far - for `run`, or every run - has gone out (tests, shutdown). */
export async function liveSettled(run?: string): Promise<void> {
	for (;;) {
		const draining = (run === undefined ? [...pacers.values()] : [pacers.get(run)]).flatMap((p) => (p?.draining ? [p.draining] : []));
		if (draining.length === 0) return;
		await Promise.all(draining);
	}
}

export interface RecordEntry {
	kind: "thinking" | "step";
	text: string;
	ts: number;
}

/**
 * The record kept on the reply: consecutive thinking merged into one entry,
 * at most `cap` bytes of JSON. Over the cap, the oldest thinking goes first
 * (steps stay), with a leading marker step saying so.
 */
export function capRecord(entries: readonly RecordEntry[], cap = RECORD_CAP_BYTES): string {
	const size = (list: readonly RecordEntry[]): number => Buffer.byteLength(JSON.stringify(list));
	if (size(entries) <= cap) return JSON.stringify(entries);
	const kept = entries.map((e) => ({ ...e }));
	const marker: RecordEntry = { kind: "step", text: TRIMMED_MARKER, ts: entries[0]?.ts ?? 0 };
	const withMarker = (): RecordEntry[] => [marker, ...kept];
	// Whole thinking entries, oldest first, then the front of the last one left.
	for (let i = 0; i < kept.length && size(withMarker()) > cap; ) {
		if (kept[i].kind !== "thinking") {
			i++;
			continue;
		}
		const over = size(withMarker()) - cap;
		const bytes = Buffer.byteLength(kept[i].text);
		if (bytes <= over || kept.slice(i + 1).some((e) => e.kind === "thinking")) {
			kept.splice(i, 1);
			continue;
		}
		// The newest thinking, trimmed from its start (a few spare bytes for escapes).
		kept[i].text = Buffer.from(kept[i].text).subarray(over + 16).toString().replace(/^\uFFFD+/, "");
		i++;
	}
	// Steps alone over the cap: the oldest steps go too.
	while (kept.length > 0 && size(withMarker()) > cap) kept.shift();
	return JSON.stringify(withMarker());
}

/**
 * One agent run answering one object's chat: publishes its progress and
 * keeps the record its reply carries.
 */
export class LiveRun {
	readonly run = crypto.randomUUID();
	private readonly started = Date.now();
	private readonly entries: RecordEntry[] = [];
	private ended = false;

	constructor(
		readonly agent: string,
		readonly object: string,
		readonly thread: string,
	) {}

	private publish(kind: LiveKind, text: string): void {
		if (this.ended) return;
		publishLive({ run: this.run, agent: this.agent, object: this.object, thread: this.thread, kind, text });
	}

	thinking(delta: string): void {
		if (!delta || this.ended) return;
		const last = this.entries[this.entries.length - 1];
		if (last?.kind === "thinking") last.text += delta;
		else this.entries.push({ kind: "thinking", text: delta, ts: Date.now() });
		this.publish("thinking", delta);
	}

	text(delta: string): void {
		if (delta) this.publish("text", delta);
	}

	step(name: string, input: Record<string, unknown>): void {
		if (this.ended) return;
		const summary = stepSummary(name, input);
		this.entries.push({ kind: "step", text: summary, ts: Date.now() });
		this.publish("step", summary);
	}

	done(): void {
		this.publish("done", "");
		this.ended = true;
	}

	error(message: string): void {
		this.publish("error", message.slice(0, 1000));
		this.ended = true;
	}

	/** The reply's `thinking` meta; "" when the run neither thought nor used a tool. */
	record(): string {
		return this.entries.length > 0 ? capRecord(this.entries) : "";
	}

	thoughtMs(): number {
		return Date.now() - this.started;
	}
}

/** The input a tool call is best known by, in the order tools name it. */
const KEY_ARGUMENTS = ["command", "url", "query", "path", "name", "title", "key", "object_id", "id", "text"];

/** One line for a tool call: its name and its key argument ("shell_exec: git status"). */
export function stepSummary(name: string, input: Record<string, unknown>): string {
	const key = KEY_ARGUMENTS.find((k) => typeof input[k] === "string" && (input[k] as string).trim()) ?? Object.keys(input).find((k) => typeof input[k] === "string" && (input[k] as string).trim());
	let arg = key ? (input[key] as string).replace(/\s+/g, " ").trim() : "";
	if (key === "url") arg = arg.replace(/^https?:\/\//, "");
	if (arg.length > 120) arg = `${arg.slice(0, 119)}…`;
	return arg ? `${name}: ${arg}` : name;
}
