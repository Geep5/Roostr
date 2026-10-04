/**
 * The md-file KB becomes kb_entry objects: one entry per ## section, the
 * filename becomes the category, the staff-file convention becomes
 * audience, and the prompt section groups entries by category with
 * staff-only ones marked.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { str } from "./api";
import { kbPromptSection, KB_TYPE, knowledgeBaseChannels, parseKbFile } from "./kb";

test("parseKbFile splits a file into one entry per ## section", () => {
	const entries = parseKbFile("pin.md", [
		"# Pin Delivery",
		"",
		"## How It Works",
		"- Pins are voucher links.",
		"",
		"## Pricing",
		"> \"Prices vary per pin.\"",
		"",
		"## Known Issues",
		"",
	].join("\n"));
	expect(entries.map((e) => e.title)).toEqual(["How It Works", "Pricing"]);
	expect(entries.every((e) => e.category === "pin" && e.audience === "customer" && e.status === "current")).toBe(true);
	expect(entries[1].markdown).toBe('> "Prices vary per pin."');
	expect(entries[0].source).toBe("pin.md#How It Works");
});

test("parseKbFile maps the staff-file convention to audience, and open questions to uncertain", () => {
	const staff = parseKbFile("staff.md", "# Staff\n\n## Routing\n- Pins go to Sam.");
	expect(staff[0]).toMatchObject({ category: "other", audience: "staff", title: "Routing" });
	const open = parseKbFile("open_questions.md", "## Refund policy\n- TBD");
	expect(open[0]).toMatchObject({ audience: "staff", status: "uncertain" });
});

test("parseKbFile turns non-empty preamble into a named entry", () => {
	const entries = parseKbFile("global.md", "# Global\n\nThe canonical invite is example.com/discord.\n\n## Links\n- x");
	expect(entries.map((e) => e.title)).toEqual(["General", "Links"]);
});

test("parseKbFile drops empty sections and blank files", () => {
	expect(parseKbFile("bug.md", "# Bugs\n\n## Empty\n\n")).toEqual([]);
});

// --- prompt section ---

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-kb-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function entry(id: string, name: string, category: string, audience: string, status: string, body: string[]): ObjectJSON {
	const fields: Record<string, ValueJSON> = {
		name: { stringValue: name },
		kb_category: { stringValue: category },
		kb_audience: { stringValue: audience },
		kb_status: { stringValue: status },
	};
	return {
		id, typeKey: KB_TYPE, fields, deleted: false, createdAt: 0, updatedAt: 0, mailbox: [],
		blocks: body.map((text, i) => ({ id: `b${i}`, childrenIds: [], content: { text: { text, style: 0 } } })),
	};
}

test("knowledgeBaseChannels reads the agent's Knowledge bases link list", () => {
	const agent = entry("a", "Support", "", "", "", []);
	expect(knowledgeBaseChannels(agent)).toEqual([]);
	agent.fields["knowledge_bases"] = { valuesValue: { items: [{ linkValue: { targetId: "space-1" } }, { linkValue: { targetId: "space-2" } }] } };
	expect(knowledgeBaseChannels(agent)).toEqual(["space-1", "space-2"]);
});

test("kbPromptSection groups by category and marks staff entries", async () => {
	const objects = [
		entry("1", "Pin types", "pin", "customer", "current", ["Contributor pins are variable-priced."]),
		entry("2", "Invite links", "global", "customer", "current", ["Use the canonical invite."]),
		entry("3", "Routing", "other", "staff", "current", ["Pins go to Sam."]),
		entry("4", "Old policy", "pin", "customer", "outdated", ["Superseded."]),
	];
	globalThis.fetch = (async (input: string | URL | Request) => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((o) => o.id === url.pathname.slice("/api/objects/".length));
			if (found) return Response.json(found);
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	const rows = objects.map((o) => ({ id: o.id, typeKey: KB_TYPE, name: str(o.fields, "name"), createdAt: 0, updatedAt: 0, fields: o.fields }));
	const section = await kbPromptSection(rows);
	expect(section).not.toBeNull();
	const text = section!.text;
	expect(text.indexOf("## global")).toBeLessThan(text.indexOf("## other"));
	expect(text.indexOf("## other")).toBeLessThan(text.indexOf("## pin"));
	expect(text).toContain("### [internal] Routing");
	expect(text).toContain("### Old policy (outdated)");
	expect(text).toContain("Contributor pins are variable-priced.");
});

test("kbPromptSection is null with no rows (opt-in: no links, no section)", async () => {
	expect(await kbPromptSection([])).toBeNull();
});
