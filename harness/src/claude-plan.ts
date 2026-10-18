/**
 * The Claude plan, space-wide. Settings' "Sign in with Claude" opens the
 * claude.ai sign-in in a Chrome window on this computer; the code it lands
 * on is read from the window's tab list (nothing attaches to a page), and the
 * login goes onto the default Anthropic credential of every space you own
 * (its Plan login - anthropic-plan.ts), served by the computer Settings
 * picks. That computer alone renews it - Claude replaces the refresh token
 * on every renewal, so two renewing would undo each other - and writes the
 * new token onto every one of those credentials. Agents use the plan while
 * it is good and the credential's API key otherwise.
 */
import { apiFetch, API, deleteField, iv, queryAll, setField, str, sv, type QueryRow } from "./api";
import { ANTHROPIC_AUTHORIZE_URL, ANTHROPIC_CLIENT_ID, ANTHROPIC_REDIRECT_URI, ANTHROPIC_SCOPES, ANTHROPIC_TOKEN_URL, generatePkce, refreshAnthropicToken } from "./auth";
import { PLAN_ACCOUNT, PLAN_ERROR, PLAN_EXPIRES, PLAN_FIELDS, PLAN_REFRESH, PLAN_TOKEN, anthropicState, hasPlan } from "./anthropic-plan";
import { openLoginWindow, type LoginWindow } from "./browser";
import { refreshCredentials } from "./credential-objects";
import { machineId } from "./roster";
import { ANTHROPIC_SERVICE, spaceAnthropicCredential } from "./space-defaults";

const CREDENTIAL_TYPE = "credential";
/** Renew this long before the token expires: the credential check runs every 5 minutes. */
const RENEW_BEFORE_MS = 15 * 60_000;
/** How long a sign-in window waits for the person. */
const SIGN_IN_MS = 10 * 60_000;

interface Tokens {
	access: string;
	refresh: string;
	expires: number;
	account: string;
}

/** A sign-in started from Settings: its PKCE verifier, the computer that will serve it, and how it is going. */
interface Pending {
	verifier: string;
	servedBy: string;
	window: LoginWindow | null;
	/** "" while it runs; otherwise why it stopped (the paste box takes over). */
	error: string;
}
let pending: Pending | null = null;

// ── Spaces ──────────────────────────────────────────────────────

/** Spaces this identity owns (an imported space names its owner). */
async function ownedSpaces(): Promise<Array<{ id: string; name: string }>> {
	const res = await apiFetch(`${API}/api/channels`);
	if (!res.ok) throw new Error(`spaces: HTTP ${res.status}`);
	return ((await res.json()) as Array<{ id: string; name: string; owner: string }>).filter((s) => !s.owner);
}

/** Each owned space's default Anthropic credential: the one already holding the plan, else the space's default. */
async function planCredentials(): Promise<Array<{ space: { id: string; name: string }; credential: QueryRow | undefined }>> {
	const creds = await queryAll({ type: CREDENTIAL_TYPE });
	return (await ownedSpaces()).map((space) => {
		const holding = creds.find((c) => str(c.fields, "channel") === space.id && str(c.fields, "service") === ANTHROPIC_SERVICE && hasPlan(c.fields));
		return { space, credential: holding ?? spaceAnthropicCredential(creds, space.id) };
	});
}

// ── Sign-in ─────────────────────────────────────────────────────

/** Hosts Anthropic's callback page is served from: console.anthropic.com forwards to platform.claude.com. */
const CALLBACK_HOSTS = new Set(["console.anthropic.com", "platform.claude.com"]);

/** The authorization code (and state) in the address Anthropic's callback page lands on, or null. */
export function codeFromCallback(url: string): { code: string; state: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" || !CALLBACK_HOSTS.has(parsed.hostname) || parsed.pathname !== new URL(ANTHROPIC_REDIRECT_URI).pathname) return null;
	const code = parsed.searchParams.get("code") ?? "";
	return code ? { code, state: parsed.searchParams.get("state") ?? "" } : null;
}

