/**
 * Generated covers, end to end on one computer: a `cover_request` on a page
 * → the art director's prompt (from the page's visible content only) → the
 * image → an ordinary File in the page's space → the session on the page's
 * `cover_generation`. OpenAI is a fake HTTP server (Bun.serve) that checks
 * what it is sent; the store is a fake daemon answering the harness's HTTP
 * calls from an in-memory map.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlockJSON, ObjectJSON, QueryRow, ValueJSON } from "./api";
import { fetchObject } from "./api";
import { COVER_GENERATION_KEY, COVER_REQUEST_KEY, coverGeneration, NEEDS_KEY, takeCoverRequest, type CoverGeneration } from "./covers";
import { checkCredential } from "./credential-objects";
import { seedSpaceDefaults } from "./space-defaults";
import { hasBlob } from "./files";
import { ART_DIRECTOR_INSTRUCTIONS, ART_DIRECTOR_MODEL, COVER_SIZE, COVER_STYLE, IMAGE_MODEL } from "./openai";
import { resetMachineIdCache } from "./roster";

const ME = "test-machine";
const SPACE = "space-1";
/** A 1x1 PNG: what the fake painter returns. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// ── The fake OpenAI ─────────────────────────────────────────────

interface Seen {
	path: string;
	auth: string;
	body: Record<string, unknown>;
}
let seen: Seen[] = [];
let ideas = 0;
/** What the painter does instead of painting, when set (a refusal, a slow paint). */
let onImage: ((body: Record<string, unknown>) => Promise<Response | null>) | null = null;

const openai = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		const auth = req.headers.get("authorization") ?? "";
		const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
		seen.push({ path: url.pathname, auth, body });
		if (auth !== "Bearer sk-test-123") return Response.json({ error: { message: "Incorrect API key provided: sk-bad.", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 });
		if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: ART_DIRECTOR_MODEL, object: "model" }, { id: IMAGE_MODEL, object: "model" }] });
		if (url.pathname === "/v1/responses") {
			ideas += 1;
			return Response.json({ id: "resp_1", object: "response", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: `"Idea ${ideas}"` }] }] });
		}
		if (url.pathname === "/v1/images/generations") {
			const instead = onImage ? await onImage(body) : null;
			if (instead) return instead;
			return Response.json({ created: 1, data: [{ b64_json: TINY_PNG.toString("base64") }], output_format: "jpeg", quality: "high", size: COVER_SIZE });
		}
		return Response.json({ error: { message: "not found" } }, { status: 404 });
	},
});

// ── The fake store ──────────────────────────────────────────────

let objects = new Map<string, ObjectJSON>();
let created = 0;
const originalFetch = globalThis.fetch;

const sv = (s: string): ValueJSON => ({ stringValue: s });
function object(id: string, typeKey: string, fields: Record<string, ValueJSON>, blocks: BlockJSON[] = [], createdAt = 0): ObjectJSON {
	return { id, typeKey, fields: { channel: sv(SPACE), ...fields }, blocks, deleted: false, createdAt, updatedAt: 0, mailbox: [] };
}
const relation = (key: string, name: string, format: string, hidden = false) => object(`rel-${key}`, "relation", { key: sv(key), name: sv(name), format: sv(format), hidden: { boolValue: hidden } });
const text = (id: string, t: string): BlockJSON => ({ id, childrenIds: [], content: { text: { text: t, style: 0 } } });

