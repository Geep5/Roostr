/**
 * Direct live lines (rtc.ts): this computer and a viewer device, both real
 * WebRTC peers (node-datachannel) on loopback, introduce themselves through a
 * fake signal bus (what `signal_publish` and the store's `signal` frames
 * carry in production) and a live event travels the data channel. Around it:
 * when the relay copy is still needed, which signals this computer ignores,
 * how lines close and come back, and the store-stream frames that feed it.
 */

import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { PeerConnection, cleanup } from "node-datachannel";
import { subscribe } from "./api";
import * as auth from "./local-api-auth";
import { LIVE_CHANNEL_LABEL, LiveLines, VIEWER_TTL_MS, relayCopyNeeded, type LiveLinesOptions } from "./rtc";
import type { LiveEvent, LiveSignal } from "./types";

const ME = "machine-1";
const EVENT: LiveEvent = { v: 1, run: "run-1", agent: "agent-1", object: "object-1", thread: "__discussion__", seq: 0, kind: "step", text: "shell_exec: git status", ts: 1_700_000_000_000 };

const open: Array<{ close(): void }> = [];
afterEach(() => {
	for (const thing of open.splice(0)) thing.close();
});
afterAll(() => cleanup());

function signal(type: LiveSignal["type"], fields: Partial<LiveSignal>): LiveSignal {
	return { v: 1, type, from: "", to: "", session: "", role: "viewer", sdp: "", candidate: "", mid: "", ts: Date.now(), ...fields };
}

/**
 * The peers are real (libdatachannel threads on loopback): their events come
 * from native code, not from timers a fake clock could drive, so tests wait
 * on the condition itself.
 */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(20);
	}
}

interface Viewer {
	received: LiveEvent[];
	labels: string[];
	session(): string;
	hello(): void;
	deliver(s: LiveSignal, scope: string): void;
	close(): void;
}

/** An app device: answers offers with a real peer connection, collects what its channel carries. */
function viewer(device: string, space: string, lines: () => LiveLines): Viewer {
	const received: LiveEvent[] = [];
	const labels: string[] = [];
	let pc: PeerConnection | null = null;
	let session = "";
	let early: LiveSignal[] = [];
	const reply = (type: LiveSignal["type"], fields: Partial<LiveSignal>) => lines().onSignal(signal(type, { from: device, to: ME, session, ...fields }), space);
	const self: Viewer = {
		received,
		labels,
		session: () => session,
		hello: () => lines().onSignal(signal("hello", { from: device }), space),
		deliver(s: LiveSignal, scope: string): void {
			if (s.to !== device || scope !== space) return;
			if (s.type === "offer") {
				pc?.close();
				session = s.session;
				const peer = new PeerConnection(device, { iceServers: [] });
				pc = peer;
				peer.onLocalDescription((sdp, type) => {
					if (type === "answer") reply("answer", { sdp });
				});
				peer.onLocalCandidate((candidate, mid) => reply("ice", { candidate: candidate.replace(/^a=/, ""), mid }));
				peer.onDataChannel((dc) => {
					labels.push(dc.getLabel());
					dc.onMessage((m) => received.push(JSON.parse(String(m)) as LiveEvent));
				});
				peer.setRemoteDescription(s.sdp, "offer");
				for (const c of early.splice(0)) if (c.session === session) peer.addRemoteCandidate(c.candidate, c.mid);
			} else if (s.type === "ice") {
				if (pc && s.session === session) pc.addRemoteCandidate(s.candidate, s.mid);
				else early.push(s);
			}
		},
		close(): void {
			pc?.close();
			pc = null;
			early = [];
		},
	};
	open.push(self);
	return self;
}

/** This computer, its signals delivered (asynchronously, like a relay) to `viewers`. */
function host(viewers: () => Viewer[], options: Partial<LiveLinesOptions> = {}) {
	const sent: Array<{ signal: LiveSignal; space: string }> = [];
	const stored: Array<{ event: LiveEvent; relay: boolean }> = [];
	const lines = new LiveLines({
		me: ME,
		iceServers: [],
		send: async (s, space) => {
			sent.push({ signal: s, space });
			queueMicrotask(() => {
				for (const v of viewers()) v.deliver(s, space);
			});
		},
		store: async (event, relay) => {
			stored.push({ event, relay });
		},
		...options,
	});
	open.push(lines);
	return { lines, sent, stored };
}

test("an offer, an answer and trickled ice open a line that carries live events", async () => {
	const phone = viewer("phone-1", "", () => h.lines);
	const h = host(() => [phone]);
	phone.hello();
	await until(() => h.lines.openDevices().includes("phone-1") && phone.labels.length > 0);
	expect(phone.labels).toEqual([LIVE_CHANNEL_LABEL]);

	const offer = h.sent.find((s) => s.signal.type === "offer")!.signal;
	expect(offer).toMatchObject({ v: 1, from: ME, to: "phone-1", role: "host", session: phone.session() });
	expect(offer.sdp).toContain("webrtc-datachannel");
	const ice = h.sent.filter((s) => s.signal.type === "ice").map((s) => s.signal);
	expect(ice.length).toBeGreaterThan(0);
	for (const c of ice) expect(c.candidate.startsWith("candidate:")).toBe(true);

	await h.lines.transport(EVENT);
	await until(() => phone.received.length === 1);
	expect(phone.received[0]).toEqual(EVENT);
	// Every viewer has its line: the store still gets it, the relays do not.
	expect(h.stored).toEqual([{ event: EVENT, relay: false }]);
});

