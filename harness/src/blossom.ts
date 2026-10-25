/**
 * Files on Blossom (RoostrRelay): each file is encrypted on this computer
 * with a fresh 32-byte key and only the ciphertext leaves it. The File
 * object records `blob_sha256` (of the ciphertext), `blob_key` (hex) and
 * `blob_url`; objects are themselves encrypted on the relays, so the key
 * never travels in clear.
 *
 * Blob format (every host agrees): AES-256-GCM over 4 MiB plaintext frames;
 * frame i uses the 12-byte big-endian nonce i and is written as
 * ciphertext || 16-byte tag; the blob is the frames concatenated. The last
 * frame may be shorter; an empty file is one empty frame (the tag alone).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { finalizeEvent } from "nostr-tools";
import type { Identity } from "./nostrsync";

export const FRAME = 4 * 1024 * 1024;
export const TAG = 16;
export const DEFAULT_BLOSSOM = "https://roostr-relay.fly.dev";
const AUTH_KIND = 24242;
const AUTH_TTL_S = 600;
const NIP11_TIMEOUT_MS = 5_000;
const SHA_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(bytes: Uint8Array): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(bytes);
	return h.digest("hex");
}

/** Frame i's nonce: i as a 12-byte big-endian integer. */
export function frameNonce(i: number): Uint8Array {
	const n = new Uint8Array(12);
	new DataView(n.buffer).setBigUint64(4, BigInt(i));
	return n;
}

/** Encrypt `bytes` under a fresh random key into the framed blob format. */
export function encryptBlob(bytes: Uint8Array, key: Uint8Array = randomBytes(32)): { key: Uint8Array; cipher: Uint8Array } {
	if (key.byteLength !== 32) throw new Error("Blob key must be 32 bytes.");
	const frames = Math.max(1, Math.ceil(bytes.byteLength / FRAME));
	const cipher = new Uint8Array(bytes.byteLength + frames * TAG);
	let out = 0;
	for (let i = 0; i < frames; i++) {
		const c = createCipheriv("aes-256-gcm", key, frameNonce(i));
		const body = c.update(bytes.subarray(i * FRAME, Math.min(bytes.byteLength, (i + 1) * FRAME)));
		const tail = c.final();
		cipher.set(body, out);
		out += body.byteLength;
		cipher.set(tail, out);
		out += tail.byteLength;
		cipher.set(c.getAuthTag(), out);
		out += TAG;
	}
	return { key, cipher };
}

/** Inverse of encryptBlob; throws on a truncated, reordered or tampered blob. */
export function decryptBlob(cipher: Uint8Array, key: Uint8Array): Uint8Array {
	if (key.byteLength !== 32) throw new Error("Blob key must be 32 bytes.");
	if (cipher.byteLength < TAG) throw new Error("Encrypted file is truncated.");
	const frames = Math.ceil(cipher.byteLength / (FRAME + TAG));
	const last = cipher.byteLength - (frames - 1) * (FRAME + TAG);
	if (last < TAG) throw new Error("Encrypted file is truncated.");
	const plain = new Uint8Array(cipher.byteLength - frames * TAG);
	let out = 0;
	for (let i = 0; i < frames; i++) {
		const start = i * (FRAME + TAG);
		const end = Math.min(cipher.byteLength, start + FRAME + TAG);
		const d = createDecipheriv("aes-256-gcm", key, frameNonce(i));
		d.setAuthTag(cipher.subarray(end - TAG, end));
		try {
			const body = d.update(cipher.subarray(start, end - TAG));
			const tail = d.final();
			plain.set(body, out);
			out += body.byteLength;
			plain.set(tail, out);
			out += tail.byteLength;
		} catch {
			throw new Error(`Encrypted file failed authentication (frame ${i}).`);
		}
	}
	return plain;
}

/** ws(s)://host/path → http(s)://host. */
function httpOrigin(relay: string): string | null {
	try {
		const u = new URL(relay);
		const protocol = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
		if (protocol !== "https:" && protocol !== "http:") return null;
		return `${protocol}//${u.host}`;
	} catch {
		return null;
	}
}

/**
 * The Blossom server: GLON_BLOSSOM_URL when set, else the first configured
 * relay whose NIP-11 document lists the "blossom" feature, else RoostrRelay.
 */
export async function discoverServer(relays: string[]): Promise<string> {
	const override = process.env.GLON_BLOSSOM_URL;
	if (override) return override.replace(/\/+$/, "");
	for (const relay of relays) {
		const origin = httpOrigin(relay);
		if (!origin) continue;
		try {
			const res = await fetch(origin, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(NIP11_TIMEOUT_MS) });
			if (!res.ok) continue;
			const doc = (await res.json()) as { supported_features?: unknown };
			if (Array.isArray(doc.supported_features) && doc.supported_features.includes("blossom")) return origin;
		} catch {
			// Unreachable relay or not JSON: not a Blossom server.
		}
	}
	return DEFAULT_BLOSSOM;
}

const servers = new Map<string, Promise<string>>();

/** The Blossom server for these relays, discovered once per process. */
export function blossomServer(relays: string[]): Promise<string> {
	const key = relays.join(" ");
	let server = servers.get(key);
	if (!server) {
		server = discoverServer(relays);
		servers.set(key, server);
	}
	return server;
}

/** BUD-02 blob descriptor. */
export interface BlobDescriptor {
	url: string;
	sha256: string;
	size: number;
	type?: string;
	uploaded?: number;
}

