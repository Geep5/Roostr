/**
 * Direct live lines: live progress (live.ts) goes straight from this computer
 * to every open app device over a WebRTC data channel, with Nostr only
 * introducing the two (signals, kind 25079, core/signal.odin) and carrying
 * progress itself only when some viewer has no line.
 *
 * A viewer (an app device with the app open) says `hello` on start and every
 * minute. For each viewer with no open line this computer opens a peer
 * connection with one ordered data channel, `roostr-live`, and sends the
 * `offer`; the viewer `answer`s; both trickle `ice`; `bye` closes. A line that
 * fails is reopened with backoff while its viewer keeps saying hello; a viewer
 * silent for VIEWER_TTL_MS is let go. Each channel message is one live event
 * payload, exactly as on the relays.
 *
 * Signals go out through the store (`signal_publish`), whose sync daemon
 * carries them to the relays, and come in as its `signal` frames. Trust is
 * the signer (nostrsync.ts `signalScope`): a viewer of this account (scope
 * "") sees every run; a member of a shared space only runs on that space's
 * objects. Viewers are kept per (scope, device), so nobody can borrow another
 * scope's line by naming its device.
 *
 * Every live event still goes to the local store (`live_publish`), so this
 * computer's own windows see it; the relay copy is needed only while some
 * viewer that said hello lately has no open line (`relayCopyNeeded`).
 */

import { PeerConnection, type DataChannel } from "node-datachannel";
import { fetchObject, mutate, str } from "./api";
import { setLiveTransport, type LiveTransport } from "./live";
import { machineId } from "./roster";
import type { LiveEvent, LiveSignal } from "./types";

export const LIVE_CHANNEL_LABEL = "roostr-live";
export const ICE_SERVERS = ["stun:stun.l.google.com:19302"];
/** A viewer heard from this recently still counts for the relay copy. */
export const HELLO_FRESH_MS = 3 * 60_000;
/** A viewer silent this long is let go, its line closed. */
export const VIEWER_TTL_MS = 5 * 60_000;
/** An offer not open by then is retried. */
const CONNECT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const SWEEP_MS = 30_000;
/** How long an object's space is trusted before it is read again. */
const SCOPE_TTL_MS = 60_000;

/** One viewer as the relay-copy choice sees it for one event. */
export interface ViewerReach {
	/** Said hello within HELLO_FRESH_MS. */
	fresh: boolean;
	/** The event went down its open line. */
	direct: boolean;
}

/**
 * Whether a live event also needs its relay copy: yes while any viewer heard
 * from lately has no open line, and yes when no such viewer is known (an app
 * that never says hello still reads the relays).
 */
export function relayCopyNeeded(viewers: Iterable<ViewerReach>): boolean {
	let fresh = 0;
	for (const viewer of viewers) {
		if (!viewer.fresh) continue;
		if (!viewer.direct) return true;
		fresh++;
	}
	return fresh === 0;
}

interface Line {
	/** Its place in `lines`: scope and device. */
	key: string;
	device: string;
	/** "" this account, else the shared space it may see. */
	space: string;
	heardAt: number;
	session: string;
	pc: PeerConnection | null;
	channel: DataChannel | null;
	open: boolean;
	answered: boolean;
	/** Candidates that came before the answer. */
	early: Array<[candidate: string, mid: string]>;
	attempts: number;
	timer: Timer | undefined;
}

export interface LiveLinesOptions {
	/** This computer's device id (its machine id). */
	me: string;
	/** Hand a signal to the relays: `signal_publish` in `space` ("" = this account). */
	send: (signal: LiveSignal, space: string) => Promise<void>;
	/** Hand an event to the local store; `relay` false keeps it off the relays. */
	store?: (event: LiveEvent, relay: boolean) => Promise<void>;
	/** The shared space an object lives in (its `channel`). */
	scopeOf?: (objectId: string) => Promise<string>;
	now?: () => number;
	iceServers?: string[];
}

