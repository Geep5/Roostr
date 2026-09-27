/**
 * The slow system-prompt cache: assemble once for a stable agent, reuse the
 * cached parts while nothing the fingerprint covers changes, rebuild when an
 * input changes - including memory, which lives on objects other than the
 * agent itself.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { resetSlowCache, slowStats, slowSystemParts } from "./runner";
import { DEFAULT_PROMPT } from "./prompts";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-slowcache-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
	resetSlowCache();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
	resetSlowCache();
});

function object(id: string, typeKey = "agent", fields: Record<string, ValueJSON> = {}, updatedAt = 1): ObjectJSON {
	return { id, typeKey, fields, blocks: [], deleted: false, createdAt: 0, updatedAt, mailbox: [] };
}

/** QueryRows for the memory query: pinned_fact/milestone carry updatedAt. */
function memoryRows(facts: number, factUpdated: number, milestones: number, milestoneUpdated: number) {
	const fact = (i: number) => ({ id: `f${i}`, typeKey: "pinned_fact", updatedAt: factUpdated, fields: { agent: { stringValue: "ag" }, key: { stringValue: `k${i}` }, value: { stringValue: "v" } } });
	const ms = (i: number) => ({ id: `m${i}`, typeKey: "milestone", updatedAt: milestoneUpdated, fields: { agent: { stringValue: "ag" }, status: { stringValue: "open" }, text: { stringValue: "t" } } });
	return { facts: Array.from({ length: facts }, (_, i) => fact(i)), milestones: Array.from({ length: milestones }, (_, i) => ms(i)) };
}

function server(agentObj: ObjectJSON, mem: ReturnType<typeof memoryRows>) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const id = url.pathname.slice("/api/objects/".length);
			return id === agentObj.id ? Response.json(agentObj) : Response.json({}, { status: 404 });
		}
		if (url.pathname === "/api/query") {
			const raw = init?.body ?? (input instanceof Request ? input.body : null);
			const body = raw ? JSON.parse(String(raw)) : {};
			const rows = body?.type === "pinned_fact" ? mem.facts : body?.type === "milestone" ? mem.milestones : [];
			return Response.json({ records: rows, total: rows.length });
		}
		return Response.json({ records: [], total: 0 });
	}) as typeof fetch;
}

const AGENT_FIELDS: Record<string, ValueJSON> = {
	channel: { stringValue: "space" },
	memory_digest_enabled: { boolValue: true },
};

test("unchanged inputs hit the cache; a memory change rebuilds", async () => {
	const agent = object("ag", "agent", AGENT_FIELDS, 7);
	server(agent, memoryRows(1, 3, 0, 0));

	await slowSystemParts(agent, DEFAULT_PROMPT, {}, "");
	expect(slowStats.builds).toBe(1);

	// Same agent, same memory: reuse - no rebuild.
	await slowSystemParts(agent, DEFAULT_PROMPT, {}, "");
	expect(slowStats.builds).toBe(1);

	// A new memory fact arrives: the prompt's memory digest must change, so rebuild.
	server(agent, memoryRows(2, 3, 0, 0));
	await slowSystemParts(agent, DEFAULT_PROMPT, {}, "");
	expect(slowStats.builds).toBe(2);
});

test("an agent field edit rebuilds even with unchanged memory", async () => {
	const agent = object("ag", "agent", AGENT_FIELDS, 7);
	server(agent, memoryRows(1, 3, 0, 0));
	await slowSystemParts(agent, DEFAULT_PROMPT, {}, "");
	expect(slowStats.builds).toBe(1);

	// The agent object was edited (system prompt, etc.): updatedAt bumps.
	const edited = object("ag", "agent", { ...AGENT_FIELDS, system: { stringValue: "new" } }, 8);
	server(edited, memoryRows(1, 3, 0, 0));
	await slowSystemParts(edited, DEFAULT_PROMPT, {}, "");
	expect(slowStats.builds).toBe(2);
});
