import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetScheduler, startScheduler, waitForTurnEnd } from "./schedule";

let root = "";
let previousRoot: string | undefined;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-schedule-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	resetScheduler();
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function respond(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

test("a scheduled object fires to the served agent on its guest list", async () => {
	const now = Date.now();
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const channelId = "34e8f017-dfd1-4062-abaf-f7574f2b5176";
	const guestAgentId = "856fcc37-9ad6-43e8-a1d8-5ee236699183";
	const transcriptObject = "64a59d6f-0000-4000-8000-000000000001";
	const transcriptThread = "64a59d6f-0000-4000-8000-000000000002";
	const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
	let machine = "";
	const fetchMock = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ path: url.pathname, method, body });
		const filter = Array.isArray(body.filters) ? body.filters[0] : undefined;
		if (url.pathname === "/api/query") {
			if (body.type === "machine") return respond({ records: [], total: 0 });
			if (filter?.key === "repeat") {
				return respond({
					records: [{ id: objectId, typeKey: "marketing_task", fields: { repeat: { mapValue: { entries: { next: { intValue: now - 1000 } } } } } }],
					total: 1,
				});
			}
			return respond({ records: [], total: 0 });
		}
		if (url.pathname === "/api/serving") {
			const ids = (body.objectIds as string[]) ?? [];
			return respond(Object.fromEntries(ids.map((id) => [id, { machineId: machine, reason: "space", requires: [], candidates: [machine] }])));
		}
		if (url.pathname === `/api/objects/${objectId}`) {
			return respond({
				id: objectId,
				typeKey: "marketing_task",
				fields: {
					channel: { stringValue: channelId },
					name: { stringValue: "Retweet recent tagged in posts" },
					agent: { valuesValue: { items: [{ stringValue: guestAgentId }] } },
				},
				blocks: [],
				deleted: false,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (url.pathname === "/api/mutate") {
			if (body.action === "occurrence_fire") return respond({ ok: true });
			if (body.action === "block_add") return respond({ ok: true, id: "message" });
			if (body.action === "run_record") return respond({ ok: true });
			return respond({ ok: false, error: `unexpected ${String(body.action)}` }, 400);
		}
		return respond({ error: `unexpected ${method} ${url.pathname}` }, 404);
	}) as typeof fetch;
	globalThis.fetch = fetchMock;
	const turns: string[] = [];
	const turnDone = waitForTurnEnd();
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	machine = "test-machine";
	await startScheduler({
		async served(agentId) {
			if (agentId !== guestAgentId) return undefined;
			return { agentId, conv: { objectId: transcriptObject, threadId: transcriptThread } };
		},
		async turn(agentId) {
			turns.push(agentId);
			return "";
		},
	});
	await turnDone;
	const schedulerMessages = calls.filter((c) => c.path === "/api/mutate" && c.body.action === "block_add");
	expect(turns).toEqual([guestAgentId]);
	// The message goes into the agent's thread on its host object, not at
	// that object's root and not onto the scheduled object's discussion.
	expect(schedulerMessages.some((c) => c.body.object_id === transcriptObject && c.body.target_id === transcriptThread && c.body.position === 5)).toBe(true);
	expect(schedulerMessages.some((c) => c.body.object_id === objectId)).toBe(false);
	const runs = calls.filter((c) => c.path === "/api/mutate" && c.body.action === "run_record");
	expect((runs[0]?.body.run as Record<string, unknown>)?.conversation).toBe(`${transcriptObject}:${transcriptThread}`);
});

test("a scheduled object with no agent gets an error badge and no turn", async () => {
	const now = Date.now();
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const channelId = "34e8f017-dfd1-4062-abaf-f7574f2b5176";
	const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
	let machine = "";
	const fetchMock = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ path: url.pathname, method, body });
		const filter = Array.isArray(body.filters) ? body.filters[0] : undefined;
		if (url.pathname === "/api/query") {
			if (body.type === "machine") return respond({ records: [], total: 0 });
			if (filter?.key === "repeat") {
				return respond({
					records: [{ id: objectId, typeKey: "marketing_task", fields: { repeat: { mapValue: { entries: { next: { intValue: now - 1000 } } } } } }],
					total: 1,
				});
			}
			return respond({ records: [], total: 0 });
		}
		if (url.pathname === "/api/serving") {
			const ids = (body.objectIds as string[]) ?? [];
			return respond(Object.fromEntries(ids.map((id) => [id, { machineId: machine, reason: "space", requires: [], candidates: [machine] }])));
		}
		if (url.pathname === `/api/objects/${objectId}`) {
			return respond({
				id: objectId,
				typeKey: "marketing_task",
				fields: { channel: { stringValue: channelId }, name: { stringValue: "Retweet recent tagged in posts" } },
				blocks: [],
				deleted: false,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (url.pathname === "/api/mutate") {
			if (body.action === "occurrence_fire") return respond({ ok: true });
			if (body.action === "block_add") return respond({ ok: true, id: "message" });
			if (body.action === "set_field") return respond({ ok: true });
			return respond({ ok: false, error: `unexpected ${String(body.action)}` }, 400);
		}
		return respond({ error: `unexpected ${method} ${url.pathname}` }, 404);
	}) as typeof fetch;
	globalThis.fetch = fetchMock;
	const turns: string[] = [];
	const turnDone = waitForTurnEnd();
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	machine = "test-machine";
	await startScheduler({
		async served() {
			return undefined;
		},
		async turn(agentId) {
			turns.push(agentId);
			return "";
		},
	});
	await turnDone;
	// No agent owns the occurrence: no turn, no run record; the object's
	// Error badge says why, and the human gets the reminder instead.
	expect(turns).toEqual([]);
	expect(calls.some((c) => c.body.action === "run_record")).toBe(false);
	const badge = calls.find((c) => c.body.action === "set_field" && c.body.key === "error");
	expect((badge?.body.value as { stringValue?: string })?.stringValue).toBe("recurring object has no agent; add one to its Agent property");
	const reminders = calls.filter((c) => c.body.action === "block_add");
	expect(reminders.some((c) => c.body.object_id === objectId && c.body.target_id === "__discussion__")).toBe(true);
});
