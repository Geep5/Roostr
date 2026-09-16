import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetScheduler, startScheduler } from "./schedule";

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

test("a scheduled object without an owner uses its space's default agent", async () => {
	const now = Date.now();
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const channelId = "34e8f017-dfd1-4062-abaf-f7574f2b5176";
	const defaultAgentId = "856fcc37-9ad6-43e8-a1d8-5ee236699183";
	const chatId = "64a59d6f-0000-4000-8000-000000000001";
	const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
	let machine = "";
	const fetchMock = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ path: url.pathname, method, body });
		if (url.pathname === "/api/query") {
			if (body.type === "machine") return respond({ records: [], total: 0 });
			if (body.filters?.[0]?.key === "repeat") {
				return respond({
					records: [{ id: objectId, typeKey: "marketing_task", fields: { repeat: { mapValue: { entries: { next: { intValue: now - 1000 } } } } } }],
					total: 1,
				});
			}
			if (body.type === "agent" && body.filters?.[0]?.key === "bound_object") return respond({ records: [], total: 0 });
			if (body.type === "agent" && body.filters?.[0]?.key === "space_default") {
				return respond({ records: [{ id: defaultAgentId, typeKey: "agent", fields: {} }], total: 1 });
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
			if (body.action === "run_record") return respond({ ok: true });
			return respond({ ok: false, error: `unexpected ${String(body.action)}` }, 400);
		}
		return respond({ error: `unexpected ${method} ${url.pathname}` }, 404);
	}) as typeof fetch;
	globalThis.fetch = fetchMock;
	const turns: string[] = [];
	let resolveTurn!: () => void;
	const turnDone = new Promise<void>((resolve) => {
		resolveTurn = resolve;
	});
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	machine = "test-machine";
	await startScheduler({
		async served(agentId) {
			return agentId === defaultAgentId ? { agentId, chatId } : undefined;
		},
		async turn(agentId) {
			turns.push(agentId);
			resolveTurn();
			return "";
		},
	});
	await turnDone;
	const schedulerMessages = calls.filter((c) => c.path === "/api/mutate" && c.body.action === "block_add");
	expect(turns).toEqual([defaultAgentId]);
	expect(schedulerMessages.some((c) => c.body.object_id === chatId)).toBe(true);
	expect(schedulerMessages.some((c) => c.body.object_id === objectId)).toBe(false);
});
