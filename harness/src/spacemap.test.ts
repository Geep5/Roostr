/**
 * A saved view's relative date rule ("Updated more than 30 days ago") runs
 * as the engine's `numberOfDaysAgo` quick option with a numeric day count,
 * as the app sends it; a rule without a day count yet filters nothing.
 */
import { expect, test } from "bun:test";
import type { ObjectJSON, ValueJSON } from "./api";
import { convertViewFilters, type RelDef } from "./spacemap";

const rule = (entries: Record<string, string>, value: string[]): ValueJSON => ({
	mapValue: {
		entries: {
			...Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { stringValue: v }])),
			value: { valuesValue: { items: value.map((stringValue) => ({ stringValue })) } },
		},
	},
});

const view = (...rules: ValueJSON[]): ObjectJSON => ({
	id: "query-1",
	typeKey: "query",
	fields: { viewFilters: { valuesValue: { items: rules } } },
	blocks: [],
	deleted: false,
	createdAt: 0,
	updatedAt: 0,
});

const due: RelDef = { key: "due", name: "Due", emoji: "", format: "date", definition: "", readOnly: false, role: "details" };

test("a relative date rule passes its quick option with a numeric day count", () => {
	const q = view(
		rule({ key: "updatedAt", condition: "less", quickOption: "numberOfDaysAgo" }, ["30"]),
		rule({ key: "due", condition: "greaterOrEqual", quickOption: "numberOfDaysAgo" }, ["7"]),
		rule({ key: "due", condition: "less", quickOption: "numberOfDaysAgo" }, []),
		rule({ key: "createdAt", condition: "less" }, ["1700000000000"]),
	);
	expect(convertViewFilters(q, new Map([["due", due]]))).toEqual([
		{ key: "updatedAt", condition: "less", quickOption: "numberOfDaysAgo", value: 30 },
		{ key: "due", condition: "greaterOrEqual", quickOption: "numberOfDaysAgo", value: 7 },
		{ key: "createdAt", condition: "less", value: 1700000000000 },
	]);
});
