import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicKey, anthropicState } from "./anthropic-plan";
import { ANTHROPIC_REDIRECT_URI } from "./auth";
import { codeFromCallback, renewPlans } from "./claude-plan";

const originalFetch = globalThis.fetch;
let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-plan-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	await writeFile(join(root, "harness.json"), JSON.stringify({ version: 1, agents: [], machineId: "sharky" }));
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

const s = (v: string) => ({ stringValue: v });
const i = (v: number) => ({ intValue: v });
const NOW = 1_800_000_000_000;

test("agents use the Claude plan while it is good, then the API key, and Status says which", () => {
	const plan = { plan_token: s("sk-ant-oat01-plan"), plan_refresh: s("r1"), plan_expires: i(NOW + 3_600_000), plan_account: s("grant@matcherino.com") };
	const key = { key_api_key: s("sk-ant-api03-key") };

	expect(anthropicKey({ ...plan, ...key }, NOW)).toBe("sk-ant-oat01-plan");
	expect(anthropicState({ ...plan, ...key }, NOW)).toEqual({ status: "active", auth: "plan", error: "" });

	// Expired (or within a minute of it): the key takes over, and the Error says the plan needs signing in again.
	const expired = { ...plan, plan_expires: i(NOW + 30_000) };
	expect(anthropicKey({ ...expired, ...key }, NOW)).toBe("sk-ant-api03-key");
	const fallback = anthropicState({ ...expired, ...key }, NOW);
	expect(fallback.status).toBe("active");
	expect(fallback.auth).toBe("api_key");
	expect(fallback.error).toContain("Sign in with Claude again");

	// Renewal refused, no key: nothing works and Status says so.
	const refused = anthropicState({ ...plan, plan_error: s("HTTP 400") }, NOW);
	expect(refused.status).toBe("needs_auth");
	expect(anthropicKey({ ...plan, plan_error: s("HTTP 400") }, NOW)).toBe("");

	// Plan only (no key): a space with no API key works on the plan alone.
	expect(anthropicState(plan, NOW).status).toBe("active");
	expect(anthropicState({}, NOW).status).toBe("missing");
});

test("the sign-in's code is read off Anthropic's callback page address, and only that page's", () => {
	expect(codeFromCallback(`${ANTHROPIC_REDIRECT_URI}?code=abc123&state=verifier1`)).toEqual({ code: "abc123", state: "verifier1" });
	// Where console.anthropic.com forwards it.
	expect(codeFromCallback("https://platform.claude.com/oauth/code/callback?code=abc123&state=verifier1")).toEqual({ code: "abc123", state: "verifier1" });
	expect(codeFromCallback("https://platform.claude.com.evil.io/oauth/code/callback?code=x")).toBeNull();
	expect(codeFromCallback(`${ANTHROPIC_REDIRECT_URI}?error=access_denied`)).toBeNull();
	expect(codeFromCallback("https://example.com/oauth/code/callback?code=stolen")).toBeNull();
});

test("the computer serving the plan renews it once for every space sharing it, near expiry only, and marks a refusal", async () => {
	const cred = (id: string, servedBy: string, expires: number, refresh = "r1") => ({
		id,
		typeKey: "credential",
		createdAt: 1,
		fields: { channel: s(`space-${id}`), service: s("anthropic"), served_by: s(servedBy), plan_token: s("old"), plan_refresh: s(refresh), plan_expires: i(expires), plan_account: s("grant@matcherino.com") },
	});
	let rows = [cred("a", "sharky", NOW + 60_000), cred("b", "sharky", NOW + 60_000), cred("later", "sharky", NOW + 3_600_000, "r2"), cred("elsewhere", "macbook", NOW + 60_000, "r3")];
	const writes: Array<{ id: string; key: string; value: unknown }> = [];
	let renewals = 0;
	let refuse = false;
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		if (url.pathname === "/api/query") return Response.json({ records: rows, total: rows.length });
		if (url.pathname === "/api/mutate") {
			writes.push({ id: String(body.object_id), key: String(body.key), value: body.value });
			return Response.json({ ok: true });
		}
		if (url.href.includes("/v1/oauth/token")) {
			renewals += 1;
			expect(body.refresh_token).toBe("r1");
			return refuse ? new Response("invalid_grant", { status: 400 }) : Response.json({ access_token: "new", refresh_token: "r1-next", expires_in: 28_800 });
		}
		return Response.json({ error: "unexpected" }, { status: 404 });
	}) as typeof fetch;

	expect(await renewPlans(NOW)).toBe(2);
	expect(renewals).toBe(1);
	for (const id of ["a", "b"]) {
		expect(writes.find((w) => w.id === id && w.key === "plan_token")?.value).toEqual(s("new"));
		expect(writes.find((w) => w.id === id && w.key === "plan_refresh")?.value).toEqual(s("r1-next"));
	}
	expect(writes.some((w) => w.id === "later" || w.id === "elsewhere")).toBe(false);

	writes.length = 0;
	refuse = true;
	rows = [cred("a", "sharky", NOW + 60_000)];
	expect(await renewPlans(NOW)).toBe(0);
	expect(writes.find((w) => w.id === "a" && w.key === "plan_error")).toBeDefined();
});
