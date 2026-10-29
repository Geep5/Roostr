import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { FRAME, sha256Hex } from "./blossom";
import { decryptPack, encryptPack, packFrameRange, packKey } from "./pack";

// core/testdata/record_vectors/pack.json, shared with the Odin and Rust
// engines. With RECORD_VECTORS_WRITE=1 this fills `encrypted` and the frame
// ranges' `expected` (the Odin engine fills the plaintext side).
const VECTORS = join(import.meta.dir, "../../core/testdata/record_vectors/pack.json");
const writing = process.env.RECORD_VECTORS_WRITE === "1";
const vectors = JSON.parse(readFileSync(VECTORS, "utf8"));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const streamKey = Buffer.from(vectors.streamKey, "hex");
const plaintext = new Uint8Array(Buffer.from(vectors.expected.plaintext, "hex"));

/** Keys sorted at every depth like the Odin writer's, except that JS lists integer-like keys first, numerically. */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sorted);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
}

test("pack key, cipher and decryption match the engines", () => {
	const cipher = encryptPack(plaintext, streamKey, vectors.cursor);
	const actual = { packKey: hex(packKey(streamKey, vectors.cursor)), cipher: hex(cipher), cipherSha256: sha256Hex(cipher) };
	if (writing) vectors.encrypted = actual;
	else expect(actual).toEqual(vectors.encrypted);
	expect(hex(decryptPack(cipher, streamKey, vectors.cursor))).toBe(vectors.expected.plaintext);
	expect(() => decryptPack(cipher, streamKey, vectors.cursor + 1)).toThrow();
});

test("frame ranges match the engines", () => {
	for (const item of vectors.frames) {
		const range = packFrameRange(item.offset, item.length, item.total);
		if (writing) item.expected = range;
		else expect(range).toEqual(item.expected);
	}
	expect(packFrameRange(FRAME - 1, 2, 3 * FRAME)).toMatchObject({ firstFrame: 0, lastFrame: 1 });
});

test("buckets and deflate outputs inflate with zlib", () => {
	const start = vectors.expected.payloadStart;
	for (const [index, bucket] of Object.entries<{ offset: number; length: number }>(vectors.expected.header.buckets)) {
		const bytes = plaintext.subarray(start + bucket.offset, start + bucket.offset + bucket.length);
		expect(hex(inflateRawSync(bytes))).toBe(vectors.expected.buckets[index].raw);
	}
	for (const item of vectors.deflate) {
		if (item.expected.output === undefined) continue;
		const input = item.input.text ?? item.input.repeat.repeat(item.input.times);
		expect(inflateRawSync(Buffer.from(item.expected.output, "hex")).toString("latin1")).toBe(input);
	}
});

test.if(writing)("write pack.json", () => {
	writeFileSync(VECTORS, `${JSON.stringify(sorted(vectors), null, 1)}\n`);
});
