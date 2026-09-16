import { afterEach, expect, test } from "bun:test";
import { resetScheduler } from "./schedule";
import { authRequirementsOf, parseAuthRequirement } from "./authreq";
resetScheduler();

afterEach(() => {
	resetScheduler();
});

test("requires_auth parses service and service:account selectors", () => {
	expect(parseAuthRequirement("x")).toEqual({ service: "x", raw: "x" });
	expect(parseAuthRequirement("google:support@matcherino.com")).toEqual({ service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com" });
	expect(parseAuthRequirement(" google:bad ")).toEqual({ service: "google", account: "bad", raw: " google:bad " });
	expect(parseAuthRequirement(":")).toBeNull();
});

test("object auth fields prefer requires_auth and map service/account shorthand", () => {
	expect(
		authRequirementsOf({
			requires_auth: { valuesValue: { items: [{ stringValue: "x" }, { stringValue: "google:support@matcherino.com" }] } },
			service: { stringValue: "matcherino" },
		}).map((r) => r.raw),
	).toEqual(["x", "google:support@matcherino.com"]);
	expect(authRequirementsOf({ service: { stringValue: "google" }, google_account: { stringValue: "support@matcherino.com" } })).toEqual([
		{ service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com" },
	]);
});