function daemon(): void {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.port !== "7333") return originalFetch(input, init);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.get(url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		if (url.pathname === "/api/channels") return Response.json([...objects.values()].filter((o) => o.typeKey === "channel").map((o) => ({ id: o.id, name: o.fields.name?.stringValue ?? "", owner: "" })));
		if (url.pathname === "/api/query") {
			const filters = (body.filters as Array<{ key: string; condition: string }> | undefined) ?? [];
			const records: QueryRow[] = [...objects.values()]
				.filter((o) => !o.deleted && (!body.type || o.typeKey === body.type) && filters.every((f) => f.condition === "exists" && o.fields[f.key] !== undefined))
				.map((o) => ({ id: o.id, typeKey: o.typeKey, createdAt: o.createdAt, updatedAt: o.updatedAt, fields: o.fields }));
			return Response.json({ records, total: records.length });
		}
		if (url.pathname === "/api/mutate") {
			const target = objects.get(String(body.object_id));
			switch (body.action) {
				case "set_field":
					target!.fields[String(body.key)] = body.value as ValueJSON;
					return Response.json({ ok: true });
				case "delete_field":
					delete target!.fields[String(body.key)];
					return Response.json({ ok: true });
				case "create": {
					const id = body.id ? String(body.id) : `made-${++created}`;
					if (objects.has(id)) return Response.json({ ok: true, id, existed: true });
					objects.set(id, { ...object(id, String(body.type_key), {}), fields: { name: sv(String(body.name)), ...(body.fields as Record<string, ValueJSON>) } });
					return Response.json({ ok: true, id });
				}
				case "block_add":
					target!.blocks.push(body.block as BlockJSON);
					return Response.json({ ok: true, id: (body.block as BlockJSON).id });
				case "vanish":
					for (const id of body.object_ids as string[]) objects.delete(id);
					return Response.json({ ok: true, vanished: (body.object_ids as string[]).length });
			}
		}
		return Response.json({ ok: false, error: `unexpected ${url.pathname} ${String(body.action ?? "")}` }, { status: 400 });
	}) as typeof fetch;
}

const PAGE = "page-1";
const CRED = "openai-space-1";

function world(key: string, servedBy = ME): void {
	objects = new Map(
		[
			object(SPACE, "channel", { name: sv("Garden") }),
			object("type-task", "type", { key: sv("task"), name: sv("Task") }),
			relation("name", "Name", "shorttext"),
			relation("status", "Status", "status"),
			relation("dueDate", "Due date", "date"),
			relation("owner", "Owner", "object"),
			relation("done", "Done", "checkbox"),
			relation("secret_note", "Secret note", "shorttext", true),
			relation("cover", "Cover", "object"),
			object("person-ada", "person", { name: sv("Ada") }),
			object(
				PAGE,
				"task",
				{
					name: sv("Launch the rooftop garden"),
					status: { valuesValue: { items: [sv("Doing")] } },
					dueDate: { intValue: Date.UTC(2026, 10, 1) },
					owner: { valuesValue: { items: [{ linkValue: { targetId: "person-ada", relationKey: "owner" } }] } },
					done: { boolValue: false },
					secret_note: sv("do not leak this"),
					internal_marker: sv("hidden-xyz"),
				},
				[text("b1", "Plant tomatoes and basil on the roof."), { id: "c1", childrenIds: [], content: { custom: { contentType: "chat", meta: { text: "chat says something private" } } } }],
			),
			object(CRED, "credential", { name: sv("OpenAI"), service: sv("openai"), served_by: sv(servedBy), key_api_key: sv(key) }, [], 1),
		].map((o) => [o.id, o]),
	);
}

/** Ask for a cover; the page's run afterwards (null once it ended in a cover). */
async function ask(entries: Record<string, ValueJSON>): Promise<CoverGeneration | null> {
	objects.get(PAGE)!.fields[COVER_REQUEST_KEY] = { mapValue: { entries } };
	await takeCoverRequest(await fetchObject(PAGE));
	return coverGeneration(objects.get(PAGE)!.fields);
}

let root = "";
let previous: Record<string, string | undefined> = {};

beforeAll(() => {
	previous = { GLON_DATA: process.env.GLON_DATA, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL, GLON_API: process.env.GLON_API };
});

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "roostr-covers-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: ME }));
	process.env.GLON_DATA = root;
	process.env.OPENAI_BASE_URL = `http://127.0.0.1:${openai.port}`;
	delete process.env.GLON_API;
	resetMachineIdCache();
	seen = [];
	ideas = 0;
	onImage = null;
	created = 0;
	daemon();
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	await rm(root, { recursive: true, force: true });
});