/** A BUD-11 `Authorization` header: a signed kind-24242 event allowing `verb` ("upload", "delete") on `sha`. */
function authorization(identity: Pick<Identity, "sk">, verb: string, sha: string, content: string, now: number): string {
	const event = finalizeEvent(
		{
			kind: AUTH_KIND,
			created_at: now,
			tags: [
				["t", verb],
				["x", sha],
				["expiration", String(now + AUTH_TTL_S)],
			],
			content,
		},
		identity.sk,
	);
	return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

/** The `Authorization` header for uploading `sha`: a signed kind-24242 event (BUD-11). */
export function uploadAuth(identity: Pick<Identity, "sk">, sha: string, name: string, now = Math.floor(Date.now() / 1000)): string {
	return authorization(identity, "upload", sha, `Upload ${name}`, now);
}

/** The `Authorization` header for deleting `sha` (BUD-02 DELETE). */
export function deleteAuth(identity: Pick<Identity, "sk">, sha: string, now = Math.floor(Date.now() / 1000)): string {
	return authorization(identity, "delete", sha, `Delete ${sha}`, now);
}

async function failure(res: Response, what: string): Promise<Error> {
	const reason = res.headers.get("X-Reason") || (await res.text().catch(() => "")).slice(0, 200);
	return new Error(`${what} failed: ${res.status}${reason ? ` ${reason}` : ""}`);
}

/** PUT the ciphertext to `server`; returns the verified descriptor. */
export async function upload(cipher: Uint8Array, name: string, server: string, identity: Pick<Identity, "sk">): Promise<BlobDescriptor> {
	const sha = sha256Hex(cipher);
	const res = await fetch(`${server}/upload`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Length": String(cipher.byteLength),
			"X-SHA-256": sha,
			Authorization: uploadAuth(identity, sha, name),
		},
		body: cipher,
	});
	if (!res.ok) throw await failure(res, "Blossom upload");
	const d = (await res.json()) as Partial<BlobDescriptor>;
	if (typeof d.url !== "string" || typeof d.sha256 !== "string") throw new Error("Blossom upload returned no blob descriptor.");
	if (d.sha256.toLowerCase() !== sha) throw new Error("Blossom stored different bytes than were uploaded.");
	return { url: d.url, sha256: sha, size: typeof d.size === "number" ? d.size : cipher.byteLength, type: d.type, uploaded: d.uploaded };
}

/**
 * GET the ciphertext named `sha` from `source` - a blob URL (as recorded in
 * `blob_url`) or a server origin - and check it hashes to `sha`.
 */
export async function download(sha: string, source: string): Promise<Uint8Array> {
	if (!SHA_RE.test(sha)) throw new Error("Not a blob hash.");
	const url = source.includes(sha) ? source : `${source.replace(/\/+$/, "")}/${sha}`;
	const res = await fetch(url);
	if (!res.ok) throw await failure(res, "Blossom download");
	const cipher = new Uint8Array(await res.arrayBuffer());
	if (sha256Hex(cipher) !== sha) throw new Error("Blossom sent bytes that do not match the file.");
	return cipher;
}

/** BUD-02 DELETE of our blob `sha` on `server`; a blob already gone counts as deleted. */
export async function deleteBlob(sha: string, server: string, identity: Pick<Identity, "sk">): Promise<void> {
	if (!SHA_RE.test(sha)) throw new Error("Not a blob hash.");
	const res = await fetch(`${server.replace(/\/+$/, "")}/${sha}`, { method: "DELETE", headers: { Authorization: deleteAuth(identity, sha) } });
	if (!res.ok && res.status !== 404) throw await failure(res, "Blossom delete");
}

/** What a File object says about its Blossom copy. */
export interface BlobRef {
	sha256: string;
	key: string;
	url: string;
}

/**
 * Download and decrypt `ref`, trying its recorded URL and then `server`,
 * and check the plaintext is the file named by `fileHash`.
 */
export async function fetchFromBlossom(ref: BlobRef, fileHash: string, server: string): Promise<Uint8Array> {
	if (!/^[0-9a-f]{64}$/.test(ref.key)) throw new Error("File has no usable blob key.");
	const sources = [...new Set([ref.url, server].filter(Boolean))];
	let last: unknown = new Error("No Blossom server to ask.");
	for (const source of sources) {
		try {
			const plain = decryptBlob(await download(ref.sha256, source), Buffer.from(ref.key, "hex"));
			if (sha256Hex(plain) !== fileHash) throw new Error("Decrypted file does not match its hash.");
			return plain;
		} catch (err) {
			last = err;
		}
	}
	throw last;
}

/** Both remote reads failed; the peer error decides how the caller reports it. */
export class RemoteReadFailed extends Error {
	constructor(
		readonly peerError: unknown,
		readonly blossomError: unknown,
	) {
		super(`${peerError instanceof Error ? peerError.message : String(peerError)} Blossom: ${blossomError instanceof Error ? blossomError.message : String(blossomError)}`);
	}
}

/**
 * The read order for bytes named by `hash`: this computer's store, then the
 * other computers (peer-to-peer), then Blossom. Blossom bytes are verified
 * against `hash` before `store` keeps them. Returns where the bytes came from.
 */
export async function obtainBlob(
	hash: string,
	src: {
		local: () => Promise<boolean>;
		peers: () => Promise<void>;
		/** Null when no File object names a Blossom copy. */
		blossom: (() => Promise<Uint8Array>) | null;
		store: (bytes: Uint8Array) => Promise<void>;
	},
): Promise<"local" | "peer" | "blossom"> {
	if (await src.local()) return "local";
	try {
		await src.peers();
		return "peer";
	} catch (peerError) {
		if (!src.blossom) throw peerError;
		try {
			const bytes = await src.blossom();
			if (sha256Hex(bytes) !== hash) throw new Error("Decrypted file does not match its hash.");
			await src.store(bytes);
			return "blossom";
		} catch (blossomError) {
			throw new RemoteReadFailed(peerError, blossomError);
		}
	}
}
