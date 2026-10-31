import { afterEach, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { CursorRelay } from "./relay-cursor";

/**
 * A relay whose connections can go silent: a muted connection stays open but
 * never answers, as a socket that died without closing (the Mac slept, the
 * network changed) looks to the client.
 */
function fakeRelay() {
	let connections = 0;
	const muted = new Set<number>();
	const waiters: Array<{ match: (connection: number, id: string) => boolean; resolve: () => void }> = [];
	const server = Bun.serve<{ connection: number }>({
		port: 0,
		fetch(req, srv) {
			return srv.upgrade(req, { data: { connection: ++connections } }) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			message(ws, raw) {
				if (muted.has(ws.data.connection)) return;
				const [type, a] = JSON.parse(String(raw)) as [string, unknown];
				if (type === "EVENT") ws.send(JSON.stringify(["OK", (a as Event).id, true, ""]));
				if (type === "REQ") {
					for (const w of waiters) if (w.match(ws.data.connection, String(a))) w.resolve();
					ws.send(JSON.stringify(["EOSE", a]));
				}
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		connections: () => connections,
		/** Resolves when a REQ matching `match` arrives. */
		reqArrives(match: (connection: number, id: string) => boolean): Promise<void> {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ match, resolve });
			return promise;
		},
		mute: () => muted.add(connections),
		stop: () => server.stop(true),
	};
}

const event = (id: string): Event => ({ id, pubkey: "p", created_at: 0, kind: 1081, tags: [], content: "", sig: "s" });

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const done of cleanup) done();
	cleanup = [];
});

test("an unanswered publish abandons the silent socket: the next publish goes out on a new one", async () => {
	const relay = fakeRelay();
	const client = new CursorRelay(relay.url, { okMs: 100, queryMs: 100, heartbeatMs: 60_000 });
	cleanup.push(() => client.shutdown(), relay.stop);
	expect((await client.publish(event("a"))).ok).toBe(true);
	relay.mute();
	expect(await client.publish(event("b"))).toEqual({ ok: false, message: "timeout" });
	expect((await client.publish(event("c"))).ok).toBe(true);
	expect(relay.connections()).toBe(2);
});

test("a live subscription on a socket that went silent is re-sent on a new one, found by the heartbeat", async () => {
	const relay = fakeRelay();
	const client = new CursorRelay(relay.url, { okMs: 100, queryMs: 100, heartbeatMs: 50 });
	cleanup.push(() => client.shutdown(), relay.stop);
	const live = await client.subscribe([{ kinds: [1081] }], () => {});
	const resent = relay.reqArrives((connection, id) => connection === 2 && id === live);
	relay.mute();
	// Nothing is sent: only the heartbeat can notice the socket is gone. (Real
	// sockets and the client's real timers, kept short; no fixed wait.)
	await resent;
	expect(relay.connections()).toBe(2);
});
