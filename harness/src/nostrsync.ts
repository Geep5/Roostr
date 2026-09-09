/**
 * Nostr sync daemon — the transport between your devices. Design from the
 * original phase-4 research:
 *
 *   - ONE event per change: kind 1078 (regular — relays store all), content
 *     = NIP-44 self-encryption of the raw change bytes (base64). Event ids
 *     are relay-side dedup; change ids (content addresses) are local dedup.
 *   - "h" tag = HMAC-style blinded object id (sha256(privkey || objectId)
 *     prefix) so per-object filtering works without leaking real ids.
 *   - Keyring: kind 30078 replaceable event (d="roostr-keyring") carrying
 *     NIP-44 self-encrypted channel-keys.json, merged by union on receipt.
 *   - Relays are transport, not truth: the .pb files stay canonical; the
 *     local Odin server imports idempotently and rejects bad addresses.
 *
 * Loop: startup backfill (relay since=cursor → import; manifest → publish
 * unpublished) then live (SSE commit → publish; relay event → import).
 */

import { SimplePool, finalizeEvent, getPublicKey, nip19, nip44, verifyEvent, type Event, type Filter } from "nostr-tools";
import { unwrapEvent, wrapEvent } from "nostr-tools/nip59";
import { API, apiFetch, subscribe } from "./api";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";

const CHANGE_KIND = 1078;
/** NIP-59 gift wrap: space-key invites and join requests, addressed by npub. */
const WRAP_KIND = 1059;
const INVITE_RUMOR_KIND = 24891;
const JOINREQ_RUMOR_KIND = 24892;
/** Gift wraps randomize created_at up to ~2 days back; look back further. */
const WRAP_LOOKBACK_S = 3 * 86_400;
const KEYRING_KIND = 30078;
const KEYRING_D = "roostr-keyring";
/** NIP-09 deletion request. Advisory: relays SHOULD honour it, MAY ignore it. */
const DELETE_KIND = 5;
/** `e` tags per deletion request — relays cap event size, so batch. */
const DELETE_BATCH = 400;
/** The synced vanish ledger (see src/vanish.odin); never published as data to delete. */
const VANISH_LOG_ID = "__vanished__";

function dataRoot(): string {
	return process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
}

interface SyncState {
	version: 1;
	/** change hex ids already published (or seen from relays). */
	published: Record<string, true>;
	/** newest relay event created_at we've processed, per subscription. */
	cursor: number;
	/** Inclusive replay floor retained for fragments or failed native imports. */
	replaySince?: number;
	/** Unresolved group identity -> earliest fragment, retained across buffer loss/restarts. */
	pendingChunkGroups?: Record<string, number>;
	/** object ids we have already asked the relays to delete (NIP-09). */
	vanishRequested: Record<string, true>;
	/** Version 2 completion requires a successful scan and deletion on every relay. */
	vanishScanVersion?: 2;
	/** "spaceId/keyId/changeHex" published under space-key encryption. */
	publishedSpace?: Record<string, true>;
	/** spaceId -> keyId whose full history has been (re)queued shared. */
	sharedQueued?: Record<string, number>;
	/** "spaceId/memberHex" -> keyId already gift-wrapped to that member. */
	invitesSent?: Record<string, number>;
	/** gift-wrap event ids already processed. */
	wrapsSeen?: Record<string, true>;
}

function statePath(): string {
	return `${dataRoot()}/sync-state.json`;
}

async function readState(): Promise<SyncState> {
	try {
		const parsed = (await Bun.file(statePath()).json()) as SyncState;
		if (parsed?.version === 1) return { ...parsed, pendingChunkGroups: parsed.pendingChunkGroups ?? {}, vanishScanVersion: 2, vanishRequested: parsed.vanishScanVersion === 2 ? (parsed.vanishRequested ?? {}) : {}, publishedSpace: parsed.publishedSpace ?? {}, sharedQueued: parsed.sharedQueued ?? {}, invitesSent: parsed.invitesSent ?? {}, wrapsSeen: parsed.wrapsSeen ?? {} };
	} catch {
		/* fresh */
	}
	return { version: 1, published: {}, cursor: 0, pendingChunkGroups: {}, vanishScanVersion: 2, vanishRequested: {}, publishedSpace: {}, sharedQueued: {}, invitesSent: {}, wrapsSeen: {} };
}

function writeState(state: SyncState): void {
	const tmp = `${statePath()}.tmp`;
	mkdirSync(dataRoot(), { recursive: true });
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, statePath());
}

// ── Join requests ────────────────────────────────────────────────
//
// A join link (r2, no key inside) lets anyone SEND a request; it lands
// here as a gift wrap and waits for the owner's explicit approval in
// space settings. Own file so UI clears never race the sync state.

export interface JoinRequest {
	/** "spaceId/requesterHex" - stable dedupe key. */
	key: string;
	space: string;
	spaceName: string;
	requester: string;
	requesterNpub: string;
	/** kind-0 profile at request time, when the relays had one. */
	name?: string;
	picture?: string;
	at: number;
}

export interface SpaceJoinLink {
	v: 2;
	t: "space-join";
	space: string;
	name?: string;
	owner: string;
	relays: string[];
}

/** Send the same NIP-59 request as the browser, using only the service identity. */
export async function sendJoinRequest(input: SpaceJoinLink): Promise<void> {
	if (!input || typeof input !== "object" || input.v !== 2 || input.t !== "space-join") throw new Error("Invalid space join link");
	if (typeof input.space !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(input.space)) throw new Error("Invalid space id in join link");
	if (input.name !== undefined && typeof input.name !== "string") throw new Error("Invalid space name in join link");
	if (typeof input.owner !== "string") throw new Error("Invalid owner npub in join link");
	let ownerHex: string;
	try {
		const owner = nip19.decode(input.owner.trim());
		if (owner.type !== "npub") throw new Error("Expected npub");
		ownerHex = owner.data;
	} catch {
		throw new Error("Invalid owner npub in join link");
	}
	if (!Array.isArray(input.relays) || input.relays.length > 32) throw new Error("Invalid relay list in join link");
	const identity = await loadIdentity();
	if (!identity) throw new Error("No local identity configured");
	const relays = new Set<string>();
	for (const value of input.relays.length > 0 ? input.relays : identity.relays) {
		if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid relay URL in join link");
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error("Invalid relay URL in join link");
		}
		if ((url.protocol !== "wss:" && url.protocol !== "ws:") || !url.hostname || url.username || url.password || url.hash) throw new Error("Relay URL must use ws or wss without credentials or fragments");
		relays.add(url.toString());
	}
	if (relays.size === 0) throw new Error("No relays configured for the join request");
	const targets = [...relays];
	const pool = new SimplePool();
	try {
		const wrap = wrapEvent(
			{ kind: JOINREQ_RUMOR_KIND, tags: [], content: JSON.stringify({ t: "join-request", space: input.space }) },
			identity.sk,
			ownerHex,
		);
		await Promise.any(pool.publish(targets, wrap));
	} finally {
		pool.close(targets);
	}
}

function joinReqPath(): string {
	return `${dataRoot()}/join-requests.json`;
}

