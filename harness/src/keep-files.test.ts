import { expect, test } from "bun:test";
import type { QueryRow } from "./api";
import { keepAllPlan, nextBackoff, type Backoff } from "./keep-files";

const ME = "me-machine";
const hash = (c: string) => c.repeat(64);
const file = (id: string, h: string, on: string[], createdAt: number): QueryRow => ({
	id,
	name: id,
	typeKey: "file",
	createdAt,
	updatedAt: createdAt,
	fields: { file_hash: { stringValue: h }, available_on: { valuesValue: { items: on.map((m) => ({ stringValue: m })) } } },
});

test("plans the bytes this computer lacks, oldest first, one entry per hash with every holder", () => {
	const files = [
		file("newer", hash("b"), ["studio"], 20),
		file("older", hash("a"), ["laptop", ME], 10),
		file("copy", hash("b"), ["laptop"], 30),
	];
	expect(keepAllPlan(files, ME, new Set(), new Map(), 0)).toEqual([
		{ hash: hash("a"), holders: ["laptop"] },
		{ hash: hash("b"), holders: ["studio", "laptop"] },
	]);
});

test("skips bytes already here, files only this computer (or nobody) holds, bad hashes and files waiting out a backoff", () => {
	const files = [
		file("held", hash("a"), ["studio"], 1),
		file("mine", hash("b"), [ME], 2),
		file("orphan", hash("c"), [], 3),
		file("bad", "not-a-hash", ["studio"], 4),
		file("waiting", hash("d"), ["studio"], 5),
		file("due", hash("e"), ["studio"], 6),
	];
	const backoff = new Map<string, Backoff>([[hash("d"), { at: 1_000, delay: 600_000, holders: "studio" }], [hash("e"), { at: 500, delay: 600_000, holders: "studio" }]]);
	expect(keepAllPlan(files, ME, new Set([hash("a")]), backoff, 999).map((p) => p.hash)).toEqual([hash("e")]);
});

test("a waiting file is tried at once when another computer comes to hold it, not when anything else on it changes", () => {
	const backoff = new Map<string, Backoff>([[hash("d"), nextBackoff(undefined, 0, ["studio"])]]);
	expect(keepAllPlan([file("same", hash("d"), ["studio", ME], 1)], ME, new Set(), backoff, 1_000)).toEqual([]);
	expect(keepAllPlan([file("moved", hash("d"), ["studio", "laptop"], 1)], ME, new Set(), backoff, 1_000)).toEqual([{ hash: hash("d"), holders: ["studio", "laptop"] }]);
});

test("an offline holder's files wait 10 minutes, doubling to at most 6 hours; new holders start over", () => {
	let b = nextBackoff(undefined, 0, ["studio"]);
	expect(b).toEqual({ at: 600_000, delay: 600_000, holders: "studio" });
	b = nextBackoff(b, 1_000, ["studio"]);
	expect(b).toEqual({ at: 1_201_000, delay: 1_200_000, holders: "studio" });
	for (let i = 0; i < 10; i++) b = nextBackoff(b, 0, ["studio"]);
	expect(b.delay).toBe(6 * 60 * 60_000);
	expect(nextBackoff(b, 0, ["laptop", "studio"])).toEqual({ at: 600_000, delay: 600_000, holders: "laptop,studio" });
});