test("the relay copy goes out while a fresh viewer has no line, or when no viewer is known", async () => {
	expect(relayCopyNeeded([])).toBe(true);
	expect(relayCopyNeeded([{ fresh: true, direct: true }])).toBe(false);
	expect(relayCopyNeeded([{ fresh: true, direct: false }])).toBe(true);
	expect(relayCopyNeeded([{ fresh: true, direct: true }, { fresh: true, direct: false }])).toBe(true);
	// A viewer not heard from lately no longer holds the relays open...
	expect(relayCopyNeeded([{ fresh: true, direct: true }, { fresh: false, direct: false }])).toBe(false);
	// ...but with nobody fresh, the relays are all there is.
	expect(relayCopyNeeded([{ fresh: false, direct: false }])).toBe(true);

	const h = host(() => []);
	await h.lines.transport(EVENT);
	h.lines.onSignal(signal("hello", { from: "tablet-1" }), "");
	await h.lines.transport(EVENT);
	expect(h.stored.map((s) => s.relay)).toEqual([true, true]);
});

test("a shared space's viewer gets only that space's runs, and only those count for the relay copy", async () => {
	let scope = "space-a";
	const member = viewer("member-1", "space-b", () => h.lines);
	const h = host(() => [member], { scopeOf: async () => scope });
	member.hello();
	await until(() => h.lines.openDevices().includes("member-1"));
	expect(h.sent.every((s) => s.space === "space-b")).toBe(true);

	await h.lines.transport(EVENT);
	scope = "space-b";
	await h.lines.transport({ ...EVENT, seq: 1 });
	await until(() => member.received.length === 1);
	expect(member.received[0].seq).toBe(1);
	expect(h.stored.map((s) => s.relay)).toEqual([true, false]);
});

test("signals that are not for this computer change nothing", async () => {
	const phone = viewer("phone-1", "", () => h.lines);
	const h = host(() => [phone]);
	h.lines.onSignal(signal("hello", { from: ME }), "");
	h.lines.onSignal(signal("hello", { from: "other-host", role: "host" }), "");
	h.lines.onSignal(signal("hello", { from: "phone-2", to: "someone" }), "");
	expect(h.sent).toEqual([]);

	phone.hello();
	await until(() => h.lines.openDevices().includes("phone-1"));
	const session = phone.session();
	h.lines.onSignal(signal("bye", { from: "phone-1", to: "machine-2", session }), "");
	h.lines.onSignal(signal("bye", { from: "phone-1", to: ME, session: "another-session" }), "");
	h.lines.onSignal(signal("bye", { from: "phone-1", to: ME, session }), "space-x");
	h.lines.onSignal(signal("bye", { from: "phone-1", to: ME, session, role: "host" }), "");
	expect(h.lines.openDevices()).toEqual(["phone-1"]);

	h.lines.onSignal(signal("bye", { from: "phone-1", to: ME, session }), "");
	expect(h.lines.openDevices()).toEqual([]);
	await h.lines.transport(EVENT);
	expect(h.stored.at(-1)!.relay).toBe(true);
});

test("a line that drops is offered again, and a silent viewer is let go", async () => {
	let now = Date.now();
	const phone = viewer("phone-1", "", () => h.lines);
	const h = host(() => [phone], { now: () => now });
	phone.hello();
	await until(() => h.lines.openDevices().includes("phone-1"));
	const first = phone.session();

	phone.close();
	await until(() => h.lines.openDevices().length === 0);
	await until(() => h.lines.openDevices().includes("phone-1"), 15_000);
	expect(phone.session()).not.toBe(first);

	now += VIEWER_TTL_MS + 1;
	h.lines.forgetSilent();
	expect(h.lines.openDevices()).toEqual([]);
	expect(h.sent.at(-1)!.signal).toMatchObject({ type: "bye", to: "phone-1", session: phone.session() });
	await h.lines.transport(EVENT);
	expect(h.stored.at(-1)!.relay).toBe(true);
});

test("the store transport marks a directly delivered event to stay off the relays", async () => {
	const bodies: unknown[] = [];
	const fetch = spyOn(auth, "apiFetch").mockImplementation(async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		return Response.json({ ok: true });
	});
	open.push({ close: () => fetch.mockRestore() });
	const phone = viewer("phone-1", "", () => h.lines);
	const h = host(() => [phone], { store: undefined });
	phone.hello();
	await until(() => h.lines.openDevices().includes("phone-1"));
	await h.lines.transport(EVENT);
	h.lines.onSignal(signal("bye", { from: "phone-1", to: ME, session: phone.session() }), "");
	await h.lines.transport(EVENT);
	expect(bodies).toEqual([
		{ action: "live_publish", event: EVENT, relay: false },
		{ action: "live_publish", event: EVENT },
	]);
});

test("the store stream hands signal frames and the relay flag of live frames to their handlers", async () => {
	const frames = [
		{ type: "signal", origin: "relay", signal: signal("hello", { from: "phone-1" }), space: "space-a" },
		{ type: "signal", origin: "relay", signal: signal("hello", { from: "phone-2" }) },
		{ type: "live", origin: "local", live: EVENT, relay: false },
		{ type: "live", origin: "local", live: EVENT },
	];
	const fetch = spyOn(auth, "apiFetch").mockImplementation(
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")));
						// Never closed: the subscription stays on this stream.
					},
				}),
			),
	);
	open.push({ close: () => fetch.mockRestore() });
	const signals: Array<[string, string, string]> = [];
	const live: boolean[] = [];
	subscribe(() => {}, undefined, {
		signal: (s, origin, space) => signals.push([s.from, origin, space]),
		live: (_event, _origin, relay) => live.push(relay),
	});
	await until(() => live.length === 2);
	expect(signals).toEqual([
		["phone-1", "relay", "space-a"],
		["phone-2", "relay", ""],
	]);
	expect(live).toEqual([false, true]);
});
