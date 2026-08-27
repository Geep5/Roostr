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

import { SimplePool, finalizeEvent, getPublicKey, nip44, type Event } from "nostr-tools";
import { API, subscribe } from "./api";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";

const CHANGE_KIND = 1078;
const KEYRING_KIND = 30078;
const KEYRING_D = "roostr-keyring";

function dataRoot(): string {
	return process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
}

interface SyncState {
	version: 1;
	/** change hex ids already published (or seen from relays). */
	published: Record<string, true>;
	/** newest relay event created_at we've processed, per subscription. */
	cursor: number;
}

function statePath(): string {
	return `${dataRoot()}/sync-state.json`;
}

async function readState(): Promise<SyncState> {
	try {
		const parsed = (await Bun.file(statePath()).json()) as SyncState;
		if (parsed?.version === 1) return parsed;
	} catch {
		/* fresh */
	}
	return { version: 1, published: {}, cursor: 0 };
}

function writeState(state: SyncState): void {
	const tmp = `${statePath()}.tmp`;
	mkdirSync(dataRoot(), { recursive: true });
	writeFileSync(tmp, JSON.stringify(state));
	renameSync(tmp, statePath());
}

interface Identity {
	sk: Uint8Array;
	pk: string;
	conversationKey: Uint8Array;
	relays: string[];
}

async function loadIdentity(): Promise<Identity | null> {
	try {
		const parsed = (await Bun.file(`${dataRoot()}/nostr.json`).json()) as { privkey?: string; relays?: string[] };
		if (!parsed.privkey || parsed.privkey.length !== 64) return null;
		const sk = Uint8Array.from(Buffer.from(parsed.privkey, "hex"));
		const pk = getPublicKey(sk);
		return {
			sk,
			pk,
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

// ── Local server I/O ─────────────────────────────────────────────

async function localManifest(): Promise<Record<string, string[]>> {
	const res = await fetch(`${API}/api/changes`);
	return (await res.json()) as Record<string, string[]>;
}

async function localChanges(objectId: string): Promise<Array<{ id: string; b64: string }>> {
	const res = await fetch(`${API}/api/changes/${objectId}`);
	const out = (await res.json()) as { changes: Array<{ id: string; b64: string }> };
	return out.changes;
}

async function localImport(b64s: string[]): Promise<{ imported: number; rejected: number; ids: string[] }> {
	const res = await fetch(`${API}/api/changes`, { method: "POST", body: JSON.stringify({ changes: b64s }) });
	return (await res.json()) as { imported: number; rejected: number; ids: string[] };
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

	const pool = new SimplePool();
	const state = await readState();
	let dirty = false;
	const persist = () => {
		if (!dirty) return;
		dirty = false;
		writeState(state);
	};
	setInterval(persist, 5000);

	async function publishChange(objectId: string, changeHex: string, b64: string): Promise<void> {
		if (state.published[changeHex]) return;
		const ciphertext = nip44.encrypt(b64, id!.conversationKey);
		const event = finalizeEvent(
			{
				kind: CHANGE_KIND,
				created_at: Math.floor(Date.now() / 1000),
				tags: [["h", blindObjectId(id!, objectId)]],
				content: ciphertext,
			},
			id!.sk,
		);
		await Promise.any(pool.publish(id!.relays, event));
		state.published[changeHex] = true;
		dirty = true;
	}

	async function publishObject(objectId: string): Promise<void> {
		try {
			const changes = await localChanges(objectId);
			for (const c of changes) {
				if (!state.published[c.id]) await publishChange(objectId, c.id, c.b64);
			}
		} catch (err) {
			console.error(`[sync] publish failed for ${objectId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}

	async function onRelayEvent(event: Event): Promise<void> {
		try {
			const b64 = nip44.decrypt(event.content, id!.conversationKey);
			const res = await localImport([b64]);
			// Anything the relay already holds must never be echoed back.
			for (const hex of res.ids) state.published[hex] = true;
			if (event.created_at > state.cursor) state.cursor = event.created_at;
			dirty = true;
		} catch {
			/* not ours / garbled — ignore */
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

	// ── Startup: backfill both directions ─────────────────────────
	console.log(`[sync] identity ${id.pk.slice(0, 8)}… relays: ${id.relays.join(", ")}`);

	// Pull everything newer than our cursor (first run: everything).
	const backfill = await pool.querySync(id.relays, { kinds: [CHANGE_KIND], authors: [id.pk], since: state.cursor || undefined });
	console.log(`[sync] backfill: ${backfill.length} event(s) from relays`);
	const b64s: string[] = [];
	for (const event of backfill) {
		try {
			b64s.push(nip44.decrypt(event.content, id.conversationKey));
			if (event.created_at > state.cursor) state.cursor = event.created_at;
		} catch {
			/* skip */
		}
	}
	if (b64s.length > 0) {
		const res = await localImport(b64s);
		// Relay-held changes are published by definition — never echo them.
		for (const hex of res.ids) state.published[hex] = true;
		console.log(`[sync] imported ${res.imported}, rejected ${res.rejected}`);
	}
	dirty = true;

	const keyringEvents = await pool.querySync(id.relays, { kinds: [KEYRING_KIND], authors: [id.pk], "#d": [KEYRING_D] });
	if (keyringEvents.length > 0) {
		keyringEvents.sort((a, b) => b.created_at - a.created_at);
		await mergeKeyring(keyringEvents[0]);
	}

	// Publish local changes the relays don't have (published set carries
	// both prior publishes and everything backfill just returned).
	const manifest = await localManifest();
	let toPublish = 0;
	for (const hexes of Object.values(manifest)) {
		for (const hex of hexes) if (!state.published[hex]) toPublish++;
	}
	console.log(`[sync] ${toPublish} local change(s) to publish`);
	for (const objectId of Object.keys(manifest)) {
		await publishObject(objectId);
	}
	await publishKeyring();
	persist();

	// ── Live: both directions ──────────────────────────────────────
	subscribe((objectId) => void publishObject(objectId));
	pool.subscribeMany(id.relays, { kinds: [CHANGE_KIND], authors: [id.pk], since: state.cursor + 1 }, {
		onevent: (event) => void onRelayEvent(event),
	});
	pool.subscribeMany(id.relays, { kinds: [KEYRING_KIND], authors: [id.pk], "#d": [KEYRING_D], since: Math.floor(Date.now() / 1000) }, {
		onevent: (event) => void mergeKeyring(event),
	});
	console.log("[sync] live");
}
