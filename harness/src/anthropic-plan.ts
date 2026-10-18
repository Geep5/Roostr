/**
 * An Anthropic credential holds up to two logins: a Claude plan (signed in
 * from Settings - claude-plan.ts) and an API key (`key_api_key`, pasted).
 * Agents use the plan while it is good and the key otherwise; Status and
 * Error say which, and say so when the plan stopped working.
 */
import { str, type ValueJSON } from "./api";

/** The plan's access token (what agents send) and refresh token (only the computer serving the credential uses it). Secret. */
export const PLAN_TOKEN = "plan_token";
export const PLAN_REFRESH = "plan_refresh";
/** When the access token stops working (epoch ms). */
export const PLAN_EXPIRES = "plan_expires";
/** The Claude account it is signed in as. */
export const PLAN_ACCOUNT = "plan_account";
/** Why renewing it failed (the plan stays unused until signed in again). */
export const PLAN_ERROR = "plan_error";
export const PLAN_FIELDS = [PLAN_TOKEN, PLAN_REFRESH, PLAN_EXPIRES, PLAN_ACCOUNT, PLAN_ERROR] as const;

/** Margin before expiry at which a token no longer counts as good (a turn takes a while). */
const GOOD_FOR_MS = 60_000;

const num = (fields: Record<string, ValueJSON>, key: string): number => fields[key]?.intValue ?? 0;

/** The plan token to call with now, or "" when there is none or it is expired. */
export function planToken(fields: Record<string, ValueJSON>, now = Date.now()): string {
	const token = str(fields, PLAN_TOKEN);
	return token && !str(fields, PLAN_ERROR) && num(fields, PLAN_EXPIRES) > now + GOOD_FOR_MS ? token : "";
}

/** Whether a plan was signed in on this credential at all (good, expired or failed). */
export function hasPlan(fields: Record<string, ValueJSON>): boolean {
	return !!str(fields, PLAN_REFRESH);
}

/** What an agent calls Claude with: the plan first, else the API key, else "". */
export function anthropicKey(fields: Record<string, ValueJSON>, now = Date.now()): string {
	return planToken(fields, now) || str(fields, "key_api_key").trim();
}

export interface AnthropicState {
	status: "active" | "needs_auth" | "missing";
	auth: "plan" | "api_key" | "";
	error: string;
}

/** Status, auth and Error for an Anthropic credential, from its two logins. */
export function anthropicState(fields: Record<string, ValueJSON>, now = Date.now()): AnthropicState {
	const account = str(fields, PLAN_ACCOUNT);
	const key = str(fields, "key_api_key").trim();
	if (planToken(fields, now)) return { status: "active", auth: "plan", error: "" };
	if (hasPlan(fields)) {
		const why = str(fields, PLAN_ERROR) ? "the Claude plan sign-in stopped working" : "the Claude plan token expired and hasn't been renewed";
		const fix = `Sign in with Claude again in Settings${account ? ` (${account})` : ""}`;
		return key ? { status: "active", auth: "api_key", error: `Using the API key: ${why}. ${fix}.` } : { status: "needs_auth", auth: "", error: `${why[0].toUpperCase()}${why.slice(1)} - ${fix}, or paste an API key.` };
	}
	if (key) return { status: "active", auth: "api_key", error: "" };
	return { status: "missing", auth: "", error: 'No login yet - Sign in with Claude in Settings, or paste an API key in "API key or token".' };
}
