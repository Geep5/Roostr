/**
 * Record-mode sync (docs/state-objects.md "Patches", "Relay cursor",
 * "Packs", "Device flows"), used by `bun run sync` instead of the legacy
 * change/base protocol (nostrsync.ts) when the daemon runs with
 * GLON_RECORDS=1.
 *
 * Streams: the personal stream (this identity's events without an `s` tag)
 * and one per shared space (`s` = the blinded space tag), keyed and blinded
 * exactly like legacy deltas (nostrsync.ts helpers). Per stream:
 *
 *   - Journal -> relay: every unsent patch as kind 1081 (NIP-44 of the
 *     base64 Patch bytes, `c`-chunked past 40k chars), every local vanish as
 *     kind 1082 ({object_id}); acknowledged to the daemon on the relay's OK.
 *   - Relay -> store: REQ `after` the stored cursor, paged; EVENT `seq` and
 *     EOSE `head` advance the cursor (held below a half-received chunk
 *     group); a live `after` subscription follows, and a seq gap re-pages.
 *   - Packs: a device whose cursor is 0, below the relay's `oldest - 1`, or
 *     below the newest announcement's `deleted_through` loads that pack
 *     (download, sha256, decrypt, merge) and continues after its cursor.
 *   - Builder (the space's host computer; any full copy for the personal
 *     stream; GLON_RECORD_PACK_BUILDER=1|0 forces it): once caught up to the
 *     head, after 6 h or 2,000 events since the last pack, the daemon builds
 *     the pack at the head, it is encrypted (pack.ts), uploaded to Blossom
 *     and announced (kind 31081, d = blinded stream tag); then patches with
 *     seq <= the previous pack's cursor are deleted (NIP-09; the relay only
 *     honours the author's own) and the previous pack blob too.
 *
 * Cursors are per relay: only the first configured relay carries record
 * sync (its seqs are that relay's numbering).
 */

import { finalizeEvent, nip44, verifyEvent, type Event } from "nostr-tools";
import { API, apiFetch, subscribe } from "./api";
import { blossomServer, deleteBlob, download, sha256Hex, upload } from "./blossom";
import { servesHere } from "./machine";
import { blindObjectId, blindShared, loadIdentity, loadSharedSpaces, localVanished, type Identity, type SharedSpace } from "./nostrsync";
import { decryptPack, encryptPack } from "./pack";
import { CursorRelay, type CursorFilter, type SeqEvent } from "./relay-cursor";

export const PATCH_KIND = 1081;
export const VANISH_KIND = 1082;
export const PACK_KIND = 31081;
const DELETE_KIND = 5;
/** `e` tags per NIP-09 request: the relay examines at most 256 tags, two `k` tags ride along. */
const DELETE_BATCH = 254;
const CHUNK_CHARS = 40_000;
const MAX_CHUNKS = 64;
const PAGE = 500;
/** Daemon request bodies stay well under its 16 MiB cap. */
const APPLY_BATCH_CHARS = 8 * 1024 * 1024;
const PERSONAL = "personal";

