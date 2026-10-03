/**
 * A custom Tool runs in its own process: its result comes back as data,
 * its console output stays out of it, and one that runs too long is
 * killed rather than left to hang the turn.
 */
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCode } from "./tool-host";

const context = { agentId: "agent", objectId: "object", channelId: "space", machineId: "machine" };

test("a tool's result is what it returns; what it prints is only its log", async () => {
	const run = await runToolCode('console.log("checking", input.n); return [input.n, roostr.context.channelId];', { n: 3 }, context);
	expect(run).toEqual({ ok: true, value: [3, "space"], log: "checking 3\n", touched: [] });
});

test("a tool that throws reports why: an error it throws on purpose is ordinary, a JavaScript error of its own code is a crash", async () => {
	const refused = await runToolCode('throw new Error("mailbox not set");', {}, context);
	expect(refused).toMatchObject({ ok: false, error: "mailbox not set", crashed: false });
	const broken = await runToolCode("return input.missing.field;", {}, context);
	expect(broken).toMatchObject({ ok: false, crashed: true });
	expect(broken.ok ? "" : broken.error).toStartWith("TypeError: ");
});

// Real time on purpose: the limit is enforced on a separate process, which
// fake timers in this one can't reach.
test("a tool past its time limit is killed and says so", async () => {
	const marker = join(tmpdir(), `roostr-tool-timeout-${crypto.randomUUID()}`);
	const started = Date.now();
	const run = await runToolCode(`await Bun.sleep(400); await Bun.write(${JSON.stringify(marker)}, "ran"); return 1;`, {}, context, 100);
	expect(Date.now() - started).toBeLessThan(400);
	expect(run.ok).toBe(false);
	expect(run.ok ? "" : run.error).toContain("was stopped");
	// Killed, not abandoned: well past its sleep, it never finished its work.
	await Bun.sleep(700);
	expect(await Bun.file(marker).exists()).toBe(false);
	await rm(marker, { force: true });
});
