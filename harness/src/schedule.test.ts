import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialBadge, issuesBadge, missingBadge, parseIssuesBadge } from "./credential-issues";
import { flagStuckRuns, handleStuckChange, isEmptyResult, resetScheduler, retryUnblockedRuns, runNow, STUCK_BADGE, startScheduler, waitForTurnEnd } from "./schedule";

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

/** These tests run no agent with Fresh each run. */
async function unusedFresh(): Promise<never> {
	throw new Error("fresh is not expected in this test");
}

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
			return respond(Object.fromEntries(ids.map((id) => [id, { machineId: machine, reason: "agent", skills: [], candidates: [machine] }])));
		}
		if (url.pathname === `/api/objects/${objectId}`) {
			return respond({
				id: objectId,
				typeKey: "marketing_task",
				fields: {
					channel: { stringValue: channelId },
					name: { stringValue: "Retweet recent tagged in posts" },
					agent: { valuesValue: { items: [{ stringValue: guestAgentId }] } },
					repeat: { mapValue: { entries: {} } },
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
		fresh: unusedFresh,
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
			return respond(Object.fromEntries(ids.map((id) => [id, { machineId: machine, reason: "pinned", skills: [], candidates: [machine] }])));
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
		fresh: unusedFresh,
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

test("a check result counts as nothing new only when it is empty", () => {
	for (const empty of [null, undefined, "", "  ", [], {}, "[]", " {} ", "null"]) expect(isEmptyResult(empty)).toBe(true);
	for (const found of [0, false, "no", [{}], { n: 0 }, "[1]", "nothing new"]) expect(isEmptyResult(found)).toBe(false);
});

/** The scheduler's message block (postScheduled). */
interface FrameBlock {
	content: { custom: { meta: { text: string } } };
}

/**
 * A minute-repeat object whose Check first links a custom Tool running
 * `code`, owned by a served agent. Returns the daemon calls and turns.
 */
async function checkFirstRun(code: string): Promise<{ calls: Array<{ path: string; body: Record<string, unknown> }>; turns: string[] }> {
	const now = Date.now();
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const toolId = "7a1d0c3e-0000-4000-8000-000000000003";
	const agentId = "856fcc37-9ad6-43e8-a1d8-5ee236699183";
	const clock: Record<string, { stringValue?: string; intValue?: number }> = { freq: { stringValue: "minute" }, next: { intValue: now - 1000 } };
	const repeat = { mapValue: { entries: clock } };
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ path: url.pathname, body });
		const filter = Array.isArray(body.filters) ? body.filters[0] : undefined;
		if (url.pathname === "/api/query") {
			if (filter?.key === "repeat") return respond({ records: [{ id: objectId, typeKey: "task", fields: { repeat } }], total: 1 });
			return respond({ records: [], total: 0 });
		}
		if (url.pathname === "/api/serving") {
			const ids = (body.objectIds as string[]) ?? [];
			return respond(Object.fromEntries(ids.map((id) => [id, { machineId: "test-machine", reason: "agent", skills: [], candidates: ["test-machine"] }])));
		}
		if (url.pathname === `/api/objects/${objectId}`) {
			return respond({
				id: objectId,
				typeKey: "task",
				fields: { name: { stringValue: "Check support inbox" }, agent: { valuesValue: { items: [{ stringValue: agentId }] } }, check_first: { valuesValue: { items: [{ linkValue: { targetId: toolId } }] } }, repeat },
				blocks: [{ id: "b", childrenIds: [], content: { text: { text: "Triage each new email.", style: 0 } } }],
				deleted: false,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (url.pathname === `/api/objects/${toolId}`) {
			return respond({
				id: toolId,
				typeKey: "tool",
				fields: { name: { stringValue: "check_inbox" }, tool_inputs: { stringValue: "object_id: string" } },
				blocks: [{ id: "code", childrenIds: [], content: { text: { text: code, style: 5 } } }],
				deleted: false,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (url.pathname === "/api/mutate") {
			// The engine's bookkeeping as the scheduler reads it: a fired occurrence doesn't fire again, a completed one moves on.
			if (body.action === "occurrence_fire") {
				if (clock.fired_for?.intValue === clock.next?.intValue) return respond({ ok: false, error: "occurrence already fired" }, 400);
				clock.fired_for = { intValue: clock.next?.intValue };
			}
			if (body.action === "occurrence_complete") clock.next = { intValue: now + 60_000 };
			return respond({ ok: true, id: "message" });
		}
		return respond({ error: `unexpected ${url.pathname}` }, 404);
	}) as typeof fetch;
	const turns: string[] = [];
	const turnDone = waitForTurnEnd();
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	await startScheduler({
		fresh: unusedFresh,
		async served(id) {
			return id === agentId ? { agentId, conv: { objectId: agentId, threadId: "thread" } } : undefined;
		},
		async turn(id) {
			turns.push(id);
			return "";
		},
	});
	await turnDone;
	return { calls, turns };
}

test("a check that finds nothing records the run, completes the occurrence and wakes no agent", async () => {
	// The check gets the repeating object's id; [] means nothing new.
	const { calls, turns } = await checkFirstRun('return input.object_id === "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83" ? [] : ["wrong input"];');
	expect(turns).toEqual([]);
	const mutations = calls.filter((c) => c.path === "/api/mutate").map((c) => c.body);
	expect(mutations.find((m) => m.action === "run_record")?.run).toMatchObject({ machine: "test-machine", result: "nothing new" });
	expect(mutations.some((m) => m.action === "occurrence_complete")).toBe(true);
	expect(mutations.some((m) => m.action === "block_add")).toBe(false);
});

test("a check that finds something puts it in the turn's frame ahead of the instructions", async () => {
	const { calls, turns } = await checkFirstRun('return [{ subject: "Refund please" }];');
	expect(turns).toEqual(["856fcc37-9ad6-43e8-a1d8-5ee236699183"]);
	const frame = calls.find((c) => c.body.action === "block_add")?.body.block as FrameBlock;
	const text = frame.content.custom.meta.text;
	expect(text).toContain("Check first (check_inbox) found:");
	expect(text.indexOf("Refund please")).toBeLessThan(text.indexOf("Triage each new email."));
	// A minute repeat: the scheduler completes the run itself once the turn ends.
	expect(calls.some((c) => c.body.action === "occurrence_complete")).toBe(true);
});

test("an occurrence still open when the next would be due is flagged on its Error, quoting the chat; finishing it clears the flag", async () => {
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const day = 86_400_000;
	const next = Date.now() - 2 * day; // fired two days ago, never completed
	let fields: Record<string, unknown> = {
		name: { stringValue: "Update Featured Tournaments" },
		repeat: { mapValue: { entries: { freq: { stringValue: "day" }, interval: { intValue: 1 }, next: { intValue: next }, fired_for: { intValue: next } } } },
	};
	const blocks = [
		{ id: "a", childrenIds: [], content: { custom: { contentType: "chat", meta: { author: "scheduler", text: "Scheduled occurrence…", ts: String(next) } } } },
		{ id: "b", childrenIds: [], content: { custom: { contentType: "chat", meta: { author: "agent-1", text: "Matcherino - Sharky needs Reconnect", ts: String(next + 30_000) } } } },
	];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return respond({ records: [{ id: objectId, typeKey: "task", fields }], total: 1 });
		if (url.pathname === "/api/serving") return respond({ [objectId]: { machineId: "test-machine", reason: "pinned", skills: [], candidates: ["test-machine"] } });
		if (url.pathname === `/api/objects/${objectId}`) return respond({ id: objectId, typeKey: "task", fields, blocks, deleted: false, createdAt: 0, updatedAt: 0 });
		if (url.pathname === "/api/mutate") {
			if (body.action === "set_field") fields = { ...fields, [String(body.key)]: body.value };
			if (body.action === "delete_field") fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== body.key));
			return respond({ ok: true });
		}
		return respond({ error: "unexpected" }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));

	expect(await flagStuckRuns()).toBe(1);
	const badge = (fields.error as { stringValue: string }).stringValue;
	expect(badge.startsWith(STUCK_BADGE)).toBe(true);
	expect(badge).toContain('Last message: "Matcherino - Sharky needs Reconnect"');

	// A person ticked Done: the occurrence moved on and the flag goes.
	fields = { ...fields, repeat: { mapValue: { entries: { freq: { stringValue: "day" }, next: { intValue: Date.now() + day }, fired_for: { intValue: next } } } } };
	expect(await flagStuckRuns()).toBe(0);
	expect(fields.error).toBeUndefined();

	// Fired but its next is not due yet: a run in progress, not stuck.
	fields = { ...fields, repeat: { mapValue: { entries: { freq: { stringValue: "day" }, next: { intValue: Date.now() - 60_000 }, fired_for: { intValue: Date.now() - 60_000 } } } } };
	expect(await flagStuckRuns()).toBe(0);
});

test("a run a login blocked retries itself once that login is fixed - once, saying why in the chat", async () => {
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const agentId = "856fcc37-9ad6-43e8-a1d8-5ee236699183";
	const credId = "c0ffee00-0000-4000-8000-000000000001";
	const ranAt = Date.now() - 3_600_000;
	const next = ranAt - 1000; // fired, the run said it couldn't, still open
	let fields: Record<string, unknown> = {
		name: { stringValue: "Remove Old Tournaments" },
		agent: { valuesValue: { items: [{ stringValue: agentId }] } },
		error: { stringValue: missingBadge(["matcherino"]) },
		repeat: { mapValue: { entries: { freq: { stringValue: "day" }, next: { intValue: next }, fired_for: { intValue: next }, last_run: { mapValue: { entries: { at: { intValue: ranAt } } } } } } },
	};
	const agentFields: Record<string, unknown> = { name: { stringValue: "Matcherino Space" }, credentials: { valuesValue: { items: [] } } };
	let cred = { status: "active", service: "matcherino", name: "Matcherino - Sharky", updatedAt: ranAt - 60_000 };
	const posted: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		const filter = Array.isArray(body.filters) ? body.filters[0] : undefined;
		if (url.pathname === "/api/query") return respond(filter?.key === "repeat" ? { records: [{ id: objectId, typeKey: "task", fields }], total: 1 } : { records: [], total: 0 });
		if (url.pathname === "/api/serving") return respond({ [objectId]: { machineId: "test-machine", reason: "pinned", skills: [], candidates: ["test-machine"] } });
		if (url.pathname === `/api/objects/${objectId}`) return respond({ id: objectId, typeKey: "task", fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0 });
		if (url.pathname === `/api/objects/${agentId}`) return respond({ id: agentId, typeKey: "agent", fields: agentFields, blocks: [], deleted: false, createdAt: 0, updatedAt: Date.now() });
		if (url.pathname === `/api/objects/${credId}`) return respond({ id: credId, typeKey: "credential", fields: { status: { stringValue: cred.status }, service: { stringValue: cred.service }, name: { stringValue: cred.name } }, blocks: [], deleted: false, createdAt: 0, updatedAt: cred.updatedAt });
		if (url.pathname === "/api/mutate") {
			if (body.action === "set_field") fields = { ...fields, [String(body.key)]: body.value };
			if (body.action === "delete_field") fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== body.key));
			const meta = (body.block as { content?: { custom?: { meta?: { text?: string } } } } | undefined)?.content?.custom?.meta;
			if (meta?.text) posted.push(meta.text);
			return respond({ ok: true, id: "message" });
		}
		return respond({ error: `unexpected ${url.pathname}` }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	await startScheduler({
		fresh: unusedFresh,
		async served(id) {
			return id === agentId ? { agentId, conv: { objectId: agentId, threadId: "thread" } } : undefined;
		},
		async turn() {
			return "";
		},
	});

	// The agent still lists no Matcherino login: nothing to retry.
	expect(await retryUnblockedRuns()).toBe(0);
	expect(fields.run_now).toBeUndefined();

	// Someone adds one: the run is asked for once, and the chat says why.
	agentFields.credentials = { valuesValue: { items: [{ linkValue: { targetId: credId } }] } };
	expect(await retryUnblockedRuns()).toBe(1);
	expect(fields.run_now).toBeDefined();
	expect(posted.some((t) => t.includes('because "Matcherino - Sharky" was added to Matcherino Space'))).toBe(true);

	// Blocked again on the same occurrence: no second automatic retry.
	fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "run_now"));
	expect(await retryUnblockedRuns()).toBe(0);
});

