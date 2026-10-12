import { describe, expect, test } from "bun:test";
import { iv, sv, type ValueJSON } from "./api";
import { CHECK_REQUEST_KEY, pendingCheck, refreshPlan } from "./credential-objects";

const fields = (checkedAt: number | undefined, requested: number | undefined): Record<string, ValueJSON> => ({
	status: sv("active"),
	...(checkedAt !== undefined ? { checked_at: iv(checkedAt) } : {}),
	...(requested !== undefined ? { [CHECK_REQUEST_KEY]: iv(requested) } : {}),
});

describe("Check asked for from any device", () => {
	const now = 1_800_000_000_000;

	test("a request newer than checked_at is pending; none, or an answered one, is not", () => {
		expect(pendingCheck(fields(now - 10_000, now))).toBe(now);
		expect(pendingCheck(fields(undefined, now))).toBe(now);
		expect(pendingCheck(fields(now, now - 1))).toBe(0);
		expect(pendingCheck(fields(now, now))).toBe(0);
		expect(pendingCheck(fields(now, undefined))).toBe(0);
	});

	test("a pending request runs the forced check once: the stamp it writes answers it", () => {
		expect(refreshPlan(fields(now - 60_000, now), "active", false, 0, now)).toBe("check");
		// The check stamped checked_at after the request: the next refresh is the quiet one.
		expect(refreshPlan(fields(now + 2_000, now), "active", false, 0, now + 3_000)).toBe("refresh");
	});

	test("an old request is ignored", () => {
		expect(refreshPlan(fields(now, now - 3_600_000), "needs_auth", false, 0, now)).toBe("refresh");
	});

	test("a request from a device whose clock runs ahead is answered once, not on every refresh", () => {
		const ahead = now + 5 * 60_000;
		expect(refreshPlan(fields(now, ahead), "active", false, 0, now)).toBe("check");
		// Answered (checked_at stamped by this computer's clock, still before the request): no second check.
		expect(refreshPlan(fields(now + 1_000, ahead), "active", false, ahead, now + 2_000)).toBe("refresh");
		expect(pendingCheck(fields(now + 1_000, ahead), ahead)).toBe(0);
		// A newer press is a new request.
		expect(refreshPlan(fields(now + 1_000, ahead + 1), "active", false, ahead, now + 2_000)).toBe("check");
	});

	test("a request during another computer's sign-in is honored; without one that sign-in is left alone", () => {
		const started = now - 60_000;
		expect(refreshPlan(fields(started, undefined), "connecting", false, 0, now)).toBe("leave");
		expect(refreshPlan(fields(started, started - 1_000), "connecting", false, 0, now)).toBe("leave");
		expect(refreshPlan(fields(started, now), "connecting", false, 0, now)).toBe("check");
	});

	test("a sign-in running here keeps its window: a request is answered with its status, else left alone", () => {
		expect(refreshPlan(fields(now - 60_000, now), "connecting", true, 0, now)).toBe("answer");
		expect(refreshPlan(fields(now - 60_000, undefined), "connecting", true, 0, now)).toBe("leave");
	});

	test("a stale `connecting` (sign-in gone for good) is refreshed again", () => {
		expect(refreshPlan(fields(now - 16 * 60_000, undefined), "connecting", false, 0, now)).toBe("refresh");
	});
});
