/**
 * Record mode carries live progress (kind 25078) and live-line signals
 * (kind 25079) like legacy sync: a fake relay (one Bun WebSocket server on
 * localhost) and a faked daemon API; no vault, no real relay.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, getPublicKey, nip44, type Event, type Filter } from "nostr-tools";
import * as api from "./api";
import * as auth from "./local-api-auth";
import { blindObjectId, blindShared, loadIdentity, type Identity } from "./nostrsync";
import { startRecordSync, type RecordSync } from "./recordsync";
import type { LiveEvent, LiveSignal } from "./types";

const sk = new Uint8Array(32).fill(1);
const pk = getPublicKey(sk);
const conversationKey = nip44.getConversationKey(sk, pk);
const writerSk = new Uint8Array(32).fill(4);
const writerPk = getPublicKey(writerSk);
const strangerSk = new Uint8Array(32).fill(9);
const SPACE = "space-a";
const SPACE_KEY = "ab".repeat(32);
const spaceConvKey = Uint8Array.from(Buffer.from(SPACE_KEY, "hex"));
const spaceTag = blindShared(SPACE_KEY, `space:${SPACE}`);

const PROGRESS: LiveEvent = { v: 1, run: "r", agent: "a", object: "note", thread: "__discussion__", seq: 0, kind: "step", text: "x", ts: 1 };
const SIGNAL: LiveSignal = { v: 1, type: "offer", from: "machine-1", to: "phone-1", session: "s1", role: "host", sdp: "v=0", candidate: "", mid: "", ts: 1 };

type Sub = { connection: number; filters: Filter[] };

interface FakeRelay {
	url: string;
	/** Every EVENT it was sent. */
	received: Event[];
	/** Hand an event to the matching live subscriptions, as another device's publish. */
	deliver(event: Event): void;
	/** Live filters of the ephemeral subscriptions open now. */
	ephemeralFilters(): Filter[];
	/** Drop every connection, as a relay deploy does. */
	drop(): void;
	stop(): void;
}

/** Waiters re-checked whenever the relay or the daemon fake sees something. */
const waiters = new Set<() => void>();
function notify(): void {
	for (const check of [...waiters]) check();
}
function until(predicate: () => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const check = () => {
		if (!predicate()) return;
		waiters.delete(check);
		resolve();
	};
	waiters.add(check);
	check();
	return promise;
}

function matches(filter: Filter, event: Event): boolean {
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
	const h = filter["#h"];
	if (h && !event.tags.some((tag) => tag[0] === "h" && h.includes(tag[1]))) return false;
	const s = filter["#s"];
	if (s && !event.tags.some((tag) => tag[0] === "s" && s.includes(tag[1]))) return false;
	return true;
}

/** A NIP-01 relay that stores nothing: every EVENT is OK'd and handed to the matching live subscriptions. */
function fakeRelay(): FakeRelay {
	let connections = 0;
	const sockets = new Map<number, Bun.ServerWebSocket<{ connection: number }>>();
	const subs = new Map<string, Sub>();
	const received: Event[] = [];
	const server = Bun.serve<{ connection: number }>({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req, { data: { connection: ++connections } }) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			open(ws) {
				sockets.set(ws.data.connection, ws);
			},
			close(ws) {
				sockets.delete(ws.data.connection);
				for (const [id, sub] of subs) if (sub.connection === ws.data.connection) subs.delete(id);
				notify();
			},
			message(ws, raw) {
				const [type, a, ...rest] = JSON.parse(String(raw)) as [string, unknown, ...Filter[]];
				if (type === "EVENT") {
					const event = a as Event;
					received.push(event);
					ws.send(JSON.stringify(["OK", event.id, true, ""]));
					deliver(event);
				} else if (type === "REQ") {
					subs.set(`${ws.data.connection}/${String(a)}`, { connection: ws.data.connection, filters: rest });
					ws.send(JSON.stringify(["EOSE", a]));
				} else if (type === "CLOSE") {
					subs.delete(`${ws.data.connection}/${String(a)}`);
				}
				notify();
			},
		},
	});
	function deliver(event: Event): void {
		for (const [key, sub] of subs) {
			if (!sub.filters.some((filter) => matches(filter, event))) continue;
			sockets.get(sub.connection)?.send(JSON.stringify(["EVENT", key.slice(key.indexOf("/") + 1), event]));
		}
	}
	return {
		url: `ws://127.0.0.1:${server.port}`,
		received,
		deliver,
		ephemeralFilters: () => [...subs.values()].flatMap((sub) => sub.filters).filter((filter) => filter.kinds?.includes(25078)),
		drop: () => {
			for (const ws of sockets.values()) ws.close();
		},
		stop: () => server.stop(true),
	};
}

