/**
 * The tab tools against a fake daemon: the person's open tabs live in
 * `__user_prefs__`.open_tabs (space -> paths), and the tools keep the app's
 * rules - #1 is the browsing tab, one tab per page, new tabs last, a
 * home-only strip has no entry - touching only the space they edit.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { editStrip, openTabsFrom, openTabsValue, tabPath, tabTarget, USER_PREFS_ID, type OpenTabs } from "./tabs";
import tabsEdit from "./tool-code/tabs_edit";
import tabsList from "./tool-code/tabs_list";
import { createRoostr, harnessCalls, type Roostr } from "./tool-sdk";

const noHarness = harnessCalls(async (method) => {
	throw new Error(`unexpected harness call ${method}`);
});

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-tabs-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const object = (id: string, typeKey: string, name: string, channel = "space"): ObjectJSON => ({
	id,
	typeKey,
	fields: { name: { stringValue: name }, channel: { stringValue: channel } },
	blocks: [],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
	mailbox: [],
});

const OBJECTS = [object("t1", "task", "Pay rent"), object("t2", "task", "Call mom"), object("n1", "note", "Ideas"), object("far", "task", "Elsewhere", "other")];
const TYPES = [object("type-task", "type", "Task"), object("type-note", "type", "Note")];
TYPES[0].fields.key = { stringValue: "task" };
TYPES[1].fields.key = { stringValue: "note" };

/** A daemon holding `tabs` in the preferences (none: no preferences object yet); returns the writes. */
function daemon(tabs: OpenTabs | null) {
	let prefs: ObjectJSON | null = tabs ? { ...object(USER_PREFS_ID, "user_prefs", "Preferences", ""), fields: { open_tabs: openTabsValue(tabs) } } : null;
	const writes: ValueJSON[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === `/api/objects/${USER_PREFS_ID}`) return prefs ? Response.json(prefs) : Response.json({ error: "not found" }, { status: 404 });
		const found = OBJECTS.find((o) => url.pathname === `/api/objects/${o.id}`);
		if (found) return Response.json(found);
		if (url.pathname.startsWith("/api/objects/")) return Response.json({ error: "not found" }, { status: 404 });
		if (url.pathname === "/api/channels") return Response.json([{ id: "space" }, { id: "other" }]);
		if (url.pathname === "/api/query") {
			const body = JSON.parse(String(init?.body));
			const records = body.type === "type" ? TYPES : [];
			return Response.json({ records, total: records.length });
		}
		if (url.pathname === "/api/mutate") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.action === "create" && body.id === USER_PREFS_ID) {
				const existed = prefs !== null;
				prefs ??= { ...object(USER_PREFS_ID, "user_prefs", "Preferences", ""), fields: {} };
				return Response.json({ ok: true, id: USER_PREFS_ID, existed });
			}
			if (body.action === "set_field" && body.object_id === USER_PREFS_ID && prefs) {
				prefs.fields[String(body.key)] = body.value as ValueJSON;
				writes.push(body.value as ValueJSON);
				return Response.json({ ok: true });
			}
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return writes;
}

async function call(tool: (input: Record<string, unknown>, roostr: Roostr) => Promise<string>, input: Record<string, unknown>): Promise<string> {
	return tool(input, createRoostr({ agentId: "agent", objectId: "t1", channelId: "space", machineId: "m" }, new Set(), noHarness));
}

test("paths and ids: a bare id is its object's page; each path names what it shows", () => {
	expect(tabPath("t1")).toBe("/app/object/t1");
	expect(tabPath("/app/chat/t1")).toBe("/app/chat/t1");
	expect(tabTarget("/app")).toEqual({ kind: "home" });
	expect(tabTarget("/app/object/t1")).toEqual({ kind: "object", id: "t1" });
	expect(tabTarget("/app/chat/n1")).toEqual({ kind: "chat", id: "n1" });
	expect(tabTarget("/app/graph")).toEqual({ kind: "graph", focus: "" });
	expect(tabTarget("/app/graph?focus=t2")).toEqual({ kind: "graph", focus: "t2" });
	expect(tabTarget("/guide")).toBeNull();
});

