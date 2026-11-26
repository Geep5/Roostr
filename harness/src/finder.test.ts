import { expect, test } from "bun:test";
import { sv, type QueryRow } from "./api";
import { rankPages } from "./finder";

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