interface RecordSyncConfig {
	packIntervalMs: number;
	packPatches: number;
	packCheckMs: number;
	journalPollMs: number;
	builder: "auto" | "always" | "never";
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	const value = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configFromEnv(): RecordSyncConfig {
	const builder = process.env.GLON_RECORD_PACK_BUILDER;
	return {
		packIntervalMs: envNumber("GLON_RECORD_PACK_INTERVAL_MS", 6 * 3_600_000),
		packPatches: envNumber("GLON_RECORD_PACK_PATCHES", 2000),
		packCheckMs: envNumber("GLON_RECORD_PACK_CHECK_MS", 60_000),
		journalPollMs: envNumber("GLON_RECORD_JOURNAL_POLL_MS", 5_000),
		builder: builder === "1" ? "always" : builder === "0" ? "never" : "auto",
	};
}

/** The decrypted content of a kind 31081. */
export interface PackAnnouncement {
	v: 1;
	/** The pack header's stream: the space's `s` tag, or the author pubkey (personal). */
	stream: string;
	cursor: number;
	sha256: string;
	size: number;
	url: string;
	root: string;
	/** 256 bucket hashes, 16 hex chars each. */
	buckets: string[];
	records: number;
	built_at: number;
	builder: string;
	/** Patches with seq <= this were deleted: a device whose cursor is below must load the pack. */
	deleted_through: number;
}

function announcementOf(raw: unknown, stream: string): PackAnnouncement | null {
	if (!raw || typeof raw !== "object") return null;
	const a: Partial<Record<keyof PackAnnouncement, unknown>> = raw;
	const nat = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
	if (a.v !== 1 || a.stream !== stream || !nat(a.cursor) || !nat(a.size) || !nat(a.records) || !nat(a.built_at) || !nat(a.deleted_through)) return null;
	if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256) || typeof a.url !== "string" || typeof a.root !== "string" || typeof a.builder !== "string") return null;
	if (!Array.isArray(a.buckets) || a.buckets.length !== 256 || !a.buckets.every((b) => typeof b === "string")) return null;
	return { v: 1, stream, cursor: a.cursor, sha256: a.sha256, size: a.size, url: a.url, root: a.root, buckets: a.buckets, records: a.records, built_at: a.built_at, builder: a.builder, deleted_through: a.deleted_through };
}

// ── Daemon ─────────────────────────────────────────────────────────

async function daemonGet<T>(path: string): Promise<T> {
	const res = await apiFetch(`${API}${path}`);
	if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
	return (await res.json()) as T;
}

async function daemonPost<T>(path: string, body: unknown): Promise<T> {
	const res = await apiFetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
	return (await res.json()) as T;
}

interface JournalItem {
	id: string;
	objectId: string;
	space: string;
	patch?: string;
	vanish?: boolean;
}

interface Refusal {
	objectId: string;
	reason: string;
}

interface ExportedPack {
	root: string;
	buckets: string[];
	records: number;
	cursor: number;
	size: number;
	plaintext: string;
}

interface StoredCursor {
	relay: string;
	cursor: number;
}

/**
 * Which protocol the daemon speaks: "records" when /api/records/status
 * answers, "legacy" when it refuses (DAG mode). Waits up to `waitMs` for a
 * daemon that is not up yet, then assumes legacy.
 */
export async function daemonSyncMode(waitMs = 60_000): Promise<"records" | "legacy"> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const res = await apiFetch(`${API}/api/records/status`);
			return res.ok ? "records" : "legacy";
		} catch {
			if (Date.now() > deadline) return "legacy";
			await Bun.sleep(1000);
		}
	}
}

// ── Streams ────────────────────────────────────────────────────────

interface Stream {
	/** "personal" or the space id: the daemon's cursor key. */
	label: string;
	space: SharedSpace | null;
	/** The relay stream (and pack header `stream`): the space's `s` tag or this identity's pubkey. */
	streamId: string;
	/** NIP-44 conversation key and pack stream key. */
	key: Uint8Array;
	/** The 31081 `d` tag. */
	d: string;
	/** Daemon stream selection (records_sync.odin): `space=<id>` or `exclude=<shared ids>`. */
	select: string;
	writers: Set<string>;
}

interface ChunkGroup {
	total: number;
	parts: Map<number, string>;
	firstSeq: number;
}

interface StreamRun {
	stream: Stream;
	/** Highest seq processed without a gap. */
	processed: number;
	head: number;
	oldest: number;
	live: string | null;
	chain: Promise<void>;
	groups: Map<string, ChunkGroup>;
	announcement: { content: PackAnnouncement; createdAt: number } | null;
	caughtUp: boolean;
}

function streamFilter(stream: Stream): CursorFilter {
	return stream.space ? { "#s": [stream.streamId] } : { authors: [stream.streamId] };
}

export class RecordSync {
	private readonly id: Identity;
	private readonly config: RecordSyncConfig;
	private readonly relay: CursorRelay;
	private readonly runs = new Map<string, StreamRun>();
	private stored: Record<string, StoredCursor> = {};
	private flushing: Promise<void> | null = null;
	private flushAgain = false;
	private persistTimer: Timer | null = null;
	private timers: Timer[] = [];

