/**
 * The catalogs seed objects once and then leave them to their owners: one
 * Skill per catalog key (an older one adopted, never duplicated), one agent
 * Template per kind per space that is only rewritten while unedited, and
 * the retired descriptor cards gone. Runs against a fake daemon, with a
 * kind of its own registered as a private extension would (extensions.ts).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { agentTypeId, kindHash, seedCatalog } from "./catalog-seeds";
import { registerExtension } from "./extensions";
import { PROMPT_SEEDS, type AgentKindEntry } from "./prompts";
import { CATALOG, catalogSkillId } from "./skillmgr";
import { foldSpacelessSkills } from "./skill-spaces";

/** A kind with settings of its own, a default and a catalog skill. */
const PROBE: AgentKindEntry = {
	key: "probe",
	name: "Probe (test kind)",
	promptName: "Probe",
	description: "A kind registered by this test.",
	system: "You are a probe.",
	model: "test-model",
	skills: ["browserless"],
	fields: [
		{ key: "probe_channel_id", label: "Probe channel id", note: "A setting of the kind's own." },
		{ key: "repo_path", label: "Repository path", note: "A setting the space already has." },
	],
	defaults: { repo_path: "/srv/probe" },
};
let unregister = () => {};

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
	unregister = registerExtension({ kinds: [PROBE] });
});

afterEach(async () => {
	unregister();
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
		if (url.pathname === "/api/channels") {
			// A space someone shared with you names its owner.
			return Response.json([...objects.values()].filter((o) => !o.deleted && o.typeKey === "channel").map((o) => ({ id: o.id, name: o.fields.name?.stringValue ?? o.id, owner: o.fields.owner?.stringValue ?? "" })));
		}
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
		if (url.pathname === "/api/query") {
			const notEmpty = ((body.filters ?? []) as Array<{ key: string; condition: string }>).filter((f) => f.condition === "notEmpty").map((f) => f.key);
			const all = [...objects.values()]
				.filter((o) => !o.deleted && (!body.type || o.typeKey === body.type) && notEmpty.every((k) => o.fields[k] !== undefined))
				.map((o) => ({ id: o.id, typeKey: o.typeKey, fields: structuredClone(o.fields), createdAt: o.createdAt, updatedAt: o.updatedAt }));
			const offset = body.offset ?? 0;
			return Response.json({ records: all.slice(offset, offset + (body.limit ?? all.length)), total: all.length });
		}
		if (url.pathname === "/api/mutate") {
			writes.push(body);
			const o = objects.get(body.object_id);
			switch (body.action) {
				case "create": {
					const id = body.id ?? `new-${++n}`;
					if (objects.has(id)) return Response.json({ ok: true, id, existed: true });
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

const target = (v: ValueJSON | undefined): string[] => (v?.valuesValue?.items ?? (v ? [v] : [])).map((i) => i.linkValue?.targetId ?? "");

test("each space you own gets one Skill per catalog key and one template per agent kind; the next boot writes nothing", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled]);
	await seedCatalog();

	const skills = vault.ofType("skill");
	expect(skills.map((s) => s.fields.key?.stringValue).sort()).toEqual(CATALOG.map((c) => c.key).sort());
	expect(skills.every((s) => s.fields.channel?.stringValue === SPACE)).toBe(true);
	for (const entry of CATALOG) {
		const skill = skills.find((s) => s.fields.key?.stringValue === entry.key)!;
		expect(skill.fields.name?.stringValue).toBe(entry.name);
		expect(skill.blocks.length).toBeGreaterThan(0);
	}

	const templates = vault.ofType("template");
	expect(templates.map((t) => t.fields.seed_key?.stringValue).sort()).toEqual(PROMPT_SEEDS.map((s) => s.key).sort());
	const probe = templates.find((t) => t.fields.seed_key?.stringValue === "probe")!;
	expect(probe.fields.target_type?.stringValue).toBe(agentTypeId(SPACE));
	expect(probe.fields.channel?.stringValue).toBe(SPACE);
	expect(vault.objects.get(target(probe.fields.prompt)[0])?.fields.name?.stringValue).toBe("Probe");
	expect(target(probe.fields.skills)).toEqual([skills.find((s) => s.fields.key?.stringValue === "browserless")!.id]);
	expect(probe.fields.repo_path?.stringValue).toBe(PROBE.defaults.repo_path);
	// The kind's own settings became properties of the space; the bundled ones were not repeated.
	const props = vault.ofType("relation").map((r) => r.fields.key?.stringValue);
	expect(props.filter((k) => k === "probe_channel_id")).toHaveLength(1);
	expect(props.filter((k) => k === "repo_path")).toHaveLength(1);

	vault.writes.length = 0;
	await seedCatalog();
	expect(vault.writes).toEqual([]);
});

test("a space shared with you gets no Skill copies; each space you own gets its own, and its templates link those", async () => {
	const OTHER = "space-0002-bbbb";
	const vault = daemon([object(SPACE, "channel", {}), object(OTHER, "channel", {}), object("shared-1", "channel", { owner: sv("someone-else") }), ...bundled]);
	await seedCatalog();
	const skills = vault.ofType("skill");
	expect(skills.filter((s) => s.fields.channel?.stringValue === "shared-1")).toEqual([]);
	for (const space of [SPACE, OTHER]) {
		const here = skills.filter((s) => s.fields.channel?.stringValue === space);
		expect(here.map((s) => s.fields.key?.stringValue).sort()).toEqual(CATALOG.map((c) => c.key).sort());
		const probe = vault.ofType("template").find((t) => t.fields.seed_key?.stringValue === "probe" && t.fields.channel?.stringValue === space)!;
		expect(target(probe.fields.skills)).toEqual([here.find((s) => s.fields.key?.stringValue === "browserless")!.id]);
	}
});

test("a space's default copy a person deleted for good is not made again", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled]);
	const realFetch = globalThis.fetch;
	// The engine refuses an id deleted for good.
	globalThis.fetch = (async (input, init) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
		if (body.action === "create" && body.id === catalogSkillId("browserless", SPACE)) return Response.json({ ok: false, error: "object was deleted" }, { status: 409 });
		return realFetch(input, init);
	}) as typeof fetch;
	await seedCatalog();
	expect(vault.ofType("skill").map((s) => s.fields.key?.stringValue)).not.toContain("browserless");
});

