import { expect, test } from "bun:test";
import type { ValueJSON } from "./api";
import { actionsOf, COOKIE_META, cookieFieldKey, credentialKeys, credentialSession, hideCredentialSecrets, legacyKeyName, recipeHash, recipeMissing, recipeOf, seedFor, seedRecipeFields, recipeFieldKeys, serviceCookies, sessionAccepted, sessionDecision, sessionFields, sessionHash, sessionMeta, sessionSignedIn } from "./credentials";
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
	expect(actionsOf(seeded("discord-bot"))).toEqual([]);
	// Actions are code, never fields on the object.
	expect(Object.keys(seeded("x")).some((k) => k.startsWith("action"))).toBe(false);
});

// ── A sign-in's cookies as properties ──

const xCookies: SessionCookie[] = [
	{ name: "auth_token", value: "tok-1", domain: ".x.com", path: "/", expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: "None" },
	{ name: "ct0", value: "csrf-1", domain: ".x.com", path: "/", expires: -1, httpOnly: false, secure: true },
	{ name: "Twid", value: "u=1", domain: "x.com", path: "/i", expires: 2_000_000_000, httpOnly: false, secure: false },
];

test("a sign-in's cookies become one cookie_<name> property each, plus cookie_meta", () => {
	const fields = sessionFields(xCookies, "mac-a", 123);
	expect(Object.keys(fields).sort()).toEqual(["cookie_auth_token", "cookie_ct0", COOKIE_META, "cookie_twid"].sort());
	expect(fields.cookie_auth_token).toEqual({ stringValue: "tok-1" });
	expect(fields.cookie_twid).toEqual({ stringValue: "u=1" });
	const meta = sessionMeta(fields)!;
	expect(meta.signedInOn).toBe("mac-a");
	expect(meta.at).toBe(123);
	// The meta describes each cookie but never holds a value.
	expect(meta.cookies[0]).toEqual({ key: "cookie_auth_token", name: "auth_token", domain: ".x.com", path: "/", secure: true, httpOnly: true, expires: 2_000_000_000, sameSite: "None" });
	expect(fields[COOKIE_META].stringValue).not.toContain("tok-1");
	// And they come back exactly as they were captured.
	expect(credentialSession(fields)).toEqual(xCookies);
	expect(sessionSignedIn(credentialSession(fields), recipe("x"))).toBe(true);
});

test("cookie property keys are sanitized and never collide", () => {
	const taken = new Set([COOKIE_META]);
	expect(cookieFieldKey("__Secure-next-auth.session-token", taken)).toBe("cookie_secure_next_auth_session_token");
	expect(cookieFieldKey("meta", taken)).toBe("cookie_meta_2");
	expect(cookieFieldKey("***", new Set())).toBe("cookie_cookie");
	const fields = sessionFields([{ ...xCookies[0], name: "SID", value: "a" }, { ...xCookies[0], name: "sid", value: "b", domain: ".accounts.x.com" }], "m");
	expect(fields.cookie_sid.stringValue).toBe("a");
	expect(fields.cookie_sid_2.stringValue).toBe("b");
	expect(credentialSession(fields).map((c) => `${c.name}=${c.value}`)).toEqual(["SID=a", "sid=b"]);
});

test("a cookie whose value property was removed is left out; no meta means no session", () => {
	const { cookie_ct0: _, ...fields } = sessionFields(xCookies, "m");
	expect(credentialSession(fields).map((c) => c.name)).toEqual(["auth_token", "Twid"]);
	expect(credentialSession({ cookie_auth_token: { stringValue: "tok" } })).toEqual([]);
	expect(credentialSession({ [COOKIE_META]: { stringValue: "not json" } })).toEqual([]);
});

test("cookie values read [secret] to tools; cookie_meta stays readable", () => {
	const shown = hideCredentialSecrets({ typeKey: "credential", fields: sessionFields(xCookies, "m") });
	expect(shown.fields.cookie_auth_token).toEqual({ stringValue: "[secret]" });
	expect(shown.fields[COOKIE_META].stringValue).toContain("auth_token");
});

test("the serving computer tries cookies signed in elsewhere once, and remembers the answer", () => {
	const here = sessionFields(xCookies, "serving");
	const elsewhere = sessionFields(xCookies, "laptop");
	expect(sessionDecision({}, "serving", undefined)).toBe("none");
	// Made here: used as they are.
	expect(sessionDecision(here, "serving", undefined)).toBe("use");
	// Made on another computer and never tried here: try them.
	expect(sessionDecision(elsewhere, "serving", undefined)).toBe("check");
	// Tried: the answer stands while the cookies are the same ones.
	expect(sessionDecision(elsewhere, "serving", { hash: sessionHash(elsewhere), accepted: true })).toBe("use");
	expect(sessionDecision(elsewhere, "serving", { hash: sessionHash(elsewhere), accepted: false })).toBe("rejected");
	// A newer sign-in (other values) is tried again.
	const newer = sessionFields([{ ...xCookies[0], value: "tok-2" }, ...xCookies.slice(1)], "laptop");
	expect(sessionHash(newer)).not.toBe(sessionHash(elsewhere));
	expect(sessionDecision(newer, "serving", { hash: sessionHash(elsewhere), accepted: false })).toBe("check");
	// Cookies from before sign-ins named a computer count as this one's.
	expect(sessionDecision(sessionFields(xCookies, ""), "serving", undefined)).toBe("use");
});

test("a site kept the login unless it sent the page to a login wall or cleared the session cookie", () => {
	const page = (url: string, arrived: boolean, cookies: SessionCookie[]) => ({ url, title: "", arrived, cookies });
	expect(sessionAccepted(page("https://x.com/home", false, xCookies), recipe("x"))).toBe(true);
	expect(sessionAccepted(page("https://x.com/i/flow/login", false, xCookies), recipe("x"))).toBe(false);
	expect(sessionAccepted(page("https://x.com/", true, xCookies.slice(1)), recipe("x"))).toBe(false);
});