	constructor(id: Identity, config: RecordSyncConfig) {
		this.id = id;
		this.config = config;
		this.relay = new CursorRelay(id.relays[0]);
		this.relay.onReconnect = () => {
			for (const run of this.runs.values()) this.enqueue(run, () => this.catchUp(run));
			this.scheduleFlush();
		};
	}

	async start(): Promise<void> {
		this.stored = await daemonGet<Record<string, StoredCursor>>("/api/records/cursors");
		await this.refreshStreams();
		subscribe((objectId) => {
			this.scheduleFlush();
			if (this.runs.has(objectId)) void this.refreshStreams().catch((err) => log("stream refresh failed:", err));
		}, () => this.scheduleFlush());
		this.timers.push(setInterval(() => this.scheduleFlush(), this.config.journalPollMs));
		this.timers.push(setInterval(() => void this.refreshStreams().catch((err) => log("stream refresh failed:", err)), 30_000));
		this.timers.push(setInterval(() => this.checkPacks(), this.config.packCheckMs));
		this.scheduleFlush();
		log(`record sync on ${this.relay.url}: ${this.runs.size} stream(s)`);
	}

	/** Personal stream plus one per shared space; new ones catch up, gone ones close. */
	private async refreshStreams(): Promise<void> {
		const spaces = await loadSharedSpaces(this.id, await localVanished());
		const desired = new Map<string, Stream>();
		const personalD = blindObjectId(this.id, "stream:personal");
		desired.set(PERSONAL, {
			label: PERSONAL,
			space: null,
			streamId: this.id.pk,
			key: this.id.conversationKey,
			d: personalD,
			select: `exclude=${[...spaces.keys()].map(encodeURIComponent).join(",")}`,
			writers: new Set([this.id.pk]),
		});
		for (const space of spaces.values()) {
			desired.set(space.spaceId, {
				label: space.spaceId,
				space,
				streamId: space.spaceTag,
				key: space.convKey,
				d: space.spaceTag,
				select: `space=${encodeURIComponent(space.spaceId)}`,
				writers: space.writers,
			});
		}
		for (const [label, run] of this.runs) {
			const next = desired.get(label);
			if (next && next.streamId === run.stream.streamId) {
				run.stream = next; // writers and the personal stream's exclusions move
				continue;
			}
			if (run.live) this.relay.close(run.live);
			this.runs.delete(label);
		}
		for (const [label, stream] of desired) {
			if (this.runs.has(label)) continue;
			const saved = this.stored[label];
			const processed = saved && saved.relay === this.relay.url && Number.isSafeInteger(saved.cursor) ? saved.cursor : 0;
			const run: StreamRun = { stream, processed, head: 0, oldest: 1, live: null, chain: Promise.resolve(), groups: new Map(), announcement: null, caughtUp: false };
			this.runs.set(label, run);
			this.enqueue(run, () => this.catchUp(run));
		}
	}

	/** One stream's work runs in order: catch-up, live events and pack builds never interleave. */
	private enqueue(run: StreamRun, work: () => Promise<void>): Promise<void> {
		run.chain = run.chain.then(work).catch((err) => log(`[${run.stream.label.slice(0, 8)}]`, err instanceof Error ? err.message : err));
		return run.chain;
	}

	// ── Receiving ──────────────────────────────────────────────────

	private decrypt(run: StreamRun, event: Event): string | null {
		try {
			return nip44.decrypt(event.content, run.stream.key);
		} catch {
			return null;
		}
	}

