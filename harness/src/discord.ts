/**
 * Discord surface - port of MatcherinoBotAdmin/bot.py's REST poller onto the
 * harness runtime. No gateway: every 3 s each configured channel is read
 * with `after=<mark>` (bot.py:143-148, 556), and a human message becomes a
 * chat block in the channel's own conversation on the agent's object:
 *
 *   ConvRef { objectId, threadId: "__discord__<channelId>" }
 *
 * The harness runs its turn ON that thread, so the runner posts the agent's
 * words there (runner.ts postTo) and this file forwards every agent-authored
 * block it has not posted yet to the channel, ≤2000 chars a piece. One
 * thread per channel keeps DMs and the admin channel apart, exactly as
 * bot.py kept one omp session per channel (bot.py:512-520).
 *
 * Marks live in `${GLON_DATA ?? ~/.glon}/discord-marks.json`, keyed by
 * channel id: `seen` is the newest Discord message id consumed, `posted` the
 * last agent block forwarded. A channel without a mark is seeded at its
 * newest message on first sight (bot.py:1063-1087), so a fresh start never
 * answers history; a restart with marks on disk resumes where it stopped.
 */

import { addBlock, fetchObject, list, str, type BlockJSON, type ObjectJSON } from "./api";
import { addConvBlock, convBlocks, type ConvRef } from "./conv";
import { passwordCredential } from "./credentials";
import { agentKind } from "./kinds";

const DISCORD_API = "https://discord.com/api/v10";
const POLL_MS = 3_000;
/** Discord's typing indicator lasts ~10 s; refresh well inside that. */
const TYPING_MS = 8_000;
const CHUNK_GAP_MS = 500;
const RECONCILE_MS = 15_000;
const RATE_LIMIT_RETRIES = 3;
export const MESSAGE_LIMIT = 2000;
export const THREAD_PREFIX = "__discord__";

export interface DiscordConfig {
	token: string;
	channelId: string;
	extraChannelIds: string[];
	allowedDmUsers: string[];
}

export interface DiscordMessage {
	id: string;
	content?: string;
	author: { id: string; username?: string; global_name?: string | null; bot?: boolean };
	mentions?: Array<{ id: string }>;
	mention_everyone?: boolean;
}

/** Contract 2 fields on the agent object; null when there is no admin channel to answer in. */
export function discordConfigFor(agent: ObjectJSON): Omit<DiscordConfig, "token"> | null {
	const channelId = str(agent.fields, "discord_channel_id").trim();
	if (!channelId) return null;
	return {
		channelId,
		extraChannelIds: str(agent.fields, "discord_extra_channel_ids").split(",").map((x) => x.trim()).filter(Boolean),
		allowedDmUsers: str(agent.fields, "discord_allowed_dm_users").split(",").map((x) => x.trim()).filter(Boolean),
	};
}

/** The bot token from this machine's credential store (`discord-bot`). */
export async function discordToken(): Promise<string | null> {
	return passwordCredential("discord-bot")?.token || null;
}

export const discordThread = (channelId: string): string => `${THREAD_PREFIX}${channelId}`;
/** Not a uuid, so `isAgentAuthor` reads it as a human. */
export const discordAuthor = (userId: string): string => `discord:${userId}`;

// ── Marks ─────────────────────────────────────────────────────────

export interface ChannelMark {
	/** Newest Discord message id consumed; "0" for a channel that was empty when seeded. */
	seen: string;
	/** Last agent block id forwarded to the channel. */
	posted: string;
}

function marksPath(): string {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	return `${root}/discord-marks.json`;
}

let marks: Record<string, ChannelMark> | null = null;

async function loadMarks(): Promise<Record<string, ChannelMark>> {
	if (marks) return marks;
	try {
		marks = (await Bun.file(marksPath()).json()) as Record<string, ChannelMark>;
	} catch {
		marks = {};
	}
	return marks;
}

async function saveMarks(): Promise<void> {
	if (marks) await Bun.write(marksPath(), JSON.stringify(marks));
}

async function markOf(channelId: string): Promise<ChannelMark | undefined> {
	return (await loadMarks())[channelId];
}

async function setMark(channelId: string, patch: Partial<ChannelMark>): Promise<void> {
	const m = await loadMarks();
	const current = m[channelId] ?? { seen: "0", posted: "" };
	m[channelId] = { ...current, ...patch };
	await saveMarks();
}

// ── REST client (bot.py:113-162) ───────────────────────────────────

