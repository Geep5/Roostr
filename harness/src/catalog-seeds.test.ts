/**
 * The catalogs seed objects once and then leave them to their owners: one
 * Skill per catalog key (an older one adopted, never duplicated), one agent
 * Template per kind per space that is only rewritten while unedited, and
 * the retired descriptor cards gone. Runs against a fake daemon.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { agentTypeId, kindHash, seedCatalog } from "./catalog-seeds";
import { PROMPT_SEEDS } from "./prompts";
import { CATALOG } from "./skillmgr";

const SPACE = "space-0001-aaaa";
const originalFetch = globalThis.fetch;
const originalLog = console.log;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-catalog-"));
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

let clock = 0;
const object = (id: string, typeKey: string, fields: Record<string, ValueJSON>, text: string[] = []): ObjectJSON => ({
	id,
	typeKey,
	fields,
	blocks: text.map((t, i) => ({ id: `${id}-b${i}`, childrenIds: [], content: { text: { text: t, style: 0 } } })),
	deleted: false,
	createdAt: ++clock,
	updatedAt: 0,
	mailbox: [],
});

/** The engine's bundled properties an agent template uses already exist in every space. */
const bundled = ["prompt", "skills", "repo_path"].map((key) => object(`rel-${key}`, "relation", { key: sv(key), name: sv(key), channel: sv(SPACE) }));

/** A daemon over `initial`; returns the vault and every mutation it received. */
function daemon(initial: ObjectJSON[]) {
	const objects = new Map(initial.map((o) => [o.id, o]));
	const writes: Array<Record<string, unknown>> = [];
	let n = 0;
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith("/api/objects/")) {
			const o = objects.get(decodeURIComponent(url.pathname.slice("/api/objects/".length)));
			return o ? Response.json(o) : Response.json({ error: "not found" }, { status: 404 });
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
		if (url.pathname === "/api/query") {
			const all = [...objects.values()].filter((o) => !o.deleted && o.typeKey === body.type).map((o) => ({ id: o.id, typeKey: o.typeKey, fields: structuredClone(o.fields), createdAt: o.createdAt, updatedAt: o.updatedAt }));
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

const target = (v: ValueJSON | undefined): string[] => (v?.valuesValue?.items ?? (v ? [v] : [])).map((i) => i.linkValue?.targetId ?? "");

test("an empty vault gets one Skill per catalog key and one template per agent kind; the next boot writes nothing", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled]);
	await seedCatalog();

	const skills = vault.ofType("skill");
	expect(skills.map((s) => s.fields.key?.stringValue).sort()).toEqual(CATALOG.map((c) => c.key).sort());
	for (const entry of CATALOG) {
		const skill = skills.find((s) => s.fields.key?.stringValue === entry.key)!;
		expect(skill.fields.name?.stringValue).toBe(entry.name);
		expect(skill.blocks.length).toBeGreaterThan(0);
	}

	const templates = vault.ofType("template");
	expect(templates.map((t) => t.fields.seed_key?.stringValue).sort()).toEqual(PROMPT_SEEDS.map((s) => s.key).sort());
	const marco = templates.find((t) => t.fields.seed_key?.stringValue === "marco")!;
	expect(marco.fields.target_type?.stringValue).toBe(agentTypeId(SPACE));
	expect(marco.fields.channel?.stringValue).toBe(SPACE);
	expect(vault.objects.get(target(marco.fields.prompt)[0])?.fields.name?.stringValue).toBe("Marco");
	expect(target(marco.fields.skills)).toEqual([skills.find((s) => s.fields.key?.stringValue === "matcherino-dev")!.id]);
	expect(marco.fields.repo_path?.stringValue).toBe(PROMPT_SEEDS.find((s) => s.key === "marco")!.defaults.repo_path);
	// Marco's own settings became properties of the space; the bundled ones were not repeated.
	const props = vault.ofType("relation").map((r) => r.fields.key?.stringValue);
	expect(props.filter((k) => k === "discord_channel_id")).toHaveLength(1);
	expect(props.filter((k) => k === "repo_path")).toHaveLength(1);

	vault.writes.length = 0;
	await seedCatalog();
	expect(vault.writes).toEqual([]);
});

test("an older skill object is adopted, never duplicated, and its page stays the user's", async () => {
	const old = object("old-browserless", "skill", { name: sv("browserless") }, ["my own notes"]);
	const vault = daemon([object(SPACE, "channel", {}), ...bundled, old]);
	await seedCatalog();

	const browserless = vault.ofType("skill").filter((s) => s.fields.key?.stringValue === "browserless" || s.fields.name?.stringValue === "browserless");
	expect(browserless.map((s) => s.id)).toEqual(["old-browserless"]);
	expect(old.fields.name?.stringValue).toBe(CATALOG.find((c) => c.key === "browserless")!.name);
	expect(old.blocks.map((b) => b.content.text?.text)).toEqual(["my own notes"]);
});

test("a kind template is re-seeded only while nobody has edited it", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled]);
	await seedCatalog();
	const marco = vault.ofType("template").find((t) => t.fields.seed_key?.stringValue === "marco")!;
	const seed = PROMPT_SEEDS.find((s) => s.key === "marco")!;
	const repo = marco.fields.repo_path?.stringValue;

	// Seeded by an older catalog (no default yet), untouched since: brought up to date.
	delete marco.fields.repo_path;
	marco.fields.seed_hash = sv(kindHash(seed, marco.fields));
	await seedCatalog();
	expect(marco.fields.repo_path?.stringValue).toBe(repo);

	// Same, but someone filled in a setting: the template is theirs now.
	delete marco.fields.repo_path;
	marco.fields.seed_hash = sv(kindHash(seed, marco.fields));
	marco.fields.discord_channel_id = sv("123");
	await seedCatalog();
	expect(marco.fields.repo_path).toBeUndefined();
	expect(marco.fields.discord_channel_id?.stringValue).toBe("123");
});

test("the retired descriptor cards are vanished", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled, object("card", "descriptor", { key: sv("browserless") })]);
	await seedCatalog();
	expect(vault.objects.has("card")).toBe(false);
});