export async function listJoinRequests(): Promise<JoinRequest[]> {
	try {
		const parsed = (await Bun.file(joinReqPath()).json()) as { requests?: JoinRequest[] };
		return parsed.requests ?? [];
	} catch {
		return [];
	}
}

async function writeJoinRequests(requests: JoinRequest[]): Promise<void> {
	const tmp = `${joinReqPath()}.tmp`;
	mkdirSync(dataRoot(), { recursive: true });
	writeFileSync(tmp, JSON.stringify({ requests }));
	renameSync(tmp, joinReqPath());
}

export async function clearJoinRequest(key: string): Promise<void> {
	await writeJoinRequests((await listJoinRequests()).filter((r) => r.key !== key));
}

async function recordJoinRequest(r: Omit<JoinRequest, "key">): Promise<void> {
	const key = `${r.space}/${r.requester}`;
	const rest = (await listJoinRequests()).filter((x) => x.key !== key);
	rest.push({ ...r, key });
	await writeJoinRequests(rest);
}

interface Identity {
	sk: Uint8Array;
	pk: string;
	identityHash: string;
	conversationKey: Uint8Array;
	relays: string[];
}

async function loadIdentity(): Promise<Identity | null> {
	try {
		const parsed = (await Bun.file(`${dataRoot()}/nostr.json`).json()) as { privkey?: string; relays?: string[] };
		if (!parsed.privkey || parsed.privkey.length !== 64) return null;
		const sk = Uint8Array.from(Buffer.from(parsed.privkey, "hex"));
		const pk = getPublicKey(sk);
		const identityHasher = new Bun.CryptoHasher("sha256");
		identityHasher.update(sk);
		return {
			sk,
			pk,
			identityHash: identityHasher.digest("hex"),
			// Self-encryption: conversation key with our own pubkey.
			conversationKey: nip44.getConversationKey(sk, pk),
			relays: parsed.relays ?? [],
		};
	} catch {
		return null;
	}
}

/** Blinded object tag: stable per (key, object), unlinkable without the key. */
function blindObjectId(id: Identity, objectId: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(id.sk);
	h.update(objectId);
	return h.digest("hex").slice(0, 16);
}

// ── Shared spaces ────────────────────────────────────────────────
//
// A space with a key AND (members OR an imported owner) syncs under the
// SPACE key instead of self-encryption: content = nip44 with the raw
// 32-byte space key as conversation key; tags = blinded (spaceKey,
// objectId) plus a space-stream tag blinded (spaceKey, "space:"+id) so
// a joiner can pull the whole space with one #h filter and no object
// enumeration. Writers = owner + members with a non-viewer role;
// events from anyone else are ignored on receipt and refused by the
// relay via the kind-30100 allowlist the owner publishes.

const ALLOWLIST_KIND = 30100;
const ALLOWLIST_D = "roostr-allowlist";

interface SharedSpace {
	spaceId: string;
	keyHex: string;
	keyId: number;
	convKey: Uint8Array;
	spaceTag: string;
	/** hex pubkeys allowed to author events for this space. */
	writers: Set<string>;
	/** set on imported entries: the admin's hex pubkey. */
	owner?: string;
}

function blindShared(keyHex: string, id: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(keyHex);
	h.update(id);
	return h.digest("hex").slice(0, 16);
}

function npubToHex(npub: string): string | null {
	try {
		const d = nip19.decode(npub.trim());
		if (d.type === "npub") return d.data as string;
	} catch {
		/* bad npub */
	}
	const t = npub.trim().toLowerCase();
	return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

async function loadSharedSpaces(identity: Identity): Promise<Map<string, SharedSpace>> {
	const myPk = identity.pk;
	const out = new Map<string, SharedSpace>();
	let keyring: { localPubkey?: string; localIdentityHash?: string; channels?: Record<string, { key?: string; keyId?: number; owner?: string }> } = {};
	try {
		keyring = (await Bun.file(`${dataRoot()}/channel-keys.json`).json()) as typeof keyring;
	} catch {
		return out;
	}
	if (keyring.localPubkey !== myPk || keyring.localIdentityHash !== identity.identityHash) {
		keyring.localPubkey = myPk;
		keyring.localIdentityHash = identity.identityHash;
		const path = `${dataRoot()}/channel-keys.json`;
		writeFileSync(`${path}.tmp`, JSON.stringify(keyring), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	}
	for (const [spaceId, entry] of Object.entries(keyring.channels ?? {})) {
		if (!entry.key || !/^[0-9a-f]{64}$/i.test(entry.key) || !Number.isSafeInteger(entry.keyId ?? 1) || (entry.keyId ?? 1) < 1) continue;
		const writers = new Set<string>([entry.owner ?? myPk]);
		let memberCount = 0;
		try {
			const obj = (await (await apiFetch(`${API}/api/objects/${spaceId}`)).json()) as {
				fields?: Record<string, { valuesValue?: { items?: Array<{ mapValue?: { entries?: Record<string, { stringValue?: string }> } }> } }>;
			};
			const items = obj.fields?.["members"]?.valuesValue?.items ?? [];
			for (const item of items) {
				const entries = item.mapValue?.entries ?? {};
				const npub = entries["npub"]?.stringValue ?? "";
				const role = entries["role"]?.stringValue ?? "writer";
				const hex = npubToHex(npub);
				if (hex) {
					memberCount++;
					if (role !== "viewer") writers.add(hex);
				}
			}
		} catch {
			/* space object not local (yet) - imported spaces start this way */
		}
		if (memberCount === 0 && !entry.owner) continue; // personal space - self path
		out.set(spaceId, {
			spaceId,
			keyHex: entry.key,
			keyId: entry.keyId ?? 1,
			convKey: Uint8Array.from(Buffer.from(entry.key, "hex")),
			spaceTag: blindShared(entry.key, `space:${spaceId}`),
			writers,
			owner: entry.owner,
		});
	}
	return out;
}

/** objectId -> owning space id ("" when unassigned). Channels own themselves. */
async function loadSpaceMap(): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	try {
		const objs = (await (await apiFetch(`${API}/api/objects`)).json()) as Array<{ id: string; typeKey?: string; channelId?: string }>;
		for (const o of objs) out.set(o.id, o.typeKey === "channel" ? o.id : (o.channelId ?? ""));
	} catch {
		/* daemon down; publish falls back to self path */
	}
	return out;
}

// ── Local server I/O ─────────────────────────────────────────────

async function localManifest(): Promise<Record<string, string[]>> {
	const res = await apiFetch(`${API}/api/changes`);
	return (await res.json()) as Record<string, string[]>;
}

async function localChanges(objectId: string): Promise<Array<{ id: string; b64: string }>> {
	const res = await apiFetch(`${API}/api/changes/${objectId}`);
	const out = (await res.json()) as { changes: Array<{ id: string; b64: string }> };
	return out.changes;
}

interface SharedProvenance {
	spaceId: string;
	keyId: number;
	signer: string;
}

async function localImport(b64s: string[], provenance?: SharedProvenance): Promise<{ imported: number; rejected: number; ids: string[] }> {
	const res = await apiFetch(`${API}/api/changes`, { method: "POST", body: JSON.stringify({ changes: b64s, provenance }) });
	if (!res.ok) throw new Error(`Change import failed: ${res.status}`);
	return (await res.json()) as { imported: number; rejected: number; ids: string[] };
}

/** Object ids the local ledger says are vanished (src/vanish.odin). */
async function localVanished(): Promise<Set<string>> {
	try {
		const res = await apiFetch(`${API}/api/vanished`);
		const out = (await res.json()) as { vanished: Array<{ objectId: string }> };
		return new Set(out.vanished.map((v) => v.objectId));
	} catch {
		return new Set();
	}
}

// ── NIP-09: ask the relays to drop an object's events ────────────
//
// The event ids are not derivable locally: NIP-44 picks a fresh random
// nonce per encryption, so the same change published twice has two
// different ciphertexts and two different event ids, and we never stored
// them. They have to be read back from the relays — which the blinded
// "h" tags make exact, without revealing any object id.

/** `#h` values per filter: one round trip covers this many objects. */
const HTAG_BATCH = 100;

// 128 maximum-sized 40k-character NIP-44 chunks fit the relay's 8 MiB
// response budget; a 500-event page can exceed it during code/history import.
const HISTORY_PAGE_SIZE = 128;

/** Unlike querySync, a failed subscription is not a successful empty page. */
async function relayHistoryPage(pool: SimplePool, relay: string, filter: Filter): Promise<Event[]> {
	const connection = await pool.ensureRelay(relay, { connectionTimeout: 15_000 });
	return new Promise<Event[]>((resolve, reject) => {
		const events: Event[] = [];
		let settled = false;
		let sub: { close(): void } | undefined;
		const finish = (ok: boolean, close = true) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (ok) resolve(events);
			else reject(new Error("Relay history scan incomplete"));
			if (close) sub?.close();
		};
		const timer = setTimeout(() => finish(false), 15_000);
		try {
			sub = connection.subscribe([filter], {
				onevent: (event) => events.push(event),
				oneose: () => finish(true),
				onclose: () => finish(false, false),
				// nostr-tools synthesizes EOSE on timeout; ours closes first.
				eoseTimeout: 60_000,
			});
		} catch {
			finish(false);
		}
	});
}

