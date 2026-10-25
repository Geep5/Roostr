import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { DEFAULT_BLOSSOM, FRAME, RemoteReadFailed, TAG, decryptBlob, deleteBlob, discoverServer, download, encryptBlob, fetchFromBlossom, obtainBlob, sha256Hex, upload } from "./blossom";

const originalFetch = globalThis.fetch;
const originalOverride = process.env.GLON_BLOSSOM_URL;
let requests: Request[] = [];

function fakeFetch(handler: (req: Request) => Response | Promise<Response>): void {
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const req: Request = new Request(input instanceof Request ? input.url : String(input), init as never);
		requests.push(req.clone() as Request);
		return handler(req);
	}) as typeof fetch;
}

beforeEach(() => {
	requests = [];
	delete process.env.GLON_BLOSSOM_URL;
	fakeFetch((req) => {
		throw new Error(`unexpected fetch ${req.url}`);
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalOverride === undefined) delete process.env.GLON_BLOSSOM_URL;
	else process.env.GLON_BLOSSOM_URL = originalOverride;
});

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);

test("frames round trip: empty, small, exactly 4 MiB and 4 MiB + 1", () => {
	for (const size of [0, 1, 1000, FRAME, FRAME + 1]) {
		const plain = new Uint8Array(randomBytes(size));
		const { key, cipher } = encryptBlob(plain);
		expect(key.byteLength).toBe(32);
		const frames = Math.max(1, Math.ceil(size / FRAME));
		expect(cipher.byteLength).toBe(size + frames * TAG);
		expect(Buffer.from(decryptBlob(cipher, key)).equals(Buffer.from(plain))).toBe(true);
	}
	expect(encryptBlob(new Uint8Array(0)).cipher.byteLength).toBe(16);
});

test("each file gets a fresh key", () => {
	const plain = new Uint8Array([1, 2, 3]);
	expect(Buffer.from(encryptBlob(plain).key).equals(Buffer.from(encryptBlob(plain).key))).toBe(false);
});

test("nonce layout: frame i decrypts with WebCrypto under the 12-byte big-endian nonce i", async () => {
	const plain = new Uint8Array(randomBytes(FRAME + 1));
	const { cipher } = encryptBlob(plain, KEY);
	expect(cipher.byteLength).toBe(FRAME + TAG + 1 + TAG);
	const key = await crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["decrypt"]);
	const nonce1 = new Uint8Array(12);
	nonce1[11] = 1;
	const frame1 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce1 }, key, new Uint8Array(cipher.subarray(FRAME + TAG))));
	expect([...frame1]).toEqual([plain[FRAME]!]);
	const frame0 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(cipher.subarray(0, FRAME + TAG))));
	expect(Buffer.from(frame0).equals(Buffer.from(plain.subarray(0, FRAME)))).toBe(true);
	// The empty file: one frame that is the tag alone, nonce 0.
	const empty = encryptBlob(new Uint8Array(0), KEY).cipher;
	expect((await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new Uint8Array(empty))).byteLength).toBe(0);
});

test("tampered, truncated, reordered or wrongly keyed blobs are rejected", () => {
	const plain = new Uint8Array(randomBytes(FRAME + 100));
	const { key, cipher } = encryptBlob(plain);
	const flipped = cipher.slice();
	flipped[FRAME + TAG + 5]! ^= 1;
	expect(() => decryptBlob(flipped, key)).toThrow(/frame 1/);
	expect(() => decryptBlob(cipher.subarray(0, cipher.byteLength - 1), key)).toThrow();
	expect(() => decryptBlob(cipher.subarray(0, FRAME + TAG + 10), key)).toThrow(/truncated/);
	expect(() => decryptBlob(cipher.subarray(0, 10), key)).toThrow(/truncated/);
	expect(() => decryptBlob(new Uint8Array(0), key)).toThrow(/truncated/);
	expect(() => decryptBlob(cipher, new Uint8Array(randomBytes(32)))).toThrow();
	const one = encryptBlob(new Uint8Array([7]), KEY).cipher;
	const two = encryptBlob(new Uint8Array([7, 8]), KEY).cipher;
	expect(() => decryptBlob(Buffer.concat([one, two]), KEY)).toThrow();
});

