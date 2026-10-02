import { expect, test } from "bun:test";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { OWNER_PAIR_KIND, OwnerPairing } from "./owner-pairing";

const ORIGIN = "https://roostr.space";
const URL_ = "http://127.0.0.1:7334/pair/owner";
const owner = generateSecretKey();
const ownerPk = getPublicKey(owner);
const NOW = 1_800_000_000_000;

/** A signed answer as it arrives: through JSON, so no verified-flag symbol rides along. */
function answer(challenge: string, overrides: { kind?: number; origin?: string; u?: string; method?: string; at?: number; key?: Uint8Array } = {}): Record<string, unknown> {
	return JSON.parse(JSON.stringify(finalizeEvent({
		kind: overrides.kind ?? OWNER_PAIR_KIND,
		created_at: Math.floor((overrides.at ?? NOW) / 1000),
		content: "",
		tags: [["u", overrides.u ?? URL_], ["method", overrides.method ?? "POST"], ["challenge", challenge], ["origin", overrides.origin ?? ORIGIN]],
	}, overrides.key ?? owner)));
}

test("an owner-signed answer to a fresh challenge pairs, once", () => {
	const pairing = new OwnerPairing();
	const { challenge, expiresAt } = pairing.issue(ORIGIN, NOW)!;
	expect(challenge).toMatch(/^[0-9a-f]{64}$/);
	expect(expiresAt).toBe(NOW + 60_000);
	const event = answer(challenge);
	expect(pairing.verify(event, ORIGIN, URL_, ownerPk, NOW + 1000)).toBe("");
	expect(pairing.verify(event, ORIGIN, URL_, ownerPk, NOW + 2000)).toContain("challenge");
});

test("another key, even with a perfect answer, is refused", () => {
	const pairing = new OwnerPairing();
	const { challenge } = pairing.issue(ORIGIN, NOW)!;
	expect(pairing.verify(answer(challenge, { key: generateSecretKey() }), ORIGIN, URL_, ownerPk, NOW)).toContain("different key");
	// No identity on this computer: nobody proves ownership.
	const second = pairing.issue(ORIGIN, NOW)!.challenge;
	expect(pairing.verify(answer(second), ORIGIN, URL_, "", NOW)).toContain("different key");
});

test("a challenge is bound to the origin it was issued to and expires", () => {
	const pairing = new OwnerPairing();
	const { challenge } = pairing.issue("http://localhost:5173", NOW)!;
	expect(pairing.verify(answer(challenge), ORIGIN, URL_, ownerPk, NOW)).toContain("challenge");
	const late = pairing.issue(ORIGIN, NOW)!.challenge;
	expect(pairing.verify(answer(late, { at: NOW + 60_000 }), ORIGIN, URL_, ownerPk, NOW + 60_000)).toContain("challenge");
	expect(pairing.verify(answer("f".repeat(64)), ORIGIN, URL_, ownerPk, NOW)).toContain("challenge");
});

test("every signed tag must match the request, and a tampered event fails its signature", () => {
	const cases: Array<[string, Parameters<typeof answer>[1]]> = [
		["kind", { kind: 22242 }],
		["origin", { origin: "https://evil.example" }],
		["u", { u: "http://127.0.0.1:7334/files" }],
		["method", { method: "GET" }],
	];
	for (const [, overrides] of cases) {
		const pairing = new OwnerPairing();
		const { challenge } = pairing.issue(ORIGIN, NOW)!;
		expect(pairing.verify(answer(challenge, overrides), ORIGIN, URL_, ownerPk, NOW)).toContain("does not match");
	}
	const stale = new OwnerPairing();
	const staleChallenge = stale.issue(ORIGIN, NOW)!.challenge;
	expect(stale.verify(answer(staleChallenge, { at: NOW - 10 * 60_000 }), ORIGIN, URL_, ownerPk, NOW)).toContain("too old");
	const tampered = new OwnerPairing();
	const tamperedChallenge = tampered.issue(ORIGIN, NOW)!.challenge;
	const event = answer(tamperedChallenge);
	expect(tampered.verify({ ...event, content: "x" }, ORIGIN, URL_, ownerPk, NOW)).toContain("signature");
	expect(tampered.verify({ kind: OWNER_PAIR_KIND, tags: "nope" }, ORIGIN, URL_, ownerPk, NOW)).toContain("Not a signed");
});

test("outstanding challenges and attempts are capped", () => {
	const pairing = new OwnerPairing();
	for (let i = 0; i < 32; i++) expect(pairing.issue(ORIGIN, NOW)).not.toBeNull();
	expect(pairing.issue(ORIGIN, NOW)).toBeNull();
	// Expired ones make room again.
	expect(pairing.issue(ORIGIN, NOW + 60_000)).not.toBeNull();
	const limited = new OwnerPairing();
	const { challenge } = limited.issue(ORIGIN, NOW)!;
	for (let i = 0; i < 10; i++) limited.verify({}, ORIGIN, URL_, ownerPk, NOW);
	expect(limited.verify(answer(challenge), ORIGIN, URL_, ownerPk, NOW)).toContain("Too many");
	expect(limited.verify(answer(limited.issue(ORIGIN, NOW + 60_000)!.challenge, { at: NOW + 60_000 }), ORIGIN, URL_, ownerPk, NOW + 60_000)).toBe("");
});
