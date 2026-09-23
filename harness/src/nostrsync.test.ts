import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, nip44, SimplePool, type Event, type Filter } from "nostr-tools";
import * as api from "./api";
import * as auth from "./local-api-auth";
import { startNostrSync, vanishOnRelays } from "./nostrsync";

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
/** Local daemon's change manifest (objectId -> change hexes) and each change's bytes. */
let localChangeRows: Record<string, Array<{ id: string; b64: string }>>;
let checkpointRows: Record<string, unknown>;
let importCheckpoint: (body: { checkpoints: string[]; provenance?: unknown }) => Promise<Response>;
let buildCheckpoint: (objectId: string) => Promise<Response>;
let published: Event[];
let timeoutMock: Mock<typeof setTimeout>;
let restore: Array<() => void>;

function event(part: string, created_at: number, chunk?: [string, number, number], kind = 1078): Event {
	return finalizeEvent({ kind, created_at, tags: chunk ? [["c", chunk[0], String(chunk[1]), String(chunk[2])]] : [], content: nip44.encrypt(part, conversationKey) }, sk);
}
function decrypt(item: Event): string {
	return nip44.decrypt(item.content, conversationKey);
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
	return await Bun.file(join(root, "sync-state.json")).json() as { cursor: number; replaySince?: number; checkpoints: Record<string, { hash: string; heads: string[]; eventIds: string[] }> };
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
/** A few real macrotask turns: lets awaited mock responses propagate into state. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		realSetTimeout(resolve, 1);
		await promise;
	}
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
	checkpointRows = {};
	importCheckpoint = async () => Response.json({ imported: 0, rejected: 1, items: [] });
	localChangeRows = {};
	buildCheckpoint = async () => new Response("not found", { status: 404 });
	published = [];
	restore = [];
	const interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
		intervals.push({ callback, ms });
		return 1;
	}) as unknown as typeof setInterval);
	restore.push(() => interval.mockRestore());
	// Leave the daemon's paced publish loop asleep; no actual timers or sockets.
	timeoutMock = spyOn(globalThis, "setTimeout").mockImplementation((() => 1) as unknown as typeof setTimeout);
	restore.push(() => timeoutMock.mockRestore());
	const fetch = spyOn(auth, "apiFetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/changes") && init?.method === "POST") return importChange(JSON.parse(String(init.body)).changes[0]);
		const perObject = url.match(/\/api\/changes\/([^/]+)$/);
		if (perObject) return Response.json({ changes: localChangeRows[perObject[1]] ?? [] });
		if (url.endsWith("/api/checkpoints") && init?.method === "POST") return importCheckpoint(JSON.parse(String(init.body)));
		if (url.endsWith("/api/checkpoints/build")) return buildCheckpoint(JSON.parse(String(init?.body)).objectId);
		if (url.endsWith("/api/objects")) return Response.json([]);
		if (url.endsWith("/api/vanished")) return Response.json({ vanished: [] });
		if (url.endsWith("/api/checkpoints")) return Response.json(checkpointRows);
		if (url.endsWith("/api/changes")) return Response.json(Object.fromEntries(Object.entries(localChangeRows).map(([objectId, rows]) => [objectId, rows.map((row) => row.id)])));
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
				for (const item of history) if (item.created_at >= (filter.since ?? 0) && item.created_at <= (filter.until ?? Infinity)) callbacks.onevent(item);
				if (incomplete) callbacks.onclose();
				else callbacks.oneose();
			});
			return { close() {} };
		},
	}) as never);
	restore.push(() => relay.mockRestore());
	const query = spyOn(SimplePool.prototype, "querySync").mockImplementation(async (_relays, filter) => (filter.kinds?.includes(1078) ? [event("YWJj", 100)] : []));
	restore.push(() => query.mockRestore());
	const publish = spyOn(SimplePool.prototype, "publish").mockImplementation((_relays, item) => {
		published.push(item);
		return [Promise.resolve("")];
	});
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

test("a live checkpoint under our key becomes the relay's copy only when the daemon holds it; a fork is left on the relay", async () => {
	const imports: string[][] = [];
	let held = true;
	importCheckpoint = async (body) => {
		imports.push(body.checkpoints);
		return Response.json({ imported: held ? 1 : 0, rejected: 0, items: [{ objectId: "obj", hash: held ? "h1" : "h0", heads: ["b", "a"], stored: held, held }] });
	};
	await startNostrSync();
	const current = event("Q1Ax", 200, undefined, 1079);
	liveEvent(current);
	await until(() => imports.length === 1);
	expect(imports[0]).toEqual(["Q1Ax"]);
	await settle();
	const after = await state();
	expect(after.checkpoints.obj).toEqual({ hash: "h1", heads: ["a", "b"], eventIds: [current.id] });
	expect(after.cursor).toBe(200);
	// Another device's checkpoint of a different branch: the daemon keeps
	// ours, and the relay keeps theirs - it may be the only copy of that branch.
	held = false;
	const fork = event("Q1Aw", 150, undefined, 1079);
	liveEvent(fork);
	await until(() => imports.length === 2);
	await settle();
	expect(published.some((item) => item.kind === 5)).toBe(false);
	expect((await state()).checkpoints.obj).toEqual({ hash: "h1", heads: ["a", "b"], eventIds: [current.id] });
});

test("vanish splits deletion requests so no kind-5 exceeds the relay's 256-tag plan bound", async () => {
	history = Array.from({ length: 300 }, (_, i) => event("YWJj", 1000 + i));
	timeoutMock.mockImplementation(((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout);
	const { events, requests } = await vanishOnRelays(["obj"]);
	expect(events).toBe(300);
	const deletions = published.filter((item) => item.kind === 5);
	expect(deletions.length).toBe(requests);
	expect(deletions.every((item) => item.tags.length <= 256)).toBe(true);
	const targeted = new Set(deletions.flatMap((item) => item.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1])));
	expect(targeted).toEqual(new Set(history.map((item) => item.id)));
});

test("startup reconciles the whole 1078 history even when an old state file carries a checkpoint floor", async () => {
	await writeFile(join(root, "sync-state.json"), JSON.stringify({ version: 1, cursor: 0, published: {}, vanishRequested: {}, checkpointFloor: 500, checkpointFloors: { abc: 700 } }));
	await startNostrSync();
	for (const filter of filters.filter((f) => f.kinds?.includes(1078))) expect(filter.since ?? 0).toBe(0);
	expect(published.some((item) => item.kind === 30079)).toBe(false);
});

test("the checkpoint pass rebuilds moved objects and publishes 1079 without deleting the old event or stamping a manifest", async () => {
	const old = event("T0xE", 50, undefined, 1079);
	history = [old, event("U1RM", 60, undefined, 1079)];
	const onRelay: Record<string, { objectId: string; hash: string }> = { T0xE: { objectId: "obj", hash: "h0" }, U1RM: { objectId: "still", hash: "hs" } };
	importCheckpoint = async (body) => Response.json({ imported: 1, rejected: 0, items: body.checkpoints.map((b64) => ({ ...onRelay[b64], heads: ["a"], stored: true, held: true })) });
	checkpointRows = { obj: { heads: ["b"], checkpointHeads: ["a"], checkpointHash: "h0", changes: 2, covered: 1 }, still: { heads: ["a"], checkpointHeads: ["a"], checkpointHash: "hs", changes: 1, covered: 1 } };
	const builds: string[] = [];
	buildCheckpoint = async (objectId) => {
		builds.push(objectId);
		return Response.json({ objectId, b64: "TkVX", hash: "h1", heads: ["b"], covered: 2 });
	};
	// Let the paced publish loop run for this test.
	timeoutMock.mockImplementation(((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout);
	await startNostrSync();
	expect(builds).toEqual(["obj"]);
	await until(() => published.some((item) => item.kind === 1079));
	await settle();
	const checkpoint = published.find((item) => item.kind === 1079)!;
	expect(decrypt(checkpoint)).toBe("TkVX");
	expect(published.some((item) => item.kind === 5)).toBe(false);
	expect(published.some((item) => item.kind === 30079)).toBe(false);
	expect((await state()).checkpoints.obj).toEqual({ hash: "h1", heads: ["b"], eventIds: [checkpoint.id] });
});

test("a build the daemon refuses (incomplete history) leaves the object syncing as changes", async () => {
	checkpointRows = { obj: { heads: ["b"], checkpointHeads: ["a"], checkpointHash: "h0", changes: 2, covered: 1 } };
	buildCheckpoint = async () => new Response("history incomplete", { status: 409 });
	timeoutMock.mockImplementation(((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout);
	await startNostrSync();
	await settle();
	expect(published.some((item) => item.kind === 1079)).toBe(false);
	expect((await state()).checkpoints.obj).toBeUndefined();
});