const storeLive = async (event: LiveEvent, relay: boolean): Promise<void> => {
	await mutate("live_publish", relay ? { event } : { event, relay: false });
};

export class LiveLines {
	private readonly lines = new Map<string, Line>();
	private readonly scopes = new Map<string, { space: string; at: number }>();
	private readonly sweepTimer: Timer;
	private readonly store: (event: LiveEvent, relay: boolean) => Promise<void>;
	private readonly now: () => number;

	constructor(private readonly options: LiveLinesOptions) {
		this.store = options.store ?? storeLive;
		this.now = options.now ?? Date.now;
		this.sweepTimer = setInterval(() => this.forgetSilent(), SWEEP_MS);
		this.sweepTimer.unref();
	}

	/** What `setLiveTransport` takes: down every open line the event may travel, then to the store. */
	readonly transport: LiveTransport = async (event) => {
		const needsScope = [...this.lines.values()].some((line) => line.space !== "");
		const scope = needsScope ? await this.scopeOf(event.object) : "";
		const now = this.now();
		const message = JSON.stringify(event);
		const reach: ViewerReach[] = [];
		for (const line of this.lines.values()) {
			if (line.space !== "" && line.space !== scope) continue;
			let direct = false;
			if (line.open && line.channel) {
				try {
					direct = line.channel.sendMessage(message);
				} catch {
					/* closing under us: the relay copy covers it */
				}
			}
			reach.push({ fresh: now - line.heardAt <= HELLO_FRESH_MS, direct });
		}
		await this.store(event, relayCopyNeeded(reach));
	};

	/** One signal from the store's stream; `space` is the scope it speaks for. Anything not for this computer is ignored. */
	onSignal(signal: LiveSignal, space: string): void {
		if (signal.from === this.options.me) return;
		const key = `${space}\u0000${signal.from}`;
		if (signal.type === "hello") {
			if (signal.role !== "viewer" || signal.to) return;
			let line = this.lines.get(key);
			if (!line) {
				line = { key, device: signal.from, space, heardAt: 0, session: "", pc: null, channel: null, open: false, answered: false, early: [], attempts: 0, timer: undefined };
				this.lines.set(key, line);
			}
			line.heardAt = this.now();
			// Not open, not on its way, not waiting out a backoff: offer now.
			if (!line.open && !line.pc && !line.timer) this.connect(line);
			return;
		}
		if (signal.to !== this.options.me || signal.role !== "viewer") return;
		const line = this.lines.get(key);
		if (!line || signal.session !== line.session) return;
		if (signal.type === "bye") {
			this.drop(line);
			return;
		}
		const pc = line.pc;
		if (!pc) return;
		try {
			if (signal.type === "answer" && !line.answered) {
				pc.setRemoteDescription(signal.sdp, "answer");
				line.answered = true;
				for (const [candidate, mid] of line.early.splice(0)) pc.addRemoteCandidate(candidate, mid);
			} else if (signal.type === "ice") {
				if (line.answered) pc.addRemoteCandidate(signal.candidate, signal.mid);
				else line.early.push([signal.candidate, signal.mid]);
			}
		} catch {
			// A description or candidate the connection refuses: start over.
			this.lost(line);
		}
	}

	/** The open lines, by device (tests, diagnostics). */
	openDevices(): string[] {
		return [...this.lines.values()].filter((line) => line.open).map((line) => line.device);
	}

	/** Close every line (shutdown, tests). */
	close(): void {
		clearInterval(this.sweepTimer);
		for (const line of this.lines.values()) this.drop(line);
	}

	private signal(line: Line, type: LiveSignal["type"], fields: Partial<Pick<LiveSignal, "sdp" | "candidate" | "mid">> = {}): void {
		const signal: LiveSignal = { v: 1, type, from: this.options.me, to: line.device, session: line.session, role: "host", sdp: "", candidate: "", mid: "", ts: Date.now(), ...fields };
		void this.options.send(signal, line.space).catch(() => {
			/* the store is restarting: the viewer's next hello starts over */
		});
	}

