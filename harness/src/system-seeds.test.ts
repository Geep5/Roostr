/**
 * Every property and type the harness seeds is marked `system: true` (the
 * app will not delete it); one seeded before the marker existed is marked
 * once, an engine built-in (`bundled`) never, and a second boot writes
 * nothing. Runs each seeder against a fake daemon.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { seedCatalog } from "./catalog-seeds";
import { registerExtension } from "./extensions";
import { seedCredentials } from "./credential-seeds";
import { ANSWER_KEY, seedJev } from "./jev";
import { KB_TYPE, seedKbType } from "./kb";
import { AUTOSTART_KEY, MACHINE_TYPE, seedComputerProperties } from "./machine";
import { BIN_KEY, seedViewActions } from "./view-actions";

const SPACE = "space-0001-aaaa";
const originalFetch = globalThis.fetch;
const originalLog = console.log;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-system-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
	console.log = () => {};
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	console.log = originalLog;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const sv = (s: string): ValueJSON => ({ stringValue: s });
const bv = (b: boolean): ValueJSON => ({ boolValue: b });

let clock = 0;
const object = (id: string, typeKey: string, fields: Record<string, ValueJSON>): ObjectJSON => ({ id, typeKey, fields, blocks: [], deleted: false, createdAt: ++clock, updatedAt: 0, mailbox: [] });

/** A daemon over `initial`; returns the vault and every mutation it received. */
function daemon(initial: ObjectJSON[]) {
	const objects = new Map(initial.map((o) => [o.id, o]));
	const writes: Array<Record<string, any>> = [];
	let n = 0;
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const o = objects.get(decodeURIComponent(url.pathname.slice("/api/objects/".length)));
			return o ? Response.json(o) : Response.json({ error: "not found" }, { status: 404 });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
		if (url.pathname === "/api/query") {
			const all = [...objects.values()].filter((o) => !o.deleted && (!body.type || o.typeKey === body.type)).map((o) => ({ id: o.id, typeKey: o.typeKey, fields: structuredClone(o.fields), createdAt: o.createdAt, updatedAt: o.updatedAt }));
			const offset = body.offset ?? 0;
			return Response.json({ records: all.slice(offset, offset + (body.limit ?? all.length)), total: all.length });
		}
		if (url.pathname === "/api/mutate") {
			writes.push(body);
			const o = objects.get(body.object_id);
			switch (body.action) {
				case "create": {
					const id = `new-${++n}`;
					objects.set(id, object(id, body.type_key, { ...body.fields, name: sv(body.name) }));
					return Response.json({ ok: true, id });
				}
				case "set_field":
					o!.fields[body.key] = body.value;
					break;
				case "delete_field":
					delete o!.fields[body.key];
					break;
				case "block_add":
					o!.blocks.push({ id: body.block.id ?? `blk-${++n}`, childrenIds: [], content: body.block.content });
					break;
				case "block_remove":
					o!.blocks = o!.blocks.filter((b) => b.id !== body.block_id);
					break;
				case "delete":
					o!.deleted = true;
					break;
				case "vanish":
					for (const id of body.object_ids) objects.delete(id);
					break;
				default:
					return Response.json({ ok: false, error: `unexpected ${body.action}` }, { status: 400 });
			}
			return Response.json({ ok: true });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
	const ofType = (type: string) => [...objects.values()].filter((o) => !o.deleted && o.typeKey === type);
	return { objects, writes, ofType };
}

/** A property seeded by an older harness: no `system` field. */
const legacy = (key: string): ObjectJSON => object(`legacy-${key}`, "relation", { key: sv(key), name: sv(key), channel: sv(SPACE), bundled: bv(false) });
/** An engine built-in: never marked. */
const builtin = (key: string): ObjectJSON => object(`builtin-${key}`, "relation", { key: sv(key), name: sv(key), channel: sv(SPACE), bundled: bv(true) });

/** The core ships no kind settings: a kind with two, as a private extension would register. */
async function seedCatalogWithKind(): Promise<void> {
	const unregister = registerExtension({
		kinds: [{ key: "probe", name: "Probe", promptName: "Probe", description: "", system: "You are a probe.", model: "test-model", skills: [], fields: [{ key: "probe_a", label: "Probe A", note: "" }, { key: "probe_b", label: "Probe B", note: "" }], defaults: {} }],
	});
	try {
		await seedCatalog();
	} finally {
		unregister();
	}
}

const seeders: Array<[name: string, run: () => Promise<unknown>, legacyKey: string]> = [
	["catalog", seedCatalogWithKind, "probe_a"],
	["credentials", seedCredentials, "account"],
	["jev", seedJev, ANSWER_KEY],
	["kb", () => seedKbType(SPACE), "kb_category"],
	["computer", seedComputerProperties, AUTOSTART_KEY],
	["view actions", seedViewActions, BIN_KEY],
];

for (const [name, run, legacyKey] of seeders) {
	test(`${name}: new seeds carry system, an older seed is marked once, the next boot writes nothing`, async () => {
		const old = legacy(legacyKey);
		const core = builtin("prompt");
		const vault = daemon([object(SPACE, "channel", {}), object("machine-1", MACHINE_TYPE, { channel: sv(SPACE) }), old, core]);
		await run();

		const created = vault.writes.filter((w) => w.action === "create" && (w.type_key === "relation" || w.type_key === "type"));
		expect(created.length).toBeGreaterThan(0);
		for (const w of created) expect(w.fields.system).toEqual(bv(true));
		expect(created.some((w) => w.fields.key?.stringValue === legacyKey)).toBe(false);
		expect(vault.writes.filter((w) => w.action === "set_field" && w.key === "system").map((w) => w.object_id)).toEqual([old.id]);
		expect(old.fields.system).toEqual(bv(true));
		expect(core.fields.system).toBeUndefined();

		vault.writes.length = 0;
		await run();
		expect(vault.writes).toEqual([]);
	});
}

test("kb: an older Knowledge Base Entry type is marked once", async () => {
	const type = object("kb-type", "type", { key: sv(KB_TYPE), name: sv("Knowledge Base Entry"), channel: sv(SPACE) });
	const vault = daemon([object(SPACE, "channel", {}), type]);
	await seedKbType(SPACE);
	expect(vault.ofType("type")).toHaveLength(1);
	expect(type.fields.system).toEqual(bv(true));
	vault.writes.length = 0;
	await seedKbType(SPACE);
	expect(vault.writes).toEqual([]);
});
