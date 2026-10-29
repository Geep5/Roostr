/**
 * Record-mode sync end to end (docs/state-objects.md "Device flows"): a
 * local RoostrRelay (relay + Blossom) and three daemons in record mode with
 * temp GLON_DATA and one identity, each with its own `bun run sync`
 * (recordsync.ts) as a subprocess. Device A builds packs; B and C never do.
 *
 * Binaries: GLON_ODIN_BIN / ROOSTR_RELAY_BIN, else built from this repo and
 * ../../RoostrRelay into a temp dir (skipped without `odin` or the relay
 * sources). Helpers: recordsync-fixture.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { blindShared } from "./nostrsync";
import { CursorRelay } from "./relay-cursor";
import { PATCH_KIND, type PackAnnouncement } from "./recordsync";
import { binaries, Device, fixtureRunnable, newestAnnouncement, shareSpace, startRelay, waitFor, type LocalRelay } from "./recordsync-fixture";

const root = mkdtempSync(join(tmpdir(), "recordsync-"));
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const skHex = Buffer.from(sk).toString("hex");
let relay: LocalRelay | null = null;
let relayUrl = "";
let spaceId = "";
let spaceKeyHex = "";

let a: Device;
let b: Device;
let c: Device;
const builderEnv = { GLON_RECORD_PACK_BUILDER: "1", GLON_RECORD_PACK_PATCHES: "6", GLON_RECORD_PACK_CHECK_MS: "1000" };
const readerEnv = { GLON_RECORD_PACK_BUILDER: "0" };
let odinBin = "";

/** The personal stream and the shared space, as the daemon selects them. */
const personal = (): string => `exclude=${spaceId}`;
const space = (): string => `space=${spaceId}`;

async function converged(devices: Device[], what: string, timeoutMs = 45_000): Promise<void> {
	try {
		await waitFor(what, async () => {
			for (const select of [personal(), space()]) {
				const roots = await Promise.all(devices.map((d) => d.root(select)));
				if (new Set(roots).size !== 1) return false;
			}
			const journals = await Promise.all(devices.map((d) => d.json<{ journal: number }>("/api/records/status")));
			return journals.every((j) => j.journal === 0);
		}, timeoutMs);
	} catch (err) {
		const state = await Promise.all(devices.map(async (d) => {
			const fingerprints = await Promise.all([personal(), space()].map((select) => d.json<{ records: number; buckets: string[] }>(`/api/records/fingerprint?${select}`)));
			return { name: d.name, status: await d.json("/api/records/status"), cursors: await d.json("/api/records/cursors"), records: fingerprints.map((f) => f.records), buckets: fingerprints.map((f) => f.buckets) };
		}));
		const differing = [0, 1].map((s) => state[0].buckets[s].flatMap((hash, i) => (state.some((x) => x.buckets[s][i] !== hash) ? [i] : [])));
		throw new Error(`${err}\n${JSON.stringify(state.map(({ buckets: _, ...rest }) => rest))}\ndiffering buckets (personal, space): ${JSON.stringify(differing)}`);
	}
}

async function note(device: Device, name: string, channel: string): Promise<string> {
	const out = await device.mutate({ action: "create", type_key: "note", name, fields: { channel: { stringValue: channel } } });
	return String(out.id);
}

/** The space stream's newest pack announcement on the relay, decrypted. */
async function spaceAnnouncement(): Promise<PackAnnouncement | null> {
	return newestAnnouncement(relayUrl, blindShared(spaceKeyHex, `space:${spaceId}`), Uint8Array.from(Buffer.from(spaceKeyHex, "hex")));
}

let rounds = 0;

/** Enough edits on A for its next space pack (GLON_RECORD_PACK_PATCHES=6), then that pack. */
async function packRound(prefix: string): Promise<void> {
	const before = (await spaceAnnouncement())?.cursor ?? -1;
	rounds++;
	for (let i = 0; i < 7; i++) await a.mutate({ action: "set_field", object_id: spaceId, key: `${prefix}${i % 4}`, value: { stringValue: `${prefix} ${rounds}.${i}` } });
	await waitFor("a newer space pack", async () => ((await spaceAnnouncement())?.cursor ?? -1) > before);
}

async function spacePatchSeqs(): Promise<{ seqs: number[]; oldest: number; head: number }> {
	const relay = new CursorRelay(relayUrl);
	try {
		const { events, cursor } = await relay.query([{ "#s": [blindShared(spaceKeyHex, `space:${spaceId}`)], kinds: [PATCH_KIND], after: 0, limit: 1000 }]);
		return { seqs: events.map((e) => e.seq), oldest: cursor?.oldest ?? 0, head: cursor?.head ?? 0 };
	} finally {
		relay.shutdown();
	}
}

