import { expect, test } from "bun:test";
import type { ValueJSON } from "./api";
import { HUMAN_THREAD } from "./conv";
import { GENESIS_KEYS, genesisCalls, genesisFingerprint, lastGenesis } from "./genesis";
import type { ClassifiedItem } from "./types";

const agent = (fields: Record<string, ValueJSON> = {}) => ({
	id: "agent-1",
	fields: {
		name: { stringValue: "Kimi" },
		prompt: { linkValue: { relationKey: "prompt", targetId: "prompt-1" } },
		channel: { stringValue: "space-1" },
		...fields,
	} as Record<string, ValueJSON>,
});

test("every important property, the model and the prompt's text change the fingerprint; other edits do not", () => {
	const base = genesisFingerprint(agent(), "kimi-k3", "You are Kimi.");
	for (const key of GENESIS_KEYS) {
		expect(genesisFingerprint(agent({ [key]: { stringValue: "changed" } }), "kimi-k3", "You are Kimi.")).not.toBe(base);
	}
	expect(genesisFingerprint(agent(), "claude-sonnet-4-5", "You are Kimi.")).not.toBe(base);
	expect(genesisFingerprint(agent(), "kimi-k3", "You are Kimi, terse.")).not.toBe(base);
	// Tags, status, memory flags and the like leave the agent's identity alone.
	expect(genesisFingerprint(agent({ tag: { valuesValue: { items: [{ stringValue: "x" }] } }, status: { stringValue: "busy" } }), "kimi-k3", "You are Kimi.")).toBe(base);
	// A link list and the same ids as plain strings are the same skills.
	expect(genesisFingerprint(agent({ skills: { valuesValue: { items: [{ linkValue: { relationKey: "skills", targetId: "s1" } }] } } }), "m", "p"))
		.toBe(genesisFingerprint(agent({ skills: { valuesValue: { items: [{ stringValue: "s1" }] } } }), "m", "p"));
});

test("the latest genesis marker in context wins; none means genesis is due", () => {
	const use = (id: string, input: Record<string, unknown>): ClassifiedItem => ({ kind: "tool_use", blockId: id, toolUseId: id, name: "object_get", input });
	expect(lastGenesis([])).toBe("");
	expect(lastGenesis([use("a", { id: "x" })])).toBe("");
	expect(lastGenesis([use("a", { id: "agent-1", genesis: "old" }), use("b", { id: "x" }), use("c", { id: "agent-1", genesis: "new" })])).toBe("new");
});

test("genesis reads itself, the object it is on when that differs, then this conversation", () => {
	// On its own page: no second object_get; the human thread omits thread_id.
	expect(genesisCalls(agent(), { objectId: "agent-1", threadId: HUMAN_THREAD }, "fp")).toEqual([
		{ name: "object_get", input: { id: "agent-1", genesis: "fp" } },
		{ name: "discussion_read", input: { id: "agent-1" } },
	]);
	// On another object's exchange thread: that object too, and the thread named.
	expect(genesisCalls(agent(), { objectId: "task-9", threadId: "ex-1" }, "fp")).toEqual([
		{ name: "object_get", input: { id: "agent-1", genesis: "fp" } },
		{ name: "object_get", input: { id: "task-9" } },
		{ name: "discussion_read", input: { id: "task-9", thread_id: "ex-1" } },
	]);
});
