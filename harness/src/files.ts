/**
 * Peer-to-peer files: a File object (typeKey `file`) names bytes by their
 * sha256 (`file_hash`); every computer keeps its own copy in
 * GLON_DATA/blobs/<hash>, and `available_on` lists the computers holding
 * one. A computer missing the bytes asks a holder directly over a WebRTC
 * data channel; the relay only carries the introduction (offer/answer), as
 * self-encrypted ephemeral events (kind 21078) signed by the owner key every
 * device shares. Bytes never touch the relay. No fallback: if no holder is
 * online the File's `error` says so.
 */

import { mkdirSync, renameSync, rmSync } from "node:fs";
import { SimplePool, finalizeEvent, nip44, type Event } from "nostr-tools";
import { RTCPeerConnection, type RTCDataChannel } from "werift";
import { createObject, deleteField, iv, lv, queryAll, setField, str, sv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { machines } from "./machine";
import { dataRoot, loadIdentity, type Identity } from "./nostrsync";
import { machineId } from "./roster";

export const FILE_TYPE = "file";
const SIGNAL_KIND = 21078;
const SIGNAL_TAG = "roostr-rtc";
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const CHUNK = 64 * 1024;
/** Stop waiting for a peer that has said nothing for this long. */
const IDLE_MS = 15_000;
/** Signals older than this are replays or backlog, never acted on. */
const SIGNAL_MAX_AGE_S = 60;

type Signal =
	| { v: 1; t: "offer"; sid: string; from: string; to: string; hash: string; sdp: string }
	| { v: 1; t: "answer"; sid: string; from: string; to: string; sdp: string }
	| { v: 1; t: "missing"; sid: string; from: string; to: string };

const HASH_RE = /^[0-9a-f]{64}$/;

export function blobDir(): string {
	return `${dataRoot()}/blobs`;
}

function blobPath(hash: string): string {
	if (!HASH_RE.test(hash)) throw new Error("Not a file hash.");
	return `${blobDir()}/${hash}`;
}

export async function hasBlob(hash: string): Promise<boolean> {
	return HASH_RE.test(hash) && (await Bun.file(blobPath(hash)).exists());
}

/** File objects naming these bytes (one hash may back several objects). */
async function fileObjects(hash: string): Promise<QueryRow[]> {
	return queryAll({ type: FILE_TYPE, filters: [{ key: "file_hash", condition: "equal", value: hash }] });
}

function holders(row: { fields: ObjectJSON["fields"] }): string[] {
	return (row.fields["available_on"]?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean);
}

/** Record that this computer now holds the bytes, and clear a stale error. */
async function markHeld(hash: string): Promise<void> {
	const me = await machineId();
	for (const row of await fileObjects(hash)) {
		const on = holders(row);
		if (!on.includes(me)) await setField(row.id, "available_on", lv([...on, me]));
		if (str(row.fields, "error")) await deleteField(row.id, "error");
	}
}

async function markError(hash: string, error: string): Promise<void> {
	for (const row of await fileObjects(hash)) if (str(row.fields, "error") !== error) await setField(row.id, "error", sv(error));
}

/**
 * Keep uploaded bytes: store them under their hash and create the File
 * object in `space`, held by this computer.
 */
export async function storeUpload(bytes: Uint8Array, name: string, mime: string, space: string): Promise<{ id: string; hash: string; size: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	const hash = hasher.digest("hex");
	mkdirSync(blobDir(), { recursive: true });
	if (!(await hasBlob(hash))) {
		const tmp = `${blobPath(hash)}.part-${crypto.randomUUID()}`;
		await Bun.write(tmp, bytes);
		renameSync(tmp, blobPath(hash));
	}
	const fields: Record<string, ValueJSON> = {
		file_hash: sv(hash),
		file_size: iv(bytes.byteLength),
		file_mime: sv(mime),
		available_on: lv([await machineId()]),
	};
	if (space) fields.channel = sv(space);
	const { id } = await createObject(name || "Untitled file", FILE_TYPE, fields);
	return { id, hash, size: bytes.byteLength };
}

/** The MIME a File object records for these bytes, for serving them. */
export async function mimeOf(hash: string): Promise<string> {
	const row = (await fileObjects(hash))[0];
	return (row && str(row.fields, "file_mime")) || "application/octet-stream";
}

// ── Signaling ────────────────────────────────────────────────────

let peer: { id: Identity; pool: SimplePool; me: string } | null = null;
const answers = new Map<string, (s: Signal) => void>();
const seenSignals = new Set<string>();

async function signal(s: Signal): Promise<void> {
	if (!peer) throw new Error("File peer is not running.");
	const { id, pool } = peer;
	const event = finalizeEvent({
		kind: SIGNAL_KIND,
		created_at: Math.floor(Date.now() / 1000),
		tags: [["t", SIGNAL_TAG]],
		content: nip44.encrypt(JSON.stringify(s), id.conversationKey),
	}, id.sk);
	await Promise.any(pool.publish(id.relays, event));
}

/** Resolve once ICE gathering is complete: one offer/answer carries every candidate. */
async function gathered(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === "complete") return;
	const { promise, resolve } = Promise.withResolvers<void>();
	const sub = pc.iceGatheringStateChange.subscribe((state) => {
		if (state === "complete") resolve();
	});
	await promise;
	sub.unSubscribe();
}

