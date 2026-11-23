/**
 * Roostr Pass: browser sign-ins come from the person's own Chrome.
 *
 * The Roostr Pass extension (roostr-pass/) talks to this computer through
 * `glon-odin` in its Chrome native-host mode, which forwards to the two
 * service-only routes here (authserver.ts):
 *
 * - GET  /pass/watch: every browser-login Credential (a login page and a
 *   signed-in cookie; not Google), and whether it needs a fresh login now -
 *   signed out or never filled in, with no delivered login still waiting
 *   for its check. Nothing secret is in it.
 * - POST /pass/cookies {id, cookies}: a fresh login for one that needs it,
 *   saved on the credential (saveSession) naming this computer. The
 *   computer serving it then tries it like any login made elsewhere and
 *   writes Connected or signed out; a blocked run retries once it is
 *   Connected (schedule.ts retryUnblockedRuns).
 *
 * The status a failing run or check leaves is the request: nothing is sent
 * unless a credential needs it, the same cookies never twice, and the first
 * computer to deliver wins (the delivery waits for its check).
 */

import { queryAll, str } from "./api";
import type { SessionCookie } from "./browser";
import { CREDENTIAL_TYPE, credentialObject, credentialRowOf, saveSession, type CredentialRow } from "./credential-objects";
import { credentialSession, deliveryWaiting, recipeOf, serviceCookies, sessionSignedIn } from "./credentials";
import { GOOGLE_SERVICE } from "./google-credentials";
import { machineId } from "./roster";

/** One credential as Roostr Pass sees it. */
export interface PassLogin {
	id: string;
	name: string;
	account: string;
	loginUrl: string;
	/** The signed-in cookie: its site and name. */
	host: string;
	cookie: string;
	/** A fresh login is wanted now. */
	needs: boolean;
	/** A delivered login waits for the computer serving it to try it. */
	waiting: boolean;
	/** Why it is signed out, as the credential says. */
	error: string;
}

/** What a delivery came to. */
export type PassAnswer =
	| "saved" // on the credential; the computer serving it tries it next
	| "fine" // it needs nothing
	| "waiting" // another delivery waits for its check
	| "signed_out" // Chrome has no live signed-in cookie for the site
	| "same" // the cookies it already has (and that failed): sign in again
	| "other_account"; // Chrome is signed in to another account of the site

/**
 * The cookie naming the signed-in account, on sites that have one: a
 * delivery whose account differs from the one saved is refused, so a second
 * account in Chrome never replaces the credential's.
 */
const ACCOUNT_COOKIES: Record<string, string> = { "x.com": "twid" };

/** A browser login Roostr Pass serves: a login page and a signed-in cookie (Google signs in its own way). */
export function passServes(row: CredentialRow): boolean {
	const recipe = recipeOf(row.fields);
	return row.service !== GOOGLE_SERVICE && !!recipe.loginUrl && !!recipe.sessionCookie;
}

/** Wants a fresh login: signed out or never filled in, with none waiting for its check. */
export function passNeeds(row: CredentialRow): boolean {
	return (row.status === "missing" || row.status === "needs_auth" || row.status === "") && !deliveryWaiting(row.fields);
}

export function passLogin(row: CredentialRow): PassLogin {
	const cookie = recipeOf(row.fields).sessionCookie!;
	return {
		id: row.id,
		name: row.name,
		account: row.account,
		loginUrl: recipeOf(row.fields).loginUrl,
		host: cookie.host,
		cookie: cookie.name,
		needs: passNeeds(row),
		waiting: deliveryWaiting(row.fields),
		error: row.error,
	};
}

/** Every browser login of the person's spaces, for the extension. */
export async function passWatch(): Promise<PassLogin[]> {
	const rows = await Promise.all((await queryAll({ type: CREDENTIAL_TYPE })).map(credentialRowOf));
	return rows.filter(passServes).map(passLogin);
}

/** A cookie as Chrome's extension sends it, checked field by field; null when malformed. */
export function passCookie(raw: unknown): SessionCookie | null {
	if (!raw || typeof raw !== "object") return null;
	const c = raw as Record<string, unknown>;
	if (typeof c.name !== "string" || !c.name || typeof c.value !== "string" || typeof c.domain !== "string" || !c.domain) return null;
	if (typeof c.path !== "string" || typeof c.expires !== "number" || !Number.isFinite(c.expires)) return null;
	if (typeof c.httpOnly !== "boolean" || typeof c.secure !== "boolean") return null;
	if (c.sameSite !== undefined && c.sameSite !== "Strict" && c.sameSite !== "Lax" && c.sameSite !== "None") return null;
	return { name: c.name, value: c.value, domain: c.domain, path: c.path || "/", expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, ...(c.sameSite ? { sameSite: c.sameSite } : {}) };
}

/** What a delivery of `cookies` for `row` comes to, before anything is written. */
export function passVerdict(row: CredentialRow, cookies: SessionCookie[]): PassAnswer | null {
	if (!passNeeds(row)) return deliveryWaiting(row.fields) ? "waiting" : "fine";
	const recipe = recipeOf(row.fields);
	const signed = recipe.sessionCookie!;
	if (!sessionSignedIn(cookies, recipe)) return "signed_out";
	const saved = credentialSession(row.fields);
	const value = (from: SessionCookie[], name: string) => from.find((c) => c.name === name)?.value;
	if (saved.length > 0 && value(saved, signed.name) === value(cookies, signed.name)) return "same";
	const account = ACCOUNT_COOKIES[signed.host.replace(/^www\./, "")];
	if (account) {
		const was = value(saved, account);
		const now = value(cookies, account);
		if (was && now && was !== now) return "other_account";
	}
	return null;
}

/** Take a fresh login for credential `id` from this computer's Chrome. */
export async function passDeliver(id: string, raw: unknown[]): Promise<PassAnswer> {
	const row = await credentialObject(id);
	if (!passServes(row)) throw new Error(`"${row.name || id}" is not a browser sign-in.`);
	const cookies = serviceCookies(raw.map(passCookie).filter((c): c is SessionCookie => !!c), recipeOf(row.fields));
	const verdict = passVerdict(row, cookies);
	if (verdict) return verdict;
	await saveSession(row, cookies, await machineId());
	console.log(`[pass] fresh ${str(row.fields, "name") || row.service} login saved on ${row.id.slice(0, 8)} (${cookies.length} cookies)`);
	return "saved";
}
