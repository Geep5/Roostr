import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, nip44, SimplePool, type Event, type Filter } from "nostr-tools";
import * as api from "./api";
import { decryptBlob, encryptBlob, sha256Hex } from "./blossom";
import * as auth from "./local-api-auth";
import { changeIdOfPart, startNostrSync, vanishOnRelays } from "./nostrsync";

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
/** Every live subscription filter. */
let liveFilters: Filter[];
let importChange: (b64: string) => Promise<Response>;
/** Local daemon's change manifest (objectId -> change hexes) and each change's bytes (+ state-sync row fields). */
let localChangeRows: Record<string, Array<{ id: string; b64: string; b?: string; pending?: boolean; own?: boolean; class?: string }>>;
let checkpointRows: Record<string, unknown>;
let importCheckpoint: (body: { checkpoints: string[]; provenance?: unknown }) => Promise<Response>;
let buildCheckpoint: (objectId: string) => Promise<Response>;
let published: Event[];
let timeoutMock: Mock<typeof setTimeout>;
let restore: Array<() => void>;
/** GET /api/vanished rows, /api/objects rows, space objects by id, and every POST /api/mutate body. */
let vanishedRows: Array<{ objectId: string; at: number; left?: true }>;
let objectRows: Array<{ id: string; typeKey?: string; channelId?: string }>;
let spaceObjects: Record<string, unknown>;
let mutations: Array<Record<string, unknown>>;
let liveDelete: ((event: Event) => void) | undefined;
/** State-sync daemon fakes: GET /api/bases rows, GET /api/bases/<id> lists, and every POST to /api/bases* or /api/changes/published (path, body). */
let baseRows: Record<string, Record<string, unknown>>;
let heldBases: Record<string, Array<{ hash: string; epoch: number; current: boolean; b64: string }>>;
let basePosts: Array<{ path: string; body: Record<string, unknown> }>;
let baseReply: (path: string, body: Record<string, unknown>) => Response;
/** Every item POSTed to /api/changes (string, or {b64, b}). */
let changeImports: unknown[];
/** POST /api/serving answers by object id (machine.ts serverOf); unlisted objects are unserved. */
let servingRows: Record<string, unknown>;

