/**
 * The Discord surface's rules, without Discord: what a message becomes in
 * the thread, how a reply is cut for the 2000-char limit, where a channel's
 * watermark starts and how it moves, and that a 429 waits `retry_after`
 * instead of hammering. `fetch` is a stub throughout; nothing here talks
 * to discord.com or the daemon.
 */
import { expect, test } from "bun:test";
import { DiscordClient, hasOtherMentions, messageText, pollChannel, seedMark, splitMessage, type DiscordMessage } from "./discord";

const BOT = "111";

function msg(id: string, authorId: string, content: string, extra: Partial<DiscordMessage> = {}): DiscordMessage {
	return { id, content, author: { id: authorId, username: `user${authorId}` }, ...extra };
}

/** A fetch stub answering by `METHOD path`; a route with several replies hands them out in order and repeats the last. */
function fakeFetch(routes: Record<string, Array<{ status: number; body?: unknown }>>) {
	const calls: Array<{ method: string; path: string }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const path = String(input).replace("https://discord.com/api/v10", "");
		const method = init?.method ?? "GET";
		calls.push({ method, path });
		const queue = routes[`${method} ${path}`];
		const reply = queue?.length ? queue.length > 1 ? queue.shift()! : queue[0] : { status: 404, body: { message: "no route" } };
		return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

test("a human message becomes '<display name>: <content>' with the bot mention stripped", () => {
	const m = msg("5", "42", `<@${BOT}> hey <@!${BOT}> can you check prod?`, { author: { id: "42", username: "geep", global_name: "Geep" } });
	expect(messageText(m, BOT)).toBe("Geep: hey  can you check prod?");
});

test("display name falls back to the username, then 'unknown'", () => {
	expect(messageText(msg("1", "42", "hi"), BOT)).toBe("user42: hi");
	expect(messageText({ id: "2", content: "hi", author: { id: "43" } }, BOT)).toBe("unknown: hi");
});

test("the bot's own messages and bare mentions produce no block", () => {
	expect(messageText(msg("1", BOT, "I am the bot"), BOT)).toBeNull();
	expect(messageText(msg("2", "42", `<@${BOT}>`), BOT)).toBeNull();
	expect(messageText(msg("3", "42", "   "), BOT)).toBeNull();
});

test("mentions of other people or @everyone mark a message as not for the bot", () => {
	expect(hasOtherMentions(msg("1", "42", "x", { mentions: [{ id: BOT }] }), BOT)).toBe(false);
	expect(hasOtherMentions(msg("2", "42", "x", { mentions: [{ id: BOT }, { id: "77" }] }), BOT)).toBe(true);
	expect(hasOtherMentions(msg("3", "42", "x", { mention_everyone: true }), BOT)).toBe(true);
});

// ── split_message (bot.py:165-180) ────────────────────────────────

test("short text is one chunk", () => {
	expect(splitMessage("hello")).toEqual(["hello"]);
	expect(splitMessage("x".repeat(2000))).toEqual(["x".repeat(2000)]);
});

test("long text cuts at the last newline inside the limit and drops the newline", () => {
	const a = "a".repeat(1500);
	const b = "b".repeat(1500);
	const c = "c".repeat(400);
	const chunks = splitMessage(`${a}\n${b}\n${c}`);
	expect(chunks).toEqual([a, `${b}\n${c}`]);
	for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
});

test("a paragraph longer than the limit is cut hard at the limit", () => {
	const chunks = splitMessage("z".repeat(4500));
	expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);
});

test("a newline exactly at the limit is a boundary, not a leading blank", () => {
	const head = "h".repeat(1999);
	const chunks = splitMessage(`${head}\ntail`);
	expect(chunks).toEqual([head, "tail"]);
});

// ── Watermarks ────────────────────────────────────────────────────

test("a channel seeds at its newest message, or at 0 when empty", async () => {
	const { fetchImpl, calls } = fakeFetch({
		"GET /channels/A/messages?limit=1": [{ status: 200, body: [msg("900", "42", "old news")] }],
		"GET /channels/B/messages?limit=1": [{ status: 200, body: [] }],
	});
	const client = new DiscordClient("t", fetchImpl);
	expect(await seedMark(client, "A")).toBe("900");
	expect(await seedMark(client, "B")).toBe("0");
	expect(calls.map((c) => c.path)).toEqual(["/channels/A/messages?limit=1", "/channels/B/messages?limit=1"]);
});

test("polling asks for messages after the mark and advances it to the newest id, oldest first", async () => {
	const { fetchImpl, calls } = fakeFetch({
		"GET /channels/A/messages?limit=10&after=900": [{ status: 200, body: [msg("903", "42", "third"), msg("901", "42", "first"), msg("902", "42", "second")] }],
		"GET /channels/A/messages?limit=10&after=903": [{ status: 200, body: [] }],
	});
	const client = new DiscordClient("t", fetchImpl);
	const first = await pollChannel(client, "A", "900");
	expect(first.messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
	expect(first.mark).toBe("903");
	const second = await pollChannel(client, "A", first.mark);
	expect(second.messages).toEqual([]);
	expect(second.mark).toBe("903");
	expect(calls.map((c) => c.path)).toEqual(["/channels/A/messages?limit=10&after=900", "/channels/A/messages?limit=10&after=903"]);
});

test("snowflakes compare numerically, so a 19-digit id beats an 18-digit one", async () => {
	const { fetchImpl } = fakeFetch({
		"GET /channels/A/messages?limit=10&after=999999999999999999": [{ status: 200, body: [msg("1000000000000000000", "42", "new era")] }],
	});
	const { mark } = await pollChannel(new DiscordClient("t", fetchImpl), "A", "999999999999999999");
	expect(mark).toBe("1000000000000000000");
});

// ── 429 ───────────────────────────────────────────────────────────

test("a 429 sleeps retry_after seconds and retries the same request", async () => {
	const { fetchImpl, calls } = fakeFetch({
		"POST /channels/A/messages": [{ status: 429, body: { retry_after: 0.05 } }, { status: 200, body: { id: "1" } }],
	});
	const slept: number[] = [];
	const client = new DiscordClient("t", fetchImpl, async (ms) => void slept.push(ms));
	expect(await client.post("A", "hi")).toEqual({ id: "1" });
	expect(slept).toEqual([50]);
	expect(calls).toHaveLength(2);
});

test("a persistent 429 gives up after the retries instead of looping forever", async () => {
	const { fetchImpl, calls } = fakeFetch({ "POST /channels/A/messages": [{ status: 429, body: { retry_after: 0 } }] });
	const client = new DiscordClient("t", fetchImpl, async () => {});
	await expect(client.post("A", "hi")).rejects.toThrow(/rate limited/);
	expect(calls).toHaveLength(4);
});

test("other errors throw with the status, and the bot token travels as a Bot header", async () => {
	let auth: string | null = "";
	const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
		auth = new Headers(init?.headers).get("Authorization");
		return new Response(JSON.stringify({ message: "Unknown Channel" }), { status: 404 });
	}) as typeof fetch;
	await expect(new DiscordClient("s3cret", fetchImpl).typing("A")).rejects.toThrow(/404/);
	expect(auth).toBe("Bot s3cret");
});