test("a blocked run's Error names the logins to reconnect or add, and reads back as them", async () => {
	const badge = credentialBadge(["Matcherino - Sharky"]);
	expect(parseIssuesBadge(badge)).toEqual({ signedOut: ["Matcherino - Sharky"], missing: [] });
	expect(parseIssuesBadge(missingBadge(["matcherino", "google-account"]))).toEqual({ signedOut: [], missing: ["matcherino", "google-account"] });
	expect(parseIssuesBadge("run failed: boom")).toBeNull();
	// A dead login is the one named first: reconnecting it is what a person does.
	expect(issuesBadge([{ kind: "missing", service: "x" }, { kind: "signed_out", name: "Y" }])).toBe(credentialBadge(["Y"]));
});

test("Stuck holds an open run: never flagged as unfinished, and clearing it asks for the run again", async () => {
	const objectId = "0b6c86a7-7063-4dcd-81d8-3c5707bbeb83";
	const day = 86_400_000;
	const next = Date.now() - 20 * day; // fired weeks ago, held open by Stuck
	let agentName = "";
	let fields: Record<string, unknown> = {
		name: { stringValue: "Lou Fasulo" },
		stuck: { stringValue: "Ping Lou about integrating the bracket into Matcherino" },
		repeat: { mapValue: { entries: { freq: { stringValue: "week" }, interval: { intValue: 2 }, next: { intValue: next }, fired_for: { intValue: next } } } },
	};
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return respond({ records: [{ id: objectId, typeKey: "person", fields }], total: 1 });
		if (url.pathname === "/api/serving") return respond({ [objectId]: { machineId: "test-machine", reason: "pinned", skills: [], candidates: ["test-machine"] } });
		if (url.pathname === `/api/objects/${objectId}`) return respond({ id: objectId, typeKey: "person", fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0 });
		if (url.pathname === "/api/objects/a9c326b4-89e8-4a37-82c0-3d72a0bc1207") return respond({ id: "a9c326b4-89e8-4a37-82c0-3d72a0bc1207", typeKey: "agent", fields: { name: { stringValue: agentName } }, blocks: [], deleted: false, createdAt: 0, updatedAt: 0 });
		if (url.pathname === "/api/mutate") {
			if (body.action === "set_field") fields = { ...fields, [String(body.key)]: body.value };
			if (body.action === "delete_field") fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== body.key));
			return respond({ ok: true });
		}
		return respond({ error: "unexpected" }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	await startScheduler({
		fresh: unusedFresh, async served() { return undefined; }, async turn() { return ""; } });

	expect(await flagStuckRuns()).toBe(0);
	expect(fields.error).toBeUndefined();

	const chat = (author: string, ts: number, text = "…") => ({ id: `c${ts}`, childrenIds: [], content: { custom: { contentType: "chat", meta: { author, ts: String(ts), text } } } });
	const obj = (blocks: unknown[]) => ({ id: objectId, typeKey: "person", fields: fields as Record<string, never>, blocks: blocks as never[], deleted: false, createdAt: 0, updatedAt: 0 });
	// The agent's own message after getting stuck is not an answer.
	await handleStuckChange(obj([chat("a9c326b4-89e8-4a37-82c0-3d72a0bc1207", 2000)]));
	expect(fields.stuck).toBeDefined();
	// Grant answers in the chat: Stuck clears.
	await handleStuckChange(obj([chat("a9c326b4-89e8-4a37-82c0-3d72a0bc1207", 2000), chat("816854963a03323d816854963a03323d816854963a03323d816854963a03323d", 3000)]));
	expect(fields.stuck).toBeUndefined();
	// ...and with Stuck gone the held run is asked for again.
	await handleStuckChange(obj([]));
	expect(fields.run_now).toBeDefined();
	// Stuck again, answered by a reply that @-asks the object's agent: that chat turn handles it - Stuck clears, no second run.
	fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "run_now"));
	fields.stuck = { stringValue: "Is the white label ready?" };
	fields.agent = { valuesValue: { items: [{ linkValue: { relationKey: "agent", targetId: "a9c326b4-89e8-4a37-82c0-3d72a0bc1207" } }] } };
	agentName = "Lou Agent";
	await handleStuckChange(obj([chat("a9c326b4-89e8-4a37-82c0-3d72a0bc1207", 4000)]));
	await handleStuckChange(obj([chat("816854963a03323d816854963a03323d816854963a03323d816854963a03323d", 5000, "@Lou Agent it shipped")]));
	expect(fields.stuck).toBeUndefined();
	await handleStuckChange(obj([]));
	expect(fields.run_now).toBeUndefined();
	delete fields.agent;
	// Without Stuck, the same open run is flagged as unfinished again.
	fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "run_now"));
	expect(await flagStuckRuns()).toBe(1);
});