let root: string;
let previousRoot: string | undefined;
let relay: FakeRelay;
let sync: RecordSync | null;
let mutations: Array<Record<string, unknown>>;
let handlers: api.EphemeralHandlers;
let id: Identity;
let restore: Array<() => void>;

async function start(shared: boolean): Promise<void> {
	await writeFile(join(root, "nostr.json"), JSON.stringify({ privkey: Buffer.from(sk).toString("hex"), relays: [relay.url] }));
	if (shared) await writeFile(join(root, "channel-keys.json"), JSON.stringify({ version: 1, channels: { [SPACE]: { key: SPACE_KEY, keyId: 1 } } }));
	const fetch = spyOn(auth, "apiFetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/api/mutate")) {
			mutations.push(JSON.parse(String(init?.body)));
			notify();
			return Response.json({ ok: true });
		}
		if (url.endsWith("/api/records/cursors")) return Response.json({});
		if (url.endsWith("/api/records/journal")) return Response.json({ items: [] });
		if (url.endsWith("/api/vanished")) return Response.json({ vanished: [], count: 0 });
		if (url.endsWith(`/api/objects/${SPACE}`)) {
			const member = { mapValue: { entries: { npub: { stringValue: writerPk }, role: { stringValue: "writer" } } } };
			return Response.json({ id: SPACE, typeKey: "channel", fields: { members: { valuesValue: { items: [member] } } } });
		}
		if (url.endsWith("/api/objects")) return Response.json(shared ? [{ id: "note", channelId: SPACE }] : [{ id: "note" }]);
		throw new Error(`Unexpected local request: ${url}`);
	});
	restore.push(() => fetch.mockRestore());
	const subscribe = spyOn(api, "subscribe").mockImplementation((_onObject, _onConnected, ephemeral) => {
		handlers = ephemeral ?? {};
	});
	restore.push(() => subscribe.mockRestore());
	sync = await startRecordSync();
	id = (await loadIdentity())!;
	await until(() => relay.ephemeralFilters().length > 0);
}

/** The relay's copy of what this computer published, by kind. */
const sent = (kind: number) => relay.received.filter((event) => event.kind === kind && event.pubkey === pk);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "glon-recordsync-live-test-"));
	previousRoot = process.env.GLON_DATA;
	process.env.GLON_DATA = root;
	relay = fakeRelay();
	sync = null;
	mutations = [];
	handlers = {};
	restore = [];
});

