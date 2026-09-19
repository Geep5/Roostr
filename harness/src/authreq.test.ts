import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetScheduler } from "./schedule";
import { authRequirementsOf, parseAuthRequirement, validateAuthSelector, type AuthIdentity } from "./authreq";
resetScheduler();

afterEach(() => {
	resetScheduler();
});

test("requires_auth parses service and service:account selectors", () => {
	expect(parseAuthRequirement("x")).toEqual({ service: "x", raw: "x" });
	expect(parseAuthRequirement("google:support@matcherino.com")).toEqual({ service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com" });
	expect(parseAuthRequirement(" google:bad ")).toEqual({ service: "google", account: "bad", raw: " google:bad " });
	expect(parseAuthRequirement(":")).toBeNull();
});

test("object auth fields prefer requires_auth and map service/account shorthand", () => {
	expect(
		authRequirementsOf({
			requires_auth: { valuesValue: { items: [{ stringValue: "x" }, { stringValue: "google:support@matcherino.com" }] } },
			service: { stringValue: "matcherino" },
		}).map((r) => r.raw),
	).toEqual(["x", "google:support@matcherino.com"]);
	expect(authRequirementsOf({ service: { stringValue: "google" }, google_account: { stringValue: "support@matcherino.com" } })).toEqual([
		{ service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com" },
	]);
});

const REGISTRY: AuthIdentity[] = [
	{ selector: "x", service: "x", raw: "x", active: false, reason: "x is not set up on this machine" },
	{ selector: "google:support@matcherino.com", service: "google", account: "support@matcherino.com", raw: "google:support@matcherino.com", active: true, reason: "google account support@matcherino.com active (oauth2)" },
];

test("selector validation refuses guesses the machine cannot fulfil", () => {
	expect(validateAuthSelector("x", REGISTRY)).toEqual({ requirement: { service: "x", raw: "x" } });
	expect(validateAuthSelector("google", REGISTRY)).toHaveProperty("error");
	expect(validateAuthSelector("google:nobody@example.com", REGISTRY)).toHaveProperty("error");
	expect(validateAuthSelector("x:someone", REGISTRY)).toHaveProperty("error");
	expect(validateAuthSelector("gws:support@matcherino.com", REGISTRY)).toHaveProperty("error");
});


test("configured Google accounts are active only while their local CLI verifies authentication", async () => {
	const root = await mkdtemp(join(tmpdir(), "glon-auth-registry-"));
	try {
		await mkdir(join(root, "accounts", "ready@example.test"), { recursive: true });
		await mkdir(join(root, "accounts", "expired@example.test"), { recursive: true });
		await mkdir(join(root, "bin"));
		await writeFile(join(root, "bin", "gws-as"), '#!/bin/sh\nif [ "$1" = "ready@example.test" ]; then\nprintf \'%s\\n\' \'{"auth_method":"oauth2","plain_credentials_exists":true}\'\nelse\nexit 1\nfi\n', { mode: 0o700 });
		const child = Bun.spawn([process.execPath, "-e", `
			import assert from "node:assert/strict";
			import { rm } from "node:fs/promises";
			import { localAuthRegistry } from "./authreq.ts";
			const google = (await localAuthRegistry()).filter(row => row.service === "google");
			assert.deepEqual(google.map(row => ({ selector: row.selector, active: row.active })), [
				{ selector: "google:expired@example.test", active: false },
				{ selector: "google:ready@example.test", active: true },
			]);
			await rm(process.env.PATH + "/gws-as");
			const unavailable = (await localAuthRegistry()).filter(row => row.service === "google");
			assert.deepEqual(unavailable.map(row => row.active), [false, false]);
		`], {
			cwd: import.meta.dir,
			env: { ...process.env, GLON_DATA: root, GOOGLE_WORKSPACE_ACCOUNTS_DIR: join(root, "accounts"), PATH: join(root, "bin") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