async function onSignal(event: Event): Promise<void> {
	if (!peer || event.created_at < Math.floor(Date.now() / 1000) - SIGNAL_MAX_AGE_S || seenSignals.has(event.id)) return;
	seenSignals.add(event.id);
	let s: Signal;
	try {
		s = JSON.parse(nip44.decrypt(event.content, peer.id.conversationKey)) as Signal;
	} catch {
		return;
	}
	if (s.v !== 1 || s.to !== peer.me) return;
	if (s.t === "offer") void serveOffer(s).catch((err) => console.error(`[files] serving ${s.hash.slice(0, 12)} failed:`, err));
	else answers.get(s.sid)?.(s);
}

/** A holder's side: answer the offer and stream the bytes down the channel. */
async function serveOffer(s: Extract<Signal, { t: "offer" }>): Promise<void> {
	if (!peer) return;
	if (!(await hasBlob(s.hash))) {
		await signal({ v: 1, t: "missing", sid: s.sid, from: peer.me, to: s.from });
		return;
	}
	const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
	const done = setTimeout(() => void pc.close(), 10 * 60_000);
	pc.onDataChannel.subscribe((dc) => {
		void sendBlob(dc, s.hash).catch((err) => console.error(`[files] send ${s.hash.slice(0, 12)} failed:`, err)).finally(() => {
			clearTimeout(done);
			setTimeout(() => void pc.close(), 2000);
		});
	});
	await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
	await pc.setLocalDescription(await pc.createAnswer());
	await gathered(pc);
	await signal({ v: 1, t: "answer", sid: s.sid, from: peer.me, to: s.from, sdp: pc.localDescription!.sdp });
}

async function sendBlob(dc: RTCDataChannel, hash: string): Promise<void> {
	if (dc.readyState !== "open") {
		const { promise, resolve } = Promise.withResolvers<void>();
		const sub = dc.stateChanged.subscribe((state) => {
			if (state === "open") resolve();
		});
		await promise;
		sub.unSubscribe();
	}
	const file = Bun.file(blobPath(hash));
	dc.send(JSON.stringify({ size: file.size }));
	dc.bufferedAmountLowThreshold = 1024 * 1024;
	const reader = file.stream().getReader();
	let pending = new Uint8Array(0);
	for (;;) {
		const { value, done } = await reader.read();
		if (value) {
			const joined = new Uint8Array(pending.byteLength + value.byteLength);
			joined.set(pending);
			joined.set(value, pending.byteLength);
			pending = joined;
		}
		while (pending.byteLength >= CHUNK || (done && pending.byteLength > 0)) {
			const n = Math.min(CHUNK, pending.byteLength);
			if (dc.bufferedAmount > 4 * 1024 * 1024) {
				const { promise, resolve } = Promise.withResolvers<void>();
				const sub = dc.bufferedAmountLow.subscribe(() => resolve());
				await promise;
				sub.unSubscribe();
			}
			dc.send(Buffer.from(pending.subarray(0, n)));
			pending = pending.subarray(n);
		}
		if (done) break;
	}
}

