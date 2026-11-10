/**
 * Live progress in a chat, end to end in the harness: an agent answering an
 * object's chat thinks (streamed from Anthropic), calls one tool, thinks
 * again and answers. Watchers of that chat get its thinking, the step and
 * `done` through `live_publish`, paced; the reply posted there carries the
 * merged record and how long it worked. The store is a fake daemon (an
 * in-memory map behind the harness's HTTP calls), Anthropic a fake stream.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockJSON, ObjectJSON, QueryRow, ValueJSON } from "./api";
import { HUMAN_THREAD } from "./conv";
import { capRecord, LIVE_INTERVAL_MS, liveSettled, RECORD_CAP_BYTES, TRIMMED_MARKER, type RecordEntry } from "./live";
import { answerChat } from "./runner";
import { resetMachineIdCache } from "./roster";
import type { LiveEvent } from "./types";

const AGENT = "agent-live";
const SPACE = "space-live";
const PAGE = "page-live";
const CRED = "cred-anthropic";
const THREAD = "__thread__transcript";
const SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b";

const sv = (s: string): ValueJSON => ({ stringValue: s });
function object(id: string, typeKey: string, fields: Record<string, ValueJSON>, blocks: BlockJSON[] = []): ObjectJSON {
	return { id, typeKey, fields: { channel: sv(SPACE), ...fields }, blocks, deleted: false, createdAt: 1, updatedAt: 1, mailbox: [] } as ObjectJSON;
}

let objects = new Map<string, ObjectJSON>();
let created = 0;
let published: Array<{ at: number; event: LiveEvent }> = [];
let posts: Array<Record<string, unknown>> = [];
let modelRequests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
const originalFetch = globalThis.fetch;

/** One streamed Messages response, as server-sent events. */
function sse(events: Array<Record<string, unknown>>): Response {
	const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const THINKING_DELTAS = ["Checking ", "whether ", "the repo ", "is clean ", "now."];

/** First call: thinking in pieces, then one tool call. Second: a little more thinking, then the answer. */
function modelReply(call: number): Response {
	if (call === 1) {
		return sse([
			{ type: "message_start", message: { usage: { input_tokens: 120, output_tokens: 1 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			...THINKING_DELTAS.map((thinking) => ({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } })),
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } },
			{ type: "content_block_stop", index: 0 },
			{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "object_search", input: {} } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":' } },
			{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"repo"}' } },
			{ type: "content_block_stop", index: 1 },
			{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
			{ type: "message_stop" },
		]);
	}
	return sse([
		{ type: "message_start", message: { usage: { input_tokens: 160, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Nothing found; say so." } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-2" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "The repo is clean." } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } },
		{ type: "message_stop" },
	]);
}

function daemon(): void {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.hostname === "api.anthropic.com") {
			modelRequests.push({ body, headers: new Headers(init?.headers) });
			return modelReply(modelRequests.length);
		}
		if (url.port !== "7333") return originalFetch(input, init);
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.get(decodeURIComponent(url.pathname.slice("/api/objects/".length)));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (url.pathname === "/api/vanished") return Response.json({ vanished: [] });
		if (url.pathname === "/api/query") {
			const records: QueryRow[] = [...objects.values()]
				.filter((o) => !body.type || o.typeKey === body.type)
				.map((o) => ({ id: o.id, typeKey: o.typeKey, createdAt: o.createdAt, updatedAt: o.updatedAt, fields: o.fields }));
			return Response.json({ records, total: records.length });
		}
		if (url.pathname === "/api/mutate") {
			const target = objects.get(String(body.object_id));
			switch (body.action) {
				case "live_publish":
					published.push({ at: Date.now(), event: body.event as LiveEvent });
					return Response.json({ ok: true });
				case "chat_post":
					posts.push(body);
					return Response.json({ ok: true, id: `post-${posts.length}`, threadId: String(body.thread_id || HUMAN_THREAD) });
				case "set_field":
					if (target) target.fields[String(body.key)] = body.value as ValueJSON;
					return Response.json({ ok: true });
				case "create": {
					const id = body.id ? String(body.id) : `made-${++created}`;
					if (!objects.has(id)) objects.set(id, object(id, String(body.type_key), { name: sv(String(body.name ?? "")), ...((body.fields as Record<string, ValueJSON>) ?? {}) }));
					return Response.json({ ok: true, id });
				}
				case "block_add": {
					const block = body.block as BlockJSON;
					target?.blocks.push({ ...block, childrenIds: block.childrenIds ?? [] });
					target?.blocks.find((b) => b.id === body.target_id)?.childrenIds.push(block.id);
					return Response.json({ ok: true, id: block.id });
				}
			}
			return Response.json({ ok: true });
		}
		return Response.json({}, { status: 200 });
	}) as typeof fetch;
}

