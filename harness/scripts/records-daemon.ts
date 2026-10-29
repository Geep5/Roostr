/**
 * A record-mode daemon's relay for the Rust replica's interop test
 * (RoostrWebsite `roostr-replica` tests/records.rs
 * `a_replica_reaches_the_daemons_root`):
 *
 *   bun scripts/records-daemon.ts            # prints `export RECORDS_DAEMON_…=…`, keeps running
 *   eval "$(…)"; cargo test -p roostr-replica --test records -- --ignored a_replica_reaches_the_daemons_root
 *
 * A local RoostrRelay (relay + Blossom) and one record-mode daemon (temp
 * GLON_DATA, throwaway key, its own `bun src/sync.ts` as the pack builder)
 * with synthetic edits in the personal stream and one shared space: pages
 * with blocks and notes, a first pack per stream, more edits, a second pack
 * (whose retention deletes the patches through the first), then edits and
 * a vanish after it. Then it prints the relay, the key, each stream's
 * fingerprint root, the space's id and key, and a file of the daemon's
 * views of a sample of objects, and stays up until interrupted (the temp
 * dir goes with it; KEEP_RECORDSYNC_TMP=1 keeps it).
 *
 * Binaries: GLON_ODIN_BIN / ROOSTR_RELAY_BIN, else built with `odin`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";
import { blindShared } from "../src/nostrsync";
import { PATCH_KIND } from "../src/recordsync";
import { binaries, Device, newestAnnouncement, shareSpace, startRelay, waitFor } from "../src/recordsync-fixture";
import { CursorRelay } from "../src/relay-cursor";

/**
 * Stream events between packs (GLON_RECORD_PACK_PATCHES). Seqs count every
 * event of the stream: the personal stream also carries this identity's
 * pack announcements and retention deletions of the space, so the late
 * phase (a few patches) stays well below it.
 */
const PACK_PATCHES = 20;

const root = mkdtempSync(join(tmpdir(), "records-daemon-"));
const sk = generateSecretKey();
const pk = getPublicKey(sk);
const skHex = Buffer.from(sk).toString("hex");
const { odinBin, relayBin } = binaries(root);
const relay = await startRelay(root, relayBin, pk);
const device = new Device(root, "daemon", skHex, relay, { GLON_RECORD_PACK_BUILDER: "1", GLON_RECORD_PACK_PATCHES: String(PACK_PATCHES), GLON_RECORD_PACK_CHECK_MS: "1000" });

let stopping = false;
async function shutdown(code: number): Promise<never> {
	if (!stopping) {
		stopping = true;
		await device.stop();
		relay.proc.kill();
		await relay.proc.exited;
		if (!process.env.KEEP_RECORDSYNC_TMP) rmSync(root, { recursive: true, force: true });
	}
	process.exit(code);
}
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

