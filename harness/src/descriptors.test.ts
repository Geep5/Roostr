/**
 * What the catalogs turn into, and the one rule that matters: a descriptor
 * says what a thing IS, never what its secret is.
 *
 * Pure shape checks over the real catalogs - no daemon, no network - so a new
 * credential entry that forgets `secret: true`, or a skill that leaks a
 * password field into its card, fails here.
 */

import { expect, test } from "bun:test";
import { catalogDescriptors } from "./descriptors";
import { CREDENTIALS } from "./credentials";
import { CATALOG } from "./skillmgr";

const AUTHOR = "npub1fcppsmdf84swh33vqwklscppskw5j8tcu280n27ejlz53lvl5xcqxj0vl2";
const cards = catalogDescriptors(AUTHOR);
const byKey = new Map(cards.map((c) => [c.key, c]));

test("every catalog entry becomes exactly one card", () => {
	expect(cards.length).toBe(CATALOG.length + CREDENTIALS.length);
	expect(new Set(cards.map((c) => c.key)).size).toBe(cards.length);
	for (const c of cards) {
		expect(c.author).toBe(AUTHOR);
		expect(c.name.length).toBeGreaterThan(0);
		expect(c.description.length).toBeGreaterThan(0);
	}
});

test("an integration card is a form: labels, and which inputs are secret", () => {
	const x = byKey.get("x");
	expect(x?.kind).toBe("integration");
	// X offers both ways in: a logged-in Chrome profile, or API app keys.
	expect(x?.auths).toEqual(["browser_profile", "api_key"]);
	expect(x?.fields.map((f) => f.key)).toEqual(["apiKey", "apiSecret", "accessToken", "accessTokenSecret"]);
	const secret = x?.fields.filter((f) => f.secret).map((f) => f.key);
	expect(secret).toEqual(["apiSecret", "accessTokenSecret"]);
	// A secret field is a password box - the client needs no table of its own.
	for (const f of x?.fields ?? []) expect(f.format).toBe(f.secret ? "password" : "text");
	expect(x?.install?.docsUrl).toBe("https://x.com/login");
});

test("a skill card carries its check and install work, and asks for nothing", () => {
	const browserless = byKey.get("browserless");
	expect(browserless?.kind).toBe("skill");
	// The human label travels as data; the key stays the command name. The
	// website used to keep its own copy of this string.
	expect(browserless?.name).toBe("Headless Chrome");
	expect(byKey.get("google")?.name).toBe("Google Workspace");
	// A tool on PATH has no login: no fields, and nothing to authenticate.
	expect(browserless?.fields).toEqual([]);
	expect(browserless?.auths).toEqual(["none"]);
	expect(browserless?.check?.command).toBe(CATALOG.find((c) => c.key === "browserless")?.checkCmd);
	expect((browserless?.install?.prompt ?? "").length).toBeGreaterThan(0);
});

test("no card can carry a secret value", () => {
	// The schema has no field for one; this pins the PROJECTION, so a future
	// edit cannot start copying `credentials.json` into the DAG. A substring
	// scan would be wrong - the browserless install prompt says the word
	// "password" on purpose ("nothing can type it, so the install would
	// hang") - so walk the keys instead.
	const forbidden = /^(value|values|secretValue|token|cookie|credentials?)$/i;
	const walk = (node: unknown, path: string): void => {
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, `${path}[${i}]`));
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const [key, child] of Object.entries(node)) {
			expect(forbidden.test(key), `${path}.${key} could hold a secret`).toBe(false);
			walk(child, `${path}.${key}`);
		}
	};
	walk(cards, "cards");
	// A FieldSpec is exactly a form description: nowhere to put a value.
	for (const c of cards) {
		for (const f of c.fields) {
			expect(Object.keys(f).sort()).toEqual(["format", "key", "label", "note", "secret"]);
		}
	}
});

test("a credential with only a browser login offers only that", () => {
	// google authenticates through a local config dir, not pasted fields.
	const google = byKey.get("google");
	if (!google) return; // catalog may drop it; the rule still holds for the rest
	expect(google.fields.length === 0 || google.auths.includes("api_key")).toBe(true);
});
