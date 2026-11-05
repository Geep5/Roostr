/**
 * Which Project folder a turn works in: an object's own (its `repo_path`)
 * for work on that object, else the agent's. Field case: the Video Maker
 * Agent's folder is its video repo, while the TOP 10 task's work lives in
 * the Rive project - the task names its folder, the agent keeps its own.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { resetSlowCache, slowSystemParts } from "./runner";
import { DEFAULT_PROMPT } from "./prompts";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";
let agentDir = "";
let taskDir = "";
let mutations: Array<Record<string, unknown>> = [];

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-folder-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
	agentDir = await mkdtemp(join(tmpdir(), "roostr-agent-folder-"));
	taskDir = await mkdtemp(join(tmpdir(), "roostr-task-folder-"));
	await writeFile(join(agentDir, "AGENTS.md"), "Rules of the video repo.");
	await writeFile(join(taskDir, "AGENTS.md"), "Rules of the Rive project.");
	mutations = [];
	resetSlowCache();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	for (const d of [root, agentDir, taskDir]) await rm(d, { recursive: true, force: true });
	resetSlowCache();
});

function object(id: string, typeKey: string, fields: Record<string, ValueJSON>): ObjectJSON {
	return { id, typeKey, fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 1, mailbox: [] };
}

function server(...objects: ObjectJSON[]) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((o) => o.id === url.pathname.slice("/api/objects/".length));
			return found ? Response.json(found) : Response.json({}, { status: 404 });
		}
		if (url.pathname === "/api/mutate") {
			mutations.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			return Response.json({ ok: true });
		}
		return Response.json({ records: [], total: 0 });
	}) as typeof fetch;
}

const workspace = async (agent: ObjectJSON, objectId: string) =>
	(await slowSystemParts(agent, DEFAULT_PROMPT, {}, objectId)).find((p) => p.label === "Workspace")?.text ?? "";

test("work on an object with its own Project folder happens there, with its AGENTS.md", async () => {
	const agent = object("ag", "agent", { channel: { stringValue: "space" }, repo_path: { stringValue: agentDir } });
	const task = object("task", "task", { channel: { stringValue: "space" }, repo_path: { stringValue: taskDir } });
	server(agent, task);
	const text = await workspace(agent, "task");
	expect(text).toContain(taskDir);
	expect(text).toContain("Rules of the Rive project.");
	expect(text).not.toContain("Rules of the video repo.");
});

test("an object without a folder, and the agent's own page, use the agent's folder", async () => {
	const agent = object("ag", "agent", { channel: { stringValue: "space" }, repo_path: { stringValue: agentDir } });
	const task = object("task", "task", { channel: { stringValue: "space" } });
	server(agent, task);
	expect(await workspace(agent, "task")).toContain("Rules of the video repo.");
	resetSlowCache();
	expect(await workspace(agent, "")).toContain("Rules of the video repo.");
});

test("an object's folder missing on this computer is on that object's Error, not the agent's", async () => {
	const agent = object("ag", "agent", { channel: { stringValue: "space" }, repo_path: { stringValue: agentDir } });
	const task = object("task", "task", { channel: { stringValue: "space" }, repo_path: { stringValue: join(taskDir, "nowhere") } });
	server(agent, task);
	expect(await workspace(agent, "task")).toBe("");
	const flagged = mutations.find((m) => m.action === "set_field" && m.key === "error");
	expect(flagged?.object_id).toBe("task");
	expect(JSON.stringify(flagged?.value)).toContain("this object's agents run on");
});