test("an older skill object in the space is adopted, never duplicated, and its page stays the user's", async () => {
	const old = object("old-browserless", "skill", { name: sv("browserless"), channel: sv(SPACE) }, ["my own notes"]);
	const vault = daemon([object(SPACE, "channel", {}), ...bundled, old]);
	await seedCatalog();

	const browserless = vault.ofType("skill").filter((s) => s.fields.key?.stringValue === "browserless" || s.fields.name?.stringValue === "browserless");
	expect(browserless.map((s) => s.id)).toEqual(["old-browserless"]);
	expect(old.fields.name?.stringValue).toBe(CATALOG.find((c) => c.key === "browserless")!.name);
	expect(old.blocks.map((b) => b.content.text?.text)).toEqual(["my own notes"]);
});

test("a Skill page still holding an earlier catalog body is upgraded; an edited one is left alone", async () => {
	const entry = CATALOG.find((c) => c.key === "browserless")!;
	const untouched = object("old-browserless", "skill", { key: sv("browserless"), name: sv(entry.name), channel: sv(SPACE) }, [entry.legacySkillBodies![0]]);
	const vault = daemon([object(SPACE, "channel", {}), ...bundled, untouched]);
	await seedCatalog();
	expect(untouched.blocks.map((b) => b.content.text?.text)).toEqual([entry.skillBody]);

	untouched.blocks = [{ id: "edited", childrenIds: [], content: { text: { text: `${entry.legacySkillBodies![0]}\nMy own line.`, style: 0 } } }];
	await seedCatalog();
	expect(untouched.blocks.map((b) => b.content.text?.text)).toEqual([`${entry.legacySkillBodies![0]}\nMy own line.`]);
});