test("upload PUTs the ciphertext with a signed kind-24242 upload authorization", async () => {
	const sk = generateSecretKey();
	const { cipher } = encryptBlob(new TextEncoder().encode("hello"));
	const sha = sha256Hex(cipher);
	fakeFetch(() => Response.json({ url: `https://blossom.test/${sha}`, sha256: sha, size: cipher.byteLength, type: "application/octet-stream", uploaded: 1 }));
	const before = Math.floor(Date.now() / 1000);
	const d = await upload(cipher, "notes.txt", "https://blossom.test", { sk });
	expect(d).toEqual({ url: `https://blossom.test/${sha}`, sha256: sha, size: cipher.byteLength, type: "application/octet-stream", uploaded: 1 });
	expect(requests).toHaveLength(1);
	const req = requests[0]!;
	expect(req.method).toBe("PUT");
	expect(req.url).toBe("https://blossom.test/upload");
	expect(req.headers.get("X-SHA-256")).toBe(sha);
	expect(req.headers.get("Content-Length")).toBe(String(cipher.byteLength));
	expect(Buffer.from(await req.arrayBuffer()).equals(Buffer.from(cipher))).toBe(true);
	const auth = req.headers.get("Authorization")!;
	expect(auth.startsWith("Nostr ")).toBe(true);
	const event = JSON.parse(Buffer.from(auth.slice(6), "base64").toString()) as Event;
	expect(verifyEvent(event)).toBe(true);
	expect(event.kind).toBe(24242);
	expect(event.pubkey).toBe(getPublicKey(sk));
	expect(event.content).toBe("Upload notes.txt");
	expect(event.tags.slice(0, 2)).toEqual([
		["t", "upload"],
		["x", sha],
	]);
	const [name, expiration] = event.tags[2]!;
	expect(name).toBe("expiration");
	expect(Number(expiration) - event.created_at).toBe(600);
	expect(event.created_at).toBeGreaterThanOrEqual(before);
});

test("upload rejects a descriptor for other bytes and reports server refusals", async () => {
	const sk = generateSecretKey();
	const cipher = encryptBlob(new Uint8Array([1])).cipher;
	fakeFetch(() => Response.json({ url: "https://blossom.test/x", sha256: "0".repeat(64), size: 1 }));
	await expect(upload(cipher, "a", "https://blossom.test", { sk })).rejects.toThrow(/different bytes/);
	fakeFetch(() => new Response("", { status: 401, headers: { "X-Reason": "pubkey not allowed" } }));
	await expect(upload(cipher, "a", "https://blossom.test", { sk })).rejects.toThrow(/401 pubkey not allowed/);
});

test("deleteBlob sends BUD-02 DELETE with a signed delete authorization; a blob already gone counts as deleted", async () => {
	const sk = generateSecretKey();
	const sha = "ab".repeat(32);
	fakeFetch(() => new Response(null, { status: 404 }));
	await deleteBlob(sha, "https://blossom.test/", { sk });
	const [req] = requests;
	expect(req.method).toBe("DELETE");
	expect(req.url).toBe(`https://blossom.test/${sha}`);
	const event = JSON.parse(Buffer.from(req.headers.get("Authorization")!.replace(/^Nostr /, ""), "base64").toString()) as Event;
	expect(verifyEvent(event)).toBe(true);
	expect(event.pubkey).toBe(getPublicKey(sk));
	expect(event.tags.slice(0, 2)).toEqual([["t", "delete"], ["x", sha]]);
	fakeFetch(() => new Response("", { status: 401, headers: { "X-Reason": "not yours" } }));
	await expect(deleteBlob(sha, "https://blossom.test", { sk })).rejects.toThrow(/401 not yours/);
});

test("discovery picks the first relay whose NIP-11 lists blossom, as an http(s) origin", async () => {
	fakeFetch((req) => {
		expect(req.headers.get("Accept")).toBe("application/nostr+json");
		if (req.url === "https://plain.test/") return Response.json({ supported_nips: [1, 11] });
		if (req.url === "http://local.test:7777/") return Response.json({ supported_features: ["blossom"] });
		throw new Error("unreachable");
	});
	expect(await discoverServer(["wss://down.test", "wss://plain.test/path", "ws://local.test:7777"])).toBe("http://local.test:7777");
	expect(requests.map((r) => r.url)).toEqual(["https://down.test/", "https://plain.test/", "http://local.test:7777/"]);
});