/** A canonical Patch (core/record.odin) setting one string property at wall time `ms`, base64. */
function patchBytes(objectId: string, key: string, value: string, ms: number): string {
	const varint = (n: bigint): number[] => {
		const out: number[] = [];
		while (n > 127n) {
			out.push(Number(n & 127n) | 128);
			n >>= 7n;
		}
		out.push(Number(n));
		return out;
	};
	const field = (tag: number, body: number[]): number[] => [(tag << 3) | 2, ...varint(BigInt(body.length)), ...body];
	const text = (s: string): number[] => [...new TextEncoder().encode(s)];
	const stamp = [0x08, ...varint(BigInt(ms) << 16n), 0x10, 0x07];
	const entry = [...field(1, text(key)), ...field(2, stamp), ...field(4, field(1, text(value)))];
	return Buffer.from([...field(1, text(objectId)), ...field(2, entry)]).toString("base64");
}

describe.skipIf(!fixtureRunnable)("record sync against a local relay", () => {
	beforeAll(async () => {
		const bins = binaries(root);
		odinBin = bins.odinBin;
		relay = await startRelay(root, bins.relayBin, pk);
		relayUrl = relay.url;

		a = new Device(root, "a", skHex, relay, builderEnv);
		b = new Device(root, "b", skHex, relay, readerEnv);
		await a.startDaemon(odinBin);
		await b.startDaemon(odinBin);
		({ spaceId, keyHex: spaceKeyHex } = await shareSpace(a, [a, b], pk, "Shared"));
		a.startSync();
		b.startSync();
	}, 600_000);

	afterAll(async () => {
		for (const d of [a, b, c]) await d?.stop();
		relay?.proc.kill();
		await relay?.proc.exited;
		if (!process.env.KEEP_RECORDSYNC_TMP) rmSync(root, { recursive: true, force: true });
	});

	const logs = () => `\n--- A ---\n${a?.syncLog}\n--- B ---\n${b?.syncLog}\n--- C ---\n${c?.syncLog ?? ""}`;

	test("edits on A appear on B, in the personal stream and the space", async () => {
		try {
			const mine = await note(a, "personal note", "");
			const shared = await note(a, "space note", spaceId);
			await waitFor("B sees A's notes", async () => (await b.field(mine, "name")) === "personal note" && (await b.field(shared, "name")) === "space note");
			expect(await b.field(spaceId, "name")).toBe("Shared");
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 60_000);

	test("concurrent edits converge", async () => {
		try {
			const shared = await note(a, "contended", spaceId);
			await waitFor("B has it", async () => (await b.field(shared, "name")) === "contended");
			await Promise.all([
				a.mutate({ action: "set_field", object_id: shared, key: "name", value: { stringValue: "from A" } }),
				b.mutate({ action: "set_field", object_id: shared, key: "name", value: { stringValue: "from B" } }),
				a.mutate({ action: "set_field", object_id: shared, key: "a_only", value: { stringValue: "a" } }),
				b.mutate({ action: "set_field", object_id: shared, key: "b_only", value: { stringValue: "b" } }),
			]);
			await converged([a, b], "A and B roots");
			expect(await a.field(shared, "name")).toBe((await b.field(shared, "name"))!);
			expect(["from A", "from B"]).toContain((await a.field(shared, "name"))!);
			expect(await a.field(shared, "b_only")).toBe("b");
			expect(await b.field(shared, "a_only")).toBe("a");
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 90_000);

	test("offline edits on B are sent later and merge", async () => {
		try {
			const shared = await note(a, "offline target", spaceId);
			await waitFor("B has it", async () => (await b.field(shared, "name")) === "offline target");
			await b.stopSync();
			await b.mutate({ action: "set_field", object_id: shared, key: "offline", value: { stringValue: "written offline on B" } });
			const mine = await note(b, "B offline personal", "");
			await a.mutate({ action: "set_field", object_id: shared, key: "online", value: { stringValue: "A meanwhile" } });
			expect(await a.field(shared, "offline")).toBeUndefined();
			expect((await b.json<{ journal: number }>("/api/records/status")).journal).toBeGreaterThan(0);
			b.startSync();
			await converged([a, b], "A and B after B reconnects");
			expect(await a.field(shared, "offline")).toBe("written offline on B");
			expect(await a.field(mine, "name")).toBe("B offline personal");
			expect(await b.field(shared, "online")).toBe("A meanwhile");
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 90_000);

	test("a vanish on A (kind 1082) drops the record on B", async () => {
		try {
			const doomed = await note(a, "to vanish", spaceId);
			await waitFor("B has it", async () => (await b.field(doomed, "name")) === "to vanish");
			await a.mutate({ action: "vanish", object_id: doomed });
			await waitFor("B drops it", async () => (await b.fetch(`/api/objects/${doomed}`)).status === 404);
			// A late patch for the vanished object is refused.
			const late = patchBytes(doomed, "name", "back again", Date.now());
			const out = await b.json<{ refused: Array<{ reason: string }> }>("/api/records/apply", { patches: [late] });
			expect(out.refused.map((r) => r.reason)).toEqual(["vanished"]);
			await converged([a, b], "A and B after the vanish");
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 60_000);

	test("a patch stamped more than 24 h ahead is refused and reported", async () => {
		const target = await note(b, "clock target", "");
		const future = patchBytes(target, "name", "from the future", Date.now() + 2 * 86_400_000);
		const out = await b.json<{ applied: number; refused: Array<{ objectId: string; reason: string }> }>("/api/records/apply", { patches: [future] });
		expect(out.applied).toBe(0);
		expect(out.refused).toEqual([{ objectId: target, reason: "stamp more than 24 h in the future" }]);
		expect(await b.field(target, "name")).toBe("clock target");
	});

	test("the journal listing survives a store rebuild while it is sent", async () => {
		// /api/records/journal names each item's space and writes the listing
		// after the store lock is released; a vanish rebuilds the store and
		// frees every state the listing's strings came from.
		await b.stopSync();
		try {
			const targets = await Promise.all(Array.from({ length: 4 }, (_, i) => note(b, `journal race ${i}`, spaceId)));
			let writing = true;
			const writer = (async () => {
				try {
					for (let round = 0; round < 12; round++) {
						const doomed = await note(b, `rebuild ${round}`, "");
						await b.mutate({ action: "vanish", object_id: doomed });
					}
				} finally {
					writing = false;
				}
			})();
			const reader = async (): Promise<void> => {
				while (writing) {
					const { items } = await b.json<{ items: Array<{ objectId: string; space: string }> }>("/api/records/journal");
					for (const item of items) if (targets.includes(item.objectId)) expect(item.space).toBe(spaceId);
				}
			};
			await Promise.all([writer, reader(), reader()]);
		} finally {
			b.startSync();
		}
		await converged([a, b], "A and B after the journal race");
	}, 90_000);

	test("A builds packs, deletes patches below the previous pack; new device C loads the pack and catches up", async () => {
		try {
			// Two pack rounds: the second announcement deletes the patches through the first.
			await packRound("bulk");
			await packRound("bulk");
			const pack = await waitFor("a pack with retention", async () => {
				const ann = await spaceAnnouncement();
				return ann && ann.deleted_through > 0 ? ann : null;
			});
			expect(pack.builder).toBe(pk);
			expect(pack.buckets).toHaveLength(256);
			// Retention: A's patches through the previous pack's cursor are gone from the relay.
			await waitFor("retention", async () => (await spacePatchSeqs()).seqs.every((seq) => seq > pack.deleted_through));

			await converged([a, b], "A and B before C");
			c = new Device(root, "c", skHex, relay!, readerEnv);
			writeFileSync(join(c.data, "channel-keys.json"), readFileSync(join(a.data, "channel-keys.json")), { mode: 0o600 });
			await c.startDaemon(odinBin);
			c.startSync();
			await waitFor("C loads the space pack", async () => /pack #\d+ loaded/.test(c.syncLog));
			await converged([a, b, c], "A, B and C roots", 60_000);
			expect(await c.field(spaceId, "bulk1")).toBe(await a.field(spaceId, "bulk1"));
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 120_000);

	test("a device behind the relay's window reloads the newest pack", async () => {
		try {
			const loadsBefore = (c.syncLog.match(/pack #\d+ loaded/g) ?? []).length;
			const { head } = await spacePatchSeqs();
			const cCursor = await waitFor("C's space cursor stored at the head", async () => {
				const cursor = (await c.json<Record<string, { cursor: number } | undefined>>("/api/records/cursors"))[spaceId]?.cursor ?? -1;
				return cursor >= head ? cursor : null;
			});
			await c.stopSync();
			await packRound("later");
			await packRound("later");
			await waitFor("the window passes C's cursor", async () => {
				const { oldest } = await spacePatchSeqs();
				const ann = await spaceAnnouncement();
				return oldest - 1 > cCursor && ann && ann.deleted_through > cCursor;
			}, 60_000);
			c.startSync();
			await waitFor("C reloads a pack", async () => (c.syncLog.match(/pack #\d+ loaded/g) ?? []).length > loadsBefore);
			await converged([a, b, c], "A, B and C after the reload", 60_000);
			expect(await c.field(spaceId, "later3")).toBe((await a.field(spaceId, "later3"))!);
		} catch (err) {
			throw new Error(`${err}${logs()}`);
		}
	}, 150_000);
});