test("a minute repeat whose run a restart cut off is finished at boot, so it keeps running", async () => {
	const objectId = "7891d9df-26c7-40b4-9756-947c8c567a55";
	const next = Date.now() - 20 * 3_600_000; // fired, then the harness restarted mid-run
	const fields = { name: { stringValue: "Check messages" }, repeat: { mapValue: { entries: { freq: { stringValue: "minute" }, interval: { intValue: 1 }, next: { intValue: next }, fired_for: { intValue: next } } } } };
	const actions: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return respond({ records: [{ id: objectId, typeKey: "page", fields }], total: 1 });
		if (url.pathname === "/api/serving") return respond({ [objectId]: { machineId: "test-machine", reason: "pinned", skills: [], candidates: ["test-machine"] } });
		if (url.pathname === `/api/objects/${objectId}`) return respond({ id: objectId, typeKey: "page", fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0 });
		if (url.pathname === "/api/mutate") {
			actions.push(String(body.action));
			return respond({ ok: true });
		}
		return respond({ error: "unexpected" }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	await startScheduler({
		fresh: unusedFresh, async served() { return undefined; }, async turn() { return ""; } });
	expect(actions).toContain("occurrence_complete");
});

test("a push run that fails while the store is down is retried until it gets through: the failure shows on the Error meanwhile, and the run that gets through clears it", async () => {
	const objectId = "5dadce02-0000-4000-8000-000000000001";
	let storeUp = false;
	let error = "";
	const errorWrites: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return respond({ records: [], total: 0 });
		if (url.pathname === `/api/objects/${objectId}`) {
			// The store is down for reads; writes reach it (a crash loop lets some requests through).
			if (!storeUp) throw new TypeError("Unable to connect. Is the computer able to access the url?");
			const fields: Record<string, unknown> = { name: { stringValue: "Check grant@ inbox" }, agent: { valuesValue: { items: [{ stringValue: "agent-served-elsewhere" }] } } };
			if (error) fields.error = { stringValue: error };
			return respond({ id: objectId, typeKey: "task", fields, blocks: [], deleted: false, createdAt: 1, updatedAt: 1 });
		}
		if (url.pathname === "/api/mutate") {
			if (body.object_id === objectId && body.key === "error") {
				if (body.action === "set_field") {
					error = String((body.value as { stringValue?: string }).stringValue ?? "");
					errorWrites.push(error);
				}
				if (body.action === "delete_field") error = "";
			}
			return respond({ ok: true });
		}
		return respond({ error: `unexpected ${url.pathname}` }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	// The retry waits a minute or more: run those waits at once.
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) >= 60_000 ? 5 : ms)) as typeof setTimeout;
	try {
		await startScheduler({
		fresh: unusedFresh, async served() { return undefined; }, async turn() { return ""; } });
		runNow(objectId, "new mail in grant@");
		for (let i = 0; i < 100 && errorWrites.length === 0; i++) await Bun.sleep(5);
		expect(errorWrites[0]).toStartWith("run failed: Unable to connect");
		expect(error).toStartWith("run failed:");
		storeUp = true;
		for (let i = 0; i < 200 && error !== ""; i++) await Bun.sleep(5);
		expect(error).toBe("");
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
});