/** Snowflakes grow past 18 digits; compare as numbers, not strings. */
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class DiscordClient {
	constructor(
		private token: string,
		private fetchImpl: typeof fetch = fetch,
		private sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
	) {}

	/** Parsed JSON, or null for an empty body. 429 sleeps `retry_after` and retries; anything else throws. */
	async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
		for (let attempt = 0; ; attempt++) {
			const res = await this.fetchImpl(`${DISCORD_API}${path}`, {
				method,
				headers: {
					Authorization: `Bot ${this.token}`,
					"Content-Type": "application/json",
					"User-Agent": "Roostr harness (https://github.com/geep/roostr, 1.0)",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await res.text();
			if (res.status === 429) {
				let retryAfter = 5;
				try {
					const parsed: unknown = JSON.parse(text);
					if (parsed && typeof parsed === "object" && "retry_after" in parsed && typeof parsed.retry_after === "number") retryAfter = parsed.retry_after;
				} catch {
					/* keep default */
				}
				console.warn(`[discord] rate limited on ${method} ${path}; sleeping ${retryAfter}s`);
				await this.sleep(retryAfter * 1000);
				if (attempt < RATE_LIMIT_RETRIES) continue;
				throw new Error(`discord ${method} ${path}: rate limited`);
			}
			if (!res.ok) throw new Error(`discord ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
			return text ? (JSON.parse(text) as T) : null;
		}
	}

	async me(): Promise<{ id: string; username: string }> {
		const me = await this.request<{ id: string; username: string }>("GET", "/users/@me");
		if (!me) throw new Error("discord: /users/@me returned nothing - check the bot token");
		return me;
	}

	async messages(channelId: string, opts: { limit: number; after?: string }): Promise<DiscordMessage[]> {
		const qs = `?limit=${opts.limit}${opts.after !== undefined ? `&after=${opts.after}` : ""}`;
		return (await this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages${qs}`)) ?? [];
	}

	post(channelId: string, content: string): Promise<unknown> {
		return this.request("POST", `/channels/${channelId}/messages`, { content });
	}

	typing(channelId: string): Promise<unknown> {
		return this.request("POST", `/channels/${channelId}/typing`);
	}

	/** The DM channel with a user, created on demand (bot.py:159-162). */
	async dmChannel(userId: string): Promise<string> {
		const out = await this.request<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
		if (!out?.id) throw new Error(`discord: no DM channel for user ${userId}`);
		return out.id;
	}
}

// ── Pure message rules (bot.py:165-180, 540-585) ──────────────────

/** Chunks ≤ `max` chars, cut at the last newline inside the limit when there is one. */
export function splitMessage(text: string, max = MESSAGE_LIMIT): string[] {
	if (text.length <= max) return [text];
	const chunks: string[] = [];
	while (text.length > 0) {
		if (text.length <= max) {
			chunks.push(text);
			break;
		}
		let cut = text.lastIndexOf("\n", max - 1);
		if (cut <= 0) cut = max;
		chunks.push(text.slice(0, cut));
		text = text.slice(cut).replace(/^\n+/, "");
	}
	return chunks;
}

/** True when the message @mentions someone other than the bot, or @everyone/@here. */
export function hasOtherMentions(msg: DiscordMessage, botId: string): boolean {
	if (msg.mention_everyone) return true;
	return (msg.mentions ?? []).some((m) => m.id !== botId);
}

/**
 * The block text for a Discord message: `<display name>: <content>` with the
 * bot's own @mention stripped. Null for the bot's own messages and for
 * messages with nothing left to say (a bare @mention).
 */
export function messageText(msg: DiscordMessage, botId: string): string | null {
	if (msg.author.id === botId) return null;
	const content = (msg.content ?? "").replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
	if (!content) return null;
	const name = msg.author.global_name || msg.author.username || "unknown";
	return `${name}: ${content}`;
}

// ── Watermarks (bot.py:522-526, 556-576, 1063-1066) ───────────────

/** The newest message id in a channel, "0" when it is empty. */
export async function seedMark(client: DiscordClient, channelId: string): Promise<string> {
	const newest = await client.messages(channelId, { limit: 1 });
	return newest[0]?.id ?? "0";
}

/** Messages after `after`, oldest first, and the advanced mark. */
export async function pollChannel(
	client: DiscordClient,
	channelId: string,
	after: string,
): Promise<{ mark: string; messages: DiscordMessage[] }> {
	const messages = await client.messages(channelId, { limit: 10, after });
	messages.sort((a, b) => (newer(a.id, b.id) ? 1 : a.id === b.id ? 0 : -1));
	let mark = after;
	for (const m of messages) if (newer(m.id, mark)) mark = m.id;
	return { mark, messages };
}

// ── Thread on the agent's object ──────────────────────────────────

// A conversation root carries its Conversation protobuf (core/conversation.odin
// encode_conversation): 1 id, 2 kind, 3 title, 4 participants, 5 created_at,
// 6 opened_by. Written once per channel, so a hand-rolled writer beats a
// protobuf dependency.
function varint(out: number[], v: bigint): void {
	while (v >= 0x80n) {
		out.push(Number(v & 0x7fn) | 0x80);
		v >>= 7n;
	}
	out.push(Number(v));
}

function strField(out: number[], field: number, s: string): void {
	if (!s) return;
	const bytes = new TextEncoder().encode(s);
	out.push((field << 3) | 2);
	varint(out, BigInt(bytes.length));
	for (const b of bytes) out.push(b);
}

export function encodeConversation(c: { id: string; kind: number; title: string; participants: string[]; createdAt: number; openedBy: string }): string {
	const out: number[] = [];
	strField(out, 1, c.id);
	if (c.kind) {
		out.push((2 << 3) | 0);
		varint(out, BigInt(c.kind));
	}
	strField(out, 3, c.title);
	for (const p of c.participants) strField(out, 4, p);
	if (c.createdAt) {
		out.push((5 << 3) | 0);
		varint(out, BigInt(c.createdAt));
	}
	strField(out, 6, c.openedBy);
	return Buffer.from(out).toString("base64");
}

/** The channel's conversation root, created on first use: a human-kind thread the agent takes part in. */
async function ensureThread(obj: ObjectJSON, ref: ConvRef, agentId: string, title: string): Promise<void> {
	if (obj.blocks.some((b) => b.id === ref.threadId)) return;
	const data = encodeConversation({ id: ref.threadId, kind: 1 /* human */, title, participants: [agentId], createdAt: Date.now(), openedBy: agentId });
	await addBlock(ref.objectId, { id: ref.threadId, childrenIds: [], content: { custom: { contentType: "discussion", data, meta: {} } } }, "", 0);
	console.log(`[discord] opened thread ${ref.threadId} on ${ref.objectId.slice(0, 8)}`);
}

const chatRows = (obj: ObjectJSON, ref: ConvRef): Array<{ id: string; block: BlockJSON }> =>
	convBlocks(obj, ref.threadId).filter((row) => row.block.content.custom?.contentType === "chat");

const authorOf = (row: { block: BlockJSON }): string => row.block.content.custom?.meta?.["author"] ?? "";

/** Index of the agent's newest message in the thread, -1 when it never spoke there. */
function lastAgentIndex(rows: Array<{ block: BlockJSON }>, agentId: string): number {
	for (let i = rows.length - 1; i >= 0; i--) if (authorOf(rows[i]) === agentId) return i;
	return -1;
}

// ── Poller ────────────────────────────────────────────────────────

interface Channel {
	id: string;
	/** DMs answer everything; group channels skip messages aimed at other people (bot.py:582-585). */
	dm: boolean;
	ref: ConvRef;
	title: string;
	/** A turn is queued behind the agent's slot. */
	queued: boolean;
	running: boolean;
	/** Messages landed in the thread while a turn ran: the runner folds them in, unless it had already finished talking. */
	steered: boolean;
	/** Forwarding to Discord is serialised per channel so a keepalive flush and the post-turn flush never double-post. */
	flushing: Promise<void>;
}

const logError = (what: string) => (err: unknown) => console.error(`[discord] ${what}:`, err instanceof Error ? err.message : err);

/**
 * Poll one agent's channels and run its turns. `turn` runs one harness turn
 * on the channel's thread and resolves when it ended - with the turn's
 * failure text when it failed, which is forwarded to the channel like
 * bot.py's `[Bot error: …]` (bot.py:600-601).
 */
export function startDiscord(opts: {
	agentId: string;
	objectId: string;
	config: DiscordConfig;
	turn: (ref: ConvRef) => Promise<string | void>;
	client?: DiscordClient;
}): { stop(): void } {
	const { agentId, objectId, config } = opts;
	const client = opts.client ?? new DiscordClient(config.token);
	const tag = agentId.slice(0, 8);
	let stopped = false;
	let botId = "";
	let timer: Timer | undefined;
	const channels = new Map<string, Channel>();
	const unresolvedDms = new Set(config.allowedDmUsers);
	let chain: Promise<void> = Promise.resolve();

	function addChannel(id: string, dm: boolean, title: string): void {
		if (channels.has(id)) return;
		channels.set(id, { id, dm, ref: { objectId, threadId: discordThread(id) }, title, queued: false, running: false, steered: false, flushing: Promise.resolve() });
	}
	addChannel(config.channelId, false, `Discord #${config.channelId}`);
	for (const id of config.extraChannelIds) addChannel(id, false, `Discord #${id}`);

	async function resolveDms(): Promise<void> {
		for (const userId of [...unresolvedDms]) {
			try {
				const id = await client.dmChannel(userId);
				unresolvedDms.delete(userId);
				addChannel(id, true, `Discord DM ${userId}`);
				console.log(`[discord] ${tag}: DM channel for user ${userId} → ${id}`);
			} catch (err) {
				logError(`${tag}: resolving DM channel for user ${userId}`)(err);
			}
		}
	}

	/** Copy fresh human messages into the thread; true when any landed. */
	async function ingest(ch: Channel, messages: DiscordMessage[]): Promise<boolean> {
		const rows: Array<{ msg: DiscordMessage; text: string }> = [];
		for (const msg of messages) {
			const text = messageText(msg, botId);
			if (!text) continue;
			if (!ch.dm && hasOtherMentions(msg, botId)) {
				console.log(`[discord] ${tag}: skipping message aimed at someone else in ${ch.id}: ${text.slice(0, 80)}`);
				continue;
			}
			rows.push({ msg, text });
		}
		if (rows.length === 0) return false;
		const obj = await fetchObject(objectId);
		await ensureThread(obj, ch.ref, agentId, ch.title);
		// Identity, not marks, makes this idempotent: a poll that ingested and
		// then failed to save its mark re-reads the same messages.
		const copied = new Set(convBlocks(obj, ch.ref.threadId).map((r) => r.block.content.custom?.meta?.["origin_block"]).filter(Boolean));
		let landed = false;
		for (const { msg, text } of rows) {
			if (copied.has(msg.id)) continue;
			await addConvBlock(ch.ref, {
				id: crypto.randomUUID(),
				childrenIds: [],
				content: {
					custom: {
						contentType: "chat",
						meta: { author: discordAuthor(msg.author.id), text, origin: "discord", origin_thread: ch.id, origin_block: msg.id, ts: String(Date.now()) },
					},
				},
			});
			console.log(`[discord] ${tag}: ${ch.id} ← ${text.slice(0, 100)}`);
			landed = true;
		}
		return landed;
	}

	/** Forward agent blocks newer than `posted`. A mark whose block is gone (the thread moved objects) re-seeds at the newest one: never replay. */
	function flush(ch: Channel): Promise<void> {
		ch.flushing = ch.flushing.then(async () => {
			const obj = await fetchObject(objectId);
			const rows = chatRows(obj, ch.ref);
			const posted = (await markOf(ch.id))?.posted ?? "";
			let start = posted ? rows.findIndex((r) => r.id === posted) : -1;
			if (posted && start < 0) start = lastAgentIndex(rows, agentId);
			for (const row of rows.slice(start + 1)) {
				if (authorOf(row) !== agentId) continue;
				const text = (row.block.content.custom?.meta?.["text"] ?? "").trim();
				for (const chunk of text ? splitMessage(text) : []) {
					await client.post(ch.id, chunk);
					await Bun.sleep(CHUNK_GAP_MS);
				}
				await setMark(ch.id, { posted: row.id });
			}
		}).catch(logError(`${tag}: forwarding to ${ch.id}`));
		return ch.flushing;
	}

	async function runChannel(ch: Channel): Promise<void> {
		ch.queued = false;
		ch.running = true;
		ch.steered = false;
		await client.typing(ch.id).catch(logError(`${tag}: typing in ${ch.id}`));
		const keepalive = setInterval(() => {
			void client.typing(ch.id).catch(logError(`${tag}: typing in ${ch.id}`));
			void flush(ch);
		}, TYPING_MS);
		let failure = "";
		try {
			failure = (await opts.turn(ch.ref)) || "";
		} catch (err) {
			failure = err instanceof Error ? err.message : String(err);
		} finally {
			clearInterval(keepalive);
			ch.running = false;
		}
		await flush(ch);
		if (failure) {
			console.error(`[discord] ${tag}: turn on ${ch.id} failed: ${failure}`);
			await client.post(ch.id, `[Bot error: ${failure.slice(0, 500)}]`).catch(logError(`${tag}: posting error to ${ch.id}`));
		}
		// A message that arrived after the runner's last model call was never
		// seen. The thread tells: it ends on a human when that happened.
		if (ch.steered && !stopped) {
			const obj = await fetchObject(objectId).catch(() => null);
			const rows = obj ? chatRows(obj, ch.ref) : [];
			if (rows.length > 0 && authorOf(rows[rows.length - 1]) !== agentId) schedule(ch);
		}
	}

	/** One turn in flight per agent; other channels queue behind it (bot.py:290, 1098-1113). */
	function schedule(ch: Channel): void {
		if (stopped || ch.queued) return;
		if (ch.running) {
			ch.steered = true;
			return;
		}
		ch.queued = true;
		chain = chain.then(() => runChannel(ch)).catch(logError(`${tag}: turn on ${ch.id}`));
	}

	async function pollAll(): Promise<void> {
		if (!botId) {
			const me = await client.me();
			botId = me.id;
			console.log(`[discord] ${tag}: bot user ${me.username} (${botId}), polling ${channels.size} channel(s)`);
		}
		if (unresolvedDms.size > 0) await resolveDms();
		for (const ch of channels.values()) {
			if (stopped) return;
			try {
				let mark = await markOf(ch.id);
				if (!mark) {
					// First sight: nothing said before now, on either side, is owed.
					const rows = chatRows(await fetchObject(objectId), ch.ref);
					const spoken = lastAgentIndex(rows, agentId);
					mark = { seen: await seedMark(client, ch.id), posted: spoken >= 0 ? rows[spoken].id : "" };
					await setMark(ch.id, mark);
					console.log(`[discord] ${tag}: ${ch.dm ? "DM" : "channel"} ${ch.id} seeded at ${mark.seen}`);
				}
				const { mark: seen, messages } = await pollChannel(client, ch.id, mark.seen);
				if (messages.length === 0) continue;
				const landed = await ingest(ch, messages);
				await setMark(ch.id, { seen });
				if (landed) schedule(ch);
			} catch (err) {
				logError(`${tag}: polling ${ch.id}`)(err);
			}
		}
	}

	async function loop(): Promise<void> {
		if (stopped) return;
		try {
			await pollAll();
		} catch (err) {
			logError(`${tag}: poll`)(err);
		}
		if (!stopped) timer = setTimeout(() => void loop(), POLL_MS);
	}
	void loop();

	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
			console.log(`[discord] ${tag}: stopped`);
		},
	};
}

