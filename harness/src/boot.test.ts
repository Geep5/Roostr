import { expect, test } from "bun:test";
import { runBootSteps } from "./boot";

test("a startup step that throws never stops the others, and is what gets reported", async () => {
	const ran: string[] = [];
	let reported: string[] | null = null;
	const failures = await runBootSteps(
		[
			{ name: "first", run: async () => void ran.push("first") },
			{ name: "space defaults", run: async () => { throw new Error('object "space-agent-x" was deleted - nothing can be written to it'); } },
			{ name: "last", run: async () => void ran.push("last") },
		],
		async (f) => void (reported = f),
	);
	expect(ran).toEqual(["first", "last"]);
	expect(failures).toEqual(['space defaults: object "space-agent-x" was deleted - nothing can be written to it']);
	expect(reported!).toEqual(failures);
});

test("a clean startup reports no failures, so an earlier report can be cleared", async () => {
	let reported: string[] | null = null;
	await runBootSteps([{ name: "only", run: async () => ({ ok: 1 }) }], async (f) => void (reported = f));
	expect(reported!).toEqual([]);
});
