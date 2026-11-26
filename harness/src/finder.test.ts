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
