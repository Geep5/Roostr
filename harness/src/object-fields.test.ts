/**
 * An agent's object writes must land where a human can see them: a write
 * the app cannot display is refused (never "ok"), and a schedule goes
 * through the real repeat rule. An agent once "made a task recurring" by
 * writing recurrence="every 2 weeks" - stored, invisible, inert.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { dispatchTool } from "./tools";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-fields-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const relation = (key: string, name: string, format: string, extra: Record<string, ValueJSON> = {}): ObjectJSON => ({
	id: `rel-${key}`,
	typeKey: "relation",
	fields: { key: { stringValue: key }, name: { stringValue: name }, format: { stringValue: format }, channel: { stringValue: "space" }, ...extra },
	blocks: [],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
	mailbox: [],
});

const RELATIONS = [relation("done", "Done", "checkbox"), relation("dueDate", "Due date", "date"), relation("createdDate", "Created date", "date", { readOnly: { boolValue: true } })];

const typeRow = (key: string, name: string): ObjectJSON => ({
	id: `type-${key}`,
	typeKey: "type",
	fields: { key: { stringValue: key }, name: { stringValue: name }, channel: { stringValue: "space" } },
	blocks: [],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
	mailbox: [],
});
const TYPES = [typeRow("task", "Task"), typeRow("note", "Note"), typeRow("person", "Person"), typeRow("agent", "Agent")];

/** A daemon with one task and the space's properties; mutations apply to the task. */
function daemon(task: ObjectJSON) {
	const mutations: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname === `/api/objects/${task.id}`) return Response.json(task);
		if (url.pathname === "/api/channels") return Response.json([{ id: "space" }]);
		if (url.pathname === "/api/query") {
			const body = JSON.parse(String(init?.body));
			const records = body.type === "relation" ? RELATIONS : body.type === "type" ? TYPES : [];
			return Response.json({ records, total: records.length });
		}
		if (url.pathname === "/api/mutate") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			mutations.push(body);
			if (body.action === "set_field") task.fields[String(body.key)] = body.value as ValueJSON;
			if (body.action === "repeat_set") {
				const rule = body.rule as { freq: string; interval: number; weekdays: number[]; time: number };
				task.fields.repeat = {
					mapValue: {
						entries: {
							freq: { stringValue: rule.freq },
							interval: { intValue: rule.interval },
							weekdays: { valuesValue: { items: rule.weekdays.map((d) => ({ intValue: d })) } },
							time: { intValue: rule.time },
						},
					},
				};
			}
			if (body.action === "repeat_clear") delete task.fields.repeat;
			if (body.action === "delete_field") delete task.fields[String(body.key)];
			if (body.action === "set_type") task.typeKey = String(body.type_key);
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return mutations;
}

const task = (fields: Record<string, ValueJSON> = {}): ObjectJSON => ({
	id: "task",
	typeKey: "task",
	fields: { channel: { stringValue: "space" }, ...fields },
	blocks: [],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
	mailbox: [],
});

const ctx = () => ({ agentId: "agent", channelId: "space", boundObject: "task", depth: 0, allowAsk: false, touched: new Set<string>() });

test("a schedule written as a field is refused and points at the repeat tool", async () => {
	const mutations = daemon(task());
	const result = await dispatchTool("object_set_field", { id: "task", key: "recurrence", value: "every 2 weeks" }, ctx());
	expect(result.content).toStartWith("error: nothing written");
	expect(result.content).toContain("object_set_repeat");
	expect(mutations).toEqual([]);
});

test("a key with no property in the space is refused, naming the ones that exist", async () => {
	const mutations = daemon(task());
	const result = await dispatchTool("object_set_field", { id: "task", key: "priority", value: "high" }, ctx());
	expect(result.content).toStartWith("error: nothing written");
	expect(result.content).toContain('no "priority" property');
	expect(result.content).toContain("dueDate (Due date, date)");
	expect(result.content).not.toContain("createdDate");
	expect(mutations).toEqual([]);
});

test("a value the property's type cannot hold is refused instead of stored as text", async () => {
	const mutations = daemon(task());
	expect((await dispatchTool("object_set_field", { id: "task", key: "done", value: "yes" }, ctx())).content).toStartWith("error: nothing written");
	expect((await dispatchTool("object_set_field", { id: "task", key: "dueDate", value: "next week-ish" }, ctx())).content).toStartWith("error: nothing written");
	expect((await dispatchTool("object_set_field", { id: "task", key: "createdDate", value: "2026-01-01" }, ctx())).content).toStartWith("error: nothing written");
	expect(mutations).toEqual([]);
});

