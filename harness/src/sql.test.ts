/**
 * Read-only PostgreSQL through a Credential (sql.ts, tool-harness.ts
 * credentialSql, tool-code/sql_query.ts): one statement only, the URL and
 * password never in an answer or error, the tunnel command exactly as
 * documented, no database without a postgres credential - and no tool
 * reading a credential's secrets off the object. A real database (a
 * throwaway postgres:16.3 container) runs when docker is there.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectJSON, ValueJSON } from "./api";
import { hideCredentialSecrets } from "./credentials";
import { rowLimit, runReadOnly, singleStatement, sshHostProblem, SQL_DEFAULT_ROWS, SQL_MAX_ROWS, tunnelCommand, urlSecrets } from "./sql";
import objectGet from "./tool-code/object_get";
import objectSearch from "./tool-code/object_search";
import sqlQuery from "./tool-code/sql_query";
import { harnessFor } from "./tool-harness";
import { createRoostr, harnessCalls, type Roostr } from "./tool-sdk";
import type { ToolContext } from "./tools";

// ── One statement ───────────────────────────────────────────────

describe("singleStatement", () => {
	test("a query runs, a trailing semicolon dropped", () => {
		expect(singleStatement("select 1;")).toEqual({ ok: true, text: "select 1", kind: "cursor" });
		expect(singleStatement("  WITH t AS (select 1) select * from t  ")).toMatchObject({ ok: true, kind: "cursor" });
		expect(singleStatement("(select 1) union (select 2)")).toMatchObject({ ok: true, kind: "cursor" });
		expect(singleStatement("show server_version")).toMatchObject({ ok: true, kind: "direct" });
		expect(singleStatement("explain select 1")).toMatchObject({ ok: true, kind: "direct" });
	});

	test("semicolons inside strings, identifiers, dollar quotes and comments are part of the one statement", () => {
		for (const sql of [
			"select 'a;b'",
			"select 'it''s; fine'",
			"select E'a\\';b'",
			'select 1 as "x;y"',
			"select $$;$$",
			"select $fn$ ; $fn$",
			"select 1 -- trailing; comment",
			"select /* a; /* nested; */ still; */ 1",
			"select 1; -- done",
		]) {
			expect(singleStatement(sql)).toMatchObject({ ok: true });
		}
	});

	test("a second statement is refused, however it hides", () => {
		for (const sql of ["select 1; select 2", "select 1;delete from t", "select 'a'; drop table t", "select 1; /* x */ select 2"]) {
			expect(singleStatement(sql)).toEqual({ ok: false, error: "one statement at a time: the SQL goes on after its first semicolon" });
		}
	});

	test("anything but a query is refused", () => {
		expect(singleStatement("insert into t values (1)")).toMatchObject({ ok: false, error: expect.stringContaining("not INSERT") });
		expect(singleStatement("set statement_timeout = 0")).toMatchObject({ ok: false, error: expect.stringContaining("not SET") });
		expect(singleStatement("  ;")).toMatchObject({ ok: false, error: "the SQL is empty" });
		expect(singleStatement("select 'open")).toMatchObject({ ok: false, error: expect.stringContaining("never closes") });
		expect(singleStatement("select /* open")).toMatchObject({ ok: false, error: expect.stringContaining("never closes") });
	});

	test("rows: 500 by default, 2000 at most", () => {
		expect(rowLimit(undefined)).toBe(SQL_DEFAULT_ROWS);
		expect(rowLimit(0)).toBe(SQL_DEFAULT_ROWS);
		expect(rowLimit("9")).toBe(SQL_DEFAULT_ROWS);
		expect(rowLimit(12.7)).toBe(12);
		expect(rowLimit(1e9)).toBe(SQL_MAX_ROWS);
	});
});

// ── Secrets and the tunnel ──────────────────────────────────────

const PASSWORD = "hunter2-db-pass";
const DEAD_URL = `postgres://reader:${PASSWORD}@127.0.0.1:1/app`;