test("a kind template is re-seeded only while nobody has edited it", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled]);
	await seedCatalog();
	const probe = vault.ofType("template").find((t) => t.fields.seed_key?.stringValue === "probe")!;
	const repo = probe.fields.repo_path?.stringValue;

	// Seeded by an older catalog (no default yet), untouched since: brought up to date.
	delete probe.fields.repo_path;
	probe.fields.seed_hash = sv(kindHash(PROBE, probe.fields));
	await seedCatalog();
	expect(probe.fields.repo_path?.stringValue).toBe(repo);

	// Same, but someone filled in a setting: the template is theirs now.
	delete probe.fields.repo_path;
	probe.fields.seed_hash = sv(kindHash(PROBE, probe.fields));
	probe.fields.probe_channel_id = sv("123");
	await seedCatalog();
	expect(probe.fields.repo_path).toBeUndefined();
	expect(probe.fields.probe_channel_id?.stringValue).toBe("123");
});

test("the retired descriptor cards are vanished", async () => {
	const vault = daemon([object(SPACE, "channel", {}), ...bundled, object("card", "descriptor", { key: sv("browserless") })]);
	await seedCatalog();
	expect(vault.objects.has("card")).toBe(false);
});

test("a spaceless Skill becomes each space's own, edits included: whatever lists it lists its space's copy, and the spaceless one goes", async () => {
	const OTHER = "space-0002-bbbb";
	const entry = CATALOG.find((c) => c.key === "browserless")!;
	const globalBrowserless = object("global-browserless", "skill", { key: sv("browserless"), name: sv(entry.name), scope: sv("global") }, ["My own browserless notes."]);
	const notes = object("global-notes", "skill", { name: sv("summarize-notes"), description: sv("How to summarize") }, ["Keep it short."]);
	const link = (ids: string[]): ValueJSON => ({ valuesValue: { items: ids.map((id) => ({ linkValue: { relationKey: "skills", targetId: id } })) } });
	const here = object("agent-here", "agent", { channel: sv(SPACE), skills: link(["global-browserless", "global-notes"]) });
	const there = object("agent-there", "agent", { channel: sv(OTHER), skills: link(["global-notes"]) });
	const vault = daemon([object(SPACE, "channel", {}), object(OTHER, "channel", {}), object("shared-1", "channel", { owner: sv("someone-else") }), ...bundled, globalBrowserless, notes, here, there]);
	await seedCatalog();
	await foldSpacelessSkills();

	const skills = vault.ofType("skill");
	expect(skills.filter((s) => !s.fields.channel?.stringValue)).toEqual([]);
	const notesIn = (space: string) => skills.find((s) => s.fields.name?.stringValue === "summarize-notes" && s.fields.channel?.stringValue === space);
	expect(notesIn("shared-1")).toBeUndefined();
	for (const space of [SPACE, OTHER]) expect(vault.objects.get(catalogSkillId("browserless", space))!.blocks.map((b) => b.content.text?.text).join("\n")).toContain("My own browserless notes.");
	expect(notesIn(OTHER)!.blocks.map((b) => b.content.text?.text).join("\n")).toContain("Keep it short.");
	expect(notesIn(OTHER)!.fields.description?.stringValue).toBe("How to summarize");
	expect(target(here.fields.skills)).toEqual([catalogSkillId("browserless", SPACE), notesIn(SPACE)!.id]);
	expect(target(there.fields.skills)).toEqual([notesIn(OTHER)!.id]);

	vault.writes.length = 0;
	await foldSpacelessSkills();
	expect(vault.writes).toEqual([]);
});
