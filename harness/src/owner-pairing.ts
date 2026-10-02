/**
 * Pairing a hosted Roostr tab (roostr.space) with this computer by proof of
 * ownership instead of a terminal code. The tab already holds the vault owner
 * key every device shares (it signs the vault's changes), so:
 *
 * 1. GET /pair/challenge from a session origin: a random one-use challenge,
 *    bound to that Origin, valid for a minute.
 * 2. The tab signs a NIP-98-shaped event (kind 27235) naming this endpoint,
 *    POST, the challenge and its origin.
 * 3. POST /pair/owner: the signature must verify, its pubkey must be this
 *    computer's own identity, and every tag must match the request. The
 *    challenge is spent whatever the outcome.
 *
 * Only then does the harness ask the daemon (service token) for the usual
 * origin-bound UI session. A page that cannot sign as the owner gets nothing;
 * a valid signature cannot be replayed (one-use, short-lived, bound to origin
 * and endpoint) nor reused from another nostr context (dedicated kind + tags).
 */

import { verifyEvent, type Event } from "nostr-tools";

export const OWNER_PAIR_KIND = 27235;
const CHALLENGE_TTL_MS = 60_000;
/** Outstanding challenges kept at once; enough for every open tab, too few to hoard. */
const MAX_CHALLENGES = 32;
/** Verified-or-not pairing attempts allowed per minute. */
const MAX_ATTEMPTS = 10;
/** How far the event's own clock may sit from ours. */
const MAX_SKEW_S = 120;

function tag(event: Event, name: string): string | undefined {
	return event.tags.find((t) => t[0] === name)?.[1];
}

function isEvent(value: unknown): value is Event {
	return typeof value === "object" && value !== null
		&& "id" in value && typeof value.id === "string" && "pubkey" in value && typeof value.pubkey === "string"
		&& "sig" in value && typeof value.sig === "string" && "content" in value && typeof value.content === "string"
		&& "kind" in value && typeof value.kind === "number" && "created_at" in value && typeof value.created_at === "number"
		&& "tags" in value && Array.isArray(value.tags) && value.tags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"));
}

export class OwnerPairing {
	private challenges = new Map<string, { origin: string; expiresAt: number }>();
	private window = 0;
	private attempts = 0;

	/** A fresh challenge for `origin`, or null when too many are outstanding. */
	issue(origin: string, now: number): { challenge: string; expiresAt: number } | null {
		for (const [key, c] of this.challenges) if (c.expiresAt <= now) this.challenges.delete(key);
		if (this.challenges.size >= MAX_CHALLENGES) return null;
		const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		const expiresAt = now + CHALLENGE_TTL_MS;
		this.challenges.set(challenge, { origin, expiresAt });
		return { challenge, expiresAt };
	}

	/**
	 * Check a signed answer arriving from `origin` at `url` against the owner
	 * pubkey. Returns why it is refused, or "" when it proves ownership.
	 */
	verify(event: unknown, origin: string, url: string, ownerPubkey: string, now: number): string {
		if (now - this.window >= 60_000) {
			this.window = now;
			this.attempts = 0;
		}
		if (++this.attempts > MAX_ATTEMPTS) return "Too many pairing attempts; wait a minute.";
		if (!isEvent(event)) return "Not a signed pairing event.";
		const challenge = tag(event, "challenge") ?? "";
		const issued = this.challenges.get(challenge);
		this.challenges.delete(challenge);
		if (!issued || issued.expiresAt <= now || issued.origin !== origin) return "The pairing challenge expired or was not issued to this page.";
		if (event.kind !== OWNER_PAIR_KIND || tag(event, "origin") !== origin || tag(event, "u") !== url || tag(event, "method") !== "POST") {
			return "The pairing event does not match this request.";
		}
		if (Math.abs(event.created_at - now / 1000) > MAX_SKEW_S) return "The pairing event is too old.";
		if (!verifyEvent(event)) return "The pairing signature is invalid.";
		if (!ownerPubkey || event.pubkey !== ownerPubkey) return "This browser is signed in with a different key than the Roostr on this computer.";
		return "";
	}
}