test("discovery defaults to RoostrRelay, and GLON_BLOSSOM_URL overrides without asking anyone", async () => {
	fakeFetch(() => Response.json({ supported_features: [] }));
	expect(await discoverServer(["wss://plain.test"])).toBe(DEFAULT_BLOSSOM);
	expect(await discoverServer([])).toBe(DEFAULT_BLOSSOM);
	requests = [];
	process.env.GLON_BLOSSOM_URL = "http://127.0.0.1:9999/";
	expect(await discoverServer(["wss://plain.test"])).toBe("http://127.0.0.1:9999");
	expect(requests).toHaveLength(0);
});

test("download verifies the ciphertext hash; fetchFromBlossom falls back to the server and checks the plaintext", async () => {
	const plain = new TextEncoder().encode("report");
	const { key, cipher } = encryptBlob(plain);
	const sha = sha256Hex(cipher);
	const ref = { sha256: sha, key: Buffer.from(key).toString("hex"), url: `https://gone.test/${sha}` };
	fakeFetch((req) => {
		if (req.url.startsWith("https://gone.test/")) return new Response("", { status: 404 });
		if (req.url === `https://blossom.test/${sha}`) return new Response(cipher);
		if (req.url === `https://liar.test/${sha}`) return new Response(new Uint8Array([1, 2, 3]));
		throw new Error(`unexpected ${req.url}`);
	});
	expect(new TextDecoder().decode(await fetchFromBlossom(ref, sha256Hex(plain), "https://blossom.test"))).toBe("report");
	expect(requests.map((r) => r.url)).toEqual([`https://gone.test/${sha}`, `https://blossom.test/${sha}`]);
	await expect(download(sha, "https://liar.test")).rejects.toThrow(/do not match/);
	await expect(fetchFromBlossom(ref, "f".repeat(64), "https://blossom.test")).rejects.toThrow(/does not match its hash/);
	await expect(fetchFromBlossom({ ...ref, key: Buffer.from(randomBytes(32)).toString("hex") }, sha256Hex(plain), "https://blossom.test")).rejects.toThrow(/authentication/);
});

test("read order: local, then peers, then Blossom (verified before it is stored)", async () => {
	const bytes = new TextEncoder().encode("file");
	const hash = sha256Hex(bytes);
	const calls: string[] = [];
	const stored: Uint8Array[] = [];
	const src = (o: { local?: boolean; peers?: boolean; blossom?: Uint8Array | Error | null }) => ({
		local: async () => {
			calls.push("local");
			return o.local ?? false;
		},
		peers: async () => {
			calls.push("peers");
			if (!o.peers) throw new Error("No computer holds this file.");
		},
		blossom:
			o.blossom === null
				? null
				: async () => {
						calls.push("blossom");
						if (o.blossom instanceof Error) throw o.blossom;
						return o.blossom ?? bytes;
					},
		store: async (b: Uint8Array) => {
			stored.push(b);
		},
	});

	expect(await obtainBlob(hash, src({ local: true }))).toBe("local");
	expect(calls).toEqual(["local"]);

	calls.length = 0;
	expect(await obtainBlob(hash, src({ peers: true }))).toBe("peer");
	expect(calls).toEqual(["local", "peers"]);
	expect(stored).toHaveLength(0);

	calls.length = 0;
	expect(await obtainBlob(hash, src({}))).toBe("blossom");
	expect(calls).toEqual(["local", "peers", "blossom"]);
	expect(stored).toEqual([bytes]);

	// Blossom bytes that are not the file are never stored.
	stored.length = 0;
	const wrong = await obtainBlob(hash, src({ blossom: new TextEncoder().encode("other") })).catch((e) => e);
	expect(wrong).toBeInstanceOf(RemoteReadFailed);
	expect(String(wrong.message)).toContain("No computer holds this file. Blossom: Decrypted file does not match its hash.");
	expect(stored).toHaveLength(0);

	// A Blossom failure keeps the peer error for the caller.
	const down = await obtainBlob(hash, src({ blossom: new Error("Blossom download failed: 404") })).catch((e) => e);
	expect(down).toBeInstanceOf(RemoteReadFailed);
	expect(down.peerError.message).toBe("No computer holds this file.");

	// No Blossom copy: the peer error as before.
	await expect(obtainBlob(hash, src({ blossom: null }))).rejects.toThrow(/^No computer holds this file\.$/);
	expect(stored).toHaveLength(0);
});