try {
	await device.startDaemon(odinBin);
	const { spaceId, keyHex } = await shareSpace(device, [device], pk, "Shared");
	const streams = [
		// The personal `d`: nostrsync.ts blindObjectId (the secret key's bytes as the prefix).
		{ name: "personal", select: `exclude=${spaceId}`, channel: "", d: new Bun.CryptoHasher("sha256").update(sk).update("stream:personal").digest("hex").slice(0, 16), key: nip44.getConversationKey(sk, pk) },
		{ name: "space", select: `space=${spaceId}`, channel: spaceId, d: blindShared(keyHex, `space:${spaceId}`), key: Uint8Array.from(Buffer.from(keyHex, "hex")) },
	];
	const sample: string[] = [spaceId];
	const create = async (fields: Record<string, unknown>): Promise<string> => {
		const id = String((await device.mutate({ action: "create", ...fields })).id);
		sample.push(id);
		return id;
	};
	/** Each stream's newest pack cursor, once it is newer than `after`. */
	const packs = (after: number[]): Promise<number[]> =>
		waitFor("a newer pack on every stream", async () => {
			const cursors = await Promise.all(streams.map(async (s) => (await newestAnnouncement(relay.url, s.d, s.key))?.cursor ?? -1));
			return cursors.every((cursor, i) => cursor > after[i]) && cursors;
		}, 60_000);

	// Before the first pack (written before the sync starts: the pack covers them).
	const pages: string[] = [];
	const notes: string[][] = [];
	for (const s of streams) {
		const page = await create({ type_key: "page", name: `${s.name} page`, fields: { channel: { stringValue: s.channel } } });
		for (const [i, text] of ["first", "second"].entries()) {
			await device.mutate({ action: "block_add", object_id: page, target_id: page, position: 2, block: { id: `${s.name}-b${i}`, content: { text: { text: `${s.name} ${text}` } } } });
		}
		pages.push(page);
		const mine: string[] = [];
		for (let i = 0; i < 3; i++) mine.push(await create({ type_key: "note", name: `${s.name} note ${i}`, fields: { channel: { stringValue: s.channel }, n: { intValue: i } } }));
		notes.push(mine);
	}
	device.startSync();
	const first = await packs([-1, -1]);
	const edits = async (round: string, count: number): Promise<void> => {
		for (let i = 0; i < count; i++) for (const [n, s] of streams.entries()) await device.mutate({ action: "set_field", object_id: pages[n], key: `${round}${i % 3}`, value: { stringValue: `${s.name} ${round} ${i}` } });
	};

	// Enough for a second pack, whose retention deletes the patches through the first.
	await edits("bulk", PACK_PATCHES);
	const second = await packs(first);

	// After the last pack: edits, new objects, a block edit, a block too big
	// for one event (a chunked patch), a vanish.
	const doomed = notes[0][1];
	await edits("late", 2);
	for (const s of streams) await create({ type_key: "note", name: `${s.name} after the pack`, fields: { channel: { stringValue: s.channel } } });
	await device.mutate({ action: "block_update", object_id: pages[0], block_id: "personal-b0", content: { text: { text: "personal first, edited after the pack" } } });
	await device.mutate({ action: "block_add", object_id: pages[1], target_id: pages[1], position: 2, block: { id: "space-big", content: { text: { text: "a long paragraph ".repeat(4_000) } } } });
	await device.mutate({ action: "vanish", object_id: doomed });
	await waitFor("the journal sent", async () => (await device.json<{ journal: number }>("/api/records/status")).journal === 0, 30_000);
	const cursorRelay = new CursorRelay(relay.url);
	const late = await cursorRelay.query([{ kinds: [PATCH_KIND], "#s": [streams[1].d], after: second[1], limit: 500 }]);
	cursorRelay.shutdown();
	if (!late.events.some(({ event }) => event.tags.some((tag) => tag[0] === "c"))) throw new Error("the big block did not go out as a chunked patch");
	if ((await packs([-1, -1])).some((cursor, i) => cursor !== second[i])) throw new Error("a pack was built after the late edits: raise PACK_PATCHES");

	const views: Record<string, unknown> = {};
	for (const id of sample.filter((id) => id !== doomed)) views[id] = await device.json(`/api/objects/${id}`);
	const viewsFile = join(root, "views.json");
	writeFileSync(viewsFile, JSON.stringify({ views, vanished: [doomed] }, null, "\t"));
	const roots = await Promise.all(streams.map((s) => device.root(s.select)));
	const env = {
		RECORDS_DAEMON_RELAY: relay.url,
		RECORDS_DAEMON_NSEC: nip19.nsecEncode(sk),
		RECORDS_DAEMON_ROOT: roots[0],
		RECORDS_DAEMON_SPACE: spaceId,
		RECORDS_DAEMON_SPACE_KEY: keyHex,
		RECORDS_DAEMON_SPACE_ROOT: roots[1],
		RECORDS_DAEMON_VIEWS: viewsFile,
	};
	for (const [key, value] of Object.entries(env)) console.log(`export ${key}=${value}`);
	console.error(`[records-daemon] packs ${JSON.stringify(first)} then ${JSON.stringify(second)}; daemon ${device.api}, data ${root}; Ctrl-C stops and cleans up`);
} catch (err) {
	const daemonLog = existsSync(device.daemonLog) ? readFileSync(device.daemonLog, "utf8").slice(-8_000) : "";
	console.error(`[records-daemon] ${err instanceof Error ? err.message : err}\n--- sync ---\n${device.syncLog.slice(-8_000)}\n--- daemon ---\n${daemonLog}`);
	await shutdown(1);
}