let root = "";
let previousData: string | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "roostr-live-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	previousData = process.env.GLON_DATA;
	process.env.GLON_DATA = root;
	resetMachineIdCache();
	published = [];
	posts = [];
	modelRequests = [];
	created = 0;
	objects = new Map(
		[
			object(SPACE, "channel", { name: sv("Live") }),
			object(CRED, "credential", { name: sv("Anthropic"), service: sv("anthropic"), key_api_key: sv("sk-ant-api03-test") }),
			object(PAGE, "task", { name: sv("Ship it") }),
			// The space already has its built-ins: no fresh-space settle wait (tool-objects.ts).
			object("tool-search", "tool", { name: sv("object_search"), tool_builtin: { boolValue: true } }),
			object(
				AGENT,
				"agent",
				{
					name: sv("Helper"),
					model: { valuesValue: { items: [sv("claude-sonnet-4-5")] } },
					temperature: { intValue: 0 },
					credentials: { valuesValue: { items: [{ linkValue: { targetId: CRED, relationKey: "credentials" } }] } },
				},
				[
					{ id: THREAD, childrenIds: ["m1"], content: { custom: { contentType: "conversation", meta: {} } } },
					{ id: "m1", childrenIds: [], content: { custom: { contentType: "chat", meta: { author: "person-1", text: "@Helper is the repo clean?", ts: "1" } } } },
				] as BlockJSON[],
			),
		].map((o) => [o.id, o]),
	);
	daemon();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousData === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousData;
	resetMachineIdCache();
	await rm(root, { recursive: true, force: true });
});

