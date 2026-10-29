/**
 * Record-mode devices against a local RoostrRelay (relay + Blossom), for
 * recordsync.test.ts and scripts/records-daemon.ts: binaries, the relay,
 * record-mode daemons with temp GLON_DATA and their `bun src/sync.ts`.
 * Never the production relay, never ~/.glon.
 *
 * Binaries: GLON_ODIN_BIN / ROOSTR_RELAY_BIN, else built from this repo and
 * ../../RoostrRelay into `<root>/bin`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { nip44 } from "nostr-tools";
import { PACK_KIND, type PackAnnouncement } from "./recordsync";
import { CursorRelay } from "./relay-cursor";

export const HARNESS = resolve(import.meta.dir, "..");
const ENGINE = resolve(HARNESS, "..");
const RELAY_SRC = resolve(ENGINE, "../RoostrRelay");

/** Prebuilt binaries given, or `odin` and the relay sources to build them. */
export const fixtureRunnable = Boolean(process.env.GLON_ODIN_BIN && process.env.ROOSTR_RELAY_BIN) || (Bun.which("odin") !== null && existsSync(join(RELAY_SRC, "src")));

export async function freePort(): Promise<number> {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}

function build(args: string[], cwd: string): void {
	const out = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	if (out.exitCode !== 0) throw new Error(`${args.join(" ")} failed:\n${out.stderr.toString()}${out.stdout.toString()}`);
}

/** The daemon and relay binaries, built into `<root>/bin` unless given. */
export function binaries(root: string): { odinBin: string; relayBin: string } {
	const bins = join(root, "bin");
	mkdirSync(bins, { recursive: true });
	const odinBin = process.env.GLON_ODIN_BIN ?? join(bins, "glon-odin");
	const relayBin = process.env.ROOSTR_RELAY_BIN ?? join(bins, "roostr-relay");
	if (!process.env.GLON_ODIN_BIN) build(["odin", "build", "src", `-out:${odinBin}`], ENGINE);
	if (!process.env.ROOSTR_RELAY_BIN) build(["odin", "build", "src", `-out:${relayBin}`], RELAY_SRC);
	return { odinBin, relayBin };
}

/**
 * Polls `check`: the devices are separate processes (daemons, sync loops,
 * relay) with no completion signal to await, so convergence is observed.
 */
export async function waitFor<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown = null;
	for (;;) {
		try {
			const value = await check();
			if (value) return value;
		} catch (err) {
			last = err;
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
		await Bun.sleep(200);
	}
}

export interface LocalRelay {
	port: number;
	url: string;
	http: string;
	proc: Subprocess;
}

/** RoostrRelay on a free port, its DB under `root`, writes open to `pk` only. */
export async function startRelay(root: string, relayBin: string, pk: string): Promise<LocalRelay> {
	const port = await freePort();
	const http = `http://127.0.0.1:${port}`;
	const proc = Bun.spawn([relayBin], { env: { ...process.env, PORT: String(port), DB_PATH: join(root, "relay.db"), RELAY_ALLOWED_PUBKEYS: pk, BLOSSOM_PUBLIC_URL: http }, cwd: root, stdout: "ignore", stderr: "ignore" });
	await waitFor("relay", async () => (await fetch(`${http}/health`)).ok);
	return { port, url: `ws://127.0.0.1:${port}`, http, proc };
}

/** The newest pack announcement with `d` on the relay, decrypted with `key`. */
export async function newestAnnouncement(relayUrl: string, d: string, key: Uint8Array): Promise<PackAnnouncement | null> {
	const relay = new CursorRelay(relayUrl);
	try {
		const { events } = await relay.query([{ kinds: [PACK_KIND], "#d": [d] }]);
		const all = events.map(({ event }) => JSON.parse(nip44.decrypt(event.content, key)) as PackAnnouncement);
		return all.sort((x, y) => y.cursor - x.cursor)[0] ?? null;
	} finally {
		relay.shutdown();
	}
}