// ── Fetching ─────────────────────────────────────────────────────

const inflight = new Map<string, Promise<void>>();

/** The requester's side: offer to one holder, receive and verify the bytes. */
async function fetchFrom(holder: string, hash: string): Promise<void> {
	if (!peer) throw new Error("File peer is not running.");
	const sid = crypto.randomUUID();
	const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
	const dc = pc.createDataChannel("blob");
	const tmp = `${blobPath(hash)}.part-${sid}`;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let idle = setTimeout(() => reject(new Error("timed out")), IDLE_MS);
	const touch = () => {
		clearTimeout(idle);
		idle = setTimeout(() => reject(new Error("stalled")), IDLE_MS);
	};
	answers.set(sid, (s) => {
		touch();
		if (s.t === "missing") reject(new Error("does not have it"));
		else if (s.t === "answer") void pc.setRemoteDescription({ type: "answer", sdp: s.sdp }).catch(reject);
	});
	mkdirSync(blobDir(), { recursive: true });
	const writer = Bun.file(tmp).writer();
	const hasher = new Bun.CryptoHasher("sha256");
	let size = -1;
	let got = 0;
	dc.onMessage.subscribe((m) => {
		touch();
		if (typeof m === "string") {
			size = (JSON.parse(m) as { size: number }).size;
		} else {
			hasher.update(m);
			writer.write(m);
			got += m.byteLength;
		}
		if (size >= 0 && got >= size) resolve();
	});
	try {
		await pc.setLocalDescription(await pc.createOffer());
		await gathered(pc);
		await signal({ v: 1, t: "offer", sid, from: peer.me, to: holder, hash, sdp: pc.localDescription!.sdp });
		await promise;
		await writer.end();
		if (hasher.digest("hex") !== hash) throw new Error("sent bytes that do not match the file");
		renameSync(tmp, blobPath(hash));
	} catch (err) {
		await Promise.resolve(writer.end()).catch(() => {});
		rmSync(tmp, { force: true });
		throw err;
	} finally {
		clearTimeout(idle);
		answers.delete(sid);
		void pc.close();
	}
}

/**
 * Make sure this computer holds the bytes, fetching them from a computer in
 * `available_on` if not. Throws (and records the File's `error`) when no
 * holder answers.
 */
export async function ensureBlob(hash: string): Promise<void> {
	if (!HASH_RE.test(hash)) throw new Error("Not a file hash.");
	if (await hasBlob(hash)) return;
	const running = inflight.get(hash);
	if (running) return running;
	const job = (async () => {
		const me = await machineId();
		const rows = await fileObjects(hash);
		if (rows.length === 0) throw new Error("No File object names these bytes.");
		const others = [...new Set(rows.flatMap(holders))].filter((m) => m !== me);
		const names = new Map((await machines()).map((m) => [m.machineId, m.name]));
		const label = (m: string) => names.get(m) || m.slice(0, 8);
		if (others.length === 0) {
			const error = "No computer holds this file.";
			await markError(hash, error);
			throw new Error(error);
		}
		const failures: string[] = [];
		for (const holder of others) {
			try {
				await fetchFrom(holder, hash);
				await markHeld(hash);
				console.log(`[files] fetched ${hash.slice(0, 12)} from ${label(holder)}`);
				return;
			} catch (err) {
				failures.push(`${label(holder)} ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		const error = `No computer holding this file answered: ${failures.join("; ")}.`;
		await markError(hash, error);
		throw new Error(error);
	})().finally(() => inflight.delete(hash));
	inflight.set(hash, job);
	return job;
}

/** Listen for introductions from the owner's other computers. */
export async function startFilePeer(): Promise<void> {
	const id = await loadIdentity();
	if (!id || id.relays.length === 0) {
		console.log("[files] no nostr identity or relays - peer-to-peer files disabled");
		return;
	}
	const pool = new SimplePool();
	peer = { id, pool, me: await machineId() };
	pool.subscribeMany(id.relays, { kinds: [SIGNAL_KIND], authors: [id.pk], "#t": [SIGNAL_TAG], since: Math.floor(Date.now() / 1000) - 5 }, {
		onevent: (event) => void onSignal(event),
	});
	console.log("[files] peer-to-peer files listening");
}