function event(part: string, created_at: number, chunk?: [string, number, number], kind = 1078): Event {
	return finalizeEvent({ kind, created_at, tags: chunk ? [["c", chunk[0], String(chunk[1]), String(chunk[2])]] : [], content: nip44.encrypt(part, conversationKey) }, sk);
}
function decrypt(item: Event): string {
	return nip44.decrypt(item.content, conversationKey);
}
function chunks(createdAt = 10, kind = 1078, b64 = "YWJjZGVm"): Event[] {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(b64);
	const gid = hasher.digest("hex").slice(0, 16);
	return [event(b64.slice(0, 4), createdAt, [gid, 0, 2], kind), event(b64.slice(4), createdAt + 1, [gid, 1, 2], kind)];
}
async function state() {
	intervals.find((timer) => timer.ms === 5000)!.callback();
	return await Bun.file(join(root, "sync-state.json")).json() as { cursor: number; replaySince?: number; vanishRequested: Record<string, true>; checkpoints: Record<string, { hash: string; heads: string[]; eventIds: string[] }>; checkpointDeletes: Record<string, true> };
}
/** The contract's blinding: sha256(key || id), 16 hex. */
function blind(key: string, id: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(key);
	hasher.update(id);
	return hasher.digest("hex").slice(0, 16);
}
async function keyring(channels: Record<string, { key: string; keyId?: number; owner?: string }>) {
	await writeFile(join(root, "channel-keys.json"), JSON.stringify({ version: 1, channels }));
}
/** A space object listing these member pubkeys (hex). */
function spaceWithMembers(id: string, members: string[]) {
	return { id, typeKey: "channel", fields: { members: { valuesValue: { items: members.map((hex) => ({ mapValue: { entries: { npub: { stringValue: hex }, role: { stringValue: "writer" } } } })) } } } };
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
	liveFilters = [];
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: ["change"] });
	checkpointRows = {};
	importCheckpoint = async () => Response.json({ imported: 0, rejected: 1, items: [] });
	localChangeRows = {};
	buildCheckpoint = async () => new Response("not found", { status: 404 });
	published = [];
	restore = [];
	vanishedRows = [];
	objectRows = [];
	spaceObjects = {};
	mutations = [];
	liveDelete = undefined;
	baseRows = {};
	heldBases = {};
	basePosts = [];
	baseReply = (path) => (path === "/api/bases" ? Response.json({ rejected: 0, items: [] }) : new Response("not found", { status: 404 }));
	changeImports = [];
	servingRows = {};
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
		if (url.endsWith("/api/changes") && init?.method === "POST") {
			const item = JSON.parse(String(init.body)).changes[0];
			changeImports.push(item);
			return importChange(typeof item === "string" ? item : item.b64);
		}
		const statePath = url.match(/(\/api\/(?:bases(?:\/(?:build|seal|rebase|covered))?|changes\/published))$/);
		if (statePath && init?.method === "POST") {
			const body = JSON.parse(String(init.body));
			basePosts.push({ path: statePath[1], body });
			return baseReply(statePath[1], body);
		}
		if (url.endsWith("/api/bases")) return Response.json(baseRows);
		const heldFor = url.match(/\/api\/bases\/([^/]+)$/);
		if (heldFor) return Response.json({ objectId: heldFor[1], bases: heldBases[heldFor[1]] ?? [] });
		// Machine roster and serving (machine.ts): no machines, nothing pinned - this computer compacts unserved objects.
		if (url.endsWith("/api/query")) return Response.json({ total: 0, records: [] });
		if (url.endsWith("/api/serving")) return Response.json(Object.fromEntries(Object.entries(servingRows).filter(([objectId]) => (JSON.parse(String(init?.body)).objectIds as string[]).includes(objectId))));
		const perObject = url.match(/\/api\/changes\/([^/]+)$/);
		if (perObject) return Response.json({ changes: localChangeRows[perObject[1]] ?? [] });
		if (url.endsWith("/api/checkpoints") && init?.method === "POST") return importCheckpoint(JSON.parse(String(init.body)));
		if (url.endsWith("/api/checkpoints/build")) return buildCheckpoint(JSON.parse(String(init?.body)).objectId);
		if (url.endsWith("/api/mutate")) {
			mutations.push(JSON.parse(String(init?.body)));
			return Response.json({ ok: true });
		}
		const space = url.match(/\/api\/objects\/([^/]+)$/);
		if (space) return spaceObjects[space[1]] ? Response.json(spaceObjects[space[1]]) : new Response("not found", { status: 404 });
		if (url.endsWith("/api/objects")) return Response.json(objectRows);
		if (url.endsWith("/api/vanished")) return Response.json({ vanished: vanishedRows, count: vanishedRows.length });
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
		liveFilters.push(filter);
		if (filter.kinds?.includes(1078)) liveEvent = (item) => callbacks.onevent?.(item);
		if (filter.kinds?.includes(5)) liveDelete = (item) => callbacks.onevent?.(item);
		return { close() {} };
	});
	restore.push(() => live.mockRestore());
});
afterEach(async () => {
	for (const undo of restore.reverse()) undo();
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
	delete process.env.GLON_STATE_SYNC_COMPACT;
	delete process.env.GLON_STATE_SYNC_SWEEP_PREMIGRATION;
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

test("a store rejection is logged with its reason, once per event however often it is replayed", async () => {
	history = [event("YWJj", 10)];
	let attempts = 0;
	importChange = async () => {
		attempts++;
		return Response.json({ imported: 0, rejected: 1, ids: [], reasons: ["only the owner may change protected fields"] });
	};
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	restore.push(() => warn.mockRestore());
	await startNostrSync();
	await watchdog();
	await settle();
	const lines = warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("refused by the store"));
	expect(attempts).toBeGreaterThan(1);
	expect(lines).toContain(`[sync] event ${history[0].id.slice(0, 8)} refused by the store: only the owner may change protected fields`);
	expect(new Set(lines).size).toBe(lines.length);
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

/** The daemon's view of relay checkpoints by b64: object, bytes hash, and how what it holds relates to them. */
function checkpointDaemon(rows: Record<string, { objectId: string; hash: string; held?: boolean; superseded?: boolean }>) {
	importCheckpoint = async (body) => Response.json({ imported: 0, rejected: 0, items: body.checkpoints.map((b64) => ({ heads: ["a"], stored: false, held: false, superseded: false, ...rows[b64] })) });
}
/** GET /api/checkpoints row: heads unmoved, the daemon holds `hash`. */
function heldRow(hash: string) {
	return { heads: ["a"], checkpointHeads: ["a"], checkpointHash: hash, changes: 1, covered: 1 };
}
function deletions(): Event[] {
	return published.filter((item) => item.kind === 5);
}
function deleted(): Set<string> {
	return new Set(deletions().flatMap((item) => item.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1])));
}
/** Let the paced publish loop (and paced deletions) run. */
function realTimers() {
	timeoutMock.mockImplementation(((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout);
}

/** obj's copy h0 is on the relay; the pass builds h1 and publishes it. `holds`: the daemon holds h1 afterwards. */
async function republish(holds: boolean) {
	const old = event("T0xE", 50, undefined, 1079);
	history = [old, event("U1RM", 60, undefined, 1079)];
	checkpointDaemon({ T0xE: { objectId: "obj", hash: "h0", held: true }, U1RM: { objectId: "still", hash: "hs", held: true }, TkVX: { objectId: "obj", hash: "h1", held: holds } });
	checkpointRows = { obj: { heads: ["b"], checkpointHeads: ["a"], checkpointHash: "h0", changes: 2, covered: 1 }, still: heldRow("hs") };
	const builds: string[] = [];
	buildCheckpoint = async (objectId) => {
		builds.push(objectId);
		if (holds) checkpointRows.obj = { heads: ["b"], checkpointHeads: ["b"], checkpointHash: "h1", changes: 2, covered: 2 };
		return Response.json({ objectId, b64: "TkVX", hash: "h1", heads: ["b"], covered: 2 });
	};
	realTimers();
	await startNostrSync();
	expect(builds).toEqual(["obj"]);
	await until(() => published.some((item) => item.kind === 1079));
	await settle();
	const checkpoint = published.find((item) => item.kind === 1079)!;
	expect(decrypt(checkpoint)).toBe("TkVX");
	expect(published.some((item) => item.kind === 30079)).toBe(false);
	expect((await state()).checkpoints.obj).toEqual({ hash: "h1", heads: ["b"], eventIds: [checkpoint.id] });
	return old;
}

test("the checkpoint pass publishes a moved object's 1079, then deletes the previous copy once the daemon reports the new one held", async () => {
	process.env.GLON_STATE_SYNC_COMPACT = "0";
	const old = await republish(true);
	await until(() => deletions().length > 0);
	await settle();
	expect(deletions().map((item) => ({ tags: item.tags, content: item.content }))).toEqual([{ tags: [["e", old.id], ["k", "1079"]], content: "checkpoint superseded" }]);
});

test("a published checkpoint the daemon does not hold never retires the previous copy", async () => {
	process.env.GLON_STATE_SYNC_COMPACT = "0";
	await republish(false);
	await settle();
	expect(deletions()).toEqual([]);
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

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const KEY_C = "33".repeat(32);
const adminSk = new Uint8Array(32).fill(2);
const admin = getPublicKey(adminSk);
/** A space-deletion request (contract §5) over `spaceId`'s stream, signed by `signer`. */
function spaceDeletion(signer: Uint8Array, key: string, spaceId: string, created_at: number): Event {
	return finalizeEvent({ kind: 5, created_at, tags: [["h", blind(key, `space:${spaceId}`)], ["k", "1078"], ["k", "1079"]], content: "space deleted" }, signer);
}

test("a shared-space event names who may delete it on the relay: the admin of a joined space, us in our own", async () => {
	await keyring({ joined: { key: KEY_A, owner: admin }, mine: { key: KEY_B } });
	spaceObjects = { mine: spaceWithMembers("mine", [admin]) };
	objectRows = [{ id: "a", channelId: "joined" }, { id: "b", channelId: "mine" }];
	localChangeRows = { a: [{ id: "ca", b64: "YWJj" }], b: [{ id: "cb", b64: "ZGVm" }] };
	timeoutMock.mockImplementation(((callback: () => void) => realSetTimeout(callback, 0)) as unknown as typeof setTimeout);
	await startNostrSync();
	const tagsOf = (key: string, objectId: string) => published.find((item) => item.kind === 1078 && item.tags.some((tag) => tag[0] === "h" && tag[1] === blind(key, objectId)))?.tags;
	await until(() => !!tagsOf(KEY_A, "a") && !!tagsOf(KEY_B, "b"));
	expect(tagsOf(KEY_A, "a")).toEqual([["h", blind(KEY_A, "a")], ["h", blind(KEY_A, "space:joined")], ["owner", admin]]);
	expect(tagsOf(KEY_B, "b")).toEqual([["h", blind(KEY_B, "b")], ["h", blind(KEY_B, "space:mine")], ["owner", pk]]);
});

test("only the owner deleting a joined space's stream vanishes it here, once; a stranger's request and our own spaces are ignored", async () => {
	await keyring({ heard: { key: KEY_A, owner: admin }, forged: { key: KEY_B, owner: admin }, mine: { key: KEY_C } });
	spaceObjects = { mine: spaceWithMembers("mine", [admin]) };
	history = [spaceDeletion(new Uint8Array(32).fill(3), KEY_B, "forged", 50), spaceDeletion(sk, KEY_C, "mine", 51)];
	await startNostrSync();
	expect(mutations).toEqual([]);
	const signal = spaceDeletion(adminSk, KEY_A, "heard", 60);
	liveDelete!(signal);
	await until(() => mutations.length > 0);
	liveDelete!(signal);
	await settle();
	expect(mutations).toEqual([{ action: "vanish", object_ids: ["heard"] }]);
});

test("a vanished space is deleted on the relays by its stream tag; a left space is neither synced nor chased", async () => {
	await keyring({ gone: { key: KEY_A }, left: { key: KEY_B, owner: admin } });
	vanishedRows = [{ objectId: "gone", at: 1 }, { objectId: "left", at: 2, left: true }];
	await startNostrSync();
	const deletions = published.filter((item) => item.kind === 5).map((item) => ({ pubkey: item.pubkey, tags: item.tags, content: item.content }));
	expect(deletions).toEqual([{ pubkey: pk, tags: [["h", blind(KEY_A, "space:gone")], ["k", "1078"], ["k", "1079"]], content: "space deleted" }]);
	expect((await state()).vanishRequested).toEqual({ gone: true, "space:gone": true });
	expect(filters.some((filter) => filter["#h"]?.includes(blind(KEY_B, "space:left")))).toBe(false);
});

test("the sweep deletes our superseded checkpoint groups with every chunk part, never the covering copy or an incomparable fork", async () => {
	const old = event("T0xE", 50, undefined, 1079);
	const parts = chunks(60, 1079, "Q0hVTktFRA==");
	const current = event("Q1Ax", 70, undefined, 1079);
	const republished = event("Q1Ax", 75, undefined, 1079);
	const fork = event("Rk9S", 80, undefined, 1079);
	history = [old, ...parts, current, republished, fork];
	checkpointDaemon({ T0xE: { objectId: "obj", hash: "h0", superseded: true }, "Q0hVTktFRA==": { objectId: "obj", hash: "h1", superseded: true }, Q1Ax: { objectId: "obj", hash: "h2", held: true }, Rk9S: { objectId: "obj", hash: "hf" } });
	checkpointRows = { obj: heldRow("h2") };
	realTimers();
	await startNostrSync();
	await until(() => deletions().length > 0);
	await settle();
	const victims = [old.id, ...parts.map((part) => part.id)];
	expect(deletions().map((item) => item.tags.filter((tag) => tag[0] !== "e"))).toEqual([[["k", "1079"]]]);
	expect(deleted()).toEqual(new Set(victims));
	const after = await state();
	expect(after.checkpoints.obj.eventIds).toEqual([current.id, republished.id]);
	expect(Object.keys(after.checkpointDeletes).sort()).toEqual(victims.sort());
	// Heard again (a watchdog catch-up): already requested, never requested again.
	liveEvent(old);
	await settle();
	expect(deletions().length).toBe(1);
});

test("nothing is deleted without a recorded relay copy of ours, or while that copy is not what the daemon holds", async () => {
	history = [event("T0xE", 50, undefined, 1079), event("VDE=", 55, undefined, 1079), event("VDI=", 60, undefined, 1079)];
	// obj: no copy of ours on the relay. moved: our copy t2, but the daemon has since built t3.
	checkpointDaemon({ T0xE: { objectId: "obj", hash: "h0", superseded: true }, "VDE=": { objectId: "moved", hash: "t1", superseded: true }, "VDI=": { objectId: "moved", hash: "t2", held: true } });
	checkpointRows = { obj: heldRow("h2"), moved: heldRow("t3") };
	realTimers();
	await startNostrSync();
	await settle();
	expect(deletions()).toEqual([]);
	const after = await state();
	expect(after.checkpoints.obj).toBeUndefined();
	expect(after.checkpointDeletes).toEqual({});
});

/** A 1079 on `spaceId`'s stream, signed by `signer`, sealed with the space key. */
function spaceCheckpoint(signer: Uint8Array, key: string, spaceId: string, objectId: string, part: string, created_at: number): Event {
	return finalizeEvent({ kind: 1079, created_at, tags: [["h", blind(key, objectId)], ["h", blind(key, `space:${spaceId}`)]], content: nip44.encrypt(part, Uint8Array.from(Buffer.from(key, "hex"))) }, signer);
}

test("in shared spaces the sweep only touches the spaces this identity owns", async () => {
	await keyring({ joined: { key: KEY_A, owner: admin }, mine: { key: KEY_B } });
	spaceObjects = { mine: spaceWithMembers("mine", [admin]), joined: spaceWithMembers("joined", [pk]) };
	objectRows = [{ id: "a", channelId: "joined" }, { id: "b", channelId: "mine" }];
	const mineOld = spaceCheckpoint(sk, KEY_B, "mine", "b", "YjE=", 50);
	history = [
		mineOld,
		spaceCheckpoint(sk, KEY_B, "mine", "b", "YjI=", 60),
		spaceCheckpoint(sk, KEY_A, "joined", "a", "YTE=", 50),
		spaceCheckpoint(sk, KEY_A, "joined", "a", "YTI=", 60),
		spaceCheckpoint(adminSk, KEY_A, "joined", "a", "YTA=", 40),
	];
	checkpointDaemon({
		"YjE=": { objectId: "b", hash: "hb1", superseded: true },
		"YjI=": { objectId: "b", hash: "hb2", held: true },
		"YTE=": { objectId: "a", hash: "ha1", superseded: true },
		"YTI=": { objectId: "a", hash: "ha2", held: true },
		"YTA=": { objectId: "a", hash: "ha0", superseded: true },
	});
	checkpointRows = { a: heldRow("ha2"), b: heldRow("hb2") };
	realTimers();
	await startNostrSync();
	await until(() => deletions().length > 0);
	await settle();
	expect(deleted()).toEqual(new Set([mineOld.id]));
	expect((await state()).checkpoints.a).toBeUndefined();
});

test("a dry run logs what the sweep would delete and deletes nothing", async () => {
	history = [event("T0xE", 50, undefined, 1079), event("Q1Ax", 70, undefined, 1079)];
	checkpointDaemon({ T0xE: { objectId: "obj", hash: "h0", superseded: true }, Q1Ax: { objectId: "obj", hash: "h2", held: true } });
	checkpointRows = { obj: heldRow("h2") };
	const lines: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
	restore.push(() => log.mockRestore());
	process.env.GLON_CHECKPOINT_SWEEP_DRY_RUN = "1";
	restore.push(() => delete process.env.GLON_CHECKPOINT_SWEEP_DRY_RUN);
	realTimers();
	await startNostrSync();
	await until(() => lines.some((line) => line.startsWith("[sync] checkpoint sweep")));
	await settle();
	expect(lines.filter((line) => line.startsWith("[sync] checkpoint sweep"))).toEqual(["[sync] checkpoint sweep (dry run): 1 event(s) across 1 object(s) would be deleted"]);
	expect(deletions()).toEqual([]);
	expect((await state()).checkpointDeletes).toEqual({});
});

test("the sweep splits its deletions so no kind-5 names more than 254 events", async () => {
	const outdated = Array.from({ length: 300 }, (_, i) => event("T0xE", 1000 + i, undefined, 1079));
	history = [...outdated, event("Q1Ax", 2000, undefined, 1079)];
	checkpointDaemon({ T0xE: { objectId: "obj", hash: "h0", superseded: true }, Q1Ax: { objectId: "obj", hash: "h2", held: true } });
	checkpointRows = { obj: heldRow("h2") };
	realTimers();
	await startNostrSync();
	await until(() => deleted().size === 300);
	expect(deletions().length).toBe(2);
	expect(deletions().every((item) => item.tags.filter((tag) => tag[0] === "e").length <= 254)).toBe(true);
	expect(deleted()).toEqual(new Set(outdated.map((item) => item.id)));
});

// ── State sync (docs/state-sync.md) ──────────────────────────────

const H1 = "a1".repeat(32);
const H2 = "b2".repeat(32);
/** Personal blinding: sha256(secret key bytes || id), 16 hex. */
function blindPersonal(id: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(sk);
	hasher.update(id);
	return hasher.digest("hex").slice(0, 16);
}
/** A sealed change part: 0a 20 <id> + a little payload, base64. */
function changeB64(idByte: number): string {
	return Buffer.from([0x0a, 0x20, ...new Array(32).fill(idByte), 0x12, 0x03, 0x6f, 0x62, 0x6a]).toString("base64");
}
function changeHex(idByte: number): string {
	return Buffer.from(new Array(32).fill(idByte)).toString("hex");
}
function baseEvent(b64: string, created_at: number, objectId = "obj"): Event {
	return finalizeEvent({ kind: 31078, created_at, tags: [["d", blindPersonal(`base:${objectId}`)], ["h", blindPersonal(objectId)], ["epoch", "1"]], content: nip44.encrypt(b64, conversationKey) }, sk);
}
function deltaEvent(b64: string, created_at: number, base?: string): Event {
	return finalizeEvent({ kind: 1078, created_at, tags: [["h", blindPersonal("obj")], ...(base ? [["b", base]] : [])], content: nip44.encrypt(b64, conversationKey) }, sk);
}
/** GET /api/bases row for an object holding base `hash`. */
function baseRow(hash: string, fields: Record<string, unknown> = {}) {
	return { hash, epoch: 1, createdAt: 1_000_000_000, prevBase: "", live: 0, orphan: 0, stale: 0, pending: 0, own: 0, rebase: 0, compact: false, reason: "", ...fields };
}

test("the change id of a sealed part is read from its leading id field", () => {
	expect(changeIdOfPart(changeB64(7))).toBe(changeHex(7));
	expect(changeIdOfPart("YWJj")).toBeNull();
});

test("bases come first; once they exist deltas are read by #b and the history walk and live subscription never start from zero", async () => {
	const base = baseEvent("QkFTRQ==", 1_000_000);
	const delta = deltaEvent(changeB64(1), 1_000_100, H1);
	history = [base, delta];
	baseReply = (path, body) => {
		if (path !== "/api/bases") return new Response("unexpected", { status: 500 });
		expect(body.bases).toEqual(["QkFTRQ=="]);
		baseRows = { obj: baseRow(H1, { createdAt: 1_000_000_000 }) };
		return Response.json({ rejected: 0, items: [{ objectId: "obj", hash: H1, epoch: 1, stored: true, current: true }] });
	};
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: [changeHex(1)] });
	await startNostrSync();
	const floor = 1_000_000 - 86_400;
	// Bases first: the first scan asks for our 31078s.
	expect(filters[0]).toMatchObject({ kinds: [31078], authors: [pk] });
	expect(filters).toContainEqual(expect.objectContaining({ kinds: [1078], "#b": [H1] }));
	expect(filters).toContainEqual(expect.objectContaining({ kinds: [1078, 1079], authors: [pk], since: floor }));
	// Nothing walks our 1078 history from zero; only objects without a base (here the vanish ledger) are read by their own stream.
	for (const filter of filters.filter((f) => f.kinds?.includes(1078) && f.authors)) expect(filter.since).toBe(floor);
	expect(filters).toContainEqual(expect.objectContaining({ kinds: [1078, 1079], "#h": [blindPersonal("__vanished__")] }));
	expect(changeImports).toContainEqual({ b64: changeB64(1), b: H1 });
	const live = liveFilters.find((f) => f.authors?.includes(pk) && f.kinds?.includes(1078))!;
	expect(live.kinds).toEqual([1078, 1079, 31078, 1080]);
	expect(live.since!).toBeGreaterThanOrEqual(floor);
	const after = (await state()) as unknown as { bases: Record<string, { hash: string; eventIds: string[] }> };
	expect(after.bases.obj).toMatchObject({ hash: H1, eventIds: [base.id] });
});

test("a chunked base assembles its 31078 part with its 1080 parts fetched by #c", async () => {
	const b64 = "QUJDREVGR0hJSktM";
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(b64);
	const gid = hasher.digest("hex").slice(0, 16);
	const head = finalizeEvent({ kind: 31078, created_at: 1_000_000, tags: [["d", "x"], ["h", "y"], ["epoch", "1"], ["c", gid, "0", "2"]], content: nip44.encrypt(b64.slice(0, 8), conversationKey) }, sk);
	const tail = finalizeEvent({ kind: 1080, created_at: 999_999, tags: [["h", "y"], ["c", gid, "1", "2"]], content: nip44.encrypt(b64.slice(8), conversationKey) }, sk);
	history = [head, tail];
	const imported: unknown[] = [];
	baseReply = (path, body) => {
		if (path === "/api/bases") imported.push(...(body.bases as unknown[]));
		return Response.json({ rejected: 0, items: [{ objectId: "obj", hash: H1, epoch: 1, stored: true, current: true }] });
	};
	await startNostrSync();
	expect(filters).toContainEqual(expect.objectContaining({ kinds: [1080], "#c": [gid] }));
	expect(imported).toEqual([b64]);
	const after = (await state()) as unknown as { bases: Record<string, { eventIds: string[]; createdAt: number }> };
	expect(new Set(after.bases.obj.eventIds)).toEqual(new Set([head.id, tail.id]));
	expect(after.bases.obj.createdAt).toBe(1_000_000);
});

test("with no base anywhere the full history walk is unchanged (dual read)", async () => {
	await startNostrSync();
	expect(filters).toContainEqual({ kinds: [1078, 1079], authors: [pk], until: undefined, limit: 128 });
	expect(filters.some((f) => f["#b"])).toBe(false);
});

test("the history floor is per stream: a space holding no base is walked whole while the personal stream has bases", async () => {
	// Rollout / offline-computer gap: a global floor cut off every unbased object older than the newest base of ANY stream.
	await keyring({ joined: { key: KEY_A, owner: admin } });
	spaceObjects = { joined: spaceWithMembers("joined", [admin, pk]) };
	objectRows = [{ id: "theirs", channelId: "joined" }];
	history = [baseEvent("QkFTRQ==", 1_000_000)];
	baseRows = { obj: baseRow(H1, { createdAt: 1_000_000_000 }) };
	await startNostrSync();
	const floor = 1_000_000 - 86_400;
	expect(filters).toContainEqual(expect.objectContaining({ kinds: [1078, 1079], authors: [pk], since: floor }));
	const space = filters.filter((f) => f.kinds?.includes(1078) && f["#h"]?.includes(blind(KEY_A, "space:joined")));
	expect(space.length).toBeGreaterThan(0);
	for (const filter of space) expect(filter.since ?? 0).toBe(0);
});

test("only live deltas are published, each with the base it was written on; covered, stale and orphan changes never go out", async () => {
	baseRows = { obj: baseRow(H1) };
	localChangeRows = {
		obj: [
			{ id: "c1", b64: "QUJD", b: H1, pending: true, class: "live" },
			{ id: "c2", b64: "REVG", class: "covered" },
			{ id: "c3", b64: "R0hJ", b: H1, class: "stale" },
			{ id: "c4", b64: "SktM", b: H1, class: "orphan" },
		],
		plain: [{ id: "c5", b64: "TU5P" }],
	};
	realTimers();
	await startNostrSync();
	await until(() => published.filter((item) => item.kind === 1078).length === 2);
	await settle();
	const out = published.filter((item) => item.kind === 1078);
	expect(out.map(decrypt).sort()).toEqual(["QUJD", "TU5P"]);
	expect(out.find((item) => decrypt(item) === "QUJD")!.tags).toContainEqual(["b", H1]);
	expect(out.find((item) => decrypt(item) === "TU5P")!.tags.some((tag) => tag[0] === "b")).toBe(false);
	// The daemon stops counting the published change as pending (it stays own until a base proves it folded).
	expect(basePosts).toContainEqual({ path: "/api/changes/published", body: { published: { obj: ["c1"] } } });
});

test("only own orphans are rebased by the daemon and published; another device's orphans and a space this identity may not write are left alone", async () => {
	process.env.GLON_STATE_SYNC_COMPACT = "0";
	await keyring({ viewed: { key: KEY_A, owner: admin } });
	spaceObjects = { viewed: spaceWithMembers("viewed", [admin]) };
	objectRows = [{ id: "shared", channelId: "viewed" }];
	baseRows = {
		obj: baseRow(H2, { orphan: 1, own: 1, rebase: 1 }),
		// Another device's orphan: its writer rebases it, the daemon discards it here.
		other: baseRow(H2, { orphan: 1 }),
		shared: baseRow(H1, { orphan: 1, own: 1, rebase: 1 }),
	};
	baseReply = (path, body) => {
		if (path !== "/api/bases/rebase") return Response.json({ rejected: 0, items: [] });
		localChangeRows[body.objectId as string] = [{ id: "r1", b64: "UkVC", b: H2, pending: true, own: true, class: "live" }];
		return Response.json({ objectId: body.objectId, base: H2, changes: [{ orphan: "o1", id: "r1", b64: "UkVC" }] });
	};
	realTimers();
	await startNostrSync();
	await until(() => published.some((item) => item.kind === 1078 && decrypt(item) === "UkVC"));
	expect(basePosts.filter((post) => post.path === "/api/bases/rebase").map((post) => post.body)).toEqual([{ objectId: "obj" }]);
	expect(published.find((item) => item.kind === 1078 && decrypt(item) === "UkVC")!.tags).toContainEqual(["b", H2]);
});

test("compaction is off by default: nothing is built, sealed or deleted", async () => {
	baseRows = { obj: baseRow(H1, { compact: true, reason: "deltas", live: 25 }) };
	realTimers();
	await startNostrSync();
	await settle();
	expect(basePosts.some((post) => post.path === "/api/bases/build" || post.path === "/api/bases/seal")).toBe(false);
	expect(published.some((item) => item.kind === 5 || item.kind === 31078)).toBe(false);
});

/** obj holds epoch-1 base H1 (our relay copy: one old event); the daemon builds epoch 2 = H2 folding delta c1. */
async function compactOnce(options: { space?: boolean } = {}) {
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	await writeFile(join(root, "sync-state.json"), JSON.stringify({ version: 1, cursor: 100, published: {}, vanishRequested: {}, bases: { obj: { scope: "", hash: H1, epoch: 1, eventIds: ["0f".repeat(32)], createdAt: 999_000, everywhere: true } } }));
	const delta = deltaEvent(changeB64(1), 1_000_100, H1);
	history = [delta];
	importChange = async () => Response.json({ imported: 1, rejected: 0, ids: [changeHex(1)] });
	baseRows = { obj: baseRow(H1, { compact: true, reason: "deltas", live: 25 }) };
	if (options.space) {
		await keyring({ joined: { key: KEY_A, owner: admin } });
		spaceObjects = { joined: spaceWithMembers("joined", [admin, pk]) };
		objectRows = [{ id: "theirs", channelId: "joined" }];
		baseRows.theirs = baseRow(H1, { compact: true, reason: "deltas", live: 25 });
	}
	const d = blindPersonal("base:obj");
	baseReply = (path, body) => {
		if (path === "/api/bases/build") return Response.json({ objectId: body.objectId, compact: true, reason: "deltas", b64: "TkVX", hash: H2, epoch: 2, prevBase: H1, folded: [changeHex(1)] });
		if (path === "/api/bases/seal") {
			expect(body).toEqual({ base: "TkVX", conversationKey: Buffer.from(conversationKey).toString("hex") });
			return Response.json({ hash: H2, objectId: "obj", epoch: 2, d, gid: "", event: { kind: 31078, content: nip44.encrypt("TkVX", conversationKey), tags: [["d", d], ["h", blindPersonal("obj")], ["epoch", "2"]] }, parts: [] });
		}
		return Response.json({ rejected: 0, items: [] });
	};
	realTimers();
	await startNostrSync();
	await until(() => published.filter((item) => item.kind === 5).length === 2);
	await settle();
	return { delta, d };
}

test("compaction publishes the next base, then deletes the deltas it folded and the previous base (a dated before the new one)", async () => {
	const { delta, d } = await compactOnce();
	const base = published.find((item) => item.kind === 31078)!;
	expect(decrypt(base)).toBe("TkVX");
	expect(published.some((item) => item.kind === 1079)).toBe(false);
	const [folded, superseded] = published.filter((item) => item.kind === 5);
	expect(folded.tags).toEqual([["e", delta.id], ["k", "1078"]]);
	expect(superseded.tags).toEqual([["a", `31078:${pk}:${d}`], ["e", "0f".repeat(32)], ["k", "31078"], ["k", "1080"]]);
	expect(superseded.created_at).toBe(base.created_at - 1);
	const after = (await state()) as unknown as { bases: Record<string, { hash: string; eventIds: string[]; everywhere: boolean }>; compactions: Record<string, unknown> };
	expect(after.bases.obj).toMatchObject({ hash: H2, eventIds: [base.id], everywhere: true });
	expect(after.compactions).toEqual({});
});

// ── Oversized bases on Blossom (docs/state-sync.md "Oversized bases") ──

interface FakeBlossom {
	blobs: Map<string, Uint8Array>;
	requests: Array<{ method: string; path: string; auth: string | null }>;
}
/** A Blossom server on any origin: PUT /upload, GET and DELETE /<sha>; `deleteStatus` answers every DELETE instead. */
function fakeBlossom(deleteStatus?: number): FakeBlossom {
	const blobs = new Map<string, Uint8Array>();
	const requests: FakeBlossom["requests"] = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		requests.push({ method, path: url.pathname, auth: new Headers(init?.headers).get("Authorization") });
		if (method === "PUT" && url.pathname === "/upload") {
			const body = new Uint8Array(init!.body as Uint8Array);
			const sha = sha256Hex(body);
			blobs.set(sha, body);
			return Response.json({ url: `${url.origin}/${sha}`, sha256: sha, size: body.byteLength });
		}
		const sha = url.pathname.slice(1);
		if (method === "DELETE") return new Response(null, { status: deleteStatus ?? (blobs.delete(sha) ? 200 : 404) });
		if (method === "GET" && blobs.has(sha)) return new Response(blobs.get(sha));
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	restore.push(() => {
		globalThis.fetch = original;
	});
	return { blobs, requests };
}
/** The BUD-11 event inside an Authorization header. */
function authEvent(header: string | null): Event {
	return JSON.parse(Buffer.from(header!.replace(/^Nostr /, ""), "base64").toString()) as Event;
}
/** A pointer 31078 as the core seals it. */
function pointerEvent(pointer: Record<string, unknown>, created_at: number, tag = [String(pointer.sha256), String(pointer.size)]): Event {
	return finalizeEvent({ kind: 31078, created_at, tags: [["d", blindPersonal("base:obj")], ["h", blindPersonal("obj")], ["epoch", "1"], ["blob", ...tag]], content: nip44.encrypt(JSON.stringify(pointer), conversationKey) }, sk);
}

/** obj's relay copy is pointer base H1 (blob ee…); the pass builds H2, too big for parts. */
async function compactToBlossom(blossom: FakeBlossom) {
	const previousBlob = "ee".repeat(32);
	blossom.blobs.set(previousBlob, new Uint8Array([1]));
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	await writeFile(join(root, "sync-state.json"), JSON.stringify({ version: 1, cursor: 100, published: {}, vanishRequested: {}, bases: { obj: { scope: "", hash: H1, epoch: 1, eventIds: ["0f".repeat(32)], createdAt: 999_000, everywhere: true, blob: previousBlob } } }));
	baseRows = { obj: baseRow(H1, { compact: true, reason: "deltas", live: 25 }) };
	const key = "4b".repeat(32);
	const d = blindPersonal("base:obj");
	baseReply = (path, body) => {
		if (path === "/api/bases/build") return Response.json({ objectId: body.objectId, compact: true, reason: "deltas", b64: "TkVX", hash: H2, epoch: 2, prevBase: H1, folded: [changeHex(1)] });
		if (path === "/api/bases/seal") {
			if (!body.blob) return Response.json({ hash: H2, objectId: "obj", epoch: 2, d, gid: "", needsBlob: true, blobKey: key });
			const blob = body.blob as { sha256: string; size: number; url: string };
			const content = nip44.encrypt(JSON.stringify({ v: 1, hash: H2, ...blob, key }), conversationKey);
			return Response.json({ hash: H2, objectId: "obj", epoch: 2, d, gid: "", event: { kind: 31078, content, tags: [["d", d], ["h", blindPersonal("obj")], ["epoch", "2"], ["blob", blob.sha256, String(blob.size)]] }, parts: [], blob: { sha256: blob.sha256, size: blob.size, key } });
		}
		return Response.json({ rejected: 0, items: [] });
	};
	realTimers();
	await startNostrSync();
	await until(() => blossom.requests.some((r) => r.method === "DELETE"));
	await settle();
	return { previousBlob, key, d };
}

test("a base too big for 64 parts goes to Blossom encrypted, its 31078 is a pointer, and the previous base's blob is deleted after it", async () => {
	const blossom = fakeBlossom();
	const { previousBlob, key, d } = await compactToBlossom(blossom);
	// The upload is the base bytes under the core's blob key; the second seal names exactly that blob.
	const put = blossom.requests.find((r) => r.method === "PUT")!;
	expect(authEvent(put.auth).tags).toContainEqual(["t", "upload"]);
	const [uploaded] = [...blossom.blobs.keys()];
	expect(Buffer.from(decryptBlob(blossom.blobs.get(uploaded)!, Buffer.from(key, "hex"))).toString("base64")).toBe("TkVX");
	const seals = basePosts.filter((post) => post.path === "/api/bases/seal");
	expect(seals.map((post) => post.body.blob)).toEqual([undefined, { sha256: uploaded, size: blossom.blobs.get(uploaded)!.byteLength, url: expect.stringMatching(new RegExp(`/${uploaded}$`)) }]);
	const base = published.find((item) => item.kind === 31078)!;
	expect(base.tags).toContainEqual(["blob", uploaded, String(blossom.blobs.get(uploaded)!.byteLength)]);
	expect(published.some((item) => item.kind === 1080)).toBe(false);
	// Only after the relays took the previous base's deletion: BUD-02 DELETE of its blob, never of the new one.
	const deletes = blossom.requests.filter((r) => r.method === "DELETE");
	expect(deletes.map((r) => r.path)).toEqual([`/${previousBlob}`]);
	expect(authEvent(deletes[0].auth).tags).toEqual(expect.arrayContaining([["t", "delete"], ["x", previousBlob]]));
	expect(blossom.requests.indexOf(deletes[0])).toBeGreaterThan(blossom.requests.indexOf(put));
	expect(published.find((item) => item.kind === 5 && item.tags.some((tag) => tag[0] === "a"))!.tags).toContainEqual(["a", `31078:${pk}:${d}`]);
	const after = (await state()) as unknown as { bases: Record<string, { hash: string; blob?: string }>; compactions: Record<string, unknown>; blobDeletes: Record<string, true> };
	expect(after.bases.obj).toMatchObject({ hash: H2, blob: uploaded });
	expect(after.compactions).toEqual({});
	expect(after.blobDeletes).toEqual({});
});

test("a Blossom that refuses the DELETE never holds back the compaction: the blob stays queued for the next pass", async () => {
	const blossom = fakeBlossom(405);
	const { previousBlob } = await compactToBlossom(blossom);
	const after = (await state()) as unknown as { compactions: Record<string, unknown>; blobDeletes: Record<string, true> };
	expect(after.compactions).toEqual({});
	expect(after.blobDeletes).toEqual({ [previousBlob]: true });
});

test("a pointer base is fetched from Blossom, checked and imported like an inline base", async () => {
	const blossom = fakeBlossom();
	const plain = Buffer.from("BASE");
	const key = "4c".repeat(32);
	const { cipher } = encryptBlob(plain, Buffer.from(key, "hex"));
	const sha = sha256Hex(cipher);
	blossom.blobs.set(sha, cipher);
	const pointer = { v: 1, hash: sha256Hex(plain), sha256: sha, size: cipher.byteLength, key, url: `https://blossom.test/${sha}` };
	const base = pointerEvent(pointer, 1_000_000);
	history = [base];
	const imported: unknown[] = [];
	baseReply = (path, body) => {
		if (path === "/api/bases") imported.push(...(body.bases as unknown[]));
		return Response.json({ rejected: 0, items: [{ objectId: "obj", hash: pointer.hash, epoch: 1, stored: true, current: true }] });
	};
	await startNostrSync();
	expect(imported).toEqual([plain.toString("base64")]);
	expect(blossom.requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual([`/${sha}`]);
	const after = (await state()) as unknown as { replaySince?: number; bases: Record<string, { hash: string; eventIds: string[]; blob?: string }> };
	expect(after.bases.obj).toMatchObject({ hash: pointer.hash, eventIds: [base.id], blob: sha });
	expect(after.replaySince).toBeUndefined();
});

test("a pointer base whose blob does not match, or whose tag names another blob, is not imported; an unknown pointer version is not even fetched", async () => {
	const blossom = fakeBlossom();
	const key = "4c".repeat(32);
	const { cipher } = encryptBlob(Buffer.from("BASE"), Buffer.from(key, "hex"));
	const sha = sha256Hex(cipher);
	blossom.blobs.set(sha, cipher);
	// Decrypts fine, but is not the base the pointer names.
	const wrong = pointerEvent({ v: 1, hash: "aa".repeat(32), sha256: sha, size: cipher.byteLength, key }, 1_000_000);
	const future = pointerEvent({ v: 2, hash: "aa".repeat(32), sha256: sha, size: cipher.byteLength, key }, 1_000_001);
	const mislabeled = pointerEvent({ v: 1, hash: sha256Hex(Buffer.from("BASE")), sha256: sha, size: cipher.byteLength, key }, 1_000_002, ["dd".repeat(32), String(cipher.byteLength)]);
	history = [wrong, future, mislabeled];
	await startNostrSync();
	expect(basePosts.some((post) => post.path === "/api/bases")).toBe(false);
	// Only the v1 pointer was fetched (from the server: it names no url).
	expect(blossom.requests.filter((r) => r.method === "GET").map((r) => r.path)).toEqual([`/${sha}`]);
});

test("a joined space's objects are compacted by its owner's computer, not here", async () => {
	await compactOnce({ space: true });
	expect(basePosts.filter((post) => post.path === "/api/bases/build").map((post) => post.body.objectId)).toEqual(["obj"]);
});

test("a base some relay refused keeps its folded deltas until a later pass gets it everywhere", async () => {
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	await writeFile(join(root, "sync-state.json"), JSON.stringify({ version: 1, cursor: 100, published: {}, vanishRequested: {}, bases: { obj: { scope: "", hash: H1, epoch: 1, eventIds: [], createdAt: 999_000, everywhere: true } } }));
	baseRows = { obj: baseRow(H1, { compact: true, reason: "deltas", live: 25 }) };
	baseReply = (path, body) => {
		if (path === "/api/bases/build") return Response.json({ objectId: body.objectId, compact: true, reason: "deltas", b64: "TkVX", hash: H2, epoch: 2, prevBase: H1, folded: [changeHex(1)] });
		if (path === "/api/bases/seal") return Response.json({ hash: H2, objectId: "obj", epoch: 2, d: "dd", gid: "", event: { kind: 31078, content: "x", tags: [["d", "dd"]] }, parts: [] });
		return Response.json({ rejected: 0, items: [] });
	};
	const publish = spyOn(SimplePool.prototype, "publish").mockImplementation((_relays, item) => {
		published.push(item);
		return item.kind === 31078 ? [Promise.resolve(""), Promise.reject(new Error("blocked"))] : [Promise.resolve("")];
	});
	restore.push(() => publish.mockRestore());
	realTimers();
	await startNostrSync();
	await until(() => published.some((item) => item.kind === 31078));
	await settle();
	expect(published.some((item) => item.kind === 5)).toBe(false);
	const after = (await state()) as unknown as { compactions: Record<string, { hash: string; folded: string[] }> };
	expect(after.compactions.obj).toMatchObject({ hash: H2, folded: [changeHex(1)] });
});

test("a compaction pass paces its bases: no two relay events go out without the publish spacing between them", async () => {
	// RoostrRelay refuses more than 30 events a second per connection; a pass over a whole vault built and
	// published one base after another unpaced and most were "rate-limited: too many events".
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	baseRows = { a: baseRow("", { compact: true, reason: "age", live: 1 }), b: baseRow("", { compact: true, reason: "age", live: 1 }), c: baseRow("", { compact: true, reason: "age", live: 1 }) };
	baseReply = (path, body) => {
		if (path === "/api/bases/build") return Response.json({ objectId: body.objectId, compact: true, reason: "age", b64: Buffer.from(String(body.objectId)).toString("base64"), hash: String(body.objectId).repeat(64), epoch: 1, prevBase: "", folded: [] });
		if (path === "/api/bases/seal") {
			const objectId = Buffer.from(String(body.base), "base64").toString();
			return Response.json({ hash: objectId.repeat(64), objectId, epoch: 1, d: objectId, gid: "", event: { kind: 31078, content: "x", tags: [["d", objectId]] }, parts: [] });
		}
		return Response.json({ rejected: 0, items: [] });
	};
	const sequence: string[] = [];
	timeoutMock.mockImplementation(((callback: () => void, ms?: number) => {
		sequence.push(`wait ${ms}`);
		return realSetTimeout(callback, 0);
	}) as unknown as typeof setTimeout);
	const publish = spyOn(SimplePool.prototype, "publish").mockImplementation((_relays, item) => {
		published.push(item);
		if (item.kind === 31078) sequence.push("base");
		return [Promise.resolve("")];
	});
	restore.push(() => publish.mockRestore());
	await startNostrSync();
	await until(() => published.filter((item) => item.kind === 31078).length === 3);
	await settle();
	const bases = sequence.flatMap((step, i) => (step === "base" ? [i] : []));
	expect(bases).toHaveLength(3);
	for (const [n, at] of bases.entries()) {
		const next = n + 1 < bases.length ? bases[n + 1] : sequence.length;
		expect(sequence.slice(at + 1, next)).toContain("wait 120");
	}
});

test("the unbased fallback: a pass compacts an unbased object over 12 h old that another computer serves, never a younger one", async () => {
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	const now = Date.now();
	const elsewhere = { machineId: "other-computer", reason: "self", skills: [], candidates: [] };
	servingRows = { oldOrphan: elsewhere, youngOrphan: elsewhere, servedOld: elsewhere };
	baseRows = {
		oldOrphan: baseRow("", { live: 3, oldestMs: now - 13 * 3_600_000 }),
		youngOrphan: baseRow("", { live: 3, oldestMs: now - 11 * 3_600_000 }),
		// Has a base: the serving computer's due rules stand.
		servedOld: baseRow(H1, { live: 3, oldestMs: now - 30 * 3_600_000 }),
	};
	baseReply = (path, body) => {
		if (path === "/api/bases/build") return Response.json({ objectId: body.objectId, compact: true, reason: "forced", b64: "TkVX", hash: H2, epoch: 1, prevBase: "", folded: [] });
		if (path === "/api/bases/seal") return Response.json({ hash: H2, objectId: "oldOrphan", epoch: 1, d: "dd", gid: "", event: { kind: 31078, content: "x", tags: [["d", "dd"]] }, parts: [] });
		return Response.json({ rejected: 0, items: [] });
	};
	realTimers();
	await startNostrSync();
	await until(() => published.some((item) => item.kind === 31078));
	await settle();
	expect(basePosts.filter((post) => post.path === "/api/bases/build").map((post) => post.body)).toEqual([{ objectId: "oldOrphan", force: true }]);
});

test("a held current base the relays lack goes out even when another computer compacts the object; nothing is built for it", async () => {
	// Built here by hand (POST /api/bases/build): unpublished, the change it folded would exist only in this local base.
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	servingRows = { theirs: { machineId: "other-computer", reason: "self", skills: [], candidates: [] } };
	baseRows = { theirs: baseRow(H2, { epoch: 2, prevBase: H1, compact: true, reason: "deltas", live: 25 }) };
	heldBases = { theirs: [{ hash: H2, epoch: 2, current: true, b64: "TkVX" }] };
	baseReply = (path) => {
		if (path === "/api/bases/seal") return Response.json({ hash: H2, objectId: "theirs", epoch: 2, d: "dd", gid: "", event: { kind: 31078, content: "x", tags: [["d", "dd"]] }, parts: [] });
		return Response.json({ rejected: 0, items: [] });
	};
	realTimers();
	await startNostrSync();
	await until(() => published.some((item) => item.kind === 31078));
	await settle();
	expect(basePosts.filter((post) => post.path === "/api/bases/seal").map((post) => post.body.base)).toEqual(["TkVX"]);
	expect(basePosts.some((post) => post.path === "/api/bases/build")).toBe(false);
	const after = (await state()) as unknown as { bases: Record<string, { hash: string; everywhere: boolean }> };
	expect(after.bases.theirs).toMatchObject({ hash: H2, everywhere: true });
});

test("the pre-migration sweep dry run counts what an epoch-1 base folded and deletes nothing", async () => {
	process.env.GLON_STATE_SYNC_SWEEP_PREMIGRATION = "dry-run";
	baseRows = { obj: baseRow(H1) };
	const old = deltaEvent(changeB64(3), 100);
	const unfolded = deltaEvent(changeB64(4), 101);
	const checkpoint = finalizeEvent({ kind: 1079, created_at: 102, tags: [["h", blindPersonal("obj")]], content: nip44.encrypt("Q1A=", conversationKey) }, sk);
	history = [old, unfolded, checkpoint];
	baseReply = (path, body) => {
		if (path === "/api/bases/covered") {
			expect(new Set(body.ids as string[])).toEqual(new Set([changeHex(3), changeHex(4)]));
			return Response.json({ premigration: [changeHex(3)], covered: [changeHex(3)] });
		}
		return Response.json({ rejected: 0, items: [] });
	};
	const log = spyOn(console, "log");
	restore.push(() => log.mockRestore());
	realTimers();
	await startNostrSync();
	await until(() => log.mock.calls.some((call) => String(call[0]).includes("pre-migration sweep (dry run)")));
	expect(log.mock.calls.map((call) => String(call[0]))).toContain("[sync] pre-migration sweep (dry run): 1 change(s) and 1 checkpoint event(s) across 1 object(s) would be deleted");
	expect(published.some((item) => item.kind === 5)).toBe(false);
});

test("the pre-migration sweep deletes folded untagged deltas and checkpoints only with compaction on", async () => {
	process.env.GLON_STATE_SYNC_SWEEP_PREMIGRATION = "1";
	process.env.GLON_STATE_SYNC_COMPACT = "1";
	baseRows = { obj: baseRow(H1) };
	const old = deltaEvent(changeB64(3), 100);
	const tagged = deltaEvent(changeB64(5), 103, H1);
	const checkpoint = finalizeEvent({ kind: 1079, created_at: 102, tags: [["h", blindPersonal("obj")]], content: nip44.encrypt("Q1A=", conversationKey) }, sk);
	history = [old, tagged, checkpoint];
	baseReply = (path) => (path === "/api/bases/covered" ? Response.json({ premigration: [changeHex(3)], covered: [changeHex(3)] }) : Response.json({ rejected: 0, items: [] }));
	realTimers();
	await startNostrSync();
	await until(() => deletions().length === 1);
	await settle();
	expect(deleted()).toEqual(new Set([checkpoint.id, old.id]));
	expect((await state()) as unknown as { premigrationSwept: Record<string, true> }).toMatchObject({ premigrationSwept: { obj: true } });
});