/** One record-mode daemon (temp GLON_DATA) and its sync loop. */
export class Device {
	readonly name: string;
	readonly data: string;
	port = 0;
	daemon: Subprocess | null = null;
	sync: Subprocess | null = null;
	syncLog = "";
	private readonly relay: LocalRelay;
	private readonly syncEnv: Record<string, string>;

	constructor(root: string, name: string, skHex: string, relay: LocalRelay, syncEnv: Record<string, string>) {
		this.name = name;
		this.data = join(root, name);
		this.relay = relay;
		this.syncEnv = syncEnv;
		mkdirSync(this.data, { recursive: true });
		writeFileSync(join(this.data, "nostr.json"), JSON.stringify({ version: 1, privkey: skHex, relays: [relay.url] }), { mode: 0o600 });
	}

	get api(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** The daemon's stdout and stderr. */
	get daemonLog(): string {
		return join(this.data, "daemon.log");
	}

	async startDaemon(bin: string): Promise<void> {
		this.port = await freePort();
		const log = Bun.file(this.daemonLog);
		this.daemon = Bun.spawn([bin, "serve", String(this.port)], { env: { ...process.env, GLON_DATA: this.data, GLON_RECORDS: "1" }, stdout: log, stderr: log });
		await waitFor(`${this.name} daemon`, async () => existsSync(join(this.data, "api-token")) && (await this.fetch("/api/records/status")).ok);
	}

	async fetch(path: string, init: RequestInit = {}): Promise<Response> {
		const token = readFileSync(join(this.data, "api-token"), "utf8").trim();
		return fetch(`${this.api}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
	}

	async json<T>(path: string, body?: unknown): Promise<T> {
		const res = await this.fetch(path, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
		if (!res.ok) throw new Error(`${this.name} ${path}: ${res.status} ${await res.text()}`);
		return (await res.json()) as T;
	}

	mutate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.json("/api/mutate", params);
	}

	async field(objectId: string, key: string): Promise<string | undefined> {
		const res = await this.fetch(`/api/objects/${objectId}`);
		if (!res.ok) return undefined;
		const obj = (await res.json()) as { fields?: Record<string, { stringValue?: string }> };
		return obj.fields?.[key]?.stringValue;
	}

	async root(select: string): Promise<string> {
		return (await this.json<{ root: string }>(`/api/records/fingerprint?${select}`)).root;
	}

	startSync(): void {
		this.sync = Bun.spawn(["bun", "src/sync.ts"], {
			cwd: HARNESS,
			env: { ...process.env, ...this.syncEnv, GLON_DATA: this.data, GLON_API: this.api, GLON_BLOSSOM_URL: this.relay.http, GLON_RECORD_JOURNAL_POLL_MS: "300" },
			stdout: "pipe",
			stderr: "pipe",
		});
		for (const stream of [this.sync.stdout, this.sync.stderr]) {
			if (!(stream instanceof ReadableStream)) continue;
			void (async () => {
				const decoder = new TextDecoder();
				for await (const chunk of stream) this.syncLog += decoder.decode(chunk);
			})();
		}
	}

	async stopSync(): Promise<void> {
		this.sync?.kill();
		await this.sync?.exited;
		this.sync = null;
	}

	async stop(): Promise<void> {
		await this.stopSync();
		this.daemon?.kill();
		await this.daemon?.exited;
	}
}

/**
 * A shared space on `owner` (a channel, its keyring entry marked owned by
 * this identity, as an imported entry), the same keyring on every device.
 */
export async function shareSpace(owner: Device, devices: Device[], pk: string, name: string): Promise<{ spaceId: string; keyHex: string }> {
	const spaceId = String((await owner.mutate({ action: "channel_create", name })).id);
	const keyring = JSON.parse(readFileSync(join(owner.data, "channel-keys.json"), "utf8")) as { channels: Record<string, { key: string; keyId: number; owner?: string }> };
	const keyHex = keyring.channels[spaceId].key;
	keyring.channels = { [spaceId]: { ...keyring.channels[spaceId], owner: pk } };
	for (const d of devices) writeFileSync(join(d.data, "channel-keys.json"), JSON.stringify(keyring), { mode: 0o600 });
	return { spaceId, keyHex };
}
