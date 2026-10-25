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
 * Loop: startup backfill (relay history → import; local history → publish
 * unpublished) then live (SSE commit → publish; relay event → import).
 *
 * State sync (docs/state-sync.md): bases first (kind 31078 + 1080 parts),
 * then live deltas by #b; once bases exist the history walk is bounded to
 * the newest base minus a day. Orphans are rebased by the daemon and
 * published. Compaction (on unless GLON_STATE_SYNC_COMPACT=0) replaces the 1079
 * checkpoint loop; GLON_STATE_SYNC_SWEEP_PREMIGRATION=1|dry-run sweeps the
 * pre-migration history folded into epoch-1 bases.
 */

import { SimplePool, finalizeEvent, getPublicKey, nip19, nip44, verifyEvent, type Event, type Filter } from "nostr-tools";
import { unwrapEvent, wrapEvent } from "nostr-tools/nip59";
import { API, VANISH_LOG_ID, apiFetch, mutate, subscribe, vanishedEntries, type VanishedEntry } from "./api";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { machines, serverOf, servesHere } from "./machine";
import { machineId } from "./roster";
import { blossomServer, decryptBlob, deleteBlob, download, encryptBlob, sha256Hex, upload } from "./blossom";

const CHANGE_KIND = 1078;
/** One Checkpoint (docs/checkpoint-sync.md) per object: a replay cache, same envelope as 1078. */
const CHECKPOINT_KIND = 1079;
const CHECKPOINT_INTERVAL_MS = 10 * 60_000;
/** State sync (docs/state-sync.md): a per-object base, addressable, and its parts 2..n. */
const BASE_KIND = 31078;
const BASE_PART_KIND = 1080;
/** Once bases exist, history walks start this long before the newest base. */
const BASE_FLOOR_SLACK_S = 86_400;
/** A computer compacts any object still without a base once its oldest change is this old, whoever serves it. */
const UNBASED_FALLBACK_MS = 12 * 3_600_000;
/** What the live subscription, the watchdog and catch-up read: deltas, legacy checkpoints, bases and their parts. */
const LIVE_KINDS = [CHANGE_KIND, CHECKPOINT_KIND, BASE_KIND, BASE_PART_KIND];
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
/**
 * `e` tags per deletion request. RoostrRelay examines at most 256 tags of a
 * kind-5 (`MAX_PLAN_TAGS`) and rejects anything longer; two `k` tags ride
 * along, so 254 victims per request is the largest batch it fully applies.
 */
const DELETE_BATCH = 254;

export function dataRoot(): string {
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
	/** Relay's checkpoint per object (own signer): heads it describes and the events carrying it. */
	checkpoints?: Record<string, PublishedCheckpoint>;
	/** Outdated own 1079 event ids already named in a NIP-09 request (checkpoint sweep). */
	checkpointDeletes?: Record<string, true>;
	/** Own base per object as the relays carry it (state sync). */
	bases?: Record<string, PublishedBase>;
	/** Compactions whose base is out but whose NIP-09 cleanup has not reached every relay yet. */
	compactions?: Record<string, PendingCompaction>;
	/** Objects whose pre-migration 1078/1079 history every relay accepted the deletion of. */
	premigrationSwept?: Record<string, true>;
	/** Blossom blobs of superseded pointer bases still to BUD-02 DELETE (sha256 -> true); retried every compaction pass. */
	blobDeletes?: Record<string, true>;
}

interface PublishedBase {
	/** "" personal, else "spaceId/keyId": the key (and address) it went out under. */
	scope: string;
	hash: string;
	epoch: number;
	/** The 31078 event and its 1080 parts. */
	eventIds: string[];
	/** created_at of the 31078 event (seconds). */
	createdAt: number;
	/** Every configured relay accepted every event. */
	everywhere: boolean;
	/** sha256 of the Blossom blob of a pointer base (docs/state-sync.md "Oversized bases"): deleted with the base. */
	blob?: string;
}

interface PendingCompaction {
	hash: string;
	epoch: number;
	prevBase: string;
	/** Delta change ids the base folded (empty at epoch 1: pre-migration, left to the sweep). */
	folded: string[];
	/** Our previous relay copies at this address: their events go by `e`. */
	previous: PublishedBase[];
	/** created_at of our 31078 carrying this base, once published. */
	createdAt?: number;
}

interface PublishedCheckpoint {
	hash: string;
	/** sorted hex heads */
	heads: string[];
	eventIds: string[];
}

function statePath(): string {
	return `${dataRoot()}/sync-state.json`;
}