// ── Manager: pollers follow the served set ────────────────────────

/**
 * Keep one poller per served agent whose kind talks to Discord: the kind
 * (or the agent's own `requires`) names `discord-bot`, the agent names a
 * channel, and this machine holds the token. Re-read every 15 s so an
 * agent adopted, reconfigured or dropped after boot follows without a
 * restart; `sync()` forces a pass.
 */
export function startDiscordManager(host: {
	served(): Array<{ agentId: string; objectId: string }>;
	turn(agentId: string, ref: ConvRef): Promise<string | void>;
}): { stop(): void; sync(): Promise<void> } {
	const running = new Map<string, { key: string; stop(): void }>();
	let syncing: Promise<void> | undefined;

	async function pass(): Promise<void> {
		const token = await discordToken();
		const want = new Map<string, { objectId: string; config: DiscordConfig; key: string }>();
		if (token) {
			for (const { agentId, objectId } of host.served()) {
				const agent = await fetchObject(agentId).catch(() => null);
				if (!agent) continue;
				const requires = [...agentKind(str(agent.fields, "kind")).requires, ...list(agent.fields, "requires")];
				if (!requires.includes("discord-bot")) continue;
				const cfg = discordConfigFor(agent);
				if (!cfg) continue;
				const config = { token, ...cfg };
				want.set(agentId, { objectId, config, key: JSON.stringify({ objectId, config }) });
			}
		}
		for (const [agentId, poller] of running) {
			if (want.get(agentId)?.key === poller.key) continue;
			poller.stop();
			running.delete(agentId);
		}
		for (const [agentId, w] of want) {
			if (running.has(agentId)) continue;
			console.log(`[discord] starting poller for ${agentId.slice(0, 8)} on #${w.config.channelId}`);
			const poller = startDiscord({ agentId, objectId: w.objectId, config: w.config, turn: (ref) => host.turn(agentId, ref) });
			running.set(agentId, { key: w.key, stop: poller.stop });
		}
	}

	function sync(): Promise<void> {
		if (!syncing) syncing = pass().catch(logError("reconcile")).finally(() => (syncing = undefined));
		return syncing;
	}

	void sync();
	const timer = setInterval(() => void sync(), RECONCILE_MS);
	return {
		sync,
		stop() {
			clearInterval(timer);
			for (const poller of running.values()) poller.stop();
			running.clear();
		},
	};
}
