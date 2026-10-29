/**
 * Pack blobs (docs/state-objects.md "Packs"): the engine builds the pack
 * plaintext (core/pack.odin `pack_build`); this encrypts it for Blossom in
 * the Blossom frame format (blossom.ts) under a key derived per stream and
 * cursor, so only members of the stream can read it. roostr-engine's
 * src/pack.rs is the same, pinned by core/testdata/record_vectors/pack.json.
 */

import { createHmac } from "node:crypto";
import { FRAME, TAG, decryptBlob, encryptBlob } from "./blossom";

export const PACK_KEY_LABEL = "roostr-pack-v1";

/** HMAC-SHA256(stream key, "roostr-pack-v1" || cursor as 8 bytes big-endian). */
export function packKey(streamKey: Uint8Array, cursor: number | bigint): Uint8Array {
	const c = new Uint8Array(8);
	new DataView(c.buffer).setBigUint64(0, BigInt(cursor));
	return new Uint8Array(createHmac("sha256", streamKey).update(PACK_KEY_LABEL).update(c).digest());
}

export function encryptPack(plaintext: Uint8Array, streamKey: Uint8Array, cursor: number | bigint): Uint8Array {
	return encryptBlob(plaintext, packKey(streamKey, cursor)).cipher;
}

/** Throws when the blob is truncated, tampered or for another stream / cursor. */
export function decryptPack(cipher: Uint8Array, streamKey: Uint8Array, cursor: number | bigint): Uint8Array {
	return decryptBlob(cipher, packKey(streamKey, cursor));
}

/** The frames covering plaintext bytes [offset, offset + length) of a pack plaintext of `total` bytes. */
export interface FrameRange {
	firstFrame: number;
	lastFrame: number;
	/** Blob bytes [cipherStart, cipherEnd): HTTP `Range: bytes=cipherStart-(cipherEnd - 1)`. */
	cipherStart: number;
	cipherEnd: number;
	/** Where `offset` lands in the decrypted frames. */
	skip: number;
}

/**
 * Frame i holds plaintext [i * FRAME, (i + 1) * FRAME) and sits at blob bytes
 * [i * (FRAME + TAG), (i + 1) * (FRAME + TAG)), the last frame shorter. A
 * bucket's plaintext range is (payload start + its offset, its length).
 */
export function packFrameRange(offset: number, length: number, total: number): FrameRange {
	const frames = Math.max(1, Math.ceil(total / FRAME));
	const firstFrame = Math.floor(offset / FRAME);
	const lastFrame = Math.floor((offset + Math.max(length, 1) - 1) / FRAME);
	return {
		firstFrame,
		lastFrame,
		cipherStart: firstFrame * (FRAME + TAG),
		cipherEnd: Math.min((lastFrame + 1) * (FRAME + TAG), total + frames * TAG),
		skip: offset - firstFrame * FRAME,
	};
}