	/** Patches and vanishes of `items` (seq order) go to the daemon in batches. */
	private async receive(run: StreamRun, items: SeqEvent[]): Promise<void> {
		const patches: string[] = [];
		const vanish: string[] = [];
		for (const { event, seq } of items) {
			if (event.kind !== PATCH_KIND && event.kind !== VANISH_KIND) continue;
			if (!run.stream.writers.has(event.pubkey) || !verifyEvent(event)) continue;
			const plain = this.decrypt(run, event);
			if (plain === null) continue;
			if (event.kind === VANISH_KIND) {
				try {
					const parsed: unknown = JSON.parse(plain);
					if (parsed && typeof parsed === "object" && "object_id" in parsed && typeof parsed.object_id === "string") vanish.push(parsed.object_id);
				} catch {
					/* not a vanish */
				}
				continue;
			}
			const c = event.tags.find((tag) => tag[0] === "c");
			if (!c) {
				patches.push(plain);
				continue;
			}
			const [, gid, rawIndex, rawTotal] = c;
			const index = Number(rawIndex);
			const total = Number(rawTotal);
			if (!gid || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 2 || total > MAX_CHUNKS || index < 0 || index >= total) continue;
			const key = `${event.pubkey}/${gid}`;
			const group = run.groups.get(key) ?? { total, parts: new Map<number, string>(), firstSeq: seq };
			if (group.total !== total) continue;
			group.parts.set(index, plain);
			group.firstSeq = Math.min(group.firstSeq, seq);
			run.groups.set(key, group);
			if (group.parts.size < total) continue;
			run.groups.delete(key);
			const whole = Array.from({ length: total }, (_, i) => group.parts.get(i) ?? "").join("");
			if (sha256Hex(new TextEncoder().encode(whole)).slice(0, 16) === gid) patches.push(whole);
		}
		await this.apply(run, patches, vanish);
	}

	private async apply(run: StreamRun, patches: string[], vanish: string[]): Promise<void> {
		let start = 0;
		while (start < patches.length || vanish.length > 0) {
			let end = start;
			let size = 0;
			while (end < patches.length && (end === start || size + patches[end].length <= APPLY_BATCH_CHARS)) size += patches[end++].length;
			const out = await daemonPost<{ applied: number; unchanged: number; vanished: number; refused: Refusal[] }>("/api/records/apply", { patches: patches.slice(start, end), vanish });
			if (out.refused.length > 0) log(`[${run.stream.label.slice(0, 8)}] ${out.refused.length} patch(es) refused: ${[...new Set(out.refused.map((r) => r.reason))].join("; ")}`);
			start = end;
			vanish = [];
		}
	}

	/** The cursor that is safe to persist: never past the first part of a half-received chunk group. */
	private safeCursor(run: StreamRun): number {
		let cursor = run.processed;
		for (const group of run.groups.values()) cursor = Math.min(cursor, group.firstSeq - 1);
		return Math.max(cursor, 0);
	}

