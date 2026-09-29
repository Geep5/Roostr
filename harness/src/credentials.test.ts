import { expect, test } from "bun:test";
import type { ValueJSON } from "./api";
import { credentialKeys, recipeHash, recipeMissing, recipeOf, seedFor, seedRecipeFields, serviceCookies, sessionSignedIn } from "./credentials";
import type { SessionCookie } from "./browser";

const cookie = (name: string, domain: string, expires = Date.now() / 1000 + 3600): SessionCookie => ({ name, value: "v", domain, path: "/", expires, httpOnly: true, secure: true });
/** A credential's recipe exactly as its fields carry it, seeded from the preset. */
const seeded = (key: string): Record<string, ValueJSON> => seedRecipeFields(seedFor(key)!);
const recipe = (key: string) => recipeOf(seeded(key));

test("only the recipe's unexpired session cookie counts as signed in", () => {
	expect(sessionSignedIn([cookie("gt", ".x.com")], recipe("x"))).toBe(false); // guest cookie from a first visit
	expect(sessionSignedIn([cookie("auth_token", ".x.com", Date.now() / 1000 - 60)], recipe("x"))).toBe(false);
	expect(sessionSignedIn([cookie("auth_token", ".x.com")], recipe("x"))).toBe(true);
	expect(sessionSignedIn([cookie("auth_token", ".evil.com")], recipe("x"))).toBe(false);
	expect(sessionSignedIn([cookie("li_at", ".linkedin.com", -1)], recipe("linkedin"))).toBe(true); // session cookie, no expiry
	expect(sessionSignedIn([cookie("token", ".discord.com")], recipe("discord-bot"))).toBe(false); // keys-only credential
});

test("a sign-in keeps only the recipe's own cookies", () => {
	const kept = serviceCookies([cookie("auth_token", ".x.com"), cookie("SID", ".google.com"), cookie("ct0", "x.com")], recipe("x"));
	expect(kept.map((c) => c.name)).toEqual(["auth_token", "ct0"]);
});

test("a browser sign-in needs both the host and the cookie name", () => {
	expect(recipeOf({ login_url: { stringValue: "https://a.test/login" }, session_host: { stringValue: "a.test" } }).sessionCookie).toBeUndefined();
	expect(recipeOf({ session_host: { stringValue: " a.test " }, session_cookie: { stringValue: "sid" } }).sessionCookie).toEqual({ host: "a.test", name: "sid" });
});

test("keys count only when every key field the credential lists is filled", () => {
	const fields = (secret: string) => ({ ...seeded("x"), secret: { stringValue: secret } });
	expect(credentialKeys(fields(JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c" })))).toBeNull();
	expect(credentialKeys(fields(JSON.stringify({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: " " })))).toBeNull();
	expect(credentialKeys(fields("not json"))).toBeNull();
	expect(credentialKeys(fields(JSON.stringify({ apiKey: " a ", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" })))).toEqual({ apiKey: "a", apiSecret: "b", accessToken: "c", accessTokenSecret: "d" });
	// A credential without key fields has no keys, whatever `secret` holds.
	expect(credentialKeys({ ...seeded("linkedin"), secret: { stringValue: JSON.stringify({ apiKey: "a" }) } })).toBeNull();
});

test("a seed's recipe survives the trip through fields, secret flags included", () => {
	const x = recipe("x");
	expect(x.service).toBe("x");
	expect(x.loginUrl).toBe("https://x.com/login");
	expect(x.passwordFields.filter((f) => f.secret).map((f) => f.key)).toEqual(["apiSecret", "accessTokenSecret"]);
	expect(recipe("discord-bot").passwordFields).toEqual([{ key: "token", label: "Bot token", secret: true }]);
	// A key field with no stated secret flag is treated as secret.
	expect(recipeOf({ key_fields: { valuesValue: { items: [{ mapValue: { entries: { key: { stringValue: "k" } } } }] } } }).passwordFields).toEqual([{ key: "k", label: "k", secret: true }]);
});

test("recipe fingerprint tracks only the recipe", () => {
	const base = recipeHash(seeded("x"));
	expect(recipeHash({ ...seeded("x"), name: { stringValue: "My X" }, account: { stringValue: "@me" } })).toBe(base);
	expect(recipeHash({ ...seeded("x"), login_url: { stringValue: "https://x.com/i/flow/login" } })).not.toBe(base);
	expect(recipeMissing({ service: { stringValue: "x" } })).toBe(true);
	expect(recipeMissing(seeded("discord-bot"))).toBe(false);
});