test("the URL and password are secrets, as written and decoded", () => {
	expect(urlSecrets("postgres://u:p%40ss-word-1@h:5432/d")).toEqual(["postgres://u:p%40ss-word-1@h:5432/d", "p%40ss-word-1", "p@ss-word-1"]);
});

test("a failed connection says why without the URL or password", async () => {
	const error = await runReadOnly(DEAD_URL, "select 1").then(
		() => "",
		(e: Error) => e.message,
	);
	expect(error).not.toBe("");
	expect(error).not.toContain(PASSWORD);
	expect(error).not.toContain(DEAD_URL);
});

test("a malformed URL is refused without echoing it", async () => {
	const error = await runReadOnly(`mysql://u:${PASSWORD}@h/d`, "select 1").catch((e: Error) => e.message);
	expect(error).toBe("key_url must be a postgres://user:password@host:port/database URL");
});

test("the tunnel command forwards a free local port to the URL's host and port", () => {
	expect(tunnelCommand("postgres://u:p@db.internal:6543/app", "root@1.2.3.4", 40123)).toEqual([
		"ssh",
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ServerAliveInterval=30",
		"-N",
		"-L",
		"127.0.0.1:40123:db.internal:6543",
		"root@1.2.3.4",
	]);
	expect(tunnelCommand("postgres://u:p@localhost/app", "box", 1)).toContain("127.0.0.1:1:localhost:5432");
});

test("an ssh host that ssh would read as an option is refused", () => {
	expect(sshHostProblem("root@1.2.3.4")).toBe("");
	expect(sshHostProblem("-oProxyCommand=touch /tmp/x")).not.toBe("");
	expect(sshHostProblem("host; rm -rf /")).not.toBe("");
	expect(() => tunnelCommand("postgres://u:p@h/d", "-oProxyCommand=x", 1)).toThrow();
});

// ── Through the harness, as a tool runs it ──────────────────────

const originalFetch = globalThis.fetch;
let previousRoot: string | undefined;
let root = "";

beforeEach(async () => {
	previousRoot = process.env.GLON_DATA;
	root = await mkdtemp(join(tmpdir(), "roostr-sql-"));
	await writeFile(join(root, "api-token"), "a".repeat(64), { mode: 0o600 });
	process.env.GLON_DATA = root;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (previousRoot === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = previousRoot;
	await rm(root, { recursive: true, force: true });
});

function object(id: string, typeKey: string, fields: Record<string, ValueJSON>): ObjectJSON {
	return { id, typeKey, fields, blocks: [], deleted: false, createdAt: 0, updatedAt: 0, mailbox: [] };
}

function agentWith(...credentialIds: string[]): ObjectJSON {
	return object("agent", "agent", {
		channel: { stringValue: "space" },
		...(credentialIds.length ? { credentials: { valuesValue: { items: credentialIds.map((targetId) => ({ linkValue: { relationKey: "credentials", targetId } })) } } } : {}),
	});
}

function postgresCredential(id: string, name: string, url: string, status = "active"): ObjectJSON {
	return object(id, "credential", {
		name: { stringValue: name },
		service: { stringValue: "postgres" },
		channel: { stringValue: "space" },
		key_fields: { stringValue: "url" },
		key_url: { stringValue: url },
		ssh_host: { stringValue: "" },
		status: { stringValue: status },
	});
}

/** The daemon serving `objects` (by id, and to any query), the one space "space". */
function server(objects: ObjectJSON[]) {
	globalThis.fetch = (async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.port !== "7333") return originalFetch(input, init);
		if (url.pathname === "/api/channels") return Response.json([{ id: "space" }]);
		if (url.pathname === "/api/query") return Response.json({ total: objects.length, records: objects.map(({ id, typeKey, fields, createdAt, updatedAt }) => ({ id, typeKey, fields, createdAt, updatedAt })) });
		if (url.pathname.startsWith("/api/objects/")) {
			const found = objects.find((candidate) => candidate.id === url.pathname.slice("/api/objects/".length));
			return Response.json(found ?? {}, { status: found ? 200 : 404 });
		}
		return Response.json({ error: "unexpected request" }, { status: 404 });
	}) as typeof fetch;
}

