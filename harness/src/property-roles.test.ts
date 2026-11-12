/**
 * Property roles: boot seeds the built-in places onto relations that have no
 * `role` (never over one a person picked; a second boot writes nothing), and
 * object_get (its shipped code) groups an object's fields by role.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { roleOf, seedPropertyRoles } from "./property-roles";
import objectGet from "./tool-code/object_get";
import { createRoostr, harnessCalls } from "./tool-sdk";

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-roles-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const sv = (s: string): ValueJSON => ({ stringValue: s });

const object = (id: string, typeKey: string, fields: Record<string, ValueJSON>): ObjectJSON => ({ id, typeKey, fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0, mailbox: [] });

const relation = (key: string, fields: Record<string, ValueJSON> = {}): ObjectJSON => object(`rel-${key}`, "relation", { key: sv(key), name: sv(key), channel: sv("space"), ...fields });

interface Mutation {
	action: string;
	object_id?: string;
	key?: string;
	value?: ValueJSON;
}

/** A daemon over `initial`: answers queries by type and object reads, applies set_field, records every mutation. */
function daemon(initial: ObjectJSON[]) {
	const objects = new Map(initial.map((o) => [o.id, o]));
	const writes: Mutation[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const o = objects.get(decodeURIComponent(url.pathname.slice("/api/objects/".length)));
			return o ? Response.json(o) : Response.json({ error: "not found" }, { status: 404 });
		}
		if (url.pathname === "/api/channels") return Response.json([{ id: "space", name: "space", owner: "" }]);
		if (url.pathname === "/api/query") {
			const body = JSON.parse(String(init?.body ?? "{}")) as { type?: string; offset?: number; limit?: number };
			const all = [...objects.values()]
				.filter((o) => !o.deleted && (!body.type || o.typeKey === body.type))
				.map((o) => ({ id: o.id, typeKey: o.typeKey, fields: structuredClone(o.fields), createdAt: o.createdAt, updatedAt: o.updatedAt }));
			const offset = body.offset ?? 0;
			return Response.json({ records: all.slice(offset, offset + (body.limit ?? all.length)), total: all.length });
		}
		if (url.pathname === "/api/mutate") {
			const m = JSON.parse(String(init?.body ?? "{}")) as Mutation;
			writes.push(m);
			const o = m.object_id ? objects.get(m.object_id) : undefined;
			if (m.action === "set_field" && o && m.key && m.value) o.fields[m.key] = m.value;
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	return { objects, writes };
}

test("seed: built-in properties get their role where none is set; a person's role stays; the next boot writes nothing", async () => {
	const agent = relation("agent");
	const due = relation("due_date");
	const status = relation("status");
	const model = relation("model");
	const picked = relation("done", { role: sv("details") });
	const custom = relation("customer");
	const vault = daemon([object("space", "channel", {}), agent, due, status, model, picked, custom]);

	expect(await seedPropertyRoles()).toBe(4);
	expect(agent.fields.role).toEqual(sv("who"));
	expect(due.fields.role).toEqual(sv("when"));
	expect(status.fields.role).toEqual(sv("state"));
	expect(model.fields.role).toEqual(sv("setup"));
	expect(picked.fields.role).toEqual(sv("details"));
	expect(custom.fields.role).toBeUndefined();
	expect(vault.writes.every((w) => w.action === "set_field" && w.key === "role")).toBe(true);
	expect(vault.writes.some((w) => w.object_id === picked.id || w.object_id === custom.id)).toBe(false);

	vault.writes.length = 0;
	expect(await seedPropertyRoles()).toBe(0);
	expect(vault.writes).toEqual([]);
});

test("roleOf: a set role wins, else the key's built-in place, else Details", () => {
	expect(roleOf({ key: sv("agent") })).toBe("who");
	expect(roleOf({ key: sv("agent"), role: sv("details") })).toBe("details");
	expect(roleOf({ key: sv("customer") })).toBe("details");
	expect(roleOf({ key: sv("customer"), role: sv("nonsense") })).toBe("details");
	expect(roleOf({ key: sv("customer"), role: sv("who") })).toBe("who");
});

test("object_get groups the object's properties by role, as the Properties pane shows them", async () => {
	daemon([
		object("space", "channel", {}),
		relation("agent"),
		relation("status"),
		relation("due_date", { format: sv("date") }),
		relation("customer"),
		relation("budget", { role: sv("who") }),
		relation("error"),
		object("task", "task", {
			channel: sv("space"),
			agent: { valuesValue: { items: [sv("agent-1")] } },
			status: sv("doing"),
			due_date: { intValue: Date.UTC(2026, 10, 20) },
			customer: sv("Acme"),
			budget: sv("10k"),
			error: sv("model gone"),
		}),
	]);
	const roostr = createRoostr(
		{ agentId: "agent-1", objectId: "task", channelId: "space", machineId: "m" },
		new Set(),
		harnessCalls(async (method) => {
			throw new Error(`unexpected harness call ${method}`);
		}),
	);
	const got = JSON.parse(await objectGet({ id: "task" }, roostr)) as { sections: Record<string, string[]>; fields: Record<string, unknown> };
	expect(got.sections).toEqual({ Who: ["agent", "budget"], When: ["due_date"], State: ["status"], Details: ["customer"] });
	expect(got.fields.error).toBe("model gone");
});
