import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, nip44, SimplePool, type Event, type Filter } from "nostr-tools";
import * as api from "./api";
import * as auth from "./local-api-auth";
import { startNostrSync } from "./nostrsync";

const sk = new Uint8Array(32).fill(1);
const pk = getPublicKey(sk);
const conversationKey = nip44.getConversationKey(sk, pk);
const realSetTimeout = globalThis.setTimeout;
let root: string;
let previousRoot: string | undefined;
let intervals: Array<{ callback: () => void; ms: number }>;
let history: Event[];
let filters: Filter[];
let incomplete: boolean;
let beforePage: (() => void) | undefined;
let liveEvent: (event: Event) => void;
let liveSubscriptions: number;
let importChange: (b64: string) => Promise<Response>;
let restore: Array<() => void>;

function event(part: string, created_at: number, chunk?: [string, number, number]): Event {
	return finalizeEvent({ kind: 1078, created_at, tags: chunk ? [["c", chunk[0], String(chunk[1]), String(chunk[2])]] : [], content: nip44.encrypt(part, conversationKey) }, sk);
}
function chunks(createdAt = 10): Event[] {
	const b64 = "YWJjZGVm";
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(b64);
	const gid = hasher.digest("hex").slice(0, 16);
	return [event(b64.slice(0, 4), createdAt, [gid, 0, 2]), event(b64.slice(4), createdAt + 1, [gid, 1, 2])];
}
async function state() {
	intervals.find((timer) => timer.ms === 5000)!.callback();
	return await Bun.file(join(root, "sync-state.json")).json() as { cursor: number; replaySince?: number };
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetTimeout(resolve, 1);
		await promise;
	}
	throw new Error("Daemon operation did not settle");
}
async function watchdog() {
	const previous = liveSubscriptions;
	intervals.filter((timer) => timer.ms === 60_000).at(-1)!.callback();
	await until(() => liveSubscriptions > previous);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "glon-replay-test-"));
	previousRoot = process.env.GLON_DATA;
	process.env.GLON_DATA = root;
	await writeFile(join(root, "nostr.json"), JSON.stringify({ privkey: Buffer.from(sk).toString("hex"), relays: ["wss://relay.invalid"] }));
	await writeFile(join(root, "sync-state.json"), JSON.stringify({ version: 1, cursor: 100, replaySince: 0, published: {}, vanishRequested: {} }));
	intervals = [];
	history = [];
	filters = [];
	incomplete = false;
	beforePage = undefined;
	liveSubscriptions = 0;
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: ["change"] });
	restore = [];
	const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
		intervals.push({ callback, ms });
		return 1;
	}) as unknown as typeof setInterval);
	restore.push(() => interval.mockRestore());
	// Leave the daemon's paced publish loop asleep; no actual timers or sockets.
	const timeout = spyOn(globalThis, "setTimeout").mockImplementation((() => 1) as unknown as typeof setTimeout);
	restore.push(() => timeout.mockRestore());
	const fetch = spyOn(auth, "apiFetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/changes") && init?.method === "POST") return importChange(JSON.parse(String(init.body)).changes[0]);
		if (url.endsWith("/api/objects")) return Response.json([]);
		if (url.endsWith("/api/vanished")) return Response.json({ vanished: [] });
		if (url.endsWith("/api/changes")) return Response.json({});
		throw new Error(`Unexpected local request: ${url}`);
	});
	restore.push(() => fetch.mockRestore());
	const subscribe = spyOn(api, "subscribe").mockImplementation(() => () => {});
	restore.push(() => subscribe.mockRestore());
	const relay = spyOn(SimplePool.prototype, "ensureRelay").mockImplementation(async () => ({
		subscribe: ([filter]: Filter[], callbacks: { onevent: (event: Event) => void; oneose: () => void; onclose: () => void }) => {
			filters.push(filter);
			queueMicrotask(() => {
				beforePage?.();
				for (const item of history) if (item.created_at >= (filter.since ?? 0)) callbacks.onevent(item);
				if (incomplete) callbacks.onclose();
				else callbacks.oneose();
			});
			return { close() {} };
		},
	}) as never);
	restore.push(() => relay.mockRestore());
	const query = spyOn(SimplePool.prototype, "querySync").mockImplementation(async (_relays, filter) => filter.kinds?.includes(1078) ? [event("YWJj", 100)] : []);
	restore.push(() => query.mockRestore());
	const publish = spyOn(SimplePool.prototype, "publish").mockImplementation(() => [Promise.resolve("")]);
	restore.push(() => publish.mockRestore());
	const live = spyOn(SimplePool.prototype, "subscribeMany").mockImplementation((_relays, filter, callbacks) => {
		liveSubscriptions++;
		if (filter.kinds?.includes(1078)) liveEvent = (item) => callbacks.onevent?.(item);
		return { close() {} };
	});
	restore.push(() => live.mockRestore());
});
afterEach(async () => {
	for (const undo of restore.reverse()) undo();
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

test("complete chunk backfill retires persisted floor and watchdog requests only cursor overlap", async () => {
	history = chunks();
	await startNostrSync();
	expect((await state()).replaySince).toBeUndefined();
	await watchdog();
	expect(filters.at(-1)?.since).toBe(100);
	expect(filters.every((filter) => filter.limit === 128)).toBe(true);
	expect((await state()).replaySince).toBeUndefined();
});

test("incomplete chunks retain floor until a complete repair scan imports the group", async () => {
	const complete = chunks();
	history = complete.slice(1);
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	history = complete;
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("closed history without genuine EOSE retains floor until a later complete scan", async () => {
	history = chunks();
	incomplete = true;
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	incomplete = false;
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("native import rejection retains floor and a later clean scan repairs it", async () => {
	history = chunks();
	importChange = async () => Response.json({ imported: 0, rejected: 1, ids: [] });
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: ["change"] });
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("fresh live import fault during otherwise complete scan prevents retirement", async () => {
	await startNostrSync();
	importChange = async () => { throw new Error("native unavailable"); };
	beforePage = () => liveEvent(event("YWJj", 100));
	await watchdog();
	expect((await state()).replaySince).toBe(100);
	beforePage = undefined;
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: ["change"] });
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("concurrent pending live import prevents retirement even without buffered groups", async () => {
	await startNostrSync();
	const pending = Promise.withResolvers<Response>();
	importChange = () => pending.promise;
	beforePage = () => liveEvent(event("YWJj", 100));
	await watchdog();
	expect((await state()).replaySince).toBe(100);
	pending.resolve(Response.json({ imported: 1, rejected: 0, ids: ["change"] }));
	beforePage = undefined;
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("new older live chunk floor outside scanned range cannot be cleared after assembly", async () => {
	await startNostrSync();
	const old = chunks(10);
	beforePage = () => { for (const item of old) liveEvent(item); };
	await watchdog();
	expect((await state()).replaySince).toBe(10);
	beforePage = undefined;
	history = old;
	await watchdog();
	expect(filters.at(-1)?.since).toBe(10);
	expect((await state()).replaySince).toBeUndefined();
});

test("completed latest-group suffix remains received after fragment TTL and repeated subscriptions", async () => {
	history = chunks(99);
	await startNostrSync();
	const future = Date.now() + 10 * 60_000;
	const clock = spyOn(Date, "now").mockReturnValue(future);
	restore.push(() => clock.mockRestore());
	liveEvent(history[1]);
	expect((await state()).replaySince).toBeUndefined();
	await watchdog();
	expect(filters.at(-1)?.since).toBe(100);
	expect((await state()).replaySince).toBeUndefined();
});

test("fragment expiry during a scan is a fresh fault even if that scan imports the group", async () => {
	const complete = chunks();
	history = complete.slice(0, 1);
	await startNostrSync();
	const future = Date.now() + 10 * 60_000;
	beforePage = () => {
		const clock = spyOn(Date, "now").mockReturnValue(future);
		restore.push(() => clock.mockRestore());
		intervals.filter((timer) => timer.ms === 60_000)[0].callback();
	};
	history = complete;
	await watchdog();
	expect((await state()).replaySince).toBe(0);
	beforePage = undefined;
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("a rejected import cannot be hidden by later successful imports in the same scan", async () => {
	history = [event("YWJj", 10), event("ZGVm", 11)];
	importChange = async (b64) => Response.json({ imported: b64 === "YWJj" ? 0 : 1, rejected: b64 === "YWJj" ? 1 : 0, ids: [] });
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: ["change"] });
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("restart and empty complete history cannot discharge an unresolved group", async () => {
	const complete = chunks();
	history = complete.slice(1);
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	// Recreate the daemon against its persisted state, without its byte buffers.
	intervals = [];
	history = [];
	await startNostrSync();
	expect((await state()).replaySince).toBe(0);
	history = complete;
	await watchdog();
	expect((await state()).replaySince).toBeUndefined();
});

test("expired byte buffers and empty complete history retain unresolved group identity", async () => {
	history = chunks().slice(0, 1);
	await startNostrSync();
	const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
	restore.push(() => clock.mockRestore());
	intervals.filter((timer) => timer.ms === 60_000)[0].callback();
	history = [];
	await watchdog();
	expect((await state()).replaySince).toBe(0);
});

test("a new suffix-only group fetches its unseen prefix older than the observed replay floor", async () => {
	await startNostrSync();
	const complete = chunks(10);
	const gid = complete[1].tags[0][1];
	const suffix = event("ZGVm", 100, [gid, 1, 2]);
	liveEvent(suffix);
	expect((await state()).replaySince).toBe(100);
	history = [complete[0], suffix];
	await watchdog();
	expect(filters.at(-1)?.since).toBe(0);
	expect((await state()).replaySince).toBeUndefined();
});