afterEach(async () => {
	sync?.stop();
	relay.stop();
	for (const undo of restore.reverse()) undo();
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

test("record mode: local progress goes out as kind 25078, another device's comes in, own echoes are dropped", async () => {
	await start(false);
	expect(relay.ephemeralFilters()).toEqual([{ kinds: [25078, 25079], authors: [pk], since: expect.any(Number) }]);

	handlers.live!(PROGRESS, "local", false); // already handed to every viewer directly
	handlers.live!({ ...PROGRESS, seq: 1 }, "relay", true); // relayed frames never go back out
	handlers.live!(PROGRESS, "local", true);
	await until(() => sent(25078).length > 0);
	const [progress, ...more] = sent(25078);
	expect(more).toEqual([]);
	expect(progress.tags).toEqual([["h", blindObjectId(id, "note")]]);
	expect(JSON.parse(nip44.decrypt(progress.content, conversationKey))).toEqual(PROGRESS);

	// Another device of this account. The relay echoed our own event to our
	// subscription first, on the same socket: only the other device's arrives.
	const other: LiveEvent = { ...PROGRESS, run: "r2", text: "from the laptop" };
	relay.deliver(finalizeEvent({ kind: 25078, created_at: Math.floor(Date.now() / 1000), tags: [["h", blindObjectId(id, "note")]], content: nip44.encrypt(JSON.stringify(other), conversationKey) }, sk));
	await until(() => mutations.length > 0);
	expect(mutations).toEqual([{ action: "live_publish", event: other, origin: "relay" }]);
});

test("record mode: local signals go out as kind 25079, another device's answer comes in, echoes and strangers are dropped", async () => {
	await start(false);
	handlers.signal!({ ...SIGNAL, session: "s2" }, "relay", "");
	handlers.signal!(SIGNAL, "local", "");
	await until(() => sent(25079).length > 0);
	const signals = sent(25079);
	expect(signals.map((event) => JSON.parse(nip44.decrypt(event.content, conversationKey)))).toEqual([SIGNAL]);
	expect(signals[0].tags).toEqual([]);

	const answer: LiveSignal = { ...SIGNAL, type: "answer", from: "phone-1", to: "machine-1", role: "viewer" };
	relay.deliver(finalizeEvent({ kind: 25079, created_at: Math.floor(Date.now() / 1000), tags: [], content: nip44.encrypt(JSON.stringify(answer), nip44.getConversationKey(strangerSk, getPublicKey(strangerSk))) }, strangerSk));
	relay.deliver(finalizeEvent({ kind: 25079, created_at: Math.floor(Date.now() / 1000), tags: [], content: nip44.encrypt(JSON.stringify(answer), conversationKey) }, sk));
	// In order on one socket: our echo and the stranger's were handled before it.
	await until(() => mutations.length > 0);
	expect(mutations).toEqual([{ action: "signal_publish", event: answer, origin: "relay" }]);
});

test("record mode: a shared space's progress and signals travel under its key and stream tag", async () => {
	await start(true);
	expect(relay.ephemeralFilters()).toEqual([
		{ kinds: [25078, 25079], authors: [pk], since: expect.any(Number) },
		{ kinds: [25078, 25079], "#h": [spaceTag], since: expect.any(Number) },
	]);

	handlers.live!(PROGRESS, "local", true);
	await until(() => sent(25078).length > 0);
	const [progress] = sent(25078);
	expect(progress.tags).toEqual([["h", blindShared(SPACE_KEY, "note")], ["h", spaceTag]]);
	expect(JSON.parse(nip44.decrypt(progress.content, spaceConvKey))).toEqual(PROGRESS);

	// A hello reaches this account and every shared space.
	handlers.signal!({ ...SIGNAL, type: "hello", to: "" }, "local", SPACE);
	await until(() => sent(25079).length === 2);
	expect(sent(25079).map((event) => event.tags)).toEqual([[], [["h", spaceTag]]]);

	// A non-writer holding the key is ignored; the space's other writer's
	// progress and signal (scoped to the space) come in.
	const theirs: LiveEvent = { ...PROGRESS, run: "r3" };
	relay.deliver(finalizeEvent({ kind: 25078, created_at: Math.floor(Date.now() / 1000), tags: [["h", spaceTag]], content: nip44.encrypt(JSON.stringify(theirs), spaceConvKey) }, strangerSk));
	relay.deliver(finalizeEvent({ kind: 25078, created_at: Math.floor(Date.now() / 1000), tags: [["h", blindShared(SPACE_KEY, "note")], ["h", spaceTag]], content: nip44.encrypt(JSON.stringify(theirs), spaceConvKey) }, writerSk));
	relay.deliver(finalizeEvent({ kind: 25079, created_at: Math.floor(Date.now() / 1000), tags: [["h", spaceTag]], content: nip44.encrypt(JSON.stringify(SIGNAL), spaceConvKey) }, writerSk));
	await until(() => mutations.length >= 2);
	expect(mutations).toEqual([
		{ action: "live_publish", event: theirs, origin: "relay" },
		{ action: "signal_publish", event: SIGNAL, origin: "relay", space: SPACE },
	]);
});

test("record mode: the progress subscription comes back after the relay drops the connection", async () => {
	await start(false);
	// Real sockets: the client's own reconnect delay (1 s) runs on the real clock.
	relay.drop();
	await until(() => relay.ephemeralFilters().length === 0);
	await until(() => relay.ephemeralFilters().length > 0);
	relay.deliver(finalizeEvent({ kind: 25078, created_at: Math.floor(Date.now() / 1000), tags: [], content: nip44.encrypt(JSON.stringify(PROGRESS), conversationKey) }, sk));
	await until(() => mutations.length > 0);
	expect(mutations).toEqual([{ action: "live_publish", event: PROGRESS, origin: "relay" }]);
});
