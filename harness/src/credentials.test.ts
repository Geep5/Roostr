import { expect, test } from "bun:test";
import type { ValueJSON } from "./api";
import { actionsOf, credentialKeys, legacyKeyName, recipeHash, recipeMissing, recipeOf, seedFor, seedRecipeFields, recipeFieldKeys, serviceCookies, sessionSignedIn } from "./credentials";
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

test("keys count only when every key field the credential carries is filled", () => {
	const x = (keys: Record<string, string>) => ({ ...seeded("x"), ...Object.fromEntries(Object.entries(keys).map(([k, v]) => [`key_${k}`, { stringValue: v }])) });
	// Seeded empty: nothing to use yet.
	expect(credentialKeys(seeded("x"))).toBeNull();
	expect(credentialKeys(x({ api_key: "a", api_secret: "b", access_token: "c" }))).toBeNull();
	expect(credentialKeys(x({ api_key: "a", api_secret: "b", access_token: "c", access_token_secret: " " }))).toBeNull();
	expect(credentialKeys(x({ api_key: " a ", api_secret: "b", access_token: "c", access_token_secret: "d" }))).toEqual({ api_key: "a", api_secret: "b", access_token: "c", access_token_secret: "d" });
	// A browser-only credential has no keys at all.
	expect(credentialKeys(seeded("linkedin"))).toBeNull();
	// A property someone added named "Key: App ID" is a key like any other.
	expect(credentialKeys({ ...seeded("discord-bot"), key_token: { stringValue: "t" }, key_app_id: { stringValue: "" } })).toBeNull();
	expect(credentialKeys({ ...seeded("discord-bot"), key_token: { stringValue: "t" }, key_app_id: { stringValue: "42" } })).toEqual({ token: "t", app_id: "42" });
	// The pre-property key list shares the prefix but is not a key.
	const legacyList = { valuesValue: { items: [{ mapValue: { entries: { key: { stringValue: "token" } } } }] } };
	expect(credentialKeys({ ...seeded("discord-bot"), key_token: { stringValue: "t" }, key_fields: legacyList })).toEqual({ token: "t" });
});

test("a seed's recipe survives the trip through fields", () => {
	const x = recipe("x");
	expect(x.service).toBe("x");
	expect(x.loginUrl).toBe("https://x.com/login");
	expect(x.passwordFields.map((f) => f.key)).toEqual(["api_key", "api_secret", "access_token", "access_token_secret"]);
	expect(recipe("discord-bot").passwordFields.map((f) => f.key)).toEqual(["token"]);
	// Keys stored before they were properties map onto the property names.
	expect(["apiKey", "accessTokenSecret", "token"].map(legacyKeyName)).toEqual(["api_key", "access_token_secret", "token"]);
});

test("recipe fingerprint tracks only the recipe", () => {
	const base = recipeHash(seeded("x"));
	expect(recipeHash({ ...seeded("x"), name: { stringValue: "My X" }, account: { stringValue: "@me" } })).toBe(base);
	expect(recipeHash({ ...seeded("x"), login_url: { stringValue: "https://x.com/i/flow/login" } })).not.toBe(base);
	expect(recipeMissing({ service: { stringValue: "x" } })).toBe(true);
	expect(recipeMissing(seeded("discord-bot"))).toBe(false);
});

test("a credential's actions are its service's", () => {
	const x = actionsOf(seeded("x"));
	expect(x.map((a) => a.key)).toEqual(["read_mentions", "retweet_post"]);
	expect(x[1].access).toBe("write");
	expect(actionsOf(seeded("matcherino")).map((a) => a.key)).toEqual(["list_featured", "feature_events"]);
	expect(actionsOf(seeded("discord-bot"))).toEqual([]);
	// Actions are code, never fields on the object.
	expect(Object.keys(seeded("matcherino")).some((k) => k.startsWith("action"))).toBe(false);
});
