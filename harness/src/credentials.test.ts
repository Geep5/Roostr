import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { credentialsPromptLine } from "./credentials";
import { resetScheduler } from "./schedule";

let root = "";
let previousRoot: string | undefined;

beforeEach(async () => {
	resetScheduler();
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-credentials-"));
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	resetScheduler();
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

async function putSessionCookie(): Promise<void> {
	const dir = join(root, "browser-profiles", "x", "Default", "Network");
	await mkdir(dir, { recursive: true });
	const db = new Database(join(dir, "Cookies"), { create: true });
	db.exec("CREATE TABLE cookies (name TEXT, host_key TEXT)");
	db.query("INSERT INTO cookies (name, host_key) VALUES (?, ?)").run("auth_token", ".x.com");
	db.close();
}

test("browser credentials tell agents to use the logged-in Chrome profile, not browserless", async () => {
	await putSessionCookie();
	const line = credentialsPromptLine();
	expect(line).toContain("browserless/web_fetch is deliberately logged out");
	expect(line).toContain("logged-in Chrome profile");
	expect(line).toContain("credential_fetch/credential_action");
	expect(line).toContain("credential_action");
	expect(line).toContain("--headless=new");
	expect(line).toContain("--user-data-dir=<path>");
});