/** Every relay/filter has its own cursor; merging pages before advancing loses events. */
async function scanRelayHistory(pool: SimplePool, relays: string[], filters: Filter[], receive: (event: Event) => void): Promise<boolean> {
	let complete = relays.length > 0;
	await Promise.all(relays.map(async (relay) => {
		for (const filter of filters) {
			let until: number | undefined;
			try {
				for (;;) {
					const page = await relayHistoryPage(pool, relay, { ...filter, until, limit: HISTORY_PAGE_SIZE });
					for (const event of page) receive(event);
					if (page.length < HISTORY_PAGE_SIZE) break;
					const oldest = Math.min(...page.map((event) => event.created_at));
					if (until !== undefined && oldest >= until) {
						// Nostr has no event-id continuation token. A saturated second
						// cannot be skipped without silently dropping unknown events.
						throw new Error(`History capped within timestamp ${oldest}; replay remains pending`);
					}
					until = oldest;
				}
			} catch (error) {
				complete = false;
				console.warn(`[sync] incomplete history from ${relay}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}));
	return complete;
}

async function collectEventIds(pool: SimplePool, id: Identity, objectIds: string[]): Promise<{ eventIds: string[]; complete: boolean }> {
	const found = new Set<string>();
	const spaces = await loadSharedSpaces(id);
	const allTags = new Set<string>();
	for (const objectId of objectIds) {
		allTags.add(blindObjectId(id, objectId));
		for (const space of spaces.values()) allTags.add(blindShared(space.keyHex, objectId));
	}
	const tagList = [...allTags];
	const filters: Filter[] = [];
	for (let i = 0; i < tagList.length; i += HTAG_BATCH) {
		filters.push({ kinds: [CHANGE_KIND], authors: [id.pk], "#h": tagList.slice(i, i + HTAG_BATCH) });
	}
	const complete = await scanRelayHistory(pool, id.relays, filters, (event) => found.add(event.id));
	return { eventIds: [...found], complete };
}

/** Count requests accepted somewhere; completion requires every relay to accept every batch. */
async function publishDeleteRequests(pool: SimplePool, id: Identity, eventIds: string[], reason: string): Promise<{ requests: number; complete: boolean }> {
	let sent = 0;
	let complete = id.relays.length > 0;
	for (let i = 0; i < eventIds.length; i += DELETE_BATCH) {
		const batch = eventIds.slice(i, i + DELETE_BATCH);
		const event = finalizeEvent(
			{
				kind: DELETE_KIND,
				created_at: Math.floor(Date.now() / 1000),
				tags: [...batch.map((eid) => ["e", eid]), ["k", String(CHANGE_KIND)]],
				content: reason,
			},
			id.sk,
		);
		const results = await Promise.allSettled(pool.publish(id.relays, event));
		if (results.some((result) => result.status === "fulfilled")) sent++;
		if (results.length !== id.relays.length || results.some((result) => result.status === "rejected")) complete = false;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 120);
		await promise;
	}
	return { requests: sent, complete };
}

// ── Sync engine ──────────────────────────────────────────────────

export async function startNostrSync(): Promise<void> {
	const id = await loadIdentity();
	if (!id) {
		console.log("[sync] no nostr key — sync disabled");
		return;
	}
	if (id.relays.length === 0) {
		console.log("[sync] no relays configured — sync disabled (add relays in Settings)");
		return;
	}

	let pool = new SimplePool();
	const state = await readState();
	let dirty = false;
	const persist = () => {
		if (!dirty) return;
		writeState(state);
		dirty = false;
	};
	setInterval(persist, 5000);

	// Vanished objects (src/vanish.odin) are never published, and their
	// relay copies are chased with NIP-09 requests. Refreshed whenever the
	// ledger object commits.
	let vanished = await localVanished();

	// ── Paced publish queue ────────────────────────────────────────
	//
	// Public relays rate-limit bursts (a fresh node pushes its whole
	// corpus). One event every PUBLISH_SPACING_MS; failures re-queue with
	// exponential backoff and are never dropped — publish is eventually
	// durable as long as the daemon lives.
	const PUBLISH_SPACING_MS = 120;
	interface QueueItem {
		objectId: string;
		changeHex: string;
		b64: string;
		attempts: number;
		notBefore: number;
		/** present = publish under this space's key instead of self. */
		space?: SharedSpace;
	}
	const queue: QueueItem[] = [];
	const queued = new Set<string>();
	let failuresLogged = 0;

	/** Live shared-space view; refreshed on startup and space commits. */
	let sharedSpaces = new Map<string, SharedSpace>();
	let spaceMap = new Map<string, string>();

	function spaceKeyFor(item: QueueItem): string {
		return item.space ? `${item.space.spaceId}/${item.space.keyId}/${item.changeHex}` : item.changeHex;
	}

	function enqueue(objectId: string, changeHex: string, b64: string): void {
		if (vanished.has(objectId)) return;
		const space = sharedSpaces.get(spaceMap.get(objectId) ?? "");
		const doneKey = space ? `${space.spaceId}/${space.keyId}/${changeHex}` : changeHex;
		const done = space ? state.publishedSpace![doneKey] : state.published[changeHex];
		if (done || queued.has(doneKey)) return;
		queued.add(doneKey);
		queue.push({ objectId, changeHex, b64, attempts: 0, notBefore: 0, space });
	}

	/** Retry until every configured relay was scanned and accepted every deletion batch. */
	let vanishBusy = false;
	async function chaseVanished(): Promise<void> {
		if (vanishBusy) return;
		const pending = [...vanished].filter((objectId) => !state.vanishRequested[objectId]);
		if (pending.length === 0) return;
		vanishBusy = true;
		try {
			const scan = await collectEventIds(pool, id!, pending);
			const deletion = await publishDeleteRequests(pool, id!, scan.eventIds, "object vanished by its owner");
			console.log(`[sync] vanish: ${pending.length} object(s), ${scan.eventIds.length} relay event(s), ${deletion.requests} delete request(s)`);
			if (scan.complete && deletion.complete) {
				for (const objectId of pending) state.vanishRequested[objectId] = true;
				dirty = true;
			}
		} finally {
			vanishBusy = false;
		}
	}

	/** Relay + NIP-44 limits: chunk big changes into ≤CHUNK_CHARS parts.
	 * Group id is content-derived so retries republish identical parts and
	 * the receiver dedupes naturally. */
	const CHUNK_CHARS = 40_000;

	function chunkGroupId(b64: string): string {
		const h = new Bun.CryptoHasher("sha256");
		h.update(b64);
		return h.digest("hex").slice(0, 16);
	}

	async function publishOnce(item: QueueItem): Promise<boolean> {
		const parts: string[] = [];
		for (let i = 0; i < item.b64.length; i += CHUNK_CHARS) parts.push(item.b64.slice(i, i + CHUNK_CHARS));
		const gid = parts.length > 1 ? chunkGroupId(item.b64) : "";
		try {
			for (let i = 0; i < parts.length; i++) {
				const tags: string[][] = item.space
					? [["h", blindShared(item.space.keyHex, item.objectId)], ["h", item.space.spaceTag]]
					: [["h", blindObjectId(id!, item.objectId)]];
				if (gid) tags.push(["c", gid, String(i), String(parts.length)]);
				const event = finalizeEvent(
					{
						kind: CHANGE_KIND,
						created_at: Math.floor(Date.now() / 1000),
						tags,
						content: nip44.encrypt(parts[i], item.space ? item.space.convKey : id!.conversationKey),
					},
					id!.sk,
				);
				await Promise.any(pool.publish(id!.relays, event));
				if (parts.length > 1 && i < parts.length - 1) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, PUBLISH_SPACING_MS);
					await promise;
				}
			}
			return true;
		} catch (err) {
			if (failuresLogged < 5) {
				failuresLogged++;
				const reasons = err instanceof AggregateError ? err.errors.map((e) => String(e).slice(0, 80)).join(" | ") : String(err).slice(0, 120);
				console.error(`[sync] publish rejected (attempt ${item.attempts + 1}): ${reasons}`);
			}
			return false;
		}
	}

	void (async () => {
		for (;;) {
			const now = Date.now();
			const idx = queue.findIndex((q) => q.notBefore <= now);
			if (idx === -1) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, 500);
				await promise;
				continue;
			}
			const [item] = queue.splice(idx, 1);
			const doneKey = spaceKeyFor(item);
			// A vanish can land while the change is already queued (or mid-backoff).
			const already = item.space ? state.publishedSpace![doneKey] : state.published[item.changeHex];
			if (already || vanished.has(item.objectId)) {
				queued.delete(doneKey);
				continue;
			}
			if (await publishOnce(item)) {
				if (item.space) state.publishedSpace![doneKey] = true;
				else state.published[item.changeHex] = true;
				queued.delete(doneKey);
				dirty = true;
			} else {
				item.attempts++;
				item.notBefore = Date.now() + Math.min(300_000, 2000 * 2 ** item.attempts);
				queue.push(item);
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, PUBLISH_SPACING_MS);
			await promise;
		}
	})();

	async function publishObject(objectId: string): Promise<void> {
		try {
			const changes = await localChanges(objectId);
			for (const c of changes) enqueue(objectId, c.id, c.b64);
		} catch (err) {
			console.error(`[sync] enqueue failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}

	/** Only bounded, short-lived transport fragments live here; canonical events have no TTL. */
	const MAX_CHUNK_GROUPS = 128;
	const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
	const CHUNK_TTL_MS = 5 * 60_000;
	const chunkGroups = new Map<string, { total: number; parts: Map<number, string>; bytes: number; expires: number; since: number }>();
	let chunkBytes = 0;
	function dropChunkGroup(key: string): void {
		const group = chunkGroups.get(key);
		if (!group) return;
		chunkBytes -= group.bytes;
		chunkGroups.delete(key);
	}
	function expireChunkGroups(): void {
		const now = Date.now();
		for (const [key, group] of chunkGroups) {
			if (group.expires > now) continue;
			recordReplayFault(group.since);
			dropChunkGroup(key);
		}
	}
	setInterval(expireChunkGroups, 60_000);

	async function importB64(b64: string, space: SharedSpace | null, signer: string): Promise<void> {
		const provenance = space ? { spaceId: space.spaceId, keyId: space.keyId, signer } : undefined;
		const res = await localImport([b64], provenance);
		if (res.rejected > 0) throw new Error("Change import rejected");
		// Anything the relay already holds must never be echoed back.
		for (const hex of res.ids) {
			if (space) state.publishedSpace![`${space.spaceId}/${space.keyId}/${hex}`] = true;
			else state.published[hex] = true;
		}
		dirty = true;
	}

	/** Try self key, then every shared-space key. */
	function decryptEvent(event: Event): { part: string; space: SharedSpace | null } | null {
		if (event.pubkey === id!.pk) {
			try {
				return { part: nip44.decrypt(event.content, id!.conversationKey), space: null };
			} catch {
				/* not self-encrypted */
			}
		}
		for (const space of sharedSpaces.values()) {
			if (!event.tags.some((tag) => tag[0] === "h" && tag[1] === space.spaceTag)) continue;
			try {
				const part = nip44.decrypt(event.content, space.convKey);
				// Writer gate: a viewer (or stranger holding a leaked key)
				// can encrypt valid events - drop anything not authored by
				// an allowed writer of this space.
				if (!space.writers.has(event.pubkey)) return null;
				return { part, space };
			} catch {
				/* next key */
			}
		}
		return null;
	}

	function retainReplaySince(createdAt: number): void {
		if (state.replaySince === undefined || createdAt < state.replaySince) {
			state.replaySince = createdAt;
			dirty = true;
		}
	}

	let replayFaultGeneration = 0;
	let replayScanGeneration = 0;
	let activeReplayScans = 0;
	let activeImports = 0;
	// Like published change IDs, receipt identities live for this daemon's
	// lifetime. Expiring one could turn an inclusive-cursor suffix replay
	// into an unresolved group whose prefix is outside the requested range.
	const completedChunkGroups = new Set<string>();
	function recordReplayFault(since: number): void {
		replayFaultGeneration++;
		retainReplaySince(since);
	}
	interface ReplayScan {
		since: number;
		faults: number;
		generation: number;
	}
	function beginReplayScan(since: number): ReplayScan {
		// Persist the in-flight range too: a crash must not advance past it.
		retainReplaySince(since);
		activeReplayScans++;
		return { since, faults: replayFaultGeneration, generation: ++replayScanGeneration };
	}
	function finishReplayScan(scan: ReplayScan, complete: boolean, allStreams: boolean): void {
		activeReplayScans--;
		if (!complete) recordReplayFault(scan.since);
		expireChunkGroups();
		// A partial-space scan cannot retire the global floor. Neither can a
		// scan overtaken by another scan, new faults, imports, or older gaps.
		if (!complete || !allStreams || activeReplayScans > 0 || activeImports > 0 || chunkGroups.size > 0
			|| Object.keys(state.pendingChunkGroups!).length > 0
			|| scan.generation !== replayScanGeneration || scan.faults !== replayFaultGeneration
			|| state.replaySince === undefined || scan.since > state.replaySince) return;
		delete state.replaySince;
		dirty = true;
	}

	async function onRelayEvent(event: Event): Promise<void> {
		let importing = false;
		activeImports++;
		try {
			if (event.kind !== CHANGE_KIND || !verifyEvent(event)) return;
			const dec = decryptEvent(event);
			if (!dec) return;
			const { part, space } = dec;
			const chunkTags = event.tags.filter((t) => t[0] === "c");
			if (chunkTags.length > 1) return;
			if (chunkTags.length === 0) {
				importing = true;
				await importB64(part, space, event.pubkey);
			} else {
				const [, gid, idxStr, totalStr] = chunkTags[0];
				if (!gid || !/^[0-9a-f]{16}$/.test(gid) || !/^(0|[1-9][0-9]*)$/.test(idxStr ?? "") || !/^[1-9][0-9]*$/.test(totalStr ?? "")) return;
				const index = Number(idxStr);
				const total = Number(totalStr);
				if (!Number.isSafeInteger(total) || total < 2 || total > 64 || !Number.isSafeInteger(index) || index >= total) return;
				if (part.length === 0 || part.length > CHUNK_CHARS || !/^[A-Za-z0-9+/=]+$/.test(part)) return;
				const groupKey = JSON.stringify([event.pubkey, space?.spaceId ?? null, space?.keyId ?? null, gid]);
				if (completedChunkGroups.has(groupKey)) {
					if (event.created_at > state.cursor) {
						state.cursor = event.created_at;
						dirty = true;
					}
					return;
				}
				// Eviction/expiry never implies receipt: keep the durable replay floor.
				retainReplaySince(event.created_at);
				const pendingSince = state.pendingChunkGroups![groupKey];
				if (pendingSince === undefined || event.created_at < pendingSince) {
					state.pendingChunkGroups![groupKey] = event.created_at;
					dirty = true;
				}
				expireChunkGroups();
				let group = chunkGroups.get(groupKey);
				if (group && (group.total !== total || (group.parts.has(index) && group.parts.get(index) !== part))) {
					recordReplayFault(Math.min(group.since, event.created_at));
					dropChunkGroup(groupKey);
					return;
				}
				if (!group) {
					if (chunkGroups.size >= MAX_CHUNK_GROUPS || chunkBytes + part.length > MAX_CHUNK_BYTES) {
						recordReplayFault(event.created_at);
						return;
					}
					group = { total, parts: new Map(), bytes: 0, expires: Date.now() + CHUNK_TTL_MS, since: event.created_at };
					chunkGroups.set(groupKey, group);
				}
				group.since = Math.min(group.since, event.created_at);
				if (!group.parts.has(index)) {
					if (chunkBytes + part.length > MAX_CHUNK_BYTES) {
						recordReplayFault(group.since);
						return;
					}
					group.parts.set(index, part);
					group.bytes += part.length;
					chunkBytes += part.length;
				}
				if (group.parts.size !== group.total) return;
				const parts: string[] = [];
				for (let i = 0; i < group.total; i++) parts.push(group.parts.get(i)!);
				const full = parts.join("");
				if (chunkGroupId(full) !== gid) {
					recordReplayFault(group.since);
					dropChunkGroup(groupKey);
					return;
				}
				importing = true;
				try {
					await importB64(full, space, event.pubkey);
					if (chunkGroups.get(groupKey) === group) {
						completedChunkGroups.add(groupKey);
						delete state.pendingChunkGroups![groupKey];
						dirty = true;
					}
				} finally {
					// A concurrent expiry/conflict may have replaced this group while
					// native import awaited; do not discard its pending fragments.
					if (chunkGroups.get(groupKey) === group) dropChunkGroup(groupKey);
				}
			}
			if (event.created_at > state.cursor) {
				state.cursor = event.created_at;
				dirty = true;
			}
		} catch {
			if (importing) recordReplayFault(event.created_at);
			/* not ours / garbled / unavailable native import — leave unpublished */
		} finally {
			activeImports--;
		}
	}

	// ── Keyring (channel keys) ─────────────────────────────────────
	const keyringPath = `${dataRoot()}/channel-keys.json`;

	async function publishKeyring(): Promise<void> {
		try {
			const raw = await Bun.file(keyringPath).text();
			const event = finalizeEvent(
				{
					kind: KEYRING_KIND,
					created_at: Math.floor(Date.now() / 1000),
					tags: [["d", KEYRING_D]],
					content: nip44.encrypt(raw, id!.conversationKey),
				},
				id!.sk,
			);
			await Promise.any(pool.publish(id!.relays, event));
		} catch {
			/* no keyring yet */
		}
	}

	async function mergeKeyring(event: Event): Promise<void> {
		try {
			if (event.pubkey !== id!.pk || !verifyEvent(event)) return;
			const remote = JSON.parse(nip44.decrypt(event.content, id!.conversationKey)) as { channels?: Record<string, unknown> };
			let local: { channels?: Record<string, unknown> } = {};
			try {
				local = (await Bun.file(keyringPath).json()) as typeof local;
			} catch {
				/* none yet */
			}
			const merged = { ...local, channels: { ...(remote.channels ?? {}), ...(local.channels ?? {}) } };
			const before = JSON.stringify(local);
			const after = JSON.stringify(merged);
			if (before !== after) {
				writeFileSync(`${keyringPath}.tmp`, after, { mode: 0o600 });
				renameSync(`${keyringPath}.tmp`, keyringPath);
				console.log("[sync] keyring merged from relay");
			}
		} catch {
			/* ignore */
		}
	}

	// ── Shared-space reconcile ─────────────────────────────────────

	async function refreshShared(): Promise<void> {
		spaceMap = await loadSpaceMap();
		sharedSpaces = await loadSharedSpaces(id!);
		// Channel objects are filtered out of /api/objects - map every
		// shared space to itself so its own changes (name, members) ride
		// the space stream too; a joiner needs them.
		for (const spaceId of sharedSpaces.keys()) spaceMap.set(spaceId, spaceId);
	}

	// ── Space invites: gift-wrapped key delivery + join requests ───

	/** ALL member hexes of a space (any role - viewers need the key too). */
	async function spaceMemberHexes(spaceId: string): Promise<string[]> {
		try {
			const obj = (await (await apiFetch(`${API}/api/objects/${spaceId}`)).json()) as {
				fields?: Record<string, { stringValue?: string; valuesValue?: { items?: Array<{ mapValue?: { entries?: Record<string, { stringValue?: string }> } }> } }>;
			};
			const out: string[] = [];
			for (const item of obj.fields?.["members"]?.valuesValue?.items ?? []) {
				const hex = npubToHex(item.mapValue?.entries?.["npub"]?.stringValue ?? "");
				if (hex) out.push(hex);
			}
			return out;
		} catch {
			return [];
		}
	}

	async function spaceNameOf(spaceId: string): Promise<string> {
		try {
			const obj = (await (await apiFetch(`${API}/api/objects/${spaceId}`)).json()) as { fields?: Record<string, { stringValue?: string }> };
			return obj.fields?.["name"]?.stringValue ?? "";
		} catch {
			return "";
		}
	}

	/** Owner duty: every member holds the current key. Adding a member (or
	 * rotating the key) gift-wraps {space, key, keyId} to their npub - the
	 * member's own device imports it and the space appears. Idempotent per
	 * (member, keyId); failures retry on the next reconcile. */
	let inviteFailLogged = 0;
	async function reconcileInvites(): Promise<void> {
		for (const space of sharedSpaces.values()) {
			if (space.owner && space.owner !== id!.pk) continue; // not mine to administer
			const members = await spaceMemberHexes(space.spaceId);
			if (members.length === 0) continue;
			const name = await spaceNameOf(space.spaceId);
			for (const hex of members) {
				if (hex === id!.pk) continue;
				const sentKey = `${space.spaceId}/${hex}`;
				if (state.invitesSent![sentKey] === space.keyId) continue;
				try {
					const wrap = wrapEvent(
						{
							kind: INVITE_RUMOR_KIND,
							tags: [],
							content: JSON.stringify({ t: "space-invite", space: space.spaceId, name, key: space.keyHex, keyId: space.keyId }),
						},
						id!.sk,
						hex,
					);
					await Promise.any(pool.publish(id!.relays, wrap));
					state.invitesSent![sentKey] = space.keyId;
					dirty = true;
					console.log(`[sync] space key #${space.keyId} gift-wrapped to ${hex.slice(0, 8)} for "${name || space.spaceId.slice(0, 8)}"`);
				} catch (err) {
					if (inviteFailLogged < 5) {
						inviteFailLogged++;
						const reasons = err instanceof AggregateError ? err.errors.map((e) => String(e).slice(0, 80)).join(" | ") : String(err).slice(0, 120);
						console.error(`[sync] invite wrap to ${hex.slice(0, 8)} refused: ${reasons}`);
					}
				}
			}
		}
	}

	/** Full backwards pagination of freshly joined space streams. */
	async function backfillSpaceTags(tags: string[]): Promise<void> {
		if (tags.length === 0) return;
		const events = new Map<string, Event>();
		const scan = beginReplayScan(0);
		const complete = await scanRelayHistory(pool, id!.relays, [{ kinds: [CHANGE_KIND], "#h": tags }], (event) => events.set(event.id, event));
		const sorted = [...events.values()].sort((a, b) => a.created_at - b.created_at);
		for (const event of sorted) await onRelayEvent(event);
		finishReplayScan(scan, complete, false);
		if (sorted.length > 0) console.log(`[sync] joined-space backfill: ${sorted.length} event(s)`);
	}

	/** A space key arrived gift-wrapped: import it (newer keyId wins) and
	 * start syncing that space immediately. */
	async function importInviteKey(rumor: { pubkey: string; content: string }): Promise<void> {
		const p = JSON.parse(rumor.content) as { t?: string; space?: string; name?: string; key?: string; keyId?: number };
		if (p.t !== "space-invite" || !p.space || !/^[0-9a-f]{64}$/.test(p.key ?? "")) return;
		if (p.keyId !== undefined && (!Number.isSafeInteger(p.keyId) || p.keyId < 1)) return;
		const keyId = p.keyId ?? 1;
		let keyring: { version?: number; localPubkey?: string; localIdentityHash?: string; channels?: Record<string, { key?: string; keyId?: number; createdAt?: number; owner?: string }> } = {};
		try {
			keyring = (await Bun.file(`${dataRoot()}/channel-keys.json`).json()) as typeof keyring;
		} catch {
			/* fresh */
		}
		keyring.channels ??= {};
		const existing = keyring.channels[p.space];
		if (existing && rumor.pubkey !== id!.pk && rumor.pubkey !== (existing.owner ?? id!.pk)) return;
		if (existing?.keyId && existing.keyId >= keyId) return;
		keyring.channels[p.space] = {
			key: p.key,
			keyId,
			createdAt: Date.now(),
			// Wrapped by ourselves (multi-device): keep prior ownership; else the sender administers.
			owner: rumor.pubkey === id!.pk ? existing?.owner : rumor.pubkey,
		};
		const tmp = `${dataRoot()}/channel-keys.json.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...keyring, version: 1, localPubkey: id!.pk, localIdentityHash: id!.identityHash }), { mode: 0o600 });
		renameSync(tmp, `${dataRoot()}/channel-keys.json`);
		console.log(`[sync] joined space "${p.name || p.space.slice(0, 8)}" via gift-wrapped key #${keyId}`);
		const before = new Set([...sharedSpaces.values()].map((sp) => sp.spaceTag));
		await refreshShared();
		subscribeLive();
		const freshTags = [...sharedSpaces.values()].map((sp) => sp.spaceTag).filter((t) => !before.has(t));
		await backfillSpaceTags(freshTags);
	}

	async function handleWrap(event: Event): Promise<void> {
		if (state.wrapsSeen![event.id]) return;
		state.wrapsSeen![event.id] = true;
		dirty = true;
		try {
			const rumor = unwrapEvent(event, id!.sk);
			if (rumor.kind === INVITE_RUMOR_KIND) {
				await importInviteKey(rumor);
			} else if (rumor.kind === JOINREQ_RUMOR_KIND) {
				const p = JSON.parse(rumor.content) as { t?: string; space?: string };
				if (p.t !== "join-request" || !p.space) return;
				// Only the space's administrator collects requests.
				const space = sharedSpaces.get(p.space);
				const entryOwnerOk = !space?.owner || space.owner === id!.pk;
				let holdsKey = !!space;
				if (!holdsKey) {
					try {
						const keyring = (await Bun.file(`${dataRoot()}/channel-keys.json`).json()) as { channels?: Record<string, { key?: string; owner?: string }> };
						const entry = keyring.channels?.[p.space];
						holdsKey = !!entry?.key && (!entry.owner || entry.owner === id!.pk);
					} catch {
						/* no keyring */
					}
				}
				if (!holdsKey || !entryOwnerOk) return;
				// The requester's public kind-0 profile, so the owner can put a
				// face to the knock before approving.
				let profile: { name?: string; picture?: string } = {};
				try {
					const events = await pool.querySync(id!.relays, { kinds: [0], authors: [rumor.pubkey], limit: 3 });
					events.sort((a, b) => b.created_at - a.created_at);
					if (events[0]) {
						const meta = JSON.parse(events[0].content) as { name?: string; display_name?: string; picture?: string };
						profile = { name: meta.display_name || meta.name, picture: meta.picture };
					}
				} catch {
					/* no profile on our relays - npub alone */
				}
				await recordJoinRequest({
					space: p.space,
					spaceName: await spaceNameOf(p.space),
					requester: rumor.pubkey,
					requesterNpub: nip19.npubEncode(rumor.pubkey),
					name: profile.name,
					picture: profile.picture,
					at: Date.now(),
				});
				console.log(`[sync] join request for ${p.space.slice(0, 8)} from ${rumor.pubkey.slice(0, 8)} - awaiting approval in space settings`);
			}
		} catch {
			/* not addressed to us / garbled */
		}
	}

	/** Owner duty: publish the relay write-allowlist (writers of every owned shared space). */
	async function publishAllowlist(): Promise<void> {
		const writers = new Set<string>();
		let owned = 0;
		for (const space of sharedSpaces.values()) {
			if (space.owner && space.owner !== id!.pk) continue; // not mine to administer
			owned++;
			for (const w of space.writers) writers.add(w);
			// Viewers too: the relay's wrap door checks the same list, and a
			// viewer must still RECEIVE the gift-wrapped space key.
			for (const hex of await spaceMemberHexes(space.spaceId)) writers.add(hex);
		}
		if (owned === 0) return;
		writers.delete(id!.pk);
		try {
			const event = finalizeEvent(
				{
					kind: ALLOWLIST_KIND,
					created_at: Math.floor(Date.now() / 1000),
					tags: [["d", ALLOWLIST_D], ...[...writers].map((w) => ["p", w])],
					content: "",
				},
				id!.sk,
			);
			await Promise.any(pool.publish(id!.relays, event));
		} catch {
			/* retried on next reconcile */
		}
	}

	/** A space that just became shared (or rotated) republishes its whole
	 * history under the space key - that is what makes joiners see it. */
	async function queueSharedHistories(): Promise<void> {
		for (const space of sharedSpaces.values()) {
			if (state.sharedQueued![space.spaceId] === space.keyId) continue;
			state.sharedQueued![space.spaceId] = space.keyId;
			dirty = true;
			let objects = 0;
			for (const [objectId, spaceId] of spaceMap) {
				if (spaceId !== space.spaceId) continue;
				objects++;
				await publishObject(objectId);
			}
			if (!spaceMap.has(space.spaceId)) {
				objects++;
				await publishObject(space.spaceId);
			}
			console.log(`[sync] space ${space.spaceId.slice(0, 8)} shared (key #${space.keyId}): queued ${objects} object(s)`);
		}
	}

	// ── Startup: backfill both directions ─────────────────────────
	console.log(`[sync] identity ${id.pk.slice(0, 8)}… relays: ${id.relays.join(", ")}`);
	await refreshShared();
	if (sharedSpaces.size > 0) console.log(`[sync] shared spaces: ${[...sharedSpaces.keys()].map((k) => k.slice(0, 8)).join(", ")}`);

	// Full reconcile on every startup: page back through EVERYTHING the
	// relays hold (no since — relays drop events silently, so the persisted
	// published-set can't be trusted) and rebuild it from relay reality.
	// Anything in the local manifest the relays didn't return gets
	// re-published below. Negentropy can replace this scan later.
	state.published = {};
	state.publishedSpace = {};
	state.sharedQueued = {};
	const backfillById = new Map<string, Event>();
	const spaceTags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
	const backfillFilters: Filter[] = [{ kinds: [CHANGE_KIND], authors: [id.pk] }];
	if (spaceTags.length > 0) backfillFilters.push({ kinds: [CHANGE_KIND], "#h": spaceTags });
	const backfillScan = beginReplayScan(0);
	const backfillComplete = await scanRelayHistory(pool, id.relays, backfillFilters, (event) => backfillById.set(event.id, event));
	const backfill = [...backfillById.values()];
	console.log(`[sync] backfill: ${backfill.length} event(s) from relays`);
	// Route every event through the chunk-aware path (sorted so multi-part
	// groups assemble in one pass); onRelayEvent advances the cursor.
	backfill.sort((a, b) => a.created_at - b.created_at);
	let assembled = 0;
	for (const event of backfill) {
		await onRelayEvent(event);
		assembled++;
	}
	finishReplayScan(backfillScan, backfillComplete, true);
	if (assembled > 0) console.log(`[sync] backfill processed ${assembled} event(s)`);
	dirty = true;

	const keyringEvents = await pool.querySync(id.relays, { kinds: [KEYRING_KIND], authors: [id.pk], "#d": [KEYRING_D] });
	if (keyringEvents.length > 0) {
		keyringEvents.sort((a, b) => b.created_at - a.created_at);
		await mergeKeyring(keyringEvents[0]);
	}

	// Gift wraps: process everything addressed to us (their created_at is
	// randomized, so no cursor - wrapsSeen dedupes across restarts).
	try {
		const wraps = await pool.querySync(id.relays, { kinds: [WRAP_KIND], "#p": [id.pk] });
		wraps.sort((a, b) => a.created_at - b.created_at);
		for (const w of wraps) await handleWrap(w);
	} catch {
		/* relay unreachable; live sub + watchdog catch up */
	}

	// The backfill may have carried new vanish records from another device;
	// re-read the ledger before deciding what to publish or chase.
	vanished = await localVanished();
	await chaseVanished();

	// Publish local changes the relays don't have (published set carries
	// both prior publishes and everything backfill just returned).
	const manifest = await localManifest();
	let toPublish = 0;
	for (const hexes of Object.values(manifest)) {
		for (const hex of hexes) if (!state.published[hex]) toPublish++;
	}
	console.log(`[sync] ${toPublish} local change(s) to publish${vanished.size > 0 ? `, ${vanished.size} object(s) vanished` : ""}`);
	for (const objectId of Object.keys(manifest)) {
		await publishObject(objectId);
	}
	await publishKeyring();
	await queueSharedHistories();
	// Allowlist BEFORE invites: delivery wraps ride ephemeral keys and are
	// p-tagged to the new member, so the relay only admits them once the
	// member is on the published allowlist.
	await publishAllowlist();
	await reconcileInvites();
	persist();

	// ── Live: both directions ──────────────────────────────────────
	subscribe((objectId) => {
		if (objectId === VANISH_LOG_ID) {
			// A vanish happened here or arrived from a peer: re-read the ledger,
			// publish the record itself, then chase the relay copies.
			void (async () => {
				vanished = await localVanished();
				await publishObject(objectId);
				await chaseVanished();
			})();
			return;
		}
		// A commit on a space object can change members/keys: refresh the
		// shared view, then reconcile allowlist + history publication.
		if (spaceMap.get(objectId) === objectId || sharedSpaces.has(objectId)) {
			void (async () => {
				await refreshShared();
				await queueSharedHistories();
				await publishAllowlist();
				await reconcileInvites();
				void publishObject(objectId);
			})();
			return;
		}
		// New objects are absent from the cached map - refresh lazily. A
		// commit can also be a space BECOMING shared (first member added to
		// a keyed space): it was in nobody's map, but after the refresh it
		// needs the full owner reconcile - history, allowlist, invites.
		if (!spaceMap.has(objectId)) {
			void (async () => {
				await refreshShared();
				if (sharedSpaces.has(objectId)) {
					await queueSharedHistories();
					await publishAllowlist();
					await reconcileInvites();
				}
				void publishObject(objectId);
			})();
			return;
		}
		void publishObject(objectId);
	});
	// ── Live subscriptions + deafness watchdog ─────────────────────
	//
	// nostr-tools does not resurrect subscriptions after a socket drop
	// (relay deploys, laptop sleep, proxy resets) - the pool keeps
	// "working" while receiving nothing and timing out publishes. The
	// watchdog asks the relay for its head every WATCHDOG_MS; a head
	// newer than our cursor (or a dead query) means we are deaf:
	// rebuild the pool, catch up since the cursor, resubscribe.

	let liveSubs: Array<{ close(): void }> = [];

	function subscribeLive(): void {
		for (const sub of liveSubs) {
			try {
				sub.close();
			} catch {
				/* already gone */
			}
		}
		liveSubs = [];
		liveSubs.push(
			pool.subscribeMany(id!.relays, { kinds: [CHANGE_KIND], authors: [id!.pk], since: Math.min(state.cursor, state.replaySince ?? state.cursor) }, {
				onevent: (event) => void onRelayEvent(event),
			}),
		);
		const tags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
		if (tags.length > 0) {
			liveSubs.push(
				pool.subscribeMany(id!.relays, { kinds: [CHANGE_KIND], "#h": tags, since: Math.min(state.cursor, state.replaySince ?? state.cursor) }, {
					onevent: (event) => void onRelayEvent(event),
				}),
			);
		}
		liveSubs.push(
			pool.subscribeMany(id!.relays, { kinds: [KEYRING_KIND], authors: [id!.pk], "#d": [KEYRING_D], since: Math.floor(Date.now() / 1000) }, {
				onevent: (event) => void mergeKeyring(event),
			}),
		);
		liveSubs.push(
			pool.subscribeMany(id!.relays, { kinds: [WRAP_KIND], "#p": [id!.pk], since: Math.floor(Date.now() / 1000) - WRAP_LOOKBACK_S }, {
				onevent: (event) => void handleWrap(event),
			}),
		);
	}

	const WATCHDOG_MS = 60_000;

	async function relayHead(): Promise<number | null> {
		const tags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
		const query = Promise.all([
			pool.querySync(id!.relays, { kinds: [CHANGE_KIND], authors: [id!.pk], limit: 1 }),
			tags.length > 0 ? pool.querySync(id!.relays, { kinds: [CHANGE_KIND], "#h": tags, limit: 1 }) : Promise.resolve([] as Event[]),
		]);
		const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
		const res = await Promise.race([query, timeout]);
		if (res === null) return null;
		return [...res[0], ...res[1]].reduce((max, e) => Math.max(max, e.created_at), 0);
	}

	async function catchup(): Promise<void> {
		const tags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
		// Observed suffix timestamps do not bound an unseen prefix: writers
		// timestamp each part separately. Only unresolved groups need this
		// full-history repair; successful groups are deduplicated above.
		const since = Object.keys(state.pendingChunkGroups!).length > 0 ? 0 : Math.min(state.cursor, state.replaySince ?? state.cursor);
		const byId = new Map<string, Event>();
		const filters: Filter[] = [{ kinds: [CHANGE_KIND], authors: [id!.pk], since }];
		if (tags.length > 0) filters.push({ kinds: [CHANGE_KIND], "#h": tags, since });
		const scan = beginReplayScan(since);
		const complete = await scanRelayHistory(pool, id!.relays, filters, (event) => byId.set(event.id, event));
		const events = [...byId.values()].sort((a, b) => a.created_at - b.created_at);
		for (const event of events) await onRelayEvent(event);
		const currentTags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
		finishReplayScan(scan, complete, currentTags.length === tags.length && currentTags.every((tag) => tags.includes(tag)));
		if (events.length > 0) console.log(`[sync] watchdog caught up ${events.length} event(s)`);
		// Gift wraps have randomized created_at: re-query them all on every
		// catchup; wrapsSeen dedupes. This is what recovers knocks and key
		// deliveries lost to a dropped subscription.
		try {
			const wraps = await pool.querySync(id!.relays, { kinds: [WRAP_KIND], "#p": [id!.pk] });
			wraps.sort((a, b) => a.created_at - b.created_at);
			for (const w of wraps) await handleWrap(w);
		} catch {
			/* next watchdog tick */
		}
	}

	let watchdogBusy = false;
	setInterval(() => {
		if (watchdogBusy) return;
		watchdogBusy = true;
		void (async () => {
			try {
				await chaseVanished();
				const head = await relayHead();
				if (head === null) {
					console.log("[sync] watchdog: relay unresponsive - rebuilding pool");
					try {
						pool.close(id!.relays);
					} catch {
						/* already closed */
					}
					pool = new SimplePool();
					await catchup();
					subscribeLive();
				} else if (head >= state.cursor || state.replaySince !== undefined) {
					console.log(`[sync] watchdog: relay head ${head}, cursor ${state.cursor} - catching up`);
					await catchup();
					subscribeLive();
				}
			} finally {
				watchdogBusy = false;
			}
		})();
	}, WATCHDOG_MS);

	subscribeLive();
	console.log("[sync] live");
}

/**
 * One-shot NIP-09 pass for objects already recorded in the local ledger —
 * used by `vanish` on the command line, where no daemon is running. The
 * local purge and the ledger write are the server's job; this only chases
 * the relay copies.
 */
export async function vanishOnRelays(objectIds: string[]): Promise<{ events: number; requests: number }> {
	const id = await loadIdentity();
	if (!id || id.relays.length === 0) {
		console.log("[vanish] no nostr key or no relays — nothing to ask (local purge already done)");
		return { events: 0, requests: 0 };
	}
	const pool = new SimplePool();
	const state = await readState();
	try {
		const scan = await collectEventIds(pool, id, objectIds);
		const deletion = await publishDeleteRequests(pool, id, scan.eventIds, "object vanished by its owner");
		for (const objectId of objectIds) {
			if (scan.complete && deletion.complete) state.vanishRequested[objectId] = true;
			else delete state.vanishRequested[objectId];
		}
		writeState(state);
		return { events: scan.eventIds.length, requests: deletion.requests };
	} finally {
		pool.close(id.relays);
	}
}