afterAll(() => {
	for (const [k, v] of Object.entries(previous)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	resetMachineIdCache();
	openai.stop(true);
});

test("Generate writes an idea from the page, paints a high-quality wide image, stores it as a File and makes it the cover", async () => {
	world("sk-test-123");
	const g = await ask({ at: { intValue: 1 }, action: sv("generate") });

	// Step 1: the Responses API, given only what the page shows.
	const director = seen.filter((s) => s.path === "/v1/responses");
	expect(director).toHaveLength(1);
	expect(director[0]!.auth).toBe("Bearer sk-test-123");
	expect(director[0]!.body.model).toBe(ART_DIRECTOR_MODEL);
	expect(director[0]!.body.instructions).toBe(ART_DIRECTOR_INSTRUCTIONS);
	const input = String(director[0]!.body.input);
	expect(input).toContain("Title: Launch the rooftop garden");
	expect(input).toContain("Type: Task");
	expect(input).toContain("- Status: Doing");
	expect(input).toContain("- Due date: 2026-11-01");
	expect(input).toContain("- Owner: Ada");
	expect(input).toContain("- Done: No");
	expect(input).toContain("Plant tomatoes and basil on the roof.");
	// Hidden properties, fields with no property and chat are not the page's visible content.
	expect(input).not.toContain("do not leak this");
	expect(input).not.toContain("hidden-xyz");
	expect(input).not.toContain("chat says");
	expect(input).not.toContain("Name:");

	// Step 2: the Images API, with that prompt in the house style (a real, minimal photograph).
	const painted = seen.filter((s) => s.path === "/v1/images/generations");
	expect(painted).toHaveLength(1);
	expect(painted[0]!.body).toEqual({ model: IMAGE_MODEL, prompt: `Idea 1\n\n${COVER_STYLE}`, n: 1, size: "3072x1024", quality: "high", output_format: "jpeg" });

	// The request is taken, the run is over, and the image is the page's cover, focused in the middle.
	const page = objects.get(PAGE)!.fields;
	expect(page[COVER_REQUEST_KEY]).toBeUndefined();
	expect(g).toBeNull();
	const fileId = page.cover?.linkValue?.targetId ?? "";
	expect(page.cover_y).toEqual({ floatValue: 0.5 });

	// The image is an ordinary File in the page's space, its bytes kept here.
	const file = objects.get(fileId)!;
	expect(file.typeKey).toBe("file");
	expect(file.fields.channel?.stringValue).toBe(SPACE);
	expect(file.fields.name?.stringValue).toBe("Cover - Launch the rooftop garden.jpg");
	expect(file.fields.file_mime?.stringValue).toBe("image/jpeg");
	expect(file.fields.file_size?.intValue).toBe(TINY_PNG.byteLength);
	expect(file.fields.available_on?.valuesValue?.items.map((i) => i.stringValue)).toEqual([ME]);
	expect(await hasBlob(file.fields.file_hash!.stringValue!)).toBe(true);

	// Generating again replaces the cover with a new File.
	await ask({ at: { intValue: 2 }, action: sv("generate") });
	const next = objects.get(PAGE)!.fields.cover?.linkValue?.targetId ?? "";
	expect(next).not.toBe("");
	expect(next).not.toBe(fileId);
});

test("a blank key asks OpenAI nothing: the session and the credential's Error say to add one", async () => {
	world("");
	const g = await ask({ at: { intValue: 1 }, action: sv("generate") });
	expect(seen).toEqual([]);
	expect(g).toMatchObject({ status: "failed", error: NEEDS_KEY, needsKey: true, credential: CRED });
	expect(objects.get(PAGE)!.fields[COVER_REQUEST_KEY]).toBeUndefined();
	const cred = objects.get(CRED)!.fields;
	expect(cred.status?.stringValue).toBe("missing");
	expect(cred.error?.stringValue).toBe('No key yet - paste "API key" to use it.');
});

test("a key OpenAI refuses fails the session with OpenAI's message and breaks the credential", async () => {
	world("sk-bad");
	const g = await ask({ at: { intValue: 1 }, action: sv("generate") });
	expect(g).toMatchObject({ status: "failed", needsKey: true, error: "Incorrect API key provided: sk-bad." });
	const cred = objects.get(CRED)!.fields;
	expect(cred.status?.stringValue).toBe("broken");
	expect(cred.error?.stringValue).toBe("OpenAI refused the key: Incorrect API key provided: sk-bad.");
});

test("a content refusal shows OpenAI's message on the session, and the key stays good", async () => {
	world("sk-test-123");
	onImage = async () => Response.json({ error: { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked" } }, { status: 400 });
	const g = await ask({ at: { intValue: 1 }, action: sv("generate"), prompt: sv("something refused") });
	expect(g).toMatchObject({ status: "failed", error: "Your request was rejected by the safety system.", needsKey: false });
	expect(objects.get(PAGE)!.fields.cover).toBeUndefined();
	expect(objects.get(CRED)!.fields.error).toBeUndefined();
});

test("a session closed while it painted keeps nothing", async () => {
	world("sk-test-123");
	onImage = async () => {
		// The person closes the panel mid-paint: the app removes the session.
		delete objects.get(PAGE)!.fields[COVER_GENERATION_KEY];
		return null;
	};
	await ask({ at: { intValue: 1 }, action: sv("generate") });
	expect(objects.get(PAGE)!.fields[COVER_GENERATION_KEY]).toBeUndefined();
	expect([...objects.values()].filter((o) => o.typeKey === "file")).toEqual([]);
});

test("only the computer serving the space's OpenAI credential takes the request", async () => {
	world("sk-test-123", "other-machine");
	objects.get(PAGE)!.fields[COVER_REQUEST_KEY] = { mapValue: { entries: { at: { intValue: 1 }, action: sv("generate") } } };
	await takeCoverRequest(await fetchObject(PAGE));
	expect(seen).toEqual([]);
	expect(objects.get(PAGE)!.fields[COVER_REQUEST_KEY]).toBeDefined();
	expect(objects.get(PAGE)!.fields[COVER_GENERATION_KEY]).toBeUndefined();
});

test("Check asks OpenAI whether the key works: a refused key breaks the credential, a good one mends it", async () => {
	world("sk-bad");
	expect((await checkCredential(CRED)).status).toBe("broken");
	expect(seen.map((s) => `${s.path} ${s.auth}`)).toEqual(["/v1/models Bearer sk-bad"]);
	expect(objects.get(CRED)!.fields.error?.stringValue).toBe("OpenAI refused the key: Incorrect API key provided: sk-bad.");
	objects.get(CRED)!.fields.key_api_key = sv("sk-test-123");
	const mended = await checkCredential(CRED);
	expect(mended).toMatchObject({ status: "active", auth: "api_key", error: "" });
	expect(objects.get(CRED)!.fields.error).toBeUndefined();
});

test("every space you own gets a blank OpenAI credential served here and the Cover properties, once", async () => {
	world("");
	objects.delete(CRED);
	objects.delete("rel-cover");
	await seedSpaceDefaults();
	const cred = objects.get(CRED)!;
	expect(cred.typeKey).toBe("credential");
	expect(cred.fields.name?.stringValue).toBe("OpenAI");
	expect(cred.fields.service?.stringValue).toBe("openai");
	expect(cred.fields.served_by?.stringValue).toBe(ME);
	expect(cred.fields.key_api_key?.stringValue).toBe("");
	expect(cred.blocks.map((b) => b.content.text?.text ?? "").join("\n")).toContain("Roostr never ships one.");
	const cover = objects.get(`rel-cover-${SPACE}`)!;
	expect(cover.fields).toMatchObject({ key: sv("cover"), name: sv("Cover"), format: sv("object"), hidden: { boolValue: false }, maxCount: { intValue: 1 }, bundled: { boolValue: false }, system: { boolValue: true } });
	expect(cover.fields.object_types?.valuesValue?.items).toEqual([sv(`bundled-type-file-${SPACE.slice(0, 8)}`)]);
	expect(objects.get(`rel-cover_y-${SPACE}`)!.fields).toMatchObject({ key: sv("cover_y"), name: sv("Cover position"), format: sv("number") });

	const count = objects.size;
	await seedSpaceDefaults();
	expect(objects.size).toBe(count);
});