const ctx: ToolContext = { agentId: "agent", channelId: "space", depth: 0, touched: new Set<string>() };

function roostrFor(turn: ToolContext): Roostr {
	const serve = harnessFor(turn);
	const run = new AbortController();
	return createRoostr({ agentId: turn.agentId, objectId: "", channelId: turn.channelId, machineId: "m" }, new Set(), harnessCalls((method, args) => serve(method, args, run.signal)));
}

test("no database for an agent whose Credentials list no postgres credential", async () => {
	server([agentWith()]);
	expect(await sqlQuery({ sql: "select 1" }, roostrFor(ctx))).toBe("error: This agent lists no credentials. Add one to its Credentials property.");
	const acme = object("acme", "credential", { name: { stringValue: "Acme" }, service: { stringValue: "acme" }, status: { stringValue: "active" } });
	server([agentWith("acme"), acme]);
	expect(await sqlQuery({ sql: "select 1" }, roostrFor(ctx))).toBe(`error: None of this agent's credentials is for "postgres".`);
	expect(await roostrFor(ctx).credentials.sql("acme", "select 1")).toMatchObject({ ok: false });
});

test("a postgres credential that is not connected is refused before any connection", async () => {
	server([agentWith("db"), postgresCredential("db", "App DB", DEAD_URL, "broken")]);
	expect(await sqlQuery({ sql: "select 1" }, roostrFor(ctx))).toStartWith('error: Credential "App DB" is not connected (broken');
});

test("with several, `credential` picks one by name and an unknown one is refused, naming them", async () => {
	server([agentWith("a", "b"), postgresCredential("a", "Main DB", DEAD_URL), postgresCredential("b", "Analytics", DEAD_URL, "broken")]);
	expect(await sqlQuery({ sql: "select 1", credential: "analytics" }, roostrFor(ctx))).toStartWith('error: Credential "Analytics" is not connected');
	expect(await sqlQuery({ sql: "select 1", credential: "Nope" }, roostrFor(ctx))).toBe(`error: None of this agent's "postgres" credentials is "Nope"; they are: "Main DB", "Analytics".`);
});

test("a statement that is not one query is refused through the tool, and a dead database's error carries no secret", async () => {
	server([agentWith("db"), postgresCredential("db", "App DB", DEAD_URL)]);
	expect(await sqlQuery({ sql: "select 1; drop table users" }, roostrFor(ctx))).toBe("error: one statement at a time: the SQL goes on after its first semicolon");
	const dead = String(await sqlQuery({ sql: "select 1" }, roostrFor(ctx)));
	expect(dead).toStartWith("error: ");
	expect(dead).not.toContain(PASSWORD);
});

test("object_get on a credential never shows its secrets", async () => {
	const cred = object("cred", "credential", {
		name: { stringValue: "Secret thing" },
		service: { stringValue: "acme" },
		channel: { stringValue: "space" },
		key_x: { stringValue: "hunter2" },
		key_url: { stringValue: DEAD_URL },
		key_empty: { stringValue: "" },
		key_fields: { stringValue: "x,url,empty" },
		session: { stringValue: '[{"name":"sid","value":"sess-abcdef123456"}]' },
		secret: { stringValue: '{"apiKey":"legacy-key-987654"}' },
	});
	server([agentWith("cred"), cred]);
	const roostr = roostrFor(ctx);
	const shown = String(await objectGet({ id: "cred" }, roostr));
	for (const secret of ["hunter2", PASSWORD, "sess-abcdef123456", "legacy-key-987654"]) expect(shown).not.toContain(secret);
	expect(shown).toContain('"key_x": "[secret]"');
	expect(shown).toContain('"key_empty": ""');
	expect(shown).toContain('"key_fields": "x,url,empty"');
	expect(shown).toContain("Secret thing");
	// Every other way a tool reaches the object.
	const reads = [await roostr.get("cred"), await roostr.getInSpace("cred"), await roostr.writable("cred"), await roostr.query({ type: "credential" }), await roostr.query({ type: "credential", limit: 5 }), await objectSearch({ query: "Secret" }, roostr)];
	expect(JSON.stringify(reads)).not.toContain("hunter2");
	// Anything that is not a Credential is left as it is.
	const task = object("t", "task", { key_x: { stringValue: "plain-value-123" } });
	expect(hideCredentialSecrets(task)).toBe(task);
});

