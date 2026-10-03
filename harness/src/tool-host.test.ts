/**
 * A Tool runs in its own process: its result comes back as data, its
 * console output stays out of it, and one that runs too long is killed
 * rather than left to hang the turn. What it asks of the harness goes over
 * its own channel and is answered by its own run's harness alone, ends with
 * the run, and doesn't count against its time.
 */
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolCode, type HarnessServe } from "./tool-host";

const context = { agentId: "agent", objectId: "object", channelId: "space", machineId: "machine" };
/** For tools that never ask the harness anything. */
const noHarness: HarnessServe = async (method) => {
	throw new Error(`unexpected harness call ${method}`);
};

test("a tool's result is what it returns; what it prints is only its log", async () => {
	const run = await runToolCode('console.log("checking", input.n); return [input.n, roostr.context.channelId];', { n: 3 }, context, noHarness);
	expect(run).toEqual({ ok: true, value: [3, "space"], log: "checking 3\n", touched: [] });
});

test("a tool that throws reports why: an error it throws on purpose is ordinary, a JavaScript error of its own code is a crash", async () => {
	const refused = await runToolCode('throw new Error("mailbox not set");', {}, context, noHarness);
	expect(refused).toMatchObject({ ok: false, error: "mailbox not set", crashed: false });
	const broken = await runToolCode("return input.missing.field;", {}, context, noHarness);
	expect(broken).toMatchObject({ ok: false, crashed: true });
	expect(broken.ok ? "" : broken.error).toStartWith("TypeError: ");
});

// Real time on purpose: the limit is enforced on a separate process, which
// fake timers in this one can't reach.
test("a tool past its time limit is killed and says so", async () => {
	const marker = join(tmpdir(), `roostr-tool-timeout-${crypto.randomUUID()}`);
	const started = Date.now();
	const run = await runToolCode(`await Bun.sleep(400); await Bun.write(${JSON.stringify(marker)}, "ran"); return 1;`, {}, context, noHarness, 100);
	expect(Date.now() - started).toBeLessThan(400);
	expect(run.ok).toBe(false);
	expect(run.ok ? "" : run.error).toContain("was stopped");
	// Killed, not abandoned: well past its sleep, it never finished its work.
	await Bun.sleep(700);
	expect(await Bun.file(marker).exists()).toBe(false);
	await rm(marker, { force: true });
});

test("two runs at once each have their calls answered by their own harness", async () => {
	const harnessOf = (who: string): HarnessServe => async (method, args) => `${who} ${method} ${JSON.stringify(args)}`;
	const code = 'return await roostr.spawn(input.task, "explore");';
	const [a, b] = await Promise.all([runToolCode(code, { task: "one" }, context, harnessOf("A")), runToolCode(code, { task: "two" }, context, harnessOf("B"))]);
	expect(a).toMatchObject({ ok: true, value: 'A spawn ["one","explore"]' });
	expect(b).toMatchObject({ ok: true, value: 'B spawn ["two","explore"]' });
});

test("what the harness refuses reaches the tool as an ordinary error, not a crash", async () => {
	const refusing: HarnessServe = async () => {
		throw new TypeError("shell_exec is not one of your tools");
	};
	const run = await runToolCode('return await roostr.shell("id");', {}, context, refusing);
	expect(run).toMatchObject({ ok: false, error: "shell_exec is not one of your tools", crashed: false });
});

// Real time again: the call has to outlast the child's own limit, kept in its parent's clock.
test("time the harness spends on a call doesn't count against the tool's limit", async () => {
	const slow: HarnessServe = async () => {
		await Bun.sleep(400);
		return "a subagent's result";
	};
	const run = await runToolCode('return await roostr.spawn("research", "task");', {}, context, slow, 200);
	expect(run).toMatchObject({ ok: true, value: "a subagent's result" });
});

test("a call still running when its run ends is stopped with the run", async () => {
	let stopped: AbortSignal | undefined;
	const lingering: HarnessServe = async (method, _args, signal) => {
		if (method !== "shell") return "left";
		stopped = signal;
		const { promise, resolve } = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => resolve());
		await promise;
		return "too late";
	};
	// Calls arrive in order: the spawn answered means the shell call is with the harness.
	const run = await runToolCode('void roostr.shell("sleep 60"); return await roostr.spawn("x", "task");', {}, context, lingering);
	expect(run).toMatchObject({ ok: true, value: "left" });
	expect(stopped?.aborted).toBe(true);
});