async function readState(): Promise<SyncState> {
	try {
		const parsed = (await Bun.file(statePath()).json()) as SyncState;
		if (parsed?.version === 1) return { ...parsed, pendingChunkGroups: parsed.pendingChunkGroups ?? {}, vanishScanVersion: 2, vanishRequested: parsed.vanishScanVersion === 2 ? (parsed.vanishRequested ?? {}) : {}, publishedSpace: parsed.publishedSpace ?? {}, sharedQueued: parsed.sharedQueued ?? {}, invitesSent: parsed.invitesSent ?? {}, wrapsSeen: parsed.wrapsSeen ?? {}, checkpoints: parsed.checkpoints ?? {}, checkpointDeletes: parsed.checkpointDeletes ?? {}, bases: parsed.bases ?? {}, compactions: parsed.compactions ?? {}, premigrationSwept: parsed.premigrationSwept ?? {}, blobDeletes: parsed.blobDeletes ?? {} };
	} catch {
		/* fresh */
	}
	return { version: 1, published: {}, cursor: 0, pendingChunkGroups: {}, vanishScanVersion: 2, vanishRequested: {}, publishedSpace: {}, sharedQueued: {}, invitesSent: {}, wrapsSeen: {}, checkpoints: {}, checkpointDeletes: {}, bases: {}, compactions: {}, premigrationSwept: {}, blobDeletes: {} };
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

export interface Identity {
	sk: Uint8Array;
	pk: string;
	identityHash: string;
	conversationKey: Uint8Array;
	relays: string[];
}

export async function loadIdentity(): Promise<Identity | null> {
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

interface KeyringEntry {
	key?: string;
	keyId?: number;
	createdAt?: number;
	/** imported spaces: the administrator's hex pubkey. */
	owner?: string;
}

/** channel-keys.json: every space key this identity holds, by space id. */
interface Keyring {
	version?: number;
	localPubkey?: string;
	localIdentityHash?: string;
	channels?: Record<string, KeyringEntry>;
}

async function readKeyring(): Promise<Keyring | null> {
	try {
		return (await Bun.file(`${dataRoot()}/channel-keys.json`).json()) as Keyring;
	} catch {
		return null;
	}
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

/**
 * Spaces syncing under their space key. `gone` (the vanish ledger) drops
 * vanished and left spaces - no subscription, publishing, allowlist or
 * invites - while their keyring entries stay: a vanished space's key still
 * names its stream for the relay deletion (contract §5).
 */
async function loadSharedSpaces(identity: Identity, gone: ReadonlyMap<string, VanishedEntry>): Promise<Map<string, SharedSpace>> {
	const myPk = identity.pk;
	const out = new Map<string, SharedSpace>();
	const keyring = await readKeyring();
	if (!keyring) return out;
	if (keyring.localPubkey !== myPk || keyring.localIdentityHash !== identity.identityHash) {
		keyring.localPubkey = myPk;
		keyring.localIdentityHash = identity.identityHash;
		const path = `${dataRoot()}/channel-keys.json`;
		writeFileSync(`${path}.tmp`, JSON.stringify(keyring), { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	}
	for (const [spaceId, entry] of Object.entries(keyring.channels ?? {})) {
		if (gone.has(spaceId)) continue;
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

/** A working-set change; `class` only when the object holds a base (the daemon classifies it). */
interface LocalChange {
	id: string;
	b64: string;
	/** Base hash the change was written on (its event's `b` tag). */
	b?: string;
	/** Written here and never confirmed published. */
	pending?: boolean;
	/** Written here and no held base has proven it folded yet (published or not). */
	own?: boolean;
	class?: "live" | "covered" | "premigrationCovered" | "orphan" | "stale";
}

async function localChanges(objectId: string): Promise<LocalChange[]> {
	const res = await apiFetch(`${API}/api/changes/${objectId}`);
	const out = (await res.json()) as { changes: LocalChange[] };
	return out.changes;
}

interface SharedProvenance {
	spaceId: string;
	keyId: number;
	signer: string;
}

/** The store refused an imported change; `reason` is the store's own (e.g. the shared-space authority gate's). */
class ImportRejected extends Error {
	reason: string;
	constructor(reason: string) {
		super(`Change import rejected: ${reason}`);
		this.reason = reason;
	}
}

/** `b`: the base hash the change's event carried; stored with the change for classification. */
async function localImport(items: Array<string | { b64: string; b: string }>, provenance?: SharedProvenance): Promise<{ imported: number; rejected: number; ids: string[]; reasons?: string[] }> {
	const res = await apiFetch(`${API}/api/changes`, { method: "POST", body: JSON.stringify({ changes: items, provenance }) });
	if (!res.ok) throw new Error(`Change import failed: ${res.status}`);
	return (await res.json()) as { imported: number; rejected: number; ids: string[]; reasons?: string[] };
}

/** POST JSON to a state-sync endpoint of the daemon (src/bases.odin); non-2xx throws with the daemon's reason. */
async function localPost<T>(path: string, body: unknown): Promise<T> {
	const res = await apiFetch(`${API}${path}`, { method: "POST", body: JSON.stringify(body) });
	if (!res.ok) throw new Error(`${path} failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
	return (await res.json()) as T;
}

/** GET /api/bases: per object, the current base and what compaction would fold. */
interface BaseRow {
	/** "" when the object holds no base. */
	hash: string;
	epoch: number;
	/** unix ms */
	createdAt: number;
	prevBase: string;
	live: number;
	orphan: number;
	stale: number;
	pending: number;
	/** Changes written here that no held base has proven folded. */
	own: number;
	/** Own orphans: POST /api/bases/rebase has work (another device's orphans are discarded, never rebased here). */
	rebase: number;
	/** unix ms of the oldest live change (0 when none). */
	oldestMs: number;
	compact: boolean;
	reason: string;
}

async function localBases(): Promise<Record<string, BaseRow>> {
	const res = await apiFetch(`${API}/api/bases`);
	if (!res.ok) throw new Error(`Base list failed: ${res.status}`);
	return (await res.json()) as Record<string, BaseRow>;
}

interface HeldBase {
	hash: string;
	epoch: number;
	current: boolean;
	b64: string;
}

interface ImportedBase {
	objectId: string;
	hash: string;
	epoch: number;
	stored: boolean;
	/** After the import this is the object's current base. */
	current: boolean;
}

interface BuiltBase {
	objectId: string;
	compact: boolean;
	reason: string;
	b64?: string;
	hash?: string;
	epoch?: number;
	prevBase?: string;
	folded?: string[];
}

interface EventTemplate {
	kind: number;
	content: string;
	tags: string[][];
}

/** Core seal_base output (via the daemon, which adds our secret for personal objects). */
interface SealedBase {
	hash: string;
	objectId: string;
	epoch: number;
	d: string;
	gid: string;
	event?: EventTemplate;
	parts?: EventTemplate[];
	/** Oversized, no event yet: encrypt the base bytes under blobKey, upload, seal again with `blob`. */
	needsBlob?: boolean;
	blobKey?: string;
	/** A pointer base: the blob it names. */
	blob?: { sha256: string; size: number; key: string };
}

/** A pointer base's content (docs/state-sync.md "Oversized bases"). */
interface BasePointer {
	/** base_hash of the blob's plaintext. */
	hash: string;
	/** sha256 of the blob: its Blossom name. */
	sha256: string;
	size: number;
	/** hex AES-256-GCM key, blossom.ts frame format. */
	key: string;
	url?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const BLOB_MAX_BYTES = 512 * 1024 * 1024;

/** The pointer a 31078's decrypted content carries, checked against its ["blob", sha256, size] tag; null for anything else (an unknown version too). */
function basePointerOf(blobTag: string[], part: string): BasePointer | null {
	if (part.length > 4096) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(part);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const p = raw as Record<string, unknown>;
	if (p.v !== 1 || typeof p.hash !== "string" || typeof p.sha256 !== "string" || typeof p.key !== "string" || typeof p.size !== "number") return null;
	if (!HEX64.test(p.hash) || !HEX64.test(p.sha256) || !HEX64.test(p.key) || !Number.isSafeInteger(p.size) || p.size < 1 || p.size > BLOB_MAX_BYTES) return null;
	if (p.url !== undefined && (typeof p.url !== "string" || p.url.length > 2048 || !/^https?:\/\//.test(p.url))) return null;
	if (blobTag[1] !== p.sha256 || blobTag[2] !== String(p.size)) return null;
	return { hash: p.hash, sha256: p.sha256, size: p.size, key: p.key, ...(p.url ? { url: p.url as string } : {}) };
}

interface CheckpointRow {
	heads: string[];
	checkpointHeads: string[] | null;
	/** "" when no checkpoint is stored. */
	checkpointHash: string;
	changes: number;
	covered: number;
}

/** Per object: current heads vs. the stored checkpoint's heads. */
async function localCheckpoints(): Promise<Record<string, CheckpointRow>> {
	const res = await apiFetch(`${API}/api/checkpoints`);
	if (!res.ok) throw new Error(`Checkpoint list failed: ${res.status}`);
	return (await res.json()) as Record<string, CheckpointRow>;
}

interface BuiltCheckpoint {
	objectId: string;
	b64: string;
	hash: string;
	heads: string[];
	covered: number;
}

/** Build from full local history and persist; the daemon owns the bytes. */
async function localCheckpointBuild(objectId: string): Promise<BuiltCheckpoint> {
	const res = await apiFetch(`${API}/api/checkpoints/build`, { method: "POST", body: JSON.stringify({ objectId }) });
	if (!res.ok) throw new Error(`Checkpoint build failed: ${res.status}`);
	return (await res.json()) as BuiltCheckpoint;
}

interface ImportedCheckpoint {
	objectId: string;
	hash: string;
	heads: string[];
	stored: boolean;
	/** The daemon holds exactly these bytes after the import. */
	held: boolean;
	/** What the daemon holds after the import covers these bytes (containment, then hash): an outdated copy. */
	superseded: boolean;
}

async function localCheckpointImport(b64s: string[], provenance?: SharedProvenance): Promise<{ imported: number; rejected: number; items: ImportedCheckpoint[] }> {
	const res = await apiFetch(`${API}/api/checkpoints`, { method: "POST", body: JSON.stringify({ checkpoints: b64s, provenance }) });
	if (!res.ok) throw new Error(`Checkpoint import failed: ${res.status}`);
	return (await res.json()) as { imported: number; rejected: number; items: ImportedCheckpoint[] };
}

/**
 * The change id inside a sealed change part: change bytes open with the id
 * field (0a 20 <32 bytes>), so the first 48 base64 characters of part 0 hold it.
 */
export function changeIdOfPart(part: string): string | null {
	const bytes = Buffer.from(part.slice(0, 48), "base64");
	if (bytes.length < 34 || bytes[0] !== 0x0a || bytes[1] !== 0x20) return null;
	return bytes.subarray(2, 34).toString("hex");
}

/** A `b` tag naming a base: 64 lowercase hex, else none. */
function baseTagOf(event: Event): string | undefined {
	const value = event.tags.find((tag) => tag[0] === "b")?.[1];
	return value && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

/** The local ledger by id (src/vanish.odin): vanished and left ids, and every object of such a space. */
async function localVanished(): Promise<Map<string, VanishedEntry>> {
	try {
		return new Map((await vanishedEntries()).map((entry) => [entry.objectId, entry]));
	} catch {
		return new Map();
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
	// Vanished spaces too: their objects' events ride their space key.
	const spaces = await loadSharedSpaces(id, new Map());
	const allTags = new Set<string>();
	for (const objectId of objectIds) {
		allTags.add(blindObjectId(id, objectId));
		for (const space of spaces.values()) allTags.add(blindShared(space.keyHex, objectId));
	}
	const tagList = [...allTags];
	const filters: Filter[] = [];
	for (let i = 0; i < tagList.length; i += HTAG_BATCH) {
		filters.push({ kinds: [CHANGE_KIND, CHECKPOINT_KIND], authors: [id.pk], "#h": tagList.slice(i, i + HTAG_BATCH) });
	}
	const complete = await scanRelayHistory(pool, id.relays, filters, (event) => found.add(event.id));
	return { eventIds: [...found], complete };
}

/**
 * Count requests accepted somewhere; completion requires every relay to accept every batch.
 * `addresses` (`a` tags, a superseded base's "31078:<pubkey>:<d>") ride the first request,
 * which then names fewer events so no request exceeds the relay's 256-tag bound. `createdAt`
 * dates every request: an `a` deletion covers every version up to it, so it must predate
 * the version that stays.
 */
async function publishDeleteRequests(pool: SimplePool, id: Identity, eventIds: string[], reason: string, kinds: number[] = [CHANGE_KIND, CHECKPOINT_KIND], options: { addresses?: string[]; createdAt?: number } = {}): Promise<{ requests: number; complete: boolean }> {
	let sent = 0;
	let complete = id.relays.length > 0;
	let addresses = options.addresses ?? [];
	for (let i = 0; i < eventIds.length || addresses.length > 0; ) {
		const take = Math.min(DELETE_BATCH, DELETE_BATCH + 2 - kinds.length - addresses.length);
		const batch = eventIds.slice(i, i + take);
		i += take;
		const event = finalizeEvent(
			{
				kind: DELETE_KIND,
				created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
				tags: [...addresses.map((address) => ["a", address]), ...batch.map((eid) => ["e", eid]), ...kinds.map((kind) => ["k", String(kind)])],
				content: reason,
			},
			id.sk,
		);
		addresses = [];
		const results = await Promise.allSettled(pool.publish(id.relays, event));
		if (results.some((result) => result.status === "fulfilled")) sent++;
		if (results.length !== id.relays.length || results.some((result) => result.status === "rejected")) complete = false;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 120);
		await promise;
	}
	return { requests: sent, complete };
}

/**
 * Contract §5: one kind-5 naming a space's stream tag. The relay drops every
 * change and checkpoint of that stream signed by us or consenting to us
 * (`owner` tag), now and on later arrival; members take an owner's request
 * as the signal that the space is gone. True when every relay accepted it.
 */
async function publishSpaceDeletion(pool: SimplePool, id: Identity, keyHex: string, spaceId: string): Promise<boolean> {
	const event = finalizeEvent(
		{
			kind: DELETE_KIND,
			created_at: Math.floor(Date.now() / 1000),
			tags: [["h", blindShared(keyHex, `space:${spaceId}`)], ["k", String(CHANGE_KIND)], ["k", String(CHECKPOINT_KIND)]],
			content: "space deleted",
		},
		id.sk,
	);
	const results = await Promise.allSettled(pool.publish(id.relays, event));
	return id.relays.length > 0 && results.length === id.relays.length && results.every((result) => result.status === "fulfilled");
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
	/** Compaction and every deletion it implies: on unless GLON_STATE_SYNC_COMPACT=0. */
	const COMPACT = process.env.GLON_STATE_SYNC_COMPACT !== "0";
	/** GLON_STATE_SYNC_SWEEP_PREMIGRATION: "1" deletes (with COMPACT), "dry-run" only logs counts. */
	const SWEEP_PREMIGRATION = process.env.GLON_STATE_SYNC_SWEEP_PREMIGRATION === "1" ? "on" : process.env.GLON_STATE_SYNC_SWEEP_PREMIGRATION === "dry-run" ? "dry-run" : "off";
	/** Once bases exist: the oldest created_at any history walk or subscription asks for (0 = from the start). */
	let historyFloor = 0;
	/** Change id -> relay event ids carrying it (imports and own publishes): compaction deletes folded deltas by these. */
	const deltaEvents = new Map<string, string[]>();
	function noteDeltaEvents(changeHex: string, eventIds: readonly string[]): void {
		deltaEvents.set(changeHex, [...new Set([...(deltaEvents.get(changeHex) ?? []), ...eventIds])]);
	}

	// Vanished objects (src/vanish.odin) are never published, and their
	// relay copies are chased with NIP-09 requests - except a left space's:
	// those stay for its other members. Refreshed whenever the ledger
	// object commits.
	let vanished = await localVanished();

	// ── Paced publish queue ────────────────────────────────────────
	//
	// Public relays rate-limit bursts (a fresh node pushes its whole
	// corpus). One event every PUBLISH_SPACING_MS; failures re-queue with
	// exponential backoff and are never dropped — publish is eventually
	// durable as long as the daemon lives.
	const PUBLISH_SPACING_MS = 120;
	interface QueueItem {
		kind: typeof CHANGE_KIND | typeof CHECKPOINT_KIND;
		objectId: string;
		/** change hex id; the checkpoint hash for CHECKPOINT_KIND. */
		changeHex: string;
		b64: string;
		attempts: number;
		notBefore: number;
		/** present = publish under this space's key instead of self. */
		space?: SharedSpace;
		/** CHECKPOINT_KIND: runs with the relay event ids once every part is accepted. */
		onPublished?: (eventIds: string[]) => Promise<void>;
		/** CHANGE_KIND: the base the change was written on - published as ["b", base]. */
		base?: string;
		/** CHANGE_KIND: the daemon still lists it as never published (.local). */
		pending?: boolean;
	}
	const queue: QueueItem[] = [];
	const queued = new Set<string>();
	let failuresLogged = 0;

	/** Live shared-space view; refreshed on startup and space commits. */
	let sharedSpaces = new Map<string, SharedSpace>();
	let spaceMap = new Map<string, string>();

	function spaceKeyFor(item: QueueItem): string {
		if (item.kind === CHECKPOINT_KIND) return `cp/${item.objectId}/${item.changeHex}`;
		return item.space ? `${item.space.spaceId}/${item.space.keyId}/${item.changeHex}` : item.changeHex;
	}

	/** Already on the relays (or queued), per the state this machine keeps. */
	function alreadyPublished(item: QueueItem): boolean {
		if (item.kind === CHECKPOINT_KIND) return state.checkpoints![item.objectId]?.hash === item.changeHex;
		return item.space ? !!state.publishedSpace![spaceKeyFor(item)] : !!state.published[item.changeHex];
	}

	function enqueue(objectId: string, changeHex: string, b64: string, base?: string, pending?: boolean): void {
		if (vanished.has(objectId)) return;
		const space = sharedSpaces.get(spaceMap.get(objectId) ?? "");
		const item: QueueItem = { kind: CHANGE_KIND, objectId, changeHex, b64, attempts: 0, notBefore: 0, space, base, pending };
		const doneKey = spaceKeyFor(item);
		if (alreadyPublished(item) || queued.has(doneKey)) return;
		queued.add(doneKey);
		queue.push(item);
	}
	/** A checkpoint supersedes the object's previous one on the relays; `onPublished` gets the event ids. False = nothing to do. */
	function enqueueCheckpoint(objectId: string, hash: string, b64: string, onPublished: (eventIds: string[]) => Promise<void>): boolean {
		if (vanished.has(objectId)) return false;
		const space = sharedSpaces.get(spaceMap.get(objectId) ?? "");
		const item: QueueItem = { kind: CHECKPOINT_KIND, objectId, changeHex: hash, b64, attempts: 0, notBefore: 0, space, onPublished };
		const doneKey = spaceKeyFor(item);
		if (alreadyPublished(item) || queued.has(doneKey)) return false;
		queued.add(doneKey);
		queue.push(item);
		return true;
	}

	/** Retry until every configured relay was scanned and accepted every deletion batch. */
	let vanishBusy = false;
	async function chaseVanished(): Promise<void> {
		if (vanishBusy) return;
		vanishBusy = true;
		try {
			const pending = [...vanished.values()].filter((entry) => !entry.left && !state.vanishRequested[entry.objectId]).map((entry) => entry.objectId);
			if (pending.length > 0) {
				const scan = await collectEventIds(pool, id!, pending);
				const deletion = await publishDeleteRequests(pool, id!, scan.eventIds, "object vanished by its owner");
				console.log(`[sync] vanish: ${pending.length} object(s), ${scan.eventIds.length} relay event(s), ${deletion.requests} delete request(s)`);
				if (scan.complete && deletion.complete) {
					for (const objectId of pending) state.vanishRequested[objectId] = true;
					dirty = true;
				}
			}
			// Each vanished space whose key is still held: one request for its whole stream.
			const keyring = await readKeyring();
			for (const entry of vanished.values()) {
				const doneKey = `space:${entry.objectId}`;
				const keyHex = keyring?.channels?.[entry.objectId]?.key;
				if (entry.left || state.vanishRequested[doneKey] || !keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) continue;
				if (!(await publishSpaceDeletion(pool, id!, keyHex, entry.objectId))) continue;
				state.vanishRequested[doneKey] = true;
				dirty = true;
				console.log(`[sync] space ${entry.objectId.slice(0, 8)} deleted on the relays`);
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

	/** Publish every part; the accepted event ids on success, null on any rejection. */
	async function publishOnce(item: QueueItem): Promise<string[] | null> {
		const parts: string[] = [];
		for (let i = 0; i < item.b64.length; i += CHUNK_CHARS) parts.push(item.b64.slice(i, i + CHUNK_CHARS));
		const gid = parts.length > 1 ? chunkGroupId(item.b64) : "";
		const eventIds: string[] = [];
		try {
			for (let i = 0; i < parts.length; i++) {
				// `owner`: consent for the space's owner to delete this event on the relay.
				const tags: string[][] = item.space
					? [["h", blindShared(item.space.keyHex, item.objectId)], ["h", item.space.spaceTag], ["owner", item.space.owner ?? id!.pk]]
					: [["h", blindObjectId(id!, item.objectId)]];
				if (gid) tags.push(["c", gid, String(i), String(parts.length)]);
				if (item.kind === CHANGE_KIND && item.base) tags.push(["b", item.base]);
				const event = finalizeEvent(
					{
						kind: item.kind,
						created_at: Math.floor(Date.now() / 1000),
						tags,
						content: nip44.encrypt(parts[i], item.space ? item.space.convKey : id!.conversationKey),
					},
					id!.sk,
				);
				await Promise.any(pool.publish(id!.relays, event));
				eventIds.push(event.id);
				if (parts.length > 1 && i < parts.length - 1) {
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, PUBLISH_SPACING_MS);
					await promise;
				}
			}
			return eventIds;
		} catch (err) {
			if (failuresLogged < 5) {
				failuresLogged++;
				const reasons = err instanceof AggregateError ? err.errors.map((e) => String(e).slice(0, 80)).join(" | ") : String(err).slice(0, 120);
				console.error(`[sync] publish rejected (attempt ${item.attempts + 1}): ${reasons}`);
			}
			return null;
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
			if (alreadyPublished(item) || vanished.has(item.objectId)) {
				queued.delete(doneKey);
				continue;
			}
			const eventIds = await publishOnce(item);
			if (eventIds) {
				if (item.kind === CHECKPOINT_KIND) await item.onPublished?.(eventIds);
				else {
					if (item.space) state.publishedSpace![doneKey] = true;
					else state.published[item.changeHex] = true;
					noteDeltaEvents(item.changeHex, eventIds);
					// The daemon stops counting it as never published (core `pending`); it
					// stays this computer's own (`.local`) until a held base proves it folded.
					if (item.pending) void localPost("/api/changes/published", { published: { [item.objectId]: [item.changeHex] } }).catch((err) => console.error(`[sync] publish confirmation failed for ${item.changeHex.slice(0, 8)}:`, err instanceof Error ? err.message : err));
				}
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

	/**
	 * Queue an object's unpublished working-set changes. With a base held the
	 * daemon classifies each one: only live deltas go out (with their `b`);
	 * covered ones were folded, stale ones may have been, own orphans are
	 * rebased and another device's orphans discarded by the daemon.
	 */
	async function publishObject(objectId: string): Promise<void> {
		try {
			const changes = await localChanges(objectId);
			for (const c of changes) if (!c.class || c.class === "live") enqueue(objectId, c.id, c.b64, c.b, c.pending);
		} catch (err) {
			console.error(`[sync] enqueue failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}

	/** Only bounded, short-lived transport fragments live here; canonical events have no TTL. */
	const MAX_CHUNK_GROUPS = 128;
	const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
	const CHUNK_TTL_MS = 5 * 60_000;
	const chunkGroups = new Map<string, { total: number; parts: Map<number, string>; eventIds: string[]; bytes: number; expires: number; since: number; b?: string; anchorAt?: number }>();
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

	/** `eventIds` carry the change on the relay; `b` is its event's base tag. */
	async function importB64(b64: string, space: SharedSpace | null, signer: string, eventIds: readonly string[] = [], b?: string): Promise<void> {
		const provenance = space ? { spaceId: space.spaceId, keyId: space.keyId, signer } : undefined;
		const res = await localImport([b ? { b64, b } : b64], provenance);
		if (res.rejected > 0) throw new ImportRejected(res.reasons?.[0] || "no reason given");
		// Anything the relay already holds must never be echoed back.
		for (const hex of res.ids) {
			if (space) state.publishedSpace![`${space.spaceId}/${space.keyId}/${hex}`] = true;
			else state.published[hex] = true;
		}
		if (res.ids.length === 1) noteDeltaEvents(res.ids[0], eventIds);
		dirty = true;
	}

	// ── Bases (docs/state-sync.md) ─────────────────────────────────
	//
	// A 31078 (with its 1080 parts) is one object's state at an epoch. The
	// daemon stores it and replays from it; signed by us (personal, or a space
	// we own) and current after the import, it is our relay copy at that
	// address - what compaction supersedes and deletes later.

	/** Per stream ("" = personal, else the space id): the newest base opened (created_at, seconds). Bounds that stream's history walk only. */
	const newestBaseAt = new Map<string, number>();
	function noteBaseAt(stream: string, createdAt: number): void {
		newestBaseAt.set(stream, Math.max(newestBaseAt.get(stream) ?? 0, createdAt));
	}
	/** Since for a stream's history walk: its newest base minus a day; 0 (whole stream) while it holds no base. Never global: an unbased object of one stream may be older than another stream's bases. */
	function streamFloor(stream: string): number {
		const at = newestBaseAt.get(stream) ?? 0;
		return at > 0 ? Math.max(0, at - BASE_FLOOR_SLACK_S) : 0;
	}
	/** Completed base chunk groups -> their import row, so republished parts join the copy. */
	const baseGroups = new Map<string, ImportedBase>();

	function recordBaseCopy(objectId: string, copy: PublishedBase): void {
		const previous = state.bases![objectId];
		if (previous?.hash === copy.hash && previous.scope === copy.scope) {
			previous.eventIds = [...new Set([...previous.eventIds, ...copy.eventIds])];
			previous.everywhere ||= copy.everywhere;
			previous.createdAt = Math.max(previous.createdAt, copy.createdAt);
			if (copy.blob) previous.blob = copy.blob;
		} else {
			state.bases![objectId] = copy;
		}
		dirty = true;
	}

	/** `blob`: the Blossom blob a pointer base came from. */
	async function importBaseB64(b64: string, space: SharedSpace | null, signer: string, eventIds: string[], createdAt: number, blob?: string): Promise<ImportedBase | undefined> {
		const provenance = space ? { spaceId: space.spaceId, keyId: space.keyId, signer } : undefined;
		const res = await localPost<{ rejected: number; items: ImportedBase[] }>("/api/bases", { bases: [b64], provenance });
		if (res.rejected > 0) throw new Error("Base import rejected");
		noteBaseAt(space?.spaceId ?? "", createdAt);
		const row = res.items[0];
		if (!row) return undefined;
		if (row.current && signer === id!.pk && (!space || (space.owner ?? id!.pk) === id!.pk)) {
			recordBaseCopy(row.objectId, { scope: space ? `${space.spaceId}/${space.keyId}` : "", hash: row.hash, epoch: row.epoch, eventIds, createdAt, everywhere: false, ...(blob ? { blob } : {}) });
		}
		// A newer base can turn our held deltas (published or not) into orphans.
		if (row.stored && sweepReady) void rebasePass();
		return row;
	}

	// ── Outdated checkpoints (docs/checkpoint-sync.md, "Sweeping") ──
	//
	// Own 1079 groups the daemon reports superseded, per object and bytes
	// hash: every event carrying those bytes (all chunk parts, republished
	// copies). In memory - the startup walk rebuilds it from the relays.
	const sweepCandidates = new Map<string, Map<string, Set<string>>>();
	/** Objects whose recorded relay copy was published but not verified held by the daemon. */
	const unverifiedCopies = new Set<string>();
	/** Completed own chunk groups -> their import row, so republished parts join the same bytes. */
	const checkpointGroups = new Map<string, ImportedCheckpoint>();
	/** GLON_CHECKPOINT_SWEEP_DRY_RUN=1: log what a sweep would delete, delete nothing. */
	const SWEEP_DRY_RUN = process.env.GLON_CHECKPOINT_SWEEP_DRY_RUN === "1";
	/** Off during the startup walk: one sweep follows it, then candidates trigger passes. */
	let sweepReady = false;
	let sweepBusy = false;
	let sweepAgain = false;

	function addSweepCandidate(objectId: string, hash: string, eventIds: readonly string[]): void {
		const fresh = eventIds.filter((eid) => !state.checkpointDeletes![eid]);
		if (fresh.length === 0) return;
		let byHash = sweepCandidates.get(objectId);
		if (!byHash) sweepCandidates.set(objectId, (byHash = new Map()));
		let ids = byHash.get(hash);
		if (!ids) byHash.set(hash, (ids = new Set()));
		for (const eid of fresh) ids.add(eid);
		if (sweepReady) void sweepCheckpoints();
	}

	/**
	 * `eventIds` carry the object's checkpoint on the relay. The same bytes as
	 * the recorded copy: more carriers of it. Other bytes: they become the
	 * copy, and when the daemon verifiably held the previous copy and holds
	 * this one now, the previous one is covered (what the daemon holds only
	 * grows by containment) - a sweep candidate.
	 */
	function recordRelayCopy(objectId: string, hash: string, heads: readonly string[], eventIds: readonly string[], held: boolean): void {
		const previous = state.checkpoints![objectId];
		if (previous?.hash === hash) {
			previous.eventIds = [...new Set([...previous.eventIds, ...eventIds])];
		} else {
			if (previous && held && !unverifiedCopies.has(objectId)) addSweepCandidate(objectId, previous.hash, previous.eventIds);
			state.checkpoints![objectId] = { hash, heads: [...heads].sort(), eventIds: [...eventIds] };
		}
		if (held) unverifiedCopies.delete(objectId);
		else unverifiedCopies.add(objectId);
		dirty = true;
	}

	/**
	 * A 1079 from the relays. The daemon decides whether it takes it (covers a
	 * superset of the stored one, then larger hash) and enforces the shared
	 * owner rule via provenance. Signed by us (personal, or a space we own):
	 * when the daemon holds exactly these bytes afterwards, it is what the
	 * relay has for the object - remember it so the checkpoint pass does not
	 * republish; when what it holds supersedes them, they are outdated - a
	 * sweep candidate. Anything else (an incomparable fork from another
	 * device, anyone else's checkpoint) stays on the relay, never deleted: it
	 * may be the only copy of a branch. Returns the row of an own checkpoint.
	 */
	async function importCheckpointB64(b64: string, space: SharedSpace | null, signer: string, eventIds: string[]): Promise<ImportedCheckpoint | undefined> {
		const provenance = space ? { spaceId: space.spaceId, keyId: space.keyId, signer } : undefined;
		const res = await localCheckpointImport([b64], provenance);
		if (res.rejected > 0) throw new Error("Checkpoint import rejected");
		if (signer !== id!.pk || (space && (space.owner ?? id!.pk) !== id!.pk)) return undefined;
		for (const row of res.items) {
			if (row.held) recordRelayCopy(row.objectId, row.hash, row.heads, eventIds, true);
			else if (row.superseded) addSweepCandidate(row.objectId, row.hash, eventIds);
		}
		return res.items[0];
	}

	/** A republished part of a completed own group: one more carrier of the same bytes. */
	function noteCheckpointCarrier(row: ImportedCheckpoint, eventId: string): void {
		const copy = state.checkpoints![row.objectId];
		if (copy?.hash === row.hash) {
			if (copy.eventIds.includes(eventId)) return;
			copy.eventIds.push(eventId);
			dirty = true;
		} else if (row.superseded || sweepCandidates.get(row.objectId)?.has(row.hash)) {
			addSweepCandidate(row.objectId, row.hash, [eventId]);
		}
	}

	/** `b`: a delta's base tag; `createdAt`: a base's 31078 event time. */
	async function importEvent(kind: number, b64: string, space: SharedSpace | null, signer: string, eventIds: string[], b: string | undefined, createdAt: number): Promise<{ checkpoint?: ImportedCheckpoint; base?: ImportedBase }> {
		if (kind === CHECKPOINT_KIND) return { checkpoint: await importCheckpointB64(b64, space, signer, eventIds) };
		if (kind === BASE_KIND) return { base: await importBaseB64(b64, space, signer, eventIds, createdAt) };
		await importB64(b64, space, signer, eventIds, b);
		return {};
	}

	/**
	 * A pointer base's bytes (docs/state-sync.md "Oversized bases"): the blob
	 * from the URL its writer recorded, else from our Blossom server; it must
	 * hash to its name, decrypt under the pointer's key and hash to the base
	 * the pointer names (writers never serialize base_hash). Base64, as an
	 * inline base arrives.
	 */
	async function fetchPointerBase(pointer: BasePointer): Promise<string> {
		let last: unknown = new Error("No Blossom server to ask.");
		for (const source of pointer.url ? [pointer.url, ""] : [""]) {
			try {
				const cipher = await download(pointer.sha256, source || (await blossomServer(id!.relays)));
				if (cipher.byteLength !== pointer.size) throw new Error("Base blob has the wrong size.");
				const plain = decryptBlob(cipher, Buffer.from(pointer.key, "hex"));
				if (sha256Hex(plain) !== pointer.hash) throw new Error("Base blob does not match its pointer.");
				return Buffer.from(plain).toString("base64");
			} catch (err) {
				last = err;
			}
		}
		throw last;
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

	/** Bases bound every replay: nothing older than `historyFloor` is ever re-walked. */
	function retainReplaySince(createdAt: number): void {
		const since = Math.max(createdAt, historyFloor);
		if (state.replaySince === undefined || since < state.replaySince) {
			state.replaySince = since;
			dirty = true;
		}
	}

	let replayFaultGeneration = 0;
	let replayScanGeneration = 0;
	let activeReplayScans = 0;
	let activeImports = 0;
	// Events whose rejection was already logged: a replayed or re-delivered
	// event is refused again, but says so once. Bounded by clearing.
	const loggedRejections = new Set<string>();
	function logRejection(eventId: string, reason: string): void {
		if (loggedRejections.has(eventId)) return;
		if (loggedRejections.size >= 4096) loggedRejections.clear();
		loggedRejections.add(eventId);
		console.warn(`[sync] event ${eventId.slice(0, 8)} refused by the store: ${reason}`);
	}
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

	/**
	 * Contract §5 member signal: the owner's kind-5 over a shared space's
	 * stream means the space was deleted for everyone, so it vanishes here
	 * too - the ledger change then wipes this identity's own copies on the
	 * relays. A space we own is the ledger's business, never a relay event's.
	 */
	async function onSpaceDeletion(event: Event): Promise<void> {
		if (!verifyEvent(event)) return;
		for (const space of sharedSpaces.values()) {
			const owner = space.owner ?? id!.pk;
			if (owner === id!.pk || event.pubkey !== owner || vanished.has(space.spaceId)) continue;
			if (!event.tags.some((tag) => tag[0] === "h" && tag[1] === space.spaceTag)) continue;
			// Claimed before the await: live, catchup and backfill may all deliver the signal.
			vanished.set(space.spaceId, { objectId: space.spaceId, at: Date.now() });
			try {
				await mutate("vanish", { object_ids: [space.spaceId] });
				console.log(`[sync] space ${space.spaceId.slice(0, 8)} deleted by its owner ${owner.slice(0, 8)} - vanished here`);
			} catch (err) {
				vanished.delete(space.spaceId);
				console.error(`[sync] vanishing space ${space.spaceId.slice(0, 8)} failed:`, err instanceof Error ? err.message : err);
			}
		}
	}

	async function onRelayEvent(event: Event): Promise<void> {
		if (event.kind === DELETE_KIND) return onSpaceDeletion(event);
		let importing = false;
		activeImports++;
		try {
			if ((event.kind !== CHANGE_KIND && event.kind !== CHECKPOINT_KIND && event.kind !== BASE_KIND && event.kind !== BASE_PART_KIND) || !verifyEvent(event)) return;
			const dec = decryptEvent(event);
			if (!dec) return;
			const { part, space } = dec;
			const chunkTags = event.tags.filter((t) => t[0] === "c");
			if (chunkTags.length > 1) return;
			if (chunkTags.length === 0) {
				// A 1080 is only ever part 2..n of a base: without `c` it is nothing.
				if (event.kind === BASE_PART_KIND) return;
				const blobTag = event.kind === BASE_KIND ? event.tags.find((t) => t[0] === "blob") : undefined;
				if (blobTag && part.startsWith("{")) {
					// A pointer base; an unknown pointer version is skipped, as readers older than pointers skip them all.
					const pointer = basePointerOf(blobTag, part);
					if (!pointer) return;
					importing = true;
					await importBaseB64(await fetchPointerBase(pointer), space, event.pubkey, [event.id], event.created_at, pointer.sha256);
				} else {
					importing = true;
					await importEvent(event.kind, part, space, event.pubkey, [event.id], baseTagOf(event), event.created_at);
				}
			} else {
				const [, gid, idxStr, totalStr] = chunkTags[0];
				if (!gid || !/^[0-9a-f]{16}$/.test(gid) || !/^(0|[1-9][0-9]*)$/.test(idxStr ?? "") || !/^[1-9][0-9]*$/.test(totalStr ?? "")) return;
				const index = Number(idxStr);
				const total = Number(totalStr);
				if (!Number.isSafeInteger(total) || total < 2 || total > 64 || !Number.isSafeInteger(index) || index >= total) return;
				if (part.length === 0 || part.length > CHUNK_CHARS || !/^[A-Za-z0-9+/=]+$/.test(part)) return;
				// A base's 31078 (part 0) and its 1080s (parts 1..n-1) are one group.
				const groupKind = event.kind === BASE_PART_KIND ? BASE_KIND : event.kind;
				const groupKey = JSON.stringify([groupKind, event.pubkey, space?.spaceId ?? null, space?.keyId ?? null, gid]);
				if (completedChunkGroups.has(groupKey)) {
					const row = checkpointGroups.get(groupKey);
					if (row) noteCheckpointCarrier(row, event.id);
					const base = baseGroups.get(groupKey);
					const copy = base ? state.bases![base.objectId] : undefined;
					if (base && copy?.hash === base.hash && !copy.eventIds.includes(event.id)) {
						copy.eventIds.push(event.id);
						dirty = true;
					}
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
					group = { total, parts: new Map(), eventIds: [], bytes: 0, expires: Date.now() + CHUNK_TTL_MS, since: event.created_at };
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
				// A republished part (same bytes, another event) carries the group too.
				if (!group.eventIds.includes(event.id)) group.eventIds.push(event.id);
				group.b ??= baseTagOf(event);
				if (event.kind === BASE_KIND) group.anchorAt = event.created_at;
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
					const rows = await importEvent(groupKind, full, space, event.pubkey, group.eventIds, group.b, group.anchorAt ?? event.created_at);
					if (rows.checkpoint) checkpointGroups.set(groupKey, rows.checkpoint);
					if (rows.base) baseGroups.set(groupKey, rows.base);
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
		} catch (err) {
			if (importing) recordReplayFault(event.created_at);
			if (err instanceof ImportRejected) logRejection(event.id, err.reason);
			/* otherwise not ours / garbled / unavailable native import — leave unpublished */
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
		sharedSpaces = await loadSharedSpaces(id!, vanished);
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

	/**
	 * Freshly joined space streams: bases first; a space with bases is read
	 * by #b plus its stream since its newest base minus a day, one without
	 * (pre-migration) by full backwards pagination.
	 */
	async function backfillSpaceTags(tags: string[]): Promise<void> {
		// One space at a time: each stream has its own floor.
		for (const tag of tags) await backfillSpaceTag(tag);
	}
	async function backfillSpaceTag(tag: string): Promise<void> {
		const tags = [tag];
		const fetched = await fetchBases([{ kinds: [BASE_KIND], "#h": tags }]);
		const since = fetched.count > 0 ? Math.max(0, fetched.newestAt - BASE_FLOOR_SLACK_S) : 0;
		const filters: Filter[] = [{ kinds: [CHANGE_KIND, CHECKPOINT_KIND], "#h": tags, since }, { kinds: [DELETE_KIND], "#h": tags }];
		if (fetched.count > 0) {
			const hashes = Object.values(await localBases()).map((row) => row.hash).filter((hash) => hash !== "");
			for (let i = 0; i < hashes.length; i += HTAG_BATCH) filters.push({ kinds: [CHANGE_KIND], "#b": hashes.slice(i, i + HTAG_BATCH) });
		}
		const events = new Map<string, Event>();
		const scan = beginReplayScan(since);
		const complete = await scanRelayHistory(pool, id!.relays, filters, (event) => events.set(event.id, event));
		// Checkpoints first so each object renders from its cache while its originals stream in.
		const sorted = [...events.values()].sort((a, b) => b.kind - a.kind || a.created_at - b.created_at);
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
		// A vanished or left space never comes back through an old invite.
		if (vanished.has(p.space)) {
			console.log(`[sync] ignored a gift-wrapped key for deleted space ${p.space.slice(0, 8)}`);
			return;
		}
		const keyId = p.keyId ?? 1;
		const keyring: Keyring = (await readKeyring()) ?? {};
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
				if (p.t !== "join-request" || !p.space || vanished.has(p.space)) return;
				// Only the space's administrator collects requests.
				const space = sharedSpaces.get(p.space);
				const entryOwnerOk = !space?.owner || space.owner === id!.pk;
				let holdsKey = !!space;
				if (!holdsKey) {
					const entry = (await readKeyring())?.channels?.[p.space];
					holdsKey = !!entry?.key && (!entry.owner || entry.owner === id!.pk);
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

	// ── Checkpoints (docs/checkpoint-sync.md) ──────────────────────
	//
	// One 1079 per object this identity may speak for: every personal
	// object and every object of a space it owns. A pass rebuilds where
	// heads moved and publishes. Checkpoints are replay caches: the 1078
	// history stays the truth and every replica reconciles it in full. An
	// outdated checkpoint of ours is deleted from the relay only once the
	// daemon proves it covered and a covering copy of ours is there (the
	// sweep below); incomparable and foreign ones are never touched.

	function sameList(a: readonly string[], b: readonly string[]): boolean {
		return a.length === b.length && a.every((x, i) => x === b[i]);
	}

	let checkpointBusy = false;
	async function checkpointPass(): Promise<void> {
		if (checkpointBusy) return;
		checkpointBusy = true;
		try {
			const rows = await localCheckpoints();
			// A base supersedes the object's checkpoint, and its pruned working set cannot build one.
			const based = await localBases().catch(() => ({}) as Record<string, BaseRow>);
			let built = 0;
			for (const [objectId, row] of Object.entries(rows)) {
				if (vanished.has(objectId) || objectId === VANISH_LOG_ID || row.heads.length === 0 || based[objectId]?.hash) continue;
				const space = sharedSpaces.get(spaceMap.get(objectId) ?? "") ?? null;
				if (space?.owner && space.owner !== id!.pk) continue; // the owner's harness speaks for its space
				const heads = [...row.heads].sort();
				const current = state.checkpoints![objectId];
				if (row.checkpointHash && sameList([...(row.checkpointHeads ?? [])].sort(), heads) && current?.hash === row.checkpointHash) continue;
				let cp: BuiltCheckpoint;
				try {
					// 409 while the daemon's history is incomplete (a parent or a
					// covered original still missing): the object keeps syncing
					// as changes and the next pass tries again.
					cp = await localCheckpointBuild(objectId);
				} catch (err) {
					console.error(`[sync] checkpoint build failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
					continue;
				}
				built++;
				if (cp.b64.length > CHUNK_CHARS * 64) {
					console.error(`[sync] checkpoint for ${objectId.slice(0, 8)} exceeds 64 chunks; object keeps syncing as changes`);
					continue;
				}
				if (current?.hash === cp.hash) continue; // the relay already holds these bytes
				const provenance = space ? { spaceId: space.spaceId, keyId: space.keyId, signer: id!.pk } : undefined;
				enqueueCheckpoint(objectId, cp.hash, cp.b64, async (eventIds) => {
					// The previous copy only counts as covered if the daemon still
					// holds exactly what went out - ask it rather than assume.
					let held = false;
					try {
						held = (await localCheckpointImport([cp.b64], provenance)).items.some((item) => item.objectId === objectId && item.hash === cp.hash && item.held);
					} catch (err) {
						console.error(`[sync] checkpoint verify failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
					}
					recordRelayCopy(objectId, cp.hash, cp.heads, eventIds, held);
				});
			}
			if (built > 0) console.log(`[sync] checkpoint pass: ${built} rebuilt`);
		} catch (err) {
			console.error("[sync] checkpoint pass failed:", err instanceof Error ? err.message : err);
		} finally {
			checkpointBusy = false;
		}
	}

	/**
	 * Delete outdated own checkpoints from the relays. A candidate group goes
	 * only when its object's recorded relay copy is not that group and is
	 * exactly what the daemon holds now: the candidate was covered by what
	 * the daemon held when it was imported, and that only grows by
	 * containment, so the copy on the relay covers it. NIP-09 kind 5 with
	 * `k` 1079 only, ≤ DELETE_BATCH ids each, paced; ids accepted by every
	 * relay are remembered and never requested again.
	 */
	async function sweepCheckpoints(): Promise<void> {
		if (sweepBusy) {
			sweepAgain = true;
			return;
		}
		sweepBusy = true;
		try {
			do {
				sweepAgain = false;
				if (sweepCandidates.size > 0) await sweepPass();
			} while (sweepAgain);
		} catch (err) {
			console.error("[sync] checkpoint sweep failed:", err instanceof Error ? err.message : err);
		} finally {
			sweepBusy = false;
		}
	}

	async function sweepPass(): Promise<void> {
		const held = await localCheckpoints();
		const victims: string[] = [];
		let objects = 0;
		let waiting = 0;
		for (const [objectId, byHash] of sweepCandidates) {
			const copy = state.checkpoints![objectId];
			if (vanished.has(objectId)) {
				sweepCandidates.delete(objectId); // the vanish chase takes every event of it
				continue;
			}
			const covered = !!copy && held[objectId]?.checkpointHash === copy.hash;
			const keep = new Set(copy?.eventIds);
			let found = 0;
			for (const [hash, ids] of byHash) {
				if (hash === copy?.hash) {
					byHash.delete(hash); // these bytes are the copy itself
					continue;
				}
				for (const eid of ids) {
					if (state.checkpointDeletes![eid] || keep.has(eid)) ids.delete(eid);
					else if (!covered) waiting++;
					else {
						victims.push(eid);
						found++;
					}
				}
				if (ids.size === 0) byHash.delete(hash);
			}
			if (byHash.size === 0) sweepCandidates.delete(objectId);
			if (found > 0) objects++;
		}
		if (SWEEP_DRY_RUN) {
			console.log(`[sync] checkpoint sweep (dry run): ${victims.length} event(s) across ${objects} object(s) would be deleted`);
			return;
		}
		let requests = 0;
		let retry = 0;
		for (let i = 0; i < victims.length; i += DELETE_BATCH) {
			const batch = victims.slice(i, i + DELETE_BATCH);
			const result = await publishDeleteRequests(pool, id!, batch, "checkpoint superseded", [CHECKPOINT_KIND]);
			requests += result.requests;
			if (!result.complete) {
				retry += batch.length;
				continue;
			}
			for (const eid of batch) state.checkpointDeletes![eid] = true;
			dirty = true;
		}
		// Requested ids leave the candidate sets; the rest wait for the next pass.
		for (const [objectId, byHash] of sweepCandidates) {
			for (const [hash, ids] of byHash) {
				for (const eid of ids) if (state.checkpointDeletes![eid]) ids.delete(eid);
				if (ids.size === 0) byHash.delete(hash);
			}
			if (byHash.size === 0) sweepCandidates.delete(objectId);
		}
		console.log(`[sync] checkpoint sweep: ${victims.length} event(s) across ${objects} object(s), ${requests} delete request(s)${retry > 0 ? `, ${retry} to retry` : ""}${waiting > 0 ? `, ${waiting} awaiting a covering copy` : ""}`);
	}

	// ── State sync: rebase, compaction, pre-migration sweep ───────
	//
	// docs/state-sync.md. The daemon classifies, rebases and builds bases;
	// this side decides who may, publishes, and asks the relays to delete
	// what a published base folded.

	/**
	 * Own orphans only (the daemon never rebases another device's, it discards
	 * them): personal objects always; a space's objects only for a writer of the space.
	 */
	let rebaseBusy = false;
	let rebaseAgain = false;
	async function rebasePass(): Promise<void> {
		if (rebaseBusy) {
			rebaseAgain = true;
			return;
		}
		rebaseBusy = true;
		try {
			do {
				rebaseAgain = false;
				let rebased = 0;
				for (const [objectId, row] of Object.entries(await localBases())) {
					if (!row.hash || !row.rebase || vanished.has(objectId)) continue;
					const space = sharedSpaces.get(spaceMap.get(objectId) ?? "");
					if (space && !space.writers.has(id!.pk)) continue;
					try {
						const out = await localPost<{ base: string; changes: Array<{ orphan: string; id: string }> }>("/api/bases/rebase", { objectId });
						rebased += out.changes.length;
						// The rebased changes are live and pending: they go out with their `b`.
						if (out.changes.length > 0) await publishObject(objectId);
					} catch (err) {
						console.error(`[sync] rebase failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
					}
				}
				if (rebased > 0) console.log(`[sync] rebased ${rebased} own orphan change(s) onto current bases`);
			} while (rebaseAgain);
		} catch (err) {
			console.error("[sync] rebase pass failed:", err instanceof Error ? err.message : err);
		} finally {
			rebaseBusy = false;
		}
	}

	/**
	 * Compaction is the serving computer's job (machine.ts servesHere). An
	 * object nobody serves (no pin, no agent) falls to the roster's smallest
	 * machine id, so every object gets a base and a bounded history walk
	 * still reaches it.
	 */
	async function compactsHere(objectId: string): Promise<boolean> {
		if (await servesHere(objectId)) return true;
		if ((await serverOf(objectId)).machineId !== "") return false;
		const roster = (await machines()).map((m) => m.machineId).filter(Boolean).sort();
		return roster.length === 0 || roster[0] === (await machineId());
	}

	/**
	 * Seal through the core (via the daemon) and publish the parts before the
	 * 31078. Records our relay copy; true only when every relay accepted every
	 * event - the condition for deleting anything the base folded. Every event
	 * is followed by PUBLISH_SPACING_MS, the last one too: a compaction pass
	 * publishes one base after another, and RoostrRelay refuses more than 30
	 * events a second per connection ("rate-limited: too many events").
	 */
	async function publishBase(objectId: string, b64: string, space: SharedSpace | null): Promise<boolean> {
		const request = {
			base: b64,
			conversationKey: Buffer.from(space ? space.convKey : id!.conversationKey).toString("hex"),
			space: space ? { keyHex: space.keyHex, spaceId: space.spaceId, owner: space.owner ?? id!.pk } : undefined,
		};
		let sealed = await localPost<SealedBase>("/api/bases/seal", request);
		if (sealed.needsBlob && sealed.blobKey) {
			// Too big for 64 parts (docs/state-sync.md "Oversized bases"): the
			// encrypted base goes to Blossom and the 31078 carries a pointer.
			const { cipher } = encryptBlob(Buffer.from(b64, "base64"), Buffer.from(sealed.blobKey, "hex"));
			const stored = await upload(cipher, "base", await blossomServer(id!.relays), id!);
			sealed = await localPost<SealedBase>("/api/bases/seal", { ...request, blob: { sha256: stored.sha256, size: cipher.byteLength, url: stored.url } });
			console.log(`[sync] base for ${objectId.slice(0, 8)} is ${(cipher.byteLength / 1e6).toFixed(1)} MB: stored on Blossom as ${stored.sha256.slice(0, 12)}`);
		}
		if (!sealed.event) throw new Error("Sealing the base returned no event.");
		const templates = [...(sealed.parts ?? []), sealed.event];
		const eventIds: string[] = [];
		let everywhere = true;
		let createdAt = 0;
		for (const template of templates) {
			const event = finalizeEvent({ kind: template.kind, tags: template.tags, content: template.content, created_at: Math.floor(Date.now() / 1000) }, id!.sk);
			const results = await Promise.allSettled(pool.publish(id!.relays, event));
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, PUBLISH_SPACING_MS);
			await promise;
			if (!results.some((result) => result.status === "fulfilled")) {
				console.error(`[sync] base for ${objectId.slice(0, 8)} refused by every relay; retried next pass`);
				return false;
			}
			if (results.length !== id!.relays.length || results.some((result) => result.status === "rejected")) everywhere = false;
			eventIds.push(event.id);
			if (template.kind === BASE_KIND) createdAt = event.created_at;
		}
		recordBaseCopy(objectId, { scope: space ? `${space.spaceId}/${space.keyId}` : "", hash: sealed.hash, epoch: sealed.epoch, eventIds, createdAt, everywhere, ...(sealed.blob ? { blob: sealed.blob.sha256 } : {}) });
		const pending = state.compactions![objectId];
		if (pending?.hash === sealed.hash) pending.createdAt = createdAt;
		return everywhere;
	}

	/** Change id -> carrying event ids, read from 1078s we can open (a chunked change is named by its part 0). */
	function changeEventIds(events: readonly Event[]): Map<string, string[]> {
		const groups = new Map<string, { changeId?: string; eventIds: string[] }>();
		for (const event of events) {
			if (event.kind !== CHANGE_KIND) continue;
			const dec = decryptEvent(event);
			if (!dec) continue;
			const chunk = event.tags.find((tag) => tag[0] === "c");
			const key = chunk ? `${event.pubkey}/${chunk[1]}` : event.id;
			let group = groups.get(key);
			if (!group) groups.set(key, (group = { eventIds: [] }));
			group.eventIds.push(event.id);
			if (!chunk || chunk[2] === "0") group.changeId ??= changeIdOfPart(dec.part) ?? undefined;
		}
		const out = new Map<string, string[]>();
		for (const group of groups.values()) if (group.changeId) out.set(group.changeId, [...(out.get(group.changeId) ?? []), ...group.eventIds]);
		return out;
	}

	/** Relay events of the folded deltas: known carriers, else the previous base's #b stream read back. */
	async function foldedEventIds(pending: PendingCompaction): Promise<string[]> {
		const out = new Set<string>();
		const missing = new Set<string>();
		for (const hex of pending.folded) {
			const known = deltaEvents.get(hex);
			if (known) for (const eid of known) out.add(eid);
			else missing.add(hex);
		}
		if (missing.size > 0 && pending.prevBase) {
			const events: Event[] = [];
			await scanRelayHistory(pool, id!.relays, [{ kinds: [CHANGE_KIND], "#b": [pending.prevBase] }], (event) => events.push(event));
			for (const [hex, eventIds] of changeEventIds(events)) {
				if (!missing.delete(hex)) continue;
				for (const eid of eventIds) out.add(eid);
			}
		}
		if (missing.size > 0) console.log(`[sync] ${missing.size} folded delta(s) not found on the relays (already gone, or written without a base tag)`);
		return [...out];
	}

	/**
	 * After a base reached every relay (or a newer base was built on it):
	 * NIP-09 the deltas it folded (`e`, k 1078) and our previous copies at its
	 * address (`a` dated just before our copy, so the copy itself stays, plus
	 * `e` for their 1080 parts). Kept and retried until every relay accepted;
	 * then the Blossom blobs of previous pointer bases join `blobDeletes`.
	 */
	async function cleanupCompaction(objectId: string, space: SharedSpace | null, row: BaseRow): Promise<void> {
		const pending = state.compactions![objectId];
		if (!pending) return;
		const copy = state.bases![objectId];
		const out = pending.hash === row.hash ? copy?.hash === pending.hash && copy.everywhere : row.prevBase === pending.hash;
		if (!out) {
			if (pending.hash !== row.hash && row.prevBase !== pending.hash) {
				// Another base won before the cleanup: what this one folded may not be folded there.
				delete state.compactions![objectId];
				dirty = true;
				console.log(`[sync] base ${pending.hash.slice(0, 8)} of ${objectId.slice(0, 8)} superseded before its cleanup; nothing deleted`);
			}
			return;
		}
		let complete = true;
		let deleted = 0;
		if (pending.folded.length > 0) {
			const eventIds = await foldedEventIds(pending);
			const result = await publishDeleteRequests(pool, id!, eventIds, "folded into a base", [CHANGE_KIND]);
			complete &&= result.complete;
			deleted += eventIds.length;
		}
		const createdAt = pending.createdAt ?? (copy?.hash === pending.hash ? copy.createdAt : undefined);
		if (pending.prevBase || pending.previous.length > 0) {
			const keep = new Set(copy?.eventIds);
			const eventIds = [...new Set(pending.previous.flatMap((p) => p.eventIds))].filter((eid) => !keep.has(eid));
			const d = space ? blindShared(space.keyHex, `base:${objectId}`) : blindObjectId(id!, `base:${objectId}`);
			const addresses = createdAt ? [`${BASE_KIND}:${id!.pk}:${d}`] : [];
			if (eventIds.length > 0 || addresses.length > 0) {
				const result = await publishDeleteRequests(pool, id!, eventIds, "base superseded", [BASE_KIND, BASE_PART_KIND], { addresses, createdAt: createdAt ? createdAt - 1 : undefined });
				complete &&= result.complete;
				deleted += eventIds.length;
			}
		}
		if (complete) {
			// Only once every relay took the deletion: a pointer a relay still serves must still resolve.
			const keepBlob = copy?.hash === pending.hash ? copy.blob : undefined;
			for (const previous of pending.previous) if (previous.blob && previous.blob !== keepBlob) state.blobDeletes![previous.blob] = true;
			delete state.compactions![objectId];
			if (deleted > 0 || pending.prevBase) console.log(`[sync] compaction of ${objectId.slice(0, 8)} (epoch ${pending.epoch}): deleted ${deleted} event(s)${pending.prevBase ? " and the previous base" : ""}`);
			await deleteSupersededBlobs();
		}
		dirty = true;
	}

	/**
	 * BUD-02 DELETE every queued blob of a superseded pointer base. A failure
	 * (server down, a server without DELETE) leaves it queued for the next
	 * pass and never holds back a compaction: an orphaned blob only costs
	 * storage.
	 */
	async function deleteSupersededBlobs(): Promise<void> {
		const queued = Object.keys(state.blobDeletes!);
		if (queued.length === 0) return;
		const server = await blossomServer(id!.relays);
		for (const sha of queued) {
			try {
				await deleteBlob(sha, server, id!);
				delete state.blobDeletes![sha];
				dirty = true;
				console.log(`[sync] deleted superseded base blob ${sha.slice(0, 12)} from Blossom`);
			} catch (err) {
				console.error(`[sync] deleting base blob ${sha.slice(0, 12)} failed (retried next pass):`, err instanceof Error ? err.message : err);
			}
		}
	}

	/**
	 * Make sure the object's current base is out: one built here (by this
	 * pass, or POST /api/bases/build by hand) but not (everywhere) on the
	 * relays yet, or one that must go out under a space key now. Runs for
	 * every object, not only those compacted here: a held base nobody
	 * publishes holds the changes it folded only locally. False = not out.
	 */
	async function publishHeldBase(objectId: string, row: BaseRow, space: SharedSpace | null): Promise<boolean> {
		const scope = space ? `${space.spaceId}/${space.keyId}` : "";
		const copy = state.bases![objectId];
		const pending = state.compactions![objectId];
		if (!row.hash || (copy?.hash === row.hash && copy.scope === scope && !(pending?.hash === row.hash && !copy.everywhere))) return true;
		const res = await apiFetch(`${API}/api/bases/${objectId}`);
		if (!res.ok) throw new Error(`Base read failed: ${res.status}`);
		// Daemon response (src/bases.odin GET /api/bases/<objectId>).
		const held = (await res.json()) as { bases: HeldBase[] };
		const current = held.bases.find((base) => base.current);
		return !!current && (await publishBase(objectId, current.b64, space));
	}

	/** One object: make sure its current base is out, finish a pending cleanup, compact when due (or forced: the unbased fallback). True = built. */
	async function compactObject(objectId: string, row: BaseRow, space: SharedSpace | null, force = false): Promise<boolean> {
		const pending = state.compactions![objectId];
		if (!(await publishHeldBase(objectId, row, space))) return false;
		if (pending) await cleanupCompaction(objectId, space, row);
		if (!row.compact && !force) return false;
		const built = await localPost<BuiltBase>("/api/bases/build", force ? { objectId, force: true } : { objectId });
		if (!built.compact || !built.b64 || !built.hash) return false;
		const epoch = built.epoch ?? 1;
		// An unfinished cleanup of the base this one builds on rides along: those deltas are folded in the chain.
		const carried = state.compactions![objectId]?.hash === built.prevBase ? state.compactions![objectId] : undefined;
		const previous = state.bases![objectId];
		state.compactions![objectId] = {
			hash: built.hash,
			epoch,
			prevBase: built.prevBase ?? "",
			folded: [...(carried?.folded ?? []), ...(epoch >= 2 ? (built.folded ?? []) : [])],
			previous: [...(carried?.previous ?? []), ...(previous ? [previous] : [])],
		};
		dirty = true;
		if (await publishBase(objectId, built.b64, space)) await cleanupCompaction(objectId, space, { ...row, hash: built.hash, prevBase: built.prevBase ?? "" });
		return true;
	}

	/**
	 * Compaction (on unless GLON_STATE_SYNC_COMPACT=0; replaces the 1079 checkpoint loop): rebase
	 * own orphans, then for every object compacted here that the core says is due,
	 * build the next base, publish it and clean up. Shared spaces: only spaces
	 * this identity owns. Unbased fallback: every object with no base whose
	 * oldest change is older than UNBASED_FALLBACK_MS gets its epoch-1 base
	 * here, whoever serves it - fresh devices walk a stream only from its
	 * newest base minus a day, so an object left unbased (its computer
	 * offline, or not upgraded yet) would be cut off. Concurrent epoch-1
	 * bases from two computers resolve by the current-base rule.
	 */
	/** Prefix of the Error sync puts on an object it could not compact; only sync writes or clears these. */
	const SYNC_BADGE = "sync failed: ";
	/** An object row's Error text, read from a parsed `/api/objects` or `/api/query` row; "" when it has none. */
	function errorOf(row: unknown): string {
		if (!row || typeof row !== "object" || !("fields" in row)) return "";
		const fields = row.fields;
		if (!fields || typeof fields !== "object" || !("error" in fields)) return "";
		const error = fields.error;
		return error && typeof error === "object" && "stringValue" in error && typeof error.stringValue === "string" ? error.stringValue : "";
	}
	/** Objects whose Error is sync's. */
	async function syncBadged(): Promise<string[]> {
		const res = await apiFetch(`${API}/api/query`, { method: "POST", body: JSON.stringify({ filters: [{ key: "error", condition: "like", value: SYNC_BADGE }], limit: 1000, fields: ["error"] }) });
		if (!res.ok) return [];
		const body: unknown = await res.json();
		const records = body && typeof body === "object" && "records" in body && Array.isArray(body.records) ? body.records : [];
		return records.flatMap((r: unknown) => (r && typeof r === "object" && "id" in r && typeof r.id === "string" && errorOf(r).startsWith(SYNC_BADGE) ? [r.id] : []));
	}
	/**
	 * Put a compaction failure on the object's Error, where a person sees it,
	 * not only in this log: its history stops being packed for the relays.
	 * An Error someone else wrote (a run, a person) is left alone.
	 */
	async function syncBadge(objectId: string, message: string, ours: boolean): Promise<void> {
		const text = `${SYNC_BADGE}${message}`.slice(0, 300);
		try {
			const res = await apiFetch(`${API}/api/objects/${encodeURIComponent(objectId)}`);
			if (!res.ok) return;
			const current = errorOf(await res.json());
			if (current === text || (current && !ours && !current.startsWith(SYNC_BADGE))) return;
			await mutate("set_field", { object_id: objectId, key: "error", value: { stringValue: text } });
		} catch (err) {
			console.error(`[sync] error badge for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	let compactBusy = false;
	async function compactionPass(): Promise<void> {
		if (compactBusy) return;
		compactBusy = true;
		try {
			await rebasePass();
			let built = 0;
			// Objects whose Error says an earlier pass could not compact them: a pass that gets through clears it.
			const flagged = new Set(await syncBadged());
			for (const [objectId, row] of Object.entries(await localBases())) {
				if (vanished.has(objectId) || objectId === VANISH_LOG_ID) continue;
				const space = sharedSpaces.get(spaceMap.get(objectId) ?? "") ?? null;
				if (space && (space.owner ?? id!.pk) !== id!.pk) continue; // the owner's computer compacts its space
				try {
					const fallback = !row.hash && row.oldestMs > 0 && Date.now() - row.oldestMs > UNBASED_FALLBACK_MS;
					if (!fallback && !(await compactsHere(objectId))) {
						await publishHeldBase(objectId, row, space);
						continue;
					}
					if (await compactObject(objectId, row, space, fallback)) built++;
					if (flagged.has(objectId)) await mutate("delete_field", { object_id: objectId, key: "error" }).catch(() => {});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[sync] compaction failed for ${objectId.slice(0, 8)}:`, message);
					await syncBadge(objectId, message, flagged.has(objectId));
				}
			}
			if (built > 0) console.log(`[sync] compaction pass: ${built} base(s) built`);
			await deleteSupersededBlobs();
		} catch (err) {
			console.error("[sync] compaction pass failed:", err instanceof Error ? err.message : err);
		} finally {
			compactBusy = false;
		}
	}

	/**
	 * Rollout step 4, explicit and default off: once every device reads bases,
	 * delete the untagged 1078s an epoch-1 base folded and every 1079 of every
	 * object holding a base, whichever computer compacts it: only covered
	 * events go, all signed by this identity, so one computer can finish the
	 * whole vault. "dry-run" only logs the counts.
	 */
	let premigrationBusy = false;
	async function premigrationSweep(): Promise<void> {
		if (SWEEP_PREMIGRATION === "off" || premigrationBusy) return;
		if (SWEEP_PREMIGRATION === "on" && !COMPACT) {
			console.warn("[sync] GLON_STATE_SYNC_SWEEP_PREMIGRATION=1 needs compaction on (GLON_STATE_SYNC_COMPACT=0 is set) - nothing deleted");
			return;
		}
		premigrationBusy = true;
		try {
			const objectByTag = new Map<string, string>();
			for (const [objectId, row] of Object.entries(await localBases())) {
				if (!row.hash || vanished.has(objectId) || objectId === VANISH_LOG_ID || state.premigrationSwept![objectId]) continue;
				const space = sharedSpaces.get(spaceMap.get(objectId) ?? "") ?? null;
				if (space && (space.owner ?? id!.pk) !== id!.pk) continue;
				objectByTag.set(space ? blindShared(space.keyHex, objectId) : blindObjectId(id!, objectId), objectId);
			}
			const tags = [...objectByTag.keys()];
			const filters: Filter[] = [];
			for (let i = 0; i < tags.length; i += HTAG_BATCH) filters.push({ kinds: [CHANGE_KIND, CHECKPOINT_KIND], "#h": tags.slice(i, i + HTAG_BATCH) });
			const byObject = new Map<string, Event[]>();
			const complete = filters.length === 0 || (await scanRelayHistory(pool, id!.relays, filters, (event) => {
				// Ours, or a member's that consents to our deletion as the space owner.
				if (event.pubkey !== id!.pk && !event.tags.some((tag) => tag[0] === "owner" && tag[1] === id!.pk)) return;
				const objectId = event.tags.filter((tag) => tag[0] === "h").map((tag) => objectByTag.get(tag[1])).find((found) => found !== undefined);
				if (!objectId) return;
				const list = byObject.get(objectId) ?? [];
				if (!list.some((known) => known.id === event.id)) list.push(event);
				byObject.set(objectId, list);
			}));
			let changes = 0;
			let checkpoints = 0;
			let objects = 0;
			let requests = 0;
			let retry = 0;
			for (const [objectId, events] of byObject) {
				const checkpointIds = events.filter((event) => event.kind === CHECKPOINT_KIND).map((event) => event.id);
				const untagged = changeEventIds(events.filter((event) => event.kind === CHANGE_KIND && !baseTagOf(event)));
				const premigration = untagged.size > 0 ? (await localPost<{ premigration: string[] }>("/api/bases/covered", { objectId, ids: [...untagged.keys()] })).premigration : [];
				const victims = [...checkpointIds, ...premigration.flatMap((hex) => untagged.get(hex) ?? [])];
				if (victims.length === 0) continue;
				objects++;
				changes += premigration.length;
				checkpoints += checkpointIds.length;
				if (SWEEP_PREMIGRATION === "dry-run") continue;
				const result = await publishDeleteRequests(pool, id!, victims, "pre-migration history folded into a base", [CHANGE_KIND, CHECKPOINT_KIND]);
				requests += result.requests;
				if (result.complete && complete) {
					state.premigrationSwept![objectId] = true;
					dirty = true;
				} else {
					retry += victims.length;
				}
			}
			if (SWEEP_PREMIGRATION === "dry-run") console.log(`[sync] pre-migration sweep (dry run): ${changes} change(s) and ${checkpoints} checkpoint event(s) across ${objects} object(s) would be deleted${complete ? "" : " (relay scan incomplete)"}`);
			else console.log(`[sync] pre-migration sweep: ${changes} change(s) and ${checkpoints} checkpoint event(s) across ${objects} object(s), ${requests} delete request(s)${retry > 0 ? `, ${retry} to retry` : ""}`);
		} catch (err) {
			console.error("[sync] pre-migration sweep failed:", err instanceof Error ? err.message : err);
		} finally {
			premigrationBusy = false;
		}
	}

	/**
	 * Bases first (docs/state-sync.md "Sync on a device"): every 31078 the
	 * filters match, then their 1080 parts by #c, each through the chunk-aware
	 * import. Returns how many 31078 events came back.
	 */
	async function fetchBases(filters: Filter[]): Promise<{ count: number; newestAt: number; complete: boolean }> {
		const events = new Map<string, Event>();
		let complete = await scanRelayHistory(pool, id!.relays, filters, (event) => {
			if (event.kind === BASE_KIND) events.set(event.id, event);
		});
		const count = events.size;
		const newestAt = [...events.values()].reduce((max, event) => Math.max(max, event.created_at), 0);
		const gids = [...new Set([...events.values()].map((event) => event.tags.find((tag) => tag[0] === "c")?.[1] ?? "").filter((gid) => gid !== ""))];
		const partFilters: Filter[] = [];
		for (let i = 0; i < gids.length; i += HTAG_BATCH) partFilters.push({ kinds: [BASE_PART_KIND], "#c": gids.slice(i, i + HTAG_BATCH) });
		if (partFilters.length > 0) {
			const parts = await scanRelayHistory(pool, id!.relays, partFilters, (event) => {
				if (event.kind === BASE_PART_KIND) events.set(event.id, event);
			});
			complete &&= parts;
		}
		for (const event of [...events.values()].sort((a, b) => a.created_at - b.created_at)) await onRelayEvent(event);
		return { count, newestAt, complete };
	}

	// ── Startup: bases first, then deltas, then publish ───────────
	console.log(`[sync] identity ${id.pk.slice(0, 8)}… relays: ${id.relays.join(", ")}`);
	await refreshShared();
	if (sharedSpaces.size > 0) console.log(`[sync] shared spaces: ${[...sharedSpaces.keys()].map((k) => k.slice(0, 8)).join(", ")}`);
	const spaceTags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);

	const baseFetch = await fetchBases(spaceTags.length > 0 ? [{ kinds: [BASE_KIND], authors: [id.pk] }, { kinds: [BASE_KIND], "#h": spaceTags }] : [{ kinds: [BASE_KIND], authors: [id.pk] }]);
	if (baseFetch.count > 0) console.log(`[sync] bases: ${baseFetch.count} from relays${baseFetch.complete ? "" : " (scan incomplete)"}`);
	const heldBases = await localBases().catch((err) => {
		console.error("[sync] base list failed:", err instanceof Error ? err.message : err);
		return {} as Record<string, BaseRow>;
	});
	const streamOf = (objectId: string): string => {
		const spaceId = spaceMap.get(objectId) ?? "";
		return sharedSpaces.has(spaceId) ? spaceId : "";
	};
	for (const [objectId, row] of Object.entries(heldBases)) if (row.hash) noteBaseAt(streamOf(objectId), Math.floor(row.createdAt / 1000));
	// No base anywhere (a pre-migration vault): today's full walk, unchanged.
	// Bases exist: history is never walked from zero again - deltas come by
	// #b, objects without a base by their own stream, the rest since the
	// newest base minus a day. That floor is per stream (personal, each
	// space): a stream holding no base is walked whole, so an object whose
	// computer has not compacted yet is never cut off by another stream's bases.
	const bounded = newestBaseAt.size > 0;
	const personalFloor = streamFloor("");
	if (bounded) {
		// Live subscriptions and catch-up span every stream: the lowest floor.
		historyFloor = Math.min(personalFloor, ...[...sharedSpaces.keys()].map(streamFloor));
		if (state.replaySince !== undefined && state.replaySince < historyFloor) state.replaySince = historyFloor;
	}
	const manifest = await localManifest();

	// Full walk: page back through EVERYTHING the relays hold (no since -
	// relays drop events silently, so the persisted published-set can't be
	// trusted) and rebuild it from relay reality. Anything in the local
	// manifest the relays didn't return gets re-published below.
	// Checkpoints (1079) never shorten this walk: they are replay caches.
	// Bounded: the persisted published-set stands (covered deltas are gone
	// from the relays on purpose) and only grows from what comes back.
	if (!bounded) {
		state.published = {};
		state.publishedSpace = {};
	}
	state.sharedQueued = {};
	state.checkpoints = {};
	const backfillById = new Map<string, Event>();
	const sinceOf = (floor: number): { since?: number } => (floor > 0 ? { since: floor } : {});
	const backfillFilters: Filter[] = [{ kinds: [CHANGE_KIND, CHECKPOINT_KIND], authors: [id.pk], ...sinceOf(personalFloor) }];
	// The space streams, each from its own floor, and every kind 5 over them: an owner's space-deletion signal (they are few).
	for (const space of sharedSpaces.values()) backfillFilters.push({ kinds: [CHANGE_KIND, CHECKPOINT_KIND], "#h": [space.spaceTag], ...sinceOf(streamFloor(space.spaceId)) });
	if (spaceTags.length > 0) backfillFilters.push({ kinds: [DELETE_KIND], "#h": spaceTags });
	if (bounded) {
		const hashes = Object.values(heldBases).map((row) => row.hash).filter((hash) => hash !== "");
		for (let i = 0; i < hashes.length; i += HTAG_BATCH) backfillFilters.push({ kinds: [CHANGE_KIND], "#b": hashes.slice(i, i + HTAG_BATCH) });
		// Objects with no base yet replay from genesis: their whole stream. The
		// vanish ledger never gets a base, so its stream is always read whole.
		// A stream walked whole already carries them.
		const unbased = [...new Set([...Object.keys(manifest), ...Object.keys(heldBases), VANISH_LOG_ID])].filter((objectId) => !heldBases[objectId]?.hash && streamFloor(streamOf(objectId)) > 0);
		const tags = unbased.map((objectId) => {
			const space = sharedSpaces.get(streamOf(objectId));
			return space ? blindShared(space.keyHex, objectId) : blindObjectId(id, objectId);
		});
		for (let i = 0; i < tags.length; i += HTAG_BATCH) backfillFilters.push({ kinds: [CHANGE_KIND, CHECKPOINT_KIND], "#h": tags.slice(i, i + HTAG_BATCH) });
	}
	const backfillScan = beginReplayScan(historyFloor);
	const backfillComplete = await scanRelayHistory(pool, id.relays, backfillFilters, (event) => backfillById.set(event.id, event));
	const backfill = [...backfillById.values()].filter((event) => event.kind !== BASE_KIND && event.kind !== BASE_PART_KIND);
	console.log(`[sync] backfill: ${backfill.length} event(s) from relays${bounded ? ` (bases held: personal since ${personalFloor}, ${[...sharedSpaces.keys()].filter((s) => streamFloor(s) === 0).length}/${sharedSpaces.size} space(s) whole, deltas by base tag)` : ""}`);
	// Route every event through the chunk-aware path (sorted so multi-part
	// groups assemble in one pass); onRelayEvent advances the cursor.
	// Checkpoints first so an object renders from its cache while its
	// originals stream in.
	backfill.sort((a, b) => b.kind - a.kind || a.created_at - b.created_at);
	let assembled = 0;
	for (const event of backfill) {
		await onRelayEvent(event);
		assembled++;
	}
	finishReplayScan(backfillScan, backfillComplete, true);
	if (assembled > 0) console.log(`[sync] backfill processed ${assembled} event(s)`);
	// Deletions the relays honoured are gone from a complete full walk: forget
	// them so the requested set stays bounded. Ids still served stay
	// remembered and are never requested again.
	if (backfillComplete && !bounded) {
		for (const eid of Object.keys(state.checkpointDeletes!)) if (!backfillById.has(eid)) delete state.checkpointDeletes![eid];
	}
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
	// An owner's signal in the backfill may have vanished a shared space: stop syncing it.
	if ([...sharedSpaces.keys()].some((spaceId) => vanished.has(spaceId))) await refreshShared();
	await chaseVanished();
	// Own orphans first: their rebased changes go out with everything else.
	await rebasePass();

	// Publish local changes the relays don't have (published set carries
	// both prior publishes and everything backfill just returned).
	let toPublish = 0;
	for (const hexes of Object.values(manifest)) {
		for (const hex of hexes) if (!state.published[hex]) toPublish++;
	}
	console.log(`[sync] ${toPublish} local change(s) not known on the relays${vanished.size > 0 ? `, ${vanished.size} object(s) vanished` : ""}`);
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
	// Compaction (bases) replaces the 1079 checkpoint loop once it is on;
	// off, checkpoints keep going out exactly as before. Either rides behind
	// the changes just enqueued.
	const periodic = async () => {
		if (COMPACT) await compactionPass();
		else await rebasePass().then(checkpointPass);
		await sweepCheckpoints();
		await premigrationSweep();
	};
	if (COMPACT) {
		console.log("[sync] compaction on: bases replace checkpoints");
		await compactionPass();
	} else {
		await checkpointPass();
	}
	sweepReady = true;
	void sweepCheckpoints().then(premigrationSweep);
	setInterval(() => void periodic(), CHECKPOINT_INTERVAL_MS);
	persist();

	// ── Live: both directions ──────────────────────────────────────
	subscribe((objectId) => {
		if (objectId === VANISH_LOG_ID) {
			// A vanish happened here or arrived from a peer: re-read the ledger,
			// stop syncing spaces it names, publish the record itself, then
			// chase the relay copies.
			void (async () => {
				vanished = await localVanished();
				if ([...sharedSpaces.keys()].some((spaceId) => vanished.has(spaceId))) {
					await refreshShared();
					subscribeLive();
				}
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
		// Bases bound the floor: a fresh cursor never subscribes to history from zero once they exist.
		const since = Math.max(historyFloor, Math.min(state.cursor, state.replaySince ?? state.cursor));
		liveSubs.push(
			pool.subscribeMany(id!.relays, { kinds: LIVE_KINDS, authors: [id!.pk], since }, {
				onevent: (event) => void onRelayEvent(event),
			}),
		);
		const tags = [...sharedSpaces.values()].map((sp) => sp.spaceTag);
		if (tags.length > 0) {
			liveSubs.push(
				pool.subscribeMany(id!.relays, { kinds: LIVE_KINDS, "#h": tags, since }, {
					onevent: (event) => void onRelayEvent(event),
				}),
			);
			liveSubs.push(
				pool.subscribeMany(id!.relays, { kinds: [DELETE_KIND], "#h": tags }, {
					onevent: (event) => void onSpaceDeletion(event),
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
			pool.querySync(id!.relays, { kinds: LIVE_KINDS, authors: [id!.pk], limit: 1 }),
			tags.length > 0 ? pool.querySync(id!.relays, { kinds: LIVE_KINDS, "#h": tags, limit: 1 }) : Promise.resolve([] as Event[]),
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
		const since = Object.keys(state.pendingChunkGroups!).length > 0 ? historyFloor : Math.max(historyFloor, Math.min(state.cursor, state.replaySince ?? state.cursor));
		const byId = new Map<string, Event>();
		const filters: Filter[] = [{ kinds: LIVE_KINDS, authors: [id!.pk], since }];
		if (tags.length > 0) filters.push({ kinds: LIVE_KINDS, "#h": tags, since }, { kinds: [DELETE_KIND], "#h": tags });
		const scan = beginReplayScan(since);
		const complete = await scanRelayHistory(pool, id!.relays, filters, (event) => byId.set(event.id, event));
		const events = [...byId.values()].sort((a, b) => b.kind - a.kind || a.created_at - b.created_at);
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
	// A left space's objects stay on the relays for its other members.
	const ledger = await localVanished();
	const chased = objectIds.filter((objectId) => !ledger.get(objectId)?.left);
	try {
		const scan = await collectEventIds(pool, id, chased);
		const deletion = await publishDeleteRequests(pool, id, scan.eventIds, "object vanished by its owner");
		for (const objectId of chased) {
			if (scan.complete && deletion.complete) state.vanishRequested[objectId] = true;
			else delete state.vanishRequested[objectId];
		}
		writeState(state);
		return { events: scan.eventIds.length, requests: deletion.requests };
	} finally {
		pool.close(id.relays);
	}
}