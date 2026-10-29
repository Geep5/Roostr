/**
 * A minimal NIP-01 client for RoostrRelay's cursor extension (RoostrRelay
 * README "Relay cursor"): `EVENT` frames may carry a fourth element
 * `{seq}` and `EOSE` a third `{head, oldest}`, which nostr-tools' pool
 * drops. One WebSocket, reconnected on loss; publishes wait for `OK`.
 */

import type { Event, Filter } from "nostr-tools";

export interface StreamCursor {
	head: number;
	oldest: number;
}

export interface SeqEvent {
	event: Event;
	/** The stream seq the relay assigned; 0 for events outside any `after` stream. */
	seq: number;
}

export type CursorFilter = Filter & { after?: number };

interface Sub {
	filters: CursorFilter[];
	onEvent: (item: SeqEvent) => void;
	onEose?: (cursor: StreamCursor | null) => void;
	onClosed?: (reason: string) => void;
}

const OK_TIMEOUT_MS = 15_000;
const QUERY_TIMEOUT_MS = 30_000;

export class CursorRelay {
	readonly url: string;
	private ws: WebSocket | null = null;
	private opening: Promise<void> | null = null;
	private subs = new Map<string, Sub>();
	private oks = new Map<string, (ok: boolean, message: string) => void>();
	private nextId = 0;
	private closed = false;
	/** Runs after every reconnection (not the first connect); live subscriptions are already re-sent. */
	onReconnect: (() => void) | null = null;
	private everOpened = false;

	constructor(url: string) {
		this.url = url;
	}

	private connect(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
		if (this.opening) return this.opening;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.opening = promise;
		const ws = new WebSocket(this.url);
		let settled = false;
		ws.onopen = () => {
			settled = true;
			this.ws = ws;
			this.opening = null;
			const reconnected = this.everOpened;
			this.everOpened = true;
			for (const [id, sub] of this.subs) ws.send(JSON.stringify(["REQ", id, ...sub.filters]));
			resolve();
			if (reconnected) this.onReconnect?.();
		};
		ws.onmessage = (message) => this.receive(String(message.data));
		ws.onerror = () => {
			if (settled) return;
			settled = true;
			this.opening = null;
			reject(new Error(`relay ${this.url} unreachable`));
		};
		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			if (!settled) {
				settled = true;
				this.opening = null;
				reject(new Error(`relay ${this.url} closed`));
			}
			for (const [, settle] of this.oks) settle(false, "connection closed");
			this.oks.clear();
			if (!this.closed && this.subs.size > 0) setTimeout(() => void this.connect().catch(() => this.retryLater()), 1000);
		};
		return promise;
	}

	private retryLater(): void {
		if (this.closed || this.subs.size === 0) return;
		setTimeout(() => void this.connect().catch(() => this.retryLater()), 2000);
	}

	private receive(raw: string): void {
		let msg: unknown;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (!Array.isArray(msg)) return;
		const [type, a, b, c] = msg;
		if (type === "EVENT" && typeof a === "string") {
			const seq = c && typeof c === "object" && "seq" in c && typeof c.seq === "number" ? c.seq : 0;
			// Validated by the subscriber (verifyEvent) before any use.
			const event: Event = b;
			this.subs.get(a)?.onEvent({ event, seq });
		} else if (type === "EOSE" && typeof a === "string") {
			const cursor = b && typeof b === "object" && "head" in b && typeof b.head === "number" && "oldest" in b && typeof b.oldest === "number" ? { head: b.head, oldest: b.oldest } : null;
			this.subs.get(a)?.onEose?.(cursor);
		} else if (type === "CLOSED" && typeof a === "string") {
			const sub = this.subs.get(a);
			this.subs.delete(a);
			sub?.onClosed?.(String(b ?? ""));
		} else if (type === "OK" && typeof a === "string") {
			const settle = this.oks.get(a);
			this.oks.delete(a);
			settle?.(b === true, String(c ?? ""));
		}
	}

	/** Send one event and wait for its `OK`; a duplicate counts as accepted. Rate-limited sends retry. */
	async publish(event: Event): Promise<{ ok: boolean; message: string }> {
		for (let attempt = 0; ; attempt++) {
			await this.connect();
			const { promise, resolve } = Promise.withResolvers<{ ok: boolean; message: string }>();
			const timer = setTimeout(() => {
				this.oks.delete(event.id);
				resolve({ ok: false, message: "timeout" });
			}, OK_TIMEOUT_MS);
			this.oks.set(event.id, (ok, message) => {
				clearTimeout(timer);
				resolve({ ok, message });
			});
			this.ws!.send(JSON.stringify(["EVENT", event]));
			const result = await promise;
			if (!result.ok && result.message.startsWith("rate-limited") && attempt < 10) {
				await Bun.sleep(1100);
				continue;
			}
			return result;
		}
	}

	/** One-shot REQ: every stored match, then the EOSE cursor (null when the relay sent none). */
	async query(filters: CursorFilter[]): Promise<{ events: SeqEvent[]; cursor: StreamCursor | null }> {
		await this.connect();
		const id = `q${this.nextId++}`;
		const { promise, resolve, reject } = Promise.withResolvers<{ events: SeqEvent[]; cursor: StreamCursor | null }>();
		const events: SeqEvent[] = [];
		const timer = setTimeout(() => {
			this.close(id);
			reject(new Error("relay query timed out"));
		}, QUERY_TIMEOUT_MS);
		this.subs.set(id, {
			filters,
			onEvent: (item) => events.push(item),
			onEose: (cursor) => {
				clearTimeout(timer);
				this.close(id);
				resolve({ events, cursor });
			},
			onClosed: (reason) => {
				clearTimeout(timer);
				reject(new Error(`relay closed the query: ${reason}`));
			},
		});
		this.ws!.send(JSON.stringify(["REQ", id, ...filters]));
		return promise;
	}

	/** A live subscription, re-sent after reconnects (with whatever `filters` holds then). */
	async subscribe(filters: CursorFilter[], onEvent: (item: SeqEvent) => void, onEose?: (cursor: StreamCursor | null) => void, onClosed?: (reason: string) => void): Promise<string> {
		const id = `s${this.nextId++}`;
		this.subs.set(id, { filters, onEvent, onEose, onClosed });
		await this.connect();
		this.ws!.send(JSON.stringify(["REQ", id, ...filters]));
		return id;
	}

	/** Replace a live subscription's filters (e.g. a newer `after`) for the next reconnect. */
	refilter(id: string, filters: CursorFilter[]): void {
		const sub = this.subs.get(id);
		if (sub) sub.filters = filters;
	}

	close(id: string): void {
		if (!this.subs.delete(id)) return;
		if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(["CLOSE", id]));
	}

	shutdown(): void {
		this.closed = true;
		this.subs.clear();
		this.ws?.close();
		this.ws = null;
	}
}