	private persistSoon(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.persist().catch((err) => log("cursor write failed:", err));
		}, 500);
	}

	private async persist(): Promise<void> {
		const streams: Record<string, StoredCursor> = {};
		for (const [label, run] of this.runs) streams[label] = { relay: this.relay.url, cursor: this.safeCursor(run) };
		this.stored = await daemonPost<Record<string, StoredCursor>>("/api/records/cursors", { streams });
	}

	/** The newest valid pack announcement of the stream from one of its writers. */
	private async fetchAnnouncement(run: StreamRun): Promise<void> {
		const { events } = await this.relay.query([{ kinds: [PACK_KIND], "#d": [run.stream.d], authors: [...run.stream.writers] }]);
		let best: StreamRun["announcement"] = null;
		for (const { event } of events) {
			if (!run.stream.writers.has(event.pubkey) || !verifyEvent(event)) continue;
			const plain = this.decrypt(run, event);
			if (plain === null) continue;
			let content: PackAnnouncement | null = null;
			try {
				content = announcementOf(JSON.parse(plain), run.stream.streamId);
			} catch {
				continue;
			}
			if (content && (!best || content.cursor > best.content.cursor || (content.cursor === best.content.cursor && event.created_at > best.createdAt))) best = { content, createdAt: event.created_at };
		}
		run.announcement = best;
	}

	private async loadPack(run: StreamRun, pack: PackAnnouncement): Promise<void> {
		const server = await blossomServer(this.id.relays);
		let cipher: Uint8Array;
		try {
			cipher = await download(pack.sha256, pack.url || server);
		} catch {
			cipher = await download(pack.sha256, server);
		}
		const plaintext = decryptPack(cipher, run.stream.key, pack.cursor);
		const res = await apiFetch(`${API}/api/records/import-pack`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: plaintext });
		if (!res.ok) throw new Error(`pack import failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
		const out = (await res.json()) as { records: number; merged: number; refused: Refusal[] };
		log(`[${run.stream.label.slice(0, 8)}] pack #${pack.cursor} loaded: ${out.records} record(s), ${out.merged} merged, ${out.refused.length} refused`);
		run.processed = pack.cursor;
		run.groups.clear();
	}

	/** Page `after` the processed seq to the head; load the pack first when the window is gone. */
	private async catchUp(run: StreamRun): Promise<void> {
		await this.fetchAnnouncement(run);
		const filter = streamFilter(run.stream);
		let page = await this.relay.query([{ ...filter, after: run.processed, limit: PAGE }]);
		const pack = run.announcement?.content;
		const oldest = page.cursor?.oldest ?? 1;
		if (pack && pack.cursor > run.processed && (run.processed === 0 || run.processed < oldest - 1 || run.processed < pack.deleted_through)) {
			await this.loadPack(run, pack);
			page = await this.relay.query([{ ...filter, after: run.processed, limit: PAGE }]);
		} else if (run.processed < oldest - 1) {
			log(`[${run.stream.label.slice(0, 8)}] behind the relay window (cursor ${run.processed}, oldest ${oldest}) and no newer pack: continuing`);
		}
		for (;;) {
			const items = page.events.filter((item) => item.seq > run.processed).sort((a, b) => a.seq - b.seq);
			await this.receive(run, items);
			if (items.length > 0) run.processed = items[items.length - 1].seq;
			if (page.cursor) {
				run.head = page.cursor.head;
				run.oldest = page.cursor.oldest;
			}
			if (page.events.length < PAGE) break;
			page = await this.relay.query([{ ...filter, after: run.processed, limit: PAGE }]);
		}
		// Everything up to the head was delivered (events the relay no longer has included).
		run.processed = Math.max(run.processed, run.head);
		run.caughtUp = true;
		this.persistSoon();
		const live = [{ ...filter, after: run.processed, limit: 0 }];
		if (run.live) this.relay.refilter(run.live, live);
		else {
			run.live = await this.relay.subscribe(live, (item) => {
				void this.enqueue(run, () => this.onLive(run, item));
			}, undefined, (reason) => {
				log(`[${run.stream.label.slice(0, 8)}] live subscription closed: ${reason}`);
				run.live = null;
				void this.enqueue(run, () => this.catchUp(run));
			});
		}
	}

	private async onLive(run: StreamRun, item: SeqEvent): Promise<void> {
		if (item.seq <= run.processed) return;
		if (item.seq !== run.processed + 1) {
			await this.catchUp(run);
			return;
		}
		await this.receive(run, [item]);
		run.processed = item.seq;
		run.head = Math.max(run.head, item.seq);
		if (item.event.kind === PACK_KIND) run.announcement = null; // refetched on the next catch-up or build check
		if (run.live) this.relay.refilter(run.live, [{ ...streamFilter(run.stream), after: run.processed, limit: 0 }]);
		this.persistSoon();
	}

	// ── Sending ────────────────────────────────────────────────────

	private runFor(space: string): StreamRun | undefined {
		return (space ? this.runs.get(space) : undefined) ?? this.runs.get(PERSONAL);
	}

	private objectTags(run: StreamRun, objectId: string): string[][] {
		const space = run.stream.space;
		if (!space) return [["h", blindObjectId(this.id, objectId)], ["v", "1"]];
		// `h` = the space tag and `owner` as legacy deltas: the owner's space deletion (kind 5 by `h`) covers these too.
		return [["h", blindShared(space.keyHex, objectId)], ["s", space.spaceTag], ["h", space.spaceTag], ["owner", space.owner ?? this.id.pk], ["v", "1"]];
	}

	private sign(kind: number, tags: string[][], content: string, createdAt = Math.floor(Date.now() / 1000)): Event {
		return finalizeEvent({ kind, created_at: createdAt, tags, content }, this.id.sk);
	}

	private eventsFor(run: StreamRun, item: JournalItem): Event[] {
		const tags = this.objectTags(run, item.objectId);
		if (item.vanish) return [this.sign(VANISH_KIND, tags, nip44.encrypt(JSON.stringify({ object_id: item.objectId }), run.stream.key))];
		const b64 = item.patch ?? "";
		const parts: string[] = [];
		for (let i = 0; i < b64.length; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));
		if (parts.length === 0) parts.push("");
		if (parts.length > MAX_CHUNKS) throw new Error(`patch for ${item.objectId} exceeds ${MAX_CHUNKS} chunks`);
		const gid = parts.length > 1 ? sha256Hex(new TextEncoder().encode(b64)).slice(0, 16) : "";
		return parts.map((part, i) => this.sign(PATCH_KIND, gid ? [...tags, ["c", gid, String(i), String(parts.length)]] : tags, nip44.encrypt(part, run.stream.key)));
	}

	/** One flush at a time (two would publish the same journal items twice): wait out a running one, then run one. */
	private async flushNow(): Promise<void> {
		while (this.flushing) await this.flushing;
		this.scheduleFlush();
		await this.flushing;
	}

	scheduleFlush(): void {
		if (this.flushing) {
			this.flushAgain = true;
			return;
		}
		this.flushing = this.flush()
			.catch((err) => log("journal flush failed:", err instanceof Error ? err.message : err))
			.finally(() => {
				this.flushing = null;
				if (this.flushAgain) {
					this.flushAgain = false;
					this.scheduleFlush();
				}
			});
	}

	/** Publish every journal item; acknowledge the ones the relay accepted. */
	private async flush(): Promise<void> {
		const { items } = await daemonGet<{ items: JournalItem[] }>("/api/records/journal");
		if (items.length === 0) return;
		const acked: string[] = [];
		let failed = 0;
		for (const item of items) {
			const run = this.runFor(item.space);
			if (!run) return; // streams not loaded yet
			let ok = true;
			for (const event of this.eventsFor(run, item)) {
				const result = await this.relay.publish(event);
				if (!result.ok && !result.message.startsWith("duplicate")) {
					ok = false;
					if (failed++ < 3) log(`publish refused for ${item.objectId.slice(0, 8)}: ${result.message}`);
					break;
				}
			}
			if (ok) acked.push(item.id);
			if (acked.length >= 200) await daemonPost("/api/records/journal/ack", { ids: acked.splice(0) });
		}
		if (acked.length > 0) await daemonPost("/api/records/journal/ack", { ids: acked });
	}

	// ── Packs ──────────────────────────────────────────────────────

	private checkPacks(): void {
		for (const run of this.runs.values()) {
			void this.enqueue(run, async () => {
				await this.maybeBuildPack(run);
			});
		}
	}

	private async isBuilder(run: StreamRun): Promise<boolean> {
		if (this.config.builder !== "auto") return this.config.builder === "always";
		return run.stream.space ? servesHere(run.stream.space.spaceId) : true;
	}

	/** Build, upload and announce a pack at the head when due; then retention. Exposed for operators and tests. */
	async maybeBuildPack(run: StreamRun, force = false): Promise<boolean> {
		if (!(await this.isBuilder(run))) return false;
		// Never behind the head: own journal out, then everything back in.
		await this.flushNow();
		await this.catchUp(run);
		if (run.groups.size > 0) return false;
		const head = await this.relay.query([{ ...streamFilter(run.stream), after: run.processed, limit: 0 }]);
		if (head.cursor && head.cursor.head > run.processed) return false;
		const previous = run.announcement;
		const cursor = run.processed;
		const due = force || !previous || (cursor > previous.content.cursor && (cursor - previous.content.cursor >= this.config.packPatches || Date.now() - previous.content.built_at >= this.config.packIntervalMs));
		if (!due || (previous && cursor <= previous.content.cursor)) return false;

		const label = run.stream.label.slice(0, 8);
		const exported = await daemonGet<ExportedPack>(`/api/records/export?${run.stream.select}&stream=${encodeURIComponent(run.stream.streamId)}&cursor=${cursor}`);
		const cipher = encryptPack(Buffer.from(exported.plaintext, "base64"), run.stream.key, cursor);
		const server = await blossomServer(this.id.relays);
		const blob = await upload(cipher, `pack-${cursor}`, server, this.id);
		const content: PackAnnouncement = {
			v: 1,
			stream: run.stream.streamId,
			cursor,
			sha256: blob.sha256,
			size: blob.size,
			url: blob.url,
			root: exported.root,
			buckets: exported.buckets.map((hash) => hash.slice(0, 16)),
			records: exported.records,
			built_at: Date.now(),
			builder: this.id.pk,
			deleted_through: previous ? previous.content.cursor : 0,
		};
		// Addressable: the newer created_at replaces the previous announcement.
		const createdAt = Math.max(Math.floor(Date.now() / 1000), (previous?.createdAt ?? 0) + 1);
		const event = this.sign(PACK_KIND, [["d", run.stream.d], ["v", "1"]], nip44.encrypt(JSON.stringify(content), run.stream.key), createdAt);
		const published = await this.relay.publish(event);
		if (!published.ok) throw new Error(`pack announcement refused: ${published.message}`);
		run.announcement = { content, createdAt };
		log(`[${label}] pack #${cursor} announced: ${exported.records} record(s), ${blob.size} bytes`);

		if (previous) {
			const deleted = await this.deletePatchesThrough(run, previous.content.cursor);
			log(`[${label}] retention: ${deleted} patch event(s) through #${previous.content.cursor} deleted`);
			if (previous.content.sha256 !== blob.sha256) await deleteBlob(previous.content.sha256, server, this.id).catch((err) => log(`[${label}] old pack blob delete failed:`, err instanceof Error ? err.message : err));
		}
		return true;
	}

	/** NIP-09 for this identity's patch and vanish events of the stream with seq <= `through`. */
	private async deletePatchesThrough(run: StreamRun, through: number): Promise<number> {
		const ids: string[] = [];
		let after = 0;
		for (;;) {
			const page = await this.relay.query([{ ...streamFilter(run.stream), kinds: [PATCH_KIND, VANISH_KIND], authors: [this.id.pk], after, limit: PAGE }]);
			const items = page.events.sort((a, b) => a.seq - b.seq);
			for (const item of items) if (item.seq <= through) ids.push(item.event.id);
			if (items.length < PAGE || items[items.length - 1].seq > through) break;
			after = items[items.length - 1].seq;
		}
		for (let i = 0; i < ids.length; i += DELETE_BATCH) {
			const batch = ids.slice(i, i + DELETE_BATCH);
			const event = this.sign(DELETE_KIND, [...batch.map((id) => ["e", id]), ["k", String(PATCH_KIND)], ["k", String(VANISH_KIND)]], "superseded by a pack");
			const result = await this.relay.publish(event);
			if (!result.ok) throw new Error(`deletion refused: ${result.message}`);
		}
		return ids.length;
	}

	/** Build every due pack now (operators, tests). */
	async buildPacks(force = false): Promise<number> {
		let built = 0;
		await Promise.all([...this.runs.values()].map((run) => this.enqueue(run, async () => {
			if (await this.maybeBuildPack(run, force)) built++;
		})));
		return built;
	}

	stop(): void {
		for (const timer of this.timers) clearInterval(timer);
		this.relay.shutdown();
	}
}

function log(...args: unknown[]): void {
	console.log("[records]", ...args);
}

export async function startRecordSync(): Promise<RecordSync | null> {
	const id = await loadIdentity();
	if (!id) {
		log("no nostr key — sync disabled");
		return null;
	}
	if (id.relays.length === 0) {
		log("no relays configured — sync disabled (add relays in Settings)");
		return null;
	}
	const sync = new RecordSync(id, configFromEnv());
	await sync.start();
	return sync;
}
