import { expect, test } from "bun:test";
import { sv, type QueryRow } from "./api";
import { handOffAgent, rankPages } from "./finder";

const row = (id: string, name: string, typeKey = "page", space = "sp", updatedAt = 1): QueryRow => ({ id, typeKey, createdAt: 0, updatedAt, fields: { name: sv(name), channel: sv(space) } });

test("Finder's search: pages of the space whose names hold the request's words, whole words first, then the newest", () => {
	const rows = [
		row("q", "Quotes"),
		row("j", "Journal quotes old", "page", "sp", 5),
		row("other", "Quotes", "page", "elsewhere"),
		row("a", "Quotes Agent", "agent"),
		row("t", "Quotes", "type"),
		row("n", "Shopping"),
	];
	expect(rankPages(rows, "sp", "help me add this quote to quotes").map((h) => h.id)).toEqual(["q", "j"]);
	expect(rankPages(rows, "sp", "nothing matching here")).toEqual([]);
});

test("hand-off agent: the one asked for, else the page's own, else the space agent - never Finder", () => {
	const agent = (id: string, name: string) => row(id, name, "agent");
	const rows = [agent("finder-agent-sp", "Finder"), agent("space-agent-sp", "Castle Space"), agent("tester", "Tester"), agent("writer", "Writer")];
	const page = row("p", "Hunter Overview");
	const withAgent = { ...page, fields: { ...page.fields, agent: { valuesValue: { items: [{ linkValue: { relationKey: "agent", targetId: "writer" } }] } } } };
	expect(handOffAgent(rows, page, "sp", "Castle", "tester")).toEqual({ id: "tester", fallback: false });
	expect(handOffAgent(rows, withAgent, "sp", "Castle", "")).toEqual({ id: "writer", fallback: true });
	expect(handOffAgent(rows, page, "sp", "Castle", "nobody")).toEqual({ id: "space-agent-sp", fallback: true });
	expect(handOffAgent(rows, page, "sp", "Castle", "finder-agent-sp")).toEqual({ id: "space-agent-sp", fallback: true });
	expect(handOffAgent([agent("finder-agent-sp", "Finder")], page, "sp", "Castle", "")).toBeNull();
});

test("the computer the app talks to answers its Finder session; without one, the Finder's own computer does", async () => {
	const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { finderComputer } = await import("./finder");
	const previous = process.env.GLON_DATA;
	const originalFetch = globalThis.fetch;
	const root = await mkdtemp(join(tmpdir(), "roostr-finder-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
	// The roster: one Computer object, for a session that links the object rather than naming the id.
	globalThis.fetch = (async () => Response.json({ records: [{ id: "studio-object", typeKey: "machine", createdAt: 0, updatedAt: 1, fields: { machine_id: sv("studio") } }], total: 1 })) as unknown as typeof fetch;
	try {
		const obj = (fields: Record<string, ReturnType<typeof sv>>) => ({ id: "x", typeKey: "finder_session", fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 1, mailbox: [] });
		const finder = obj({ served_by: sv("macbook") });
		expect(await finderComputer(obj({ finder_space: sv("sp"), served_by: sv("studio") }), finder)).toBe("studio");
		expect(await finderComputer(obj({ finder_space: sv("sp") }), finder)).toBe("macbook");
		expect(await finderComputer(obj({ finder_space: sv("sp"), served_by: sv("studio-object") }), finder)).toBe("studio");
	} finally {
		globalThis.fetch = originalFetch;
		// The fake roster stays in the machine cache otherwise, for every later test file.
		(await import("./machine")).invalidateServing();
		if (previous === undefined) delete process.env.GLON_DATA;
		else process.env.GLON_DATA = previous;
		await rm(root, { recursive: true, force: true });
	}
});
