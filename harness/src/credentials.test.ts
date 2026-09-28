import { expect, test } from "bun:test";
import { credentialKeys, serviceCookies, sessionSignedIn } from "./credentials";
import type { SessionCookie } from "./browser";

const cookie = (name: string, domain: string, expires = Date.now() / 1000 + 3600): SessionCookie => ({ name, value: "v", domain, path: "/", expires, httpOnly: true, secure: true });

test("only the service's unexpired session cookie counts as signed in", () => {
	expect(sessionSignedIn([cookie("gt", ".x.com")], "x")).toBe(false); // guest cookie from a first visit
	expect(sessionSignedIn([cookie("auth_token", ".x.com", Date.now() / 1000 - 60)], "x")).toBe(false);
	expect(sessionSignedIn([cookie("auth_token", ".x.com")], "x")).toBe(true);
	expect(sessionSignedIn([cookie("auth_token", ".evil.com")], "x")).toBe(false);
	expect(sessionSignedIn([cookie("li_at", ".linkedin.com", -1)], "linkedin")).toBe(true); // session cookie, no expiry
	expect(sessionSignedIn([cookie("token", ".discord.com")], "discord-bot")).toBe(false); // keys-only service
});

test("a sign-in keeps only the service's own cookies", () => {
	const kept = serviceCookies([cookie("auth_token", ".x.com"), cookie("SID", ".google.com"), cookie("ct0", "x.com")], "x");
	expect(kept.map((c) => c.name)).toEqual(["auth_token", "ct0"]);
});

test("keys count only when every field the service asks for is filled", () => {
	const fields = (secret: string) => ({ service: { stringValue: "x" }, secret: { stringValue: secret } });
	expect(credentialKeys(fields(JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c" })))).toBeNull();
	expect(credentialKeys(fields(JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: " " })))).toBeNull();
	expect(credentialKeys(fields("not json"))).toBeNull();
	expect(credentialKeys(fields(JSON.stringify({ apiKey: " a ", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" })))).toEqual({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" });
});