	private connect(line: Line): void {
		this.closePeer(line);
		line.session = crypto.randomUUID();
		line.answered = false;
		line.early = [];
		const pc = new PeerConnection(`${LIVE_CHANNEL_LABEL}-${line.device}`, { iceServers: this.options.iceServers ?? ICE_SERVERS });
		line.pc = pc;
		pc.onLocalDescription((sdp, type) => {
			if (line.pc === pc && type === "offer") this.signal(line, "offer", { sdp });
		});
		pc.onLocalCandidate((candidate, mid) => {
			// The browser form: "candidate:...", without the SDP attribute prefix.
			if (line.pc === pc) this.signal(line, "ice", { candidate: candidate.replace(/^a=/, ""), mid });
		});
		pc.onStateChange((state) => {
			if (line.pc === pc && (state === "failed" || state === "closed")) this.lost(line);
		});
		const channel = pc.createDataChannel(LIVE_CHANNEL_LABEL);
		line.channel = channel;
		channel.onOpen(() => {
			if (line.channel !== channel) return;
			line.open = true;
			line.attempts = 0;
			clearTimeout(line.timer);
			line.timer = undefined;
		});
		channel.onClosed(() => {
			if (line.channel === channel) this.lost(line);
		});
		line.timer = setTimeout(() => {
			line.timer = undefined;
			if (line.pc === pc && !line.open) this.lost(line);
		}, CONNECT_TIMEOUT_MS);
	}

	/** A line that failed, closed or never opened: try again with backoff while its viewer keeps saying hello. */
	private lost(line: Line): void {
		this.closePeer(line);
		clearTimeout(line.timer);
		line.timer = undefined;
		if (this.now() - line.heardAt > VIEWER_TTL_MS) {
			this.lines.delete(line.key);
			return;
		}
		const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** line.attempts);
		line.attempts++;
		line.timer = setTimeout(() => {
			line.timer = undefined;
			if (!line.pc && this.lines.get(line.key) === line) this.connect(line);
		}, delay);
	}

	private drop(line: Line): void {
		clearTimeout(line.timer);
		line.timer = undefined;
		this.closePeer(line);
		this.lines.delete(line.key);
	}

	private closePeer(line: Line): void {
		const pc = line.pc;
		line.pc = null;
		line.channel = null;
		line.open = false;
		try {
			pc?.close();
		} catch {
			/* already gone */
		}
	}

	/** Let go of viewers silent for VIEWER_TTL_MS (runs every SWEEP_MS). */
	forgetSilent(): void {
		const now = this.now();
		for (const line of this.lines.values()) {
			if (now - line.heardAt <= VIEWER_TTL_MS) continue;
			if (line.pc) this.signal(line, "bye");
			this.drop(line);
		}
	}

	private async scopeOf(objectId: string): Promise<string> {
		if (this.options.scopeOf) return this.options.scopeOf(objectId);
		const known = this.scopes.get(objectId);
		if (known && this.now() - known.at < SCOPE_TTL_MS) return known.space;
		let space = "";
		try {
			space = str((await fetchObject(objectId)).fields, "channel");
		} catch {
			// Unreadable: no shared-space viewer gets it; this account's still do.
		}
		if (this.scopes.size >= 1024) this.scopes.clear();
		this.scopes.set(objectId, { space, at: this.now() });
		return space;
	}
}

/** Open this computer's live lines and make them the live transport. Feed `onSignal` the store's `signal` frames. */
export async function startLiveLines(): Promise<LiveLines> {
	const lines = new LiveLines({
		me: await machineId(),
		send: async (signal, space) => {
			await mutate("signal_publish", space ? { event: signal, space } : { event: signal });
		},
	});
	setLiveTransport(lines.transport);
	return lines;
}