test("open appends at the end and skips pages already open, the browsing tab included", () => {
	expect(editStrip(["/app/object/t1", "/app/object/t2"], { open: ["t1", "n1", "t2", "/app/chat/t1"] })).toEqual(["/app/object/t1", "/app/object/t2", "/app/object/n1", "/app/chat/t1"]);
	// No strip yet: the browsing tab starts at the space home.
	expect(editStrip([], { open: ["t1"] })).toEqual(["/app", "/app/object/t1"]);
});

test("closing the browsing tab shows the space home there; closing an id closes its pages", () => {
	expect(editStrip(["/app/object/t1", "/app/object/t2", "/app/chat/t2"], { close: ["t1", "t2"] })).toEqual(["/app"]);
	expect(editStrip(["/app/object/t1", "/app/object/t2", "/app/chat/t2"], { close: ["/app/chat/t2"] })).toEqual(["/app/object/t1", "/app/object/t2"]);
});

test("a move lands at its 1-based place, never before #2; the browsing tab never moves", () => {
	const strip = ["/app", "/app/object/t1", "/app/object/t2", "/app/object/n1"];
	expect(editStrip(strip, { move: { id: "n1", to: 1 } })).toEqual(["/app", "/app/object/n1", "/app/object/t1", "/app/object/t2"]);
	expect(editStrip(strip, { move: { id: "t1", to: 9 } })).toEqual(["/app", "/app/object/t2", "/app/object/n1", "/app/object/t1"]);
	expect(() => editStrip(["/app/object/t1", "/app/object/t2"], { move: { id: "t1", to: 2 } })).toThrow("browsing tab");
});

test("stored strips with nothing open drop out", () => {
	expect(openTabsFrom(openTabsValue({ a: ["/app"], b: [], c: ["/app", "/app/graph"] }))).toEqual({ c: ["/app", "/app/graph"] });
});

test("tabs_list numbers the tabs, names what each shows and marks the browsing tab", async () => {
	daemon({ space: ["/app/object/t1", "/app/chat/n1", "/app/graph", "/app"] });
	const out = await call(tabsList, {});
	expect(out).toContain('1. "Pay rent" (Task, id t1) - browsing tab');
	expect(out).toContain('2. chat of "Ideas" (Note, id n1)');
	expect(out).toContain("3. graph");
	expect(out).toContain("4. space home");
});

test("tabs_edit writes only its space's strip and answers with the new list", async () => {
	const writes = daemon({ space: ["/app/object/t1"], other: ["/app", "/app/object/far"] });
	const out = await call(tabsEdit, { open: ["t2", "t1"] });
	expect(out).toContain('2. "Call mom" (Task, id t2)');
	expect(openTabsFrom(writes.at(-1))).toEqual({ space: ["/app/object/t1", "/app/object/t2"], other: ["/app", "/app/object/far"] });
});

test("a strip back to only the space home has no entry", async () => {
	const writes = daemon({ space: ["/app/object/t1"], other: ["/app", "/app/object/far"] });
	expect(await call(tabsEdit, { close: ["t1"] })).toContain("1. space home - browsing tab");
	expect(writes.at(-1)?.mapValue?.entries).toEqual({ other: { valuesValue: { items: [{ stringValue: "/app" }, { stringValue: "/app/object/far" }] } } });
});

test("without preferences yet, the first edit makes them", async () => {
	const writes = daemon(null);
	await call(tabsEdit, { open: ["n1"] });
	expect(openTabsFrom(writes.at(-1))).toEqual({ space: ["/app", "/app/object/n1"] });
});

test("an object of another space, or none, is refused before anything is written", async () => {
	const writes = daemon({ space: ["/app/object/t1"] });
	expect(await call(tabsEdit, { open: ["far"] })).toStartWith("error: nothing written. object far is in another space");
	expect(await call(tabsEdit, { open: ["ghost"] })).toStartWith("error: nothing written. no object ghost");
	expect(await call(tabsEdit, { space: "nowhere", open: ["t1"] })).toStartWith("error: nothing written. no space nowhere");
	expect(writes).toEqual([]);
});
