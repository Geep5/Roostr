import { describe, expect, test } from "bun:test";
import { iv, sv, type ValueJSON } from "./api";
import type { SessionCookie } from "./browser";
import type { CredentialRow } from "./credential-objects";
import { sessionFields } from "./credentials";
import { passCookie, passNeeds, passServes, passVerdict } from "./pass";

const future = Math.floor(Date.now() / 1000) + 86_400;
const cookie = (name: string, value: string, domain = ".x.com"): SessionCookie => ({ name, value, domain, path: "/", expires: future, httpOnly: true, secure: true, sameSite: "None" });

/** An X credential with `status`, carrying `saved` as its login (delivered `at`) and answered at `checkedAt`. */
function xRow(status: CredentialRow["status"], saved: SessionCookie[] = [], at = 1_000, checkedAt = 2_000): CredentialRow {
	const fields: Record<string, ValueJSON> = {
		name: sv("X"),
		service: sv("x"),
		login_url: sv("https://x.com/login"),
		session_host: sv("x.com"),
		session_cookie: sv("auth_token"),
		status: sv(status),
		checked_at: iv(checkedAt),
		...(saved.length > 0 ? sessionFields(saved, "machine-a", at) : {}),
	};
	return { id: "cred-x", name: "X", service: "x", account: "", servedBy: "machine-b", status, auth: "", error: "", fields };
}

describe("Roostr Pass: what needs a fresh login", () => {
	test("signed out or never filled in needs one; connected doesn't", () => {
		expect(passNeeds(xRow("needs_auth", [cookie("auth_token", "old")]))).toBe(true);
		expect(passNeeds(xRow("missing"))).toBe(true);
		expect(passNeeds(xRow("active", [cookie("auth_token", "old")]))).toBe(false);
		expect(passNeeds(xRow("broken"))).toBe(false);
	});

	test("a delivered login waits for its check: no second delivery until the serving computer answers", () => {
		const delivered = xRow("needs_auth", [cookie("auth_token", "fresh")], 5_000, 2_000);
		expect(passNeeds(delivered)).toBe(false);
		expect(passVerdict(delivered, [cookie("auth_token", "other")])).toBe("waiting");
		// Answered (checked_at after the delivery) and still signed out: it needs one again.
		expect(passNeeds(xRow("needs_auth", [cookie("auth_token", "fresh")], 5_000, 6_000))).toBe(true);
	});

	test("Google and keys-only credentials aren't Roostr Pass's", () => {
		const google = { ...xRow("missing"), service: "google-account" };
		expect(passServes(google)).toBe(false);
		const keys = xRow("missing");
		delete keys.fields.session_cookie;
		expect(passServes(keys)).toBe(false);
		expect(passServes(xRow("missing"))).toBe(true);
	});
});

describe("Roostr Pass: what a delivery comes to", () => {
	const dead = [cookie("auth_token", "old"), cookie("twid", "u%3D1")];

	test("a live signed-in cookie for a signed-out credential is taken", () => {
		expect(passVerdict(xRow("needs_auth", dead), [cookie("auth_token", "new"), cookie("twid", "u%3D1")])).toBeNull();
		expect(passVerdict(xRow("missing"), [cookie("auth_token", "new")])).toBeNull();
	});

	test("the same cookies that failed are never sent again: the person signs in again", () => {
		expect(passVerdict(xRow("needs_auth", dead), [cookie("auth_token", "old"), cookie("twid", "u%3D1")])).toBe("same");
	});

	test("Chrome signed in to another X account doesn't replace the credential's", () => {
		expect(passVerdict(xRow("needs_auth", dead), [cookie("auth_token", "new"), cookie("twid", "u%3D2")])).toBe("other_account");
	});

	test("no signed-in cookie, or an expired one, is no login", () => {
		expect(passVerdict(xRow("needs_auth", dead), [cookie("gt", "guest")])).toBe("signed_out");
		expect(passVerdict(xRow("needs_auth", dead), [{ ...cookie("auth_token", "new"), expires: 1 }])).toBe("signed_out");
	});

	test("a connected credential takes nothing", () => {
		expect(passVerdict(xRow("active", dead), [cookie("auth_token", "new")])).toBe("fine");
	});
});

describe("Roostr Pass: cookies from the extension", () => {
	test("well-formed ones are kept as sent; malformed ones dropped", () => {
		expect(passCookie({ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: -1, httpOnly: true, secure: true })).toEqual({ name: "auth_token", value: "v", domain: ".x.com", path: "/", expires: -1, httpOnly: true, secure: true });
		expect(passCookie({ name: "a", value: "v", domain: ".x.com", path: "/", expires: "soon", httpOnly: true, secure: true })).toBeNull();
		expect(passCookie({ name: "a", value: "v", domain: ".x.com", path: "/", expires: 1, httpOnly: true, secure: true, sameSite: "weird" })).toBeNull();
		expect(passCookie({ name: "", value: "v", domain: ".x.com", path: "/", expires: 1, httpOnly: true, secure: true })).toBeNull();
	});
});