test("a valid write reports the value as the human now sees it", async () => {
	const t = task();
	daemon(t);
	const result = await dispatchTool("object_set_field", { id: "task", key: "done", value: "true" }, ctx());
	expect(result.content).toBe("Done is now: checked");
	expect(t.fields.done).toEqual({ boolValue: true });
});

test("object_set_repeat writes the real rule and reads it back in the Repeat cell's words", async () => {
	const t = task({ agent: { valuesValue: { items: [{ stringValue: "agent" }] } } });
	const mutations = daemon(t);
	const result = await dispatchTool("object_set_repeat", { every: 2, unit: "week", weekdays: ["wed"], time: "09:30" }, ctx());
	expect(result.content).toStartWith("Repeats every 2 weeks on Wed at 9:30");
	const set = mutations.find((m) => m.action === "repeat_set");
	expect(set?.object_id).toBe("task");
	expect(set?.rule).toMatchObject({ freq: "week", interval: 2, weekdays: [3], time: 570 });
});

test("object_set_repeat says when nobody is on the guest list to run it", async () => {
	daemon(task());
	const result = await dispatchTool("object_set_repeat", { unit: "day" }, ctx());
	expect(result.content).toContain("No agent is on its guest list");
});

test("object_set_repeat rejects a malformed rule without writing", async () => {
	const mutations = daemon(task());
	for (const input of [{ unit: "fortnight" }, { unit: "week", weekdays: ["someday"] }, { unit: "day", time: "25:00" }, { unit: "day", every: 0 }]) {
		expect((await dispatchTool("object_set_repeat", input, ctx())).content).toStartWith("error: nothing written");
	}
	expect(mutations).toEqual([]);
});

test("object_clear_repeat turns repeating off, and refuses on an object that does not repeat", async () => {
	const t = task();
	const mutations = daemon(t);
	expect((await dispatchTool("object_clear_repeat", {}, ctx())).content).toStartWith("error: nothing written");
	expect(mutations).toEqual([]);
	await dispatchTool("object_set_repeat", { unit: "month" }, ctx());
	expect((await dispatchTool("object_clear_repeat", {}, ctx())).content).toBe("This object no longer repeats.");
	expect(t.fields.repeat).toBeUndefined();
});

test("object_add_property creates a visible property keyed like the app's, once", async () => {
	const mutations = daemon(task());
	const reply = (await dispatchTool("object_add_property", { name: "Mockup Status", format: "status" }, ctx())).content;
	expect(reply).toContain("key mockup_status");
	const create = mutations.find((m) => m.action === "create");
	expect(create).toMatchObject({ type_key: "relation", fields: { key: { stringValue: "mockup_status" }, format: { stringValue: "status" }, channel: { stringValue: "space" }, hidden: { boolValue: false }, maxCount: { intValue: 1 } } });
	// An existing key creates nothing.
	const again = daemon(task());
	expect((await dispatchTool("object_add_property", { name: "Due date", format: "text" }, ctx())).content).toStartWith("error: nothing created");
	for (const name of ["Due date", "due_date", "dueDate", "DUE DATE"]) {
		expect((await dispatchTool("object_add_property", { name, format: "date" }, ctx())).content).toContain("already has Due date (key dueDate");
	}
	expect((await dispatchTool("object_add_property", { name: "Recurrence", format: "shorttext" }, ctx())).content).toContain("object_set_repeat");
	expect(again).toEqual([]);
});

test("object_clear_field empties a property and refuses the ones with their own rules", async () => {
	const t = task({ dueDate: { intValue: 1 } });
	const mutations = daemon(t);
	for (const key of ["agent", "repeat", "createdDate", "priority"]) {
		expect((await dispatchTool("object_clear_field", { key }, ctx())).content).toStartWith("error: nothing cleared");
	}
	expect(mutations).toEqual([]);
	expect((await dispatchTool("object_clear_field", { key: "dueDate" }, ctx())).content).toBe("Due date is now empty.");
	expect(t.fields.dueDate).toBeUndefined();
});

test("object_set_type retypes to a space type and never into or out of infrastructure", async () => {
	const t = task();
	const mutations = daemon(t);
	expect((await dispatchTool("object_set_type", { type: "agent" }, ctx())).content).toStartWith("error: nothing changed");
	expect((await dispatchTool("object_set_type", { type: "spaceship" }, ctx())).content).toContain("types here: task (Task), note (Note), person (Person)");
	expect(mutations).toEqual([]);
	expect((await dispatchTool("object_set_type", { type: "person" }, ctx())).content).toBe("It is now a Person.");
	expect(t.typeKey).toBe("person");
	const agentObj = task();
	agentObj.typeKey = "agent";
	daemon(agentObj);
	expect((await dispatchTool("object_set_type", { type: "task" }, ctx())).content).toStartWith("error: nothing changed");
});