test("a chat turn publishes its thinking, its step and done, paced, and its reply keeps the record", async () => {
	const reply = await answerChat(AGENT, { objectId: AGENT, threadId: THREAD }, { objectId: PAGE, threadId: HUMAN_THREAD });
	expect(reply).toBe("The repo is clean.");
	expect(published.length).toBeGreaterThan(0);
	await liveSettled();

	// Every event names the run, the agent and the chat it is about, in seq order.
	const events = published.map((p) => p.event);
	for (const e of events) expect(e).toMatchObject({ v: 1, run: events[0].run, agent: AGENT, object: PAGE, thread: HUMAN_THREAD });
	expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
	const kinds = events.map((e) => e.kind).filter((k, i, all) => k !== all[i - 1]);
	expect(kinds).toEqual(["thinking", "step", "thinking", "done"]);
	const stepAt = events.findIndex((e) => e.kind === "step");
	expect(events[stepAt].text).toBe("object_search: repo");
	expect(events.slice(0, stepAt).map((e) => e.text).join("")).toBe(THINKING_DELTAS.join(""));
	expect(events.slice(stepAt + 1, -1).map((e) => e.text).join("")).toBe("Nothing found; say so.");
	expect(events[events.length - 1].text).toBe("");
	// Paced: deltas that arrived together went out together, one event per slot.
	expect(stepAt).toBeLessThan(THINKING_DELTAS.length);
	for (let i = 1; i < published.length; i++) expect(published[i].at - published[i - 1].at).toBeGreaterThanOrEqual(LIVE_INTERVAL_MS - 5);

	// The reply on the object's chat carries the merged record and the time it took.
	const onPage = posts.filter((p) => p.object_id === PAGE);
	expect(onPage).toHaveLength(1);
	expect(onPage[0]).toMatchObject({ text: "The repo is clean.", as_author: AGENT });
	const record = JSON.parse(String(onPage[0].thinking)) as RecordEntry[];
	expect(record.map(({ kind, text }) => ({ kind, text }))).toEqual([
		{ kind: "thinking", text: THINKING_DELTAS.join("") },
		{ kind: "step", text: "object_search: repo" },
		{ kind: "thinking", text: "Nothing found; say so." },
	]);
	expect(typeof onPage[0].thought_ms).toBe("number");
	expect(onPage[0].thought_ms as number).toBeGreaterThanOrEqual(0);

	// Claude was asked to think (no custom temperature, room past the budget), streamed.
	const first = modelRequests[0];
	expect(first.body).toMatchObject({ stream: true, thinking: { type: "enabled", budget_tokens: 8192 } });
	expect(first.body.temperature).toBeUndefined();
	expect(first.body.max_tokens as number).toBeGreaterThan(8192);
	expect(first.headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
	// The tool-use turn's next request carries the thinking back, signature and all, before the call.
	const assistant = (modelRequests[1].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).filter((m) => m.role === "assistant").pop()!;
	const callAt = assistant.content.findIndex((c) => c.type === "tool_use" && c.id === "toolu_1");
	expect(callAt).toBeGreaterThan(0);
	expect(assistant.content[callAt - 1]).toEqual({ type: "thinking", thinking: THINKING_DELTAS.join(""), signature: SIGNATURE });
});

test("a turn that fails publishes error, and the turn's failure still surfaces", async () => {
	objects.get(AGENT)!.fields.model = { valuesValue: { items: [] } };
	await expect(answerChat(AGENT, { objectId: AGENT, threadId: THREAD }, { objectId: PAGE, threadId: HUMAN_THREAD })).rejects.toThrow("No Model set");
	await liveSettled();
	expect(published.map((p) => p.event.kind)).toEqual(["error"]);
	expect(published[0].event.text).toContain("No Model set");
	expect(posts.filter((p) => p.object_id === PAGE)).toHaveLength(0);
});

test("a publish the store refuses never breaks the turn", async () => {
	const fake = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		if (init?.body && String(init.body).includes('"live_publish"')) return Response.json({ error: "store down" }, { status: 500 });
		return fake(input, init);
	}) as typeof fetch;
	const reply = await answerChat(AGENT, { objectId: AGENT, threadId: THREAD }, { objectId: PAGE, threadId: HUMAN_THREAD });
	expect(reply).toBe("The repo is clean.");
	expect(posts.filter((p) => p.object_id === PAGE)).toHaveLength(1);
});

test("the record is capped: oldest thinking goes first, steps stay, a marker says so", () => {
	const big = (c: string) => c.repeat(40 * 1024);
	const entries: RecordEntry[] = [
		{ kind: "thinking", text: big("a"), ts: 1 },
		{ kind: "step", text: "shell_exec: git status", ts: 2 },
		{ kind: "thinking", text: big("b"), ts: 3 },
		{ kind: "step", text: "web_fetch: example.com", ts: 4 },
		{ kind: "thinking", text: big("c"), ts: 5 },
	];
	const capped = capRecord(entries);
	expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(RECORD_CAP_BYTES);
	const kept = JSON.parse(capped) as RecordEntry[];
	expect(kept[0]).toMatchObject({ kind: "step", text: TRIMMED_MARKER });
	expect(kept.filter((e) => e.kind === "step").map((e) => e.text)).toEqual([TRIMMED_MARKER, "shell_exec: git status", "web_fetch: example.com"]);
	const thoughts = kept.filter((e) => e.kind === "thinking").map((e) => e.text);
	expect(thoughts.join("")).not.toContain("a");
	expect(thoughts[thoughts.length - 1]).toBe(big("c"));
	// Under the cap nothing changes.
	const small: RecordEntry[] = [{ kind: "thinking", text: "short", ts: 1 }];
	expect(capRecord(small)).toBe(JSON.stringify(small));
});
