/**
 * The supervisor's restart pace and crash reports (supervisor.ts): restarts
 * back off while a program keeps dying and start over once it stays up; a
 * crash loop is one Error with a count; clearing the Error starts the count
 * over; an Error someone else wrote is never overwritten.
 */

import { describe, expect, test } from "bun:test";
import { CRASH_RE, nextDelay, reportPlan, type Crash, type Crashes } from "./supervisor";

const crash = (label: string, at: number, exit = "exit code 1", tail: string[] = []): Crash => ({ label, count: 1, first: at, last: at, exit, tail });
const one = (c: Crash): Crashes => new Map([[c.label, c]]);

describe("nextDelay", () => {
	test("doubles from 1 s while a program keeps dying, capped at a minute", () => {
		const delays: number[] = [];
		let delay = 0;
		for (let i = 0; i < 9; i++) delays.push((delay = nextDelay(delay, 2_000)));
		expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
	});

	test("starts over at 1 s once the program ran a minute", () => {
		expect(nextDelay(60_000, 59_999)).toBe(60_000);
		expect(nextDelay(60_000, 60_000)).toBe(1_000);
	});
});

describe("reportPlan", () => {
	const t0 = Date.UTC(2026, 9, 6, 22, 2);

	test("a first crash is written at once, naming the program, how it ended and its last output", () => {
		const plan = reportPlan("", "", new Map(), one(crash("Sync", t0, "exit code 1", ["a", "b", "c", "TypeError: boom"])));
		expect(plan?.urgent).toBe(true);
		expect(plan?.text).toMatch(CRASH_RE);
		expect(plan?.text).toContain("Sync crashed");
		expect(plan?.text).toContain("(exit code 1) and was restarted");
		expect(plan?.text).toContain("b\nc\nTypeError: boom");
		expect(plan?.text).not.toContain("\na\n");
	});

	test("a crash loop counts into the same Error, on the slow pace", () => {
		const first = reportPlan("", "", new Map(), one(crash("Harness", t0)))!;
		const second = reportPlan(first.text, first.text, first.shown, one(crash("Harness", t0 + 60_000, "killed by SIGKILL")))!;
		expect(second.urgent).toBe(false);
		expect(second.text).toContain("Harness crashed 2 times since");
		expect(second.text).toContain("(killed by SIGKILL)");
	});

	test("another program crashing is written at once, beside the first", () => {
		const first = reportPlan("", "", new Map(), one(crash("Harness", t0)))!;
		const plan = reportPlan(first.text, first.text, first.shown, one(crash("Store", t0 + 5_000)))!;
		expect(plan.urgent).toBe(true);
		expect(plan.text.indexOf("Harness crashed")).toBeLessThan(plan.text.indexOf("Store crashed"));
	});

	test("clearing the Error starts the count over", () => {
		const first = reportPlan("", "", new Map(), one(crash("Sync", t0)))!;
		const plan = reportPlan("", first.text, first.shown, one(crash("Sync", t0 + 60_000)))!;
		expect(plan.urgent).toBe(true);
		expect(plan.text).toContain("and was restarted");
		expect(plan.text).not.toContain("2 times");
	});

	test("an Error someone else wrote is left alone; a report from an earlier run is replaced", () => {
		expect(reportPlan("Fan is loud, check it", "", new Map(), one(crash("Sync", t0)))).toBeNull();
		const old = reportPlan("", "", new Map(), one(crash("Store", t0)))!.text;
		const plan = reportPlan(old, "", new Map(), one(crash("Sync", t0 + 60_000)))!;
		expect(plan.text).not.toContain("Store crashed");
		expect(plan.text).toContain("Sync crashed");
	});

	test("nothing new, nothing written", () => {
		expect(reportPlan("", "", new Map(), new Map())).toBeNull();
	});
});
