import { afterEach, expect, test } from "bun:test";
import { resetScheduler } from "./schedule";
import { authContractPrompt, authRequirementsOf, localAuthRegistry, parseAuthRequirement, validateAuthSelector, type AuthIdentity } from "./authreq";
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

const REGISTRY: AuthIdentity[] = [
	{ selector: "x", service: "x", raw: "x", active: false, reason: "x is not set up on this machine" },
	{ selector: "google:support@matcherino.com", service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com", active: true, reason: "google account support@matcherino.com active (oauth2)" },
];

test("selector validation refuses guesses the machine cannot fulfil", () => {
	expect(validateAuthSelector("x", REGISTRY)).toEqual({ requirement: { service: "x", raw: "x" } });
	expect(validateAuthSelector("google", REGISTRY)).toEqual({ error: "google needs an account selector, e.g. google:support@matcherino.com" });
	expect(validateAuthSelector("google:nobody@example.com", REGISTRY)).toEqual({
		error: 'google account "nobody@example.com" is not configured here; configured: support@matcherino.com',
	});
	expect(validateAuthSelector("x:someone", REGISTRY)).toEqual({ error: "x does not take an account selector" });
	expect(validateAuthSelector("gws:support@matcherino.com", REGISTRY)).toEqual({
		error: 'unknown auth service "gws"; this machine knows google, x',
	});
});

test("the contract prompt teaches the vocabulary even with nothing declared", () => {
	const text = authContractPrompt(REGISTRY, []);
	expect(text).toContain("requires_auth (list)");
	expect(text).toContain("browserless (checkbox)");
	expect(text).toContain("external_action (checkbox)");
	expect(text).toContain("- google:support@matcherino.com: active");
	expect(text).toContain("- x: needs setup");
	expect(text).toContain("object_set_auth");
	expect(text).toContain("declares no auth requirements yet");
});

test("this machine's registry lists browserless and every configured google account", async () => {
	const registry = await localAuthRegistry();
	expect(registry.some((r) => r.selector === "browserless")).toBe(true);
	expect(registry.some((r) => r.selector === "google:support@matcherino.com" && r.active)).toBe(true);
});