/** Exchange the code for tokens; the state must be the one this sign-in sent. */
async function exchange(code: string, state: string, verifier: string): Promise<Tokens> {
	if (state && state !== verifier) throw new Error("That code belongs to a different sign-in - start again.");
	const res = await fetch(ANTHROPIC_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ grant_type: "authorization_code", client_id: ANTHROPIC_CLIENT_ID, code, state: state || verifier, redirect_uri: ANTHROPIC_REDIRECT_URI, code_verifier: verifier }),
	});
	if (!res.ok) throw new Error(`Claude refused the sign-in (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
	const data = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; account?: { email_address?: string } };
	return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000, account: data.account?.email_address ?? "" };
}

/**
 * Start a sign-in: a Chrome window opens here on the claude.ai sign-in;
 * when it reaches the callback page the login is saved space-wide and the
 * window closes. Returns at once - Settings follows it through status().
 */
export async function startPlanSignIn(servedBy: string): Promise<void> {
	if (pending?.window) throw new Error("A Claude sign-in window is already open on this computer.");
	const pkce = await generatePkce();
	const params = new URLSearchParams({ code: "true", client_id: ANTHROPIC_CLIENT_ID, response_type: "code", redirect_uri: ANTHROPIC_REDIRECT_URI, scope: ANTHROPIC_SCOPES, code_challenge: pkce.challenge, code_challenge_method: "S256", state: pkce.verifier });
	const me = await machineId();
	const job: Pending = { verifier: pkce.verifier, servedBy: servedBy || me, window: null, error: "" };
	pending = job;
	try {
		job.window = openLoginWindow(`${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`, { tabs: true });
	} catch (err) {
		job.error = `${err instanceof Error ? err.message : String(err)} Open the sign-in yourself and paste the code.`;
		return;
	}
	const win = job.window;
	let closed = false;
	void win.exited.then(() => (closed = true));
	void (async () => {
		const deadline = Date.now() + SIGN_IN_MS;
		let landed = null as { code: string; state: string } | null;
		while (!landed && !closed && Date.now() < deadline && pending === job) {
			for (const url of await win.tabUrls()) landed ??= codeFromCallback(url);
			if (!landed) await Bun.sleep(1000);
		}
		await win.finish().catch(() => []);
		if (pending !== job) return;
		job.window = null;
		if (!landed) {
			job.error = closed ? "The sign-in window closed before it finished. Paste the code claude.ai showed, or sign in again." : "The sign-in took too long. Paste the code claude.ai showed, or sign in again.";
			return;
		}
		try {
			await applyPlan(await exchange(landed.code, landed.state, job.verifier), job.servedBy);
			pending = null;
		} catch (err) {
			job.error = err instanceof Error ? err.message : String(err);
		}
	})();
}

/** Finish a sign-in with the code claude.ai shows (CODE#STATE), when the window could not be read. */
export async function finishPlanSignIn(raw: string): Promise<void> {
	const job = pending;
	if (!job) throw new Error("No sign-in is in progress - press Sign in with Claude first.");
	const [code, state = ""] = raw.trim().split("#");
	if (!code) throw new Error("Paste the code claude.ai showed.");
	await applyPlan(await exchange(code, state, job.verifier), job.servedBy);
	if (job.window) await job.window.finish().catch(() => []);
	pending = null;
}

/** Write a login onto every owned space's default Anthropic credential, served by `servedBy`. */
async function applyPlan(tokens: Tokens, servedBy: string): Promise<void> {
	for (const { credential } of await planCredentials()) {
		if (!credential) continue;
		await writeTokens(credential.id, tokens);
		if (str(credential.fields, "served_by") !== servedBy) await setField(credential.id, "served_by", sv(servedBy));
	}
	await refreshCredentials();
}

async function writeTokens(id: string, tokens: Tokens): Promise<void> {
	await setField(id, PLAN_TOKEN, sv(tokens.access));
	await setField(id, PLAN_REFRESH, sv(tokens.refresh));
	await setField(id, PLAN_EXPIRES, iv(tokens.expires));
	if (tokens.account) await setField(id, PLAN_ACCOUNT, sv(tokens.account));
	await deleteField(id, PLAN_ERROR);
}

// ── Settings: computer, sign out, status ───────────────────────

/** Move every space's plan to another computer (it renews from now on). */
export async function servePlanOn(machine: string): Promise<void> {
	if (!machine) throw new Error("Pick a computer.");
	for (const { credential } of await planCredentials()) {
		if (credential && str(credential.fields, "served_by") !== machine) await setField(credential.id, "served_by", sv(machine));
	}
	if (pending) pending.servedBy = machine;
}

/** Take the plan off every space: agents carry on with the API key where there is one. */
export async function signOutPlan(): Promise<void> {
	for (const { credential } of await planCredentials()) {
		if (!credential) continue;
		for (const key of PLAN_FIELDS) if (credential.fields[key]) await deleteField(credential.id, key);
	}
	await refreshCredentials();
}

export interface PlanStatus {
	/** The computer this sign-in runs on (its Chrome window opens here): the default to keep it fresh. */
	thisComputer: string;
	account: string;
	expires: number;
	servedBy: string;
	signingIn: boolean;
	/** Why the sign-in in progress stopped (the paste box takes over). */
	signInError: string;
	spaces: Array<{ id: string; name: string; credential: string; status: string; auth: string; error: string }>;
}

export async function planStatus(): Promise<PlanStatus> {
	const rows = await planCredentials();
	const signed = rows.map((r) => r.credential).find((c) => c && hasPlan(c.fields));
	return {
		thisComputer: await machineId(),
		account: signed ? str(signed.fields, PLAN_ACCOUNT) : "",
		expires: signed?.fields[PLAN_EXPIRES]?.intValue ?? 0,
		servedBy: str((signed ?? rows.find((r) => r.credential)?.credential)?.fields ?? {}, "served_by") || (pending?.servedBy ?? ""),
		signingIn: !!pending && !pending.error,
		signInError: pending?.error ?? "",
		spaces: rows.map(({ space, credential }) => {
			const state = credential ? anthropicState(credential.fields) : { status: "missing", auth: "", error: "This space has no Anthropic credential yet." };
			return { id: space.id, name: space.name, credential: credential?.id ?? "", status: state.status, auth: state.auth, error: state.error };
		}),
	};
}

// ── Renewal (the computer serving the credentials) ─────────────

/**
 * Renew plans this computer serves that expire within RENEW_BEFORE_MS:
 * credentials sharing one refresh token are renewed once and all get the new
 * tokens. A refused renewal marks them (the plan stays unused until signed
 * in again; agents use the API key). Run before each credential check.
 */
export async function renewPlans(now = Date.now()): Promise<number> {
	const me = await machineId();
	const groups = new Map<string, QueryRow[]>();
	for (const c of await queryAll({ type: CREDENTIAL_TYPE })) {
		if (str(c.fields, "service") !== ANTHROPIC_SERVICE || str(c.fields, "served_by") !== me) continue;
		const refresh = str(c.fields, PLAN_REFRESH);
		if (!refresh || str(c.fields, PLAN_ERROR) || (c.fields[PLAN_EXPIRES]?.intValue ?? 0) - now > RENEW_BEFORE_MS) continue;
		groups.set(refresh, [...(groups.get(refresh) ?? []), c]);
	}
	let renewed = 0;
	for (const [refresh, creds] of groups) {
		try {
			const fresh = await refreshAnthropicToken(refresh);
			// refreshAnthropicToken keeps a 5-minute margin in `expires`; the token's own expiry is 5 minutes later.
			const tokens: Tokens = { access: fresh.access, refresh: fresh.refresh, expires: fresh.expires + 5 * 60_000, account: str(creds[0].fields, PLAN_ACCOUNT) };
			for (const c of creds) await writeTokens(c.id, tokens);
			renewed += creds.length;
		} catch (err) {
			const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
			console.error(`[claude-plan] renewing the Claude plan failed: ${why}`);
			// Claude refused it (signed out, revoked): mark it. A network hiccup is tried again on the next check.
			if (/HTTP (400|401|403)\b/.test(why)) for (const c of creds) await setField(c.id, PLAN_ERROR, sv(why));
		}
	}
	return renewed;
}
