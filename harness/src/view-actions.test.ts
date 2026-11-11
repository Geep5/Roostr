/**
 * A query that moves things to the bin leaves anything marked Don't delete
 * alone, and only binning queries do: Mark done and the others still act.
 */
import { expect, test } from "bun:test";
import { bv } from "./api";
import { ACTED_FIELD, type Actions, KEEP_KEY, leavesAlone } from "./view-actions";

const actions = (over: Partial<Actions>): Actions => ({ bin: false, done: false, tag: [], setProperty: "", setValue: "", ...over });
const q = { id: "query-1" };

test("a binning query leaves a Don't delete object alone, until it is unticked", () => {
	const kept = { id: "email-1", fields: { [KEEP_KEY]: bv(true) } };
	expect(leavesAlone(q, actions({ bin: true }), kept)).toBe(true);
	const unticked = { id: "email-1", fields: { [KEEP_KEY]: bv(false) } };
	expect(leavesAlone(q, actions({ bin: true }), unticked)).toBe(false);
	expect(leavesAlone(q, actions({ bin: true }), { id: "email-2", fields: {} })).toBe(false);
});

test("Don't delete does not stop other actions, and an object acted on once stays done", () => {
	const kept = { id: "task-1", fields: { [KEEP_KEY]: bv(true) } };
	expect(leavesAlone(q, actions({ done: true }), kept)).toBe(false);
	const acted = { id: "task-2", fields: { [ACTED_FIELD]: { mapValue: { entries: { "query-1": { mapValue: { entries: {} } } } } } } };
	expect(leavesAlone(q, actions({ done: true }), acted)).toBe(true);
	expect(leavesAlone(q, actions({ bin: true }), { id: "query-1", fields: {} })).toBe(true);
});