// ── A real database ─────────────────────────────────────────────

const docker = Bun.which("docker") !== null && Bun.spawnSync(["docker", "image", "inspect", "postgres:16.3"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!docker)("against postgres:16.3 in docker", () => {
	const name = `roostr-sql-test-${process.pid}`;
	const password = "docker-test-pass-42";
	let url = "";

	beforeAll(async () => {
		const run = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", name, "-e", `POSTGRES_PASSWORD=${password}`, "-p", "127.0.0.1::5432", "postgres:16.3"]);
		if (run.exitCode !== 0) throw new Error(`docker run failed: ${run.stderr.toString()}`);
		const port = Bun.spawnSync(["docker", "port", name, "5432/tcp"]).stdout.toString().trim().split(":").pop();
		url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
		// A real server starting in a container: nothing to await but its port answering, so this polls (bounded) rather than faking time.
		const deadline = Date.now() + 60_000;
		for (;;) {
			const up = await runReadOnly(url, "select 1").then(
				() => true,
				() => false,
			);
			if (up) break;
			if (Date.now() > deadline) throw new Error("postgres did not start");
			await Bun.sleep(500);
		}
		const setup = Bun.spawnSync(["docker", "exec", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "create table t (n int); create sequence s;"]);
		if (setup.exitCode !== 0) throw new Error(`setup failed: ${setup.stderr.toString()}`);
	}, 90_000);

	afterAll(() => {
		Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
	});

	test("a query answers with columns and rows", async () => {
		expect(await runReadOnly(url, "select 1 as one, 'a;b' as text, null as nothing")).toEqual({ columns: ["one", "text", "nothing"], rows: [[1, "a;b", null]], rowCount: 1, truncated: false });
	});

	test("max_rows truncates and says so", async () => {
		expect(await runReadOnly(url, "select g from generate_series(1, 10) g", 3)).toEqual({ columns: ["g"], rows: [[1], [2], [3]], rowCount: 3, truncated: true });
		expect(await runReadOnly(url, "select g from generate_series(1, 3) g", 3)).toMatchObject({ rowCount: 3, truncated: false });
	});

	test("an INSERT is refused, and a write hidden in a query is rejected by the read-only transaction", async () => {
		expect(await runReadOnly(url, "insert into t values (1)").catch((e: Error) => e.message)).toContain("not INSERT");
		const nextval = await runReadOnly(url, "select nextval('s')").catch((e: Error) => e.message);
		expect(String(nextval)).toContain("read-only transaction");
		const cte = await runReadOnly(url, "with x as (insert into t values (1) returning n) select * from x").catch((e: Error) => e.message);
		expect(String(cte)).not.toBe("");
		expect(await runReadOnly(url, "select count(*)::int as n from t")).toMatchObject({ rows: [[0]] });
	});

	test("a statement past the timeout is cancelled", async () => {
		const error = await runReadOnly(url, "select pg_sleep(5)", 1, "300ms").catch((e: Error) => e.message);
		expect(String(error)).toContain("statement timeout");
	}, 15_000);

	test("a wrong password fails without echoing it", async () => {
		const wrong = url.replace(password, "wrong-password-xyz");
		const error = await runReadOnly(wrong, "select 1").catch((e: Error) => e.message);
		expect(String(error)).toContain("password authentication failed");
		expect(String(error)).not.toContain("wrong-password-xyz");
	});
});