test("an agent with Fresh each run gets a new transcript for every run: the run's message goes there, and a run of an agent without it stays on its transcript", async () => {
	const objectId = "5dadce02-0000-4000-8000-000000000002";
	const agentId = "c7581436-0000-4000-8000-000000000003";
	const oldConv = { objectId: agentId, threadId: "__thread__old" };
	const newConv = { objectId: agentId, threadId: "__thread__new" };
	let freshRuns = true;
	const posts: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return respond({ records: [], total: 0 });
		if (url.pathname === `/api/objects/${objectId}`) {
			return respond({ id: objectId, typeKey: "task", fields: { name: { stringValue: "Check grant@ inbox" }, agent: { valuesValue: { items: [{ stringValue: agentId }] } } }, blocks: [], deleted: false, createdAt: 1, updatedAt: 1 });
		}
		if (url.pathname === `/api/objects/${agentId}`) {
			return respond({ id: agentId, typeKey: "agent", fields: freshRuns ? { fresh_runs: { boolValue: true } } : {}, blocks: [], deleted: false, createdAt: 1, updatedAt: 1 });
		}
		if (url.pathname === "/api/mutate") {
			if (body.action === "block_add") posts.push(String(body.target_id));
			return respond({ ok: true, id: "message" });
		}
		return respond({ error: `unexpected ${url.pathname}` }, 404);
	}) as typeof fetch;
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "test-machine" }));
	const freshCalls: string[] = [];
	await startScheduler({
		async served(id) {
			return id === agentId ? { agentId, conv: oldConv } : undefined;
		},
		async turn() {
			return "";
		},
		async fresh(id) {
			freshCalls.push(id);
			return newConv;
		},
	});
	let done = waitForTurnEnd();
	runNow(objectId, "new mail in grant@");
	await done;
	expect(freshCalls).toEqual([agentId]);
	expect(posts).toEqual([newConv.threadId]);

	freshRuns = false;
	done = waitForTurnEnd();
	runNow(objectId, "new mail in grant@");
	await done;
	expect(freshCalls).toEqual([agentId]);
	expect(posts).toEqual([newConv.threadId, oldConv.threadId]);
});
