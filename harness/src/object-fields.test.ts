/**
 * An agent's object writes must land where a human can see them: a write
 * the app cannot display is refused (never "ok"), and a schedule goes
 * through the real repeat rule. An agent once "made a task recurring" by
 * writing recurrence="every 2 weeks" - stored, invisible, inert. The tools
 * run their shipped code (tool-code/) in-process against a fake daemon.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import objectAddProperty from "./tool-code/object_add_property";
import objectClearField from "./tool-code/object_clear_field";
import objectClearRepeat from "./tool-code/object_clear_repeat";
import objectSetField from "./tool-code/object_set_field";
import objectSetRepeat from "./tool-code/object_set_repeat";
import objectSetType from "./tool-code/object_set_type";
import { createRoostr, type Roostr } from "./tool-sdk";

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

/** The `rule` object_set_repeat sends with repeat_set. */
interface RepeatRule {
	freq: string;
	interval: number;
	weekdays: number[];
	times?: number[];
	window?: number[];
}

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
				const rule = body.rule as RepeatRule;
				const ints = (xs: number[]): ValueJSON => ({ valuesValue: { items: xs.map((n) => ({ intValue: n })) } });
				task.fields.repeat = {
					mapValue: {
						entries: {
							freq: { stringValue: rule.freq },
							interval: { intValue: rule.interval },
							weekdays: ints(rule.weekdays),
							...(rule.times ? { times: ints(rule.times) } : {}),
							...(rule.window ? { window: ints(rule.window) } : {}),
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

const SHIPPED: Record<string, (input: Record<string, unknown>, roostr: Roostr) => Promise<string>> = {
	object_add_property: objectAddProperty,
	object_clear_field: objectClearField,
	object_clear_repeat: objectClearRepeat,
	object_set_field: objectSetField,
	object_set_repeat: objectSetRepeat,
	object_set_type: objectSetType,
};

/** One call of a shipped tool in a turn on "task", its refusal read as the agent reads it. */
async function call(name: string, input: Record<string, unknown>): Promise<string> {
	try {
		return await SHIPPED[name](input, createRoostr({ agentId: "agent", objectId: "task", channelId: "space", machineId: "m" }, new Set()));
	} catch (err) {
		return `error: ${err instanceof Error ? err.message : String(err)}`;
	}
}

test("a schedule written as a field is refused and points at the repeat tool", async () => {
	const mutations = daemon(task());
	const result = await call("object_set_field", { id: "task", key: "recurrence", value: "every 2 weeks" });
	expect(result).toStartWith("error: nothing written");
	expect(result).toContain("object_set_repeat");
	expect(mutations).toEqual([]);
});

test("a key with no property in the space is refused, naming the ones that exist", async () => {
	const mutations = daemon(task());
	const result = await call("object_set_field", { id: "task", key: "priority", value: "high" });
	expect(result).toStartWith("error: nothing written");
	expect(result).toContain('no "priority" property');
	expect(result).toContain("dueDate (Due date, date)");
	expect(result).not.toContain("createdDate");
	expect(mutations).toEqual([]);
});

test("a value the property's type cannot hold is refused instead of stored as text", async () => {
	const mutations = daemon(task());
	expect((await call("object_set_field", { id: "task", key: "done", value: "yes" }))).toStartWith("error: nothing written");
	expect((await call("object_set_field", { id: "task", key: "dueDate", value: "next week-ish" }))).toStartWith("error: nothing written");
	expect((await call("object_set_field", { id: "task", key: "createdDate", value: "2026-01-01" }))).toStartWith("error: nothing written");
	expect(mutations).toEqual([]);
});

test("a valid write reports the value as the human now sees it", async () => {
	const t = task();
	daemon(t);
	const result = await call("object_set_field", { id: "task", key: "done", value: "true" });
	expect(result).toBe("Done is now: checked");
	expect(t.fields.done).toEqual({ boolValue: true });
});

test("object_set_repeat writes the real rule and reads it back in the Repeat cell's words", async () => {
	const t = task({ agent: { valuesValue: { items: [{ stringValue: "agent" }] } } });
	const mutations = daemon(t);
	const result = await call("object_set_repeat", { every: 2, unit: "week", weekdays: ["wed"], times: ["09:30", "14:00"] });
	expect(result).toStartWith("Repeats every 2 weeks on Wed at 9:30");
	expect(result).toContain("2:00");
	const set = mutations.find((m) => m.action === "repeat_set");
	expect(set?.object_id).toBe("task");
	expect(set?.rule).toMatchObject({ freq: "week", interval: 2, weekdays: [3], times: [570, 840] });
});

test("object_set_repeat runs every few minutes inside a daily window, on chosen days", async () => {
	const t = task({ agent: { valuesValue: { items: [{ stringValue: "agent" }] } } });
	const mutations = daemon(t);
	const result = await call("object_set_repeat", { every: 5, unit: "minute", from: "09:00", until: "17:00", weekdays: ["mon", "tue"] });
	expect(result).toStartWith("Repeats every 5 minutes on Mon, Tue from 9:00");
	expect(mutations.find((m) => m.action === "repeat_set")?.rule).toMatchObject({ freq: "minute", interval: 5, weekdays: [1, 2], window: [540, 1020] });
});

test("object_set_repeat says when nobody is on the guest list to run it", async () => {
	daemon(task());
	const result = await call("object_set_repeat", { unit: "day" });
	expect(result).toContain("No agent is on its guest list");
});

test("object_set_repeat rejects a malformed rule without writing", async () => {
	const mutations = daemon(task());
	for (const input of [
		{ unit: "fortnight" },
		{ unit: "week", weekdays: ["someday"] },
		{ unit: "day", times: ["25:00"] },
		{ unit: "day", times: [] },
		{ unit: "day", every: 0 },
		{ unit: "hour", every: 24 },
		{ unit: "minute", from: "17:00", until: "09:00" },
		{ unit: "minute", times: ["09:00"] },
		{ unit: "day", from: "09:00" },
	]) {
		expect((await call("object_set_repeat", input))).toStartWith("error: nothing written");
	}
	expect(mutations).toEqual([]);
});

test("object_clear_repeat turns repeating off, and refuses on an object that does not repeat", async () => {
	const t = task();
	const mutations = daemon(t);
	expect((await call("object_clear_repeat", {}))).toStartWith("error: nothing written");
	expect(mutations).toEqual([]);
	await call("object_set_repeat", { unit: "month" });
	expect((await call("object_clear_repeat", {}))).toBe("This object no longer repeats.");
	expect(t.fields.repeat).toBeUndefined();
});

test("object_add_property creates a visible property keyed like the app's, once", async () => {
	const mutations = daemon(task());
	const reply = (await call("object_add_property", { name: "Mockup Status", format: "status" }));
	expect(reply).toContain("key mockup_status");
	const create = mutations.find((m) => m.action === "create");
	expect(create).toMatchObject({ type_key: "relation", fields: { key: { stringValue: "mockup_status" }, format: { stringValue: "status" }, channel: { stringValue: "space" }, hidden: { boolValue: false }, maxCount: { intValue: 1 } } });
	// An existing key creates nothing.
	const again = daemon(task());
	expect((await call("object_add_property", { name: "Due date", format: "text" }))).toStartWith("error: nothing created");
	for (const name of ["Due date", "due_date", "dueDate", "DUE DATE"]) {
		expect((await call("object_add_property", { name, format: "date" }))).toContain("already has Due date (key dueDate");
	}
	expect((await call("object_add_property", { name: "Recurrence", format: "shorttext" }))).toContain("object_set_repeat");
	expect(again).toEqual([]);
});

test("object_clear_field empties a property and refuses the ones with their own rules", async () => {
	const t = task({ dueDate: { intValue: 1 } });
	const mutations = daemon(t);
	for (const key of ["agent", "repeat", "createdDate", "priority"]) {
		expect((await call("object_clear_field", { key }))).toStartWith("error: nothing cleared");
	}
	expect(mutations).toEqual([]);
	expect((await call("object_clear_field", { key: "dueDate" }))).toBe("Due date is now empty.");
	expect(t.fields.dueDate).toBeUndefined();
});

test("object_set_type retypes to a space type and never into or out of infrastructure", async () => {
	const t = task();
	const mutations = daemon(t);
	expect((await call("object_set_type", { type: "agent" }))).toStartWith("error: nothing changed");
	expect((await call("object_set_type", { type: "spaceship" }))).toContain("types here: task (Task), note (Note), person (Person)");
	expect(mutations).toEqual([]);
	expect((await call("object_set_type", { type: "person" }))).toBe("It is now a Person.");
	expect(t.typeKey).toBe("person");
	const agentObj = task();
	agentObj.typeKey = "agent";
	daemon(agentObj);
	expect((await call("object_set_type", { type: "task" }))).toStartWith("error: nothing changed");
});
