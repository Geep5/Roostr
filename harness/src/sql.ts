/**
 * Read-only PostgreSQL through a Credential (service `postgres`,
 * credentials.ts): what `sql_query` and `roostr.credentials.sql` run
 * (tool-harness.ts credentialSql) and what a Check of such a credential
 * runs (credential-objects.ts).
 *
 * - The credential carries `key_url` (postgres://user:password@host:port/db)
 *   and, optionally, `ssh_host` (`root@1.2.3.4`). With an ssh host, this
 *   computer reaches the URL's host:port through an SSH tunnel it opens
 *   itself with its own keys (`ssh -N -L`), one per credential, kept while
 *   it lives, reopened when it dies, killed when the harness exits.
 * - Exactly one statement runs, in a READ ONLY transaction with a 30s
 *   statement timeout, always rolled back. A query (SELECT, WITH, VALUES,
 *   TABLE) runs through a cursor, so only max_rows + 1 rows are fetched to
 *   tell a truncated answer from a whole one; SHOW and EXPLAIN run as they
 *   are. Nothing else is accepted - the database role should still be a
 *   read-only one, as a read-only transaction does not stop every function.
 * - The statement is sent as a prepared statement, so the server itself
 *   refuses a second command even if the check here missed one.
 * - Each call opens its own connection and closes it when done: agents
 *   query now and then, so a pool would mostly hold idle server slots, and a
 *   fresh session can never inherit state from an earlier statement. Only
 *   the SSH tunnel, the slow part, is kept between calls.
 * - The password and the URL are blanked out of every answer and error.
 */
import { SQL, type ReservedSQL, type Subprocess } from "bun";
import { createConnection, createServer } from "node:net";
import { blankSecrets, blankSecretsDeep, secretList } from "./credentials";

export const POSTGRES_SERVICE = "postgres";
export const SQL_DEFAULT_ROWS = 500;
export const SQL_MAX_ROWS = 2000;
const STATEMENT_TIMEOUT = "30s";
const CONNECT_TIMEOUT_S = 15;
const TUNNEL_READY_MS = 15_000;
const CURSOR = "roostr_sql";

/** A statement's answer: the column names, at most the asked-for rows, and whether there were more. */
export interface SqlResult {
	columns: string[];
	rows: unknown[][];
	rowCount: number;
	truncated: boolean;
}

/** Where a credential's database is: its id (one tunnel each), its URL, and the ssh host to tunnel through ("" for none). */
export interface PostgresTarget {
	id: string;
	url: string;
	sshHost: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ── One statement ───────────────────────────────────────────────

/** Statements that run through a cursor (DECLARE takes them), and the two that run as they are. */
const CURSOR_KEYWORDS: Readonly<Record<string, true>> = { select: true, with: true, values: true, table: true };
const DIRECT_KEYWORDS: Readonly<Record<string, true>> = { show: true, explain: true };

export type Statement = { ok: true; text: string; kind: "cursor" | "direct" } | { ok: false; error: string };

/** A character that continues an identifier: a quote or `$` right after one is part of the name (`E'...'` aside), not a quote. */
const IDENT_CHAR = /[\w$\u0080-\uffff]/;

/** Index just past the quote opened at `start`, or -1 when it never closes; `escapes`: a backslash escapes (E'...'). */
function closeQuote(sql: string, start: number, quote: string, escapes: boolean): number {
	let i = start + 1;
	while (i < sql.length) {
		const c = sql[i];
		if (escapes && c === "\\") i += 2;
		else if (c === quote) {
			if (sql[i + 1] !== quote) return i + 1;
			i += 2;
		} else i += 1;
	}
	return -1;
}

/** Index just past the (nesting) block comment opened at `start`, or -1 when it never closes. */
function closeComment(sql: string, start: number): number {
	let depth = 0;
	let i = start;
	while (i < sql.length) {
		if (sql.startsWith("/*", i)) {
			depth += 1;
			i += 2;
		} else if (sql.startsWith("*/", i)) {
			depth -= 1;
			i += 2;
			if (depth === 0) return i;
		} else i += 1;
	}
	return -1;
}

/**
 * `sql` with every string, quoted identifier, dollar-quoted body and
 * comment blanked to spaces (same length), so what remains is the code
 * PostgreSQL reads; null when one of them never closes.
 */
function codeOnly(sql: string): string | null {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		let end = i;
		if (c === "-" && sql[i + 1] === "-") {
			const nl = sql.indexOf("\n", i);
			end = nl < 0 ? sql.length : nl;
		} else if (c === "/" && sql[i + 1] === "*") end = closeComment(sql, i);
		else if (c === "'") end = closeQuote(sql, i, "'", (sql[i - 1] === "E" || sql[i - 1] === "e") && !IDENT_CHAR.test(sql[i - 2] ?? ""));
		else if (c === '"') end = closeQuote(sql, i, '"', false);
		else if (c === "$" && !IDENT_CHAR.test(sql[i - 1] ?? "")) {
			// $tag$ ... $tag$ (or $$ ... $$); `$1` is a parameter, not a quote.
			const tag = /^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(sql.slice(i))?.[0];
			if (tag) {
				const close = sql.indexOf(tag, i + tag.length);
				end = close < 0 ? -1 : close + tag.length;
			}
		}
		if (end < 0) return null;
		if (end === i) {
			out += c;
			i += 1;
		} else {
			out += " ".repeat(end - i);
			i = end;
		}
	}
	return out;
}

/**
 * The one statement `sql` holds, or why it is refused: one trailing
 * semicolon is dropped; any other semicolon outside quotes and comments
 * means a second statement. Only a query, SHOW or EXPLAIN is accepted.
 */
export function singleStatement(sql: string): Statement {
	const code = codeOnly(sql);
	if (code === null) return { ok: false, error: "the SQL has a quote, dollar quote or comment that never closes" };
	const semi = code.indexOf(";");
	if (semi >= 0 && code.slice(semi + 1).trim()) return { ok: false, error: "one statement at a time: the SQL goes on after its first semicolon" };
	const head = (semi < 0 ? code : code.slice(0, semi)).trim();
	if (!head) return { ok: false, error: "the SQL is empty" };
	const text = (semi < 0 ? sql : sql.slice(0, semi)).trim();
	const word = (/^[\s(]*([A-Za-z]+)/.exec(head)?.[1] ?? "").toLowerCase();
	if (CURSOR_KEYWORDS[word]) return { ok: true, text, kind: "cursor" };
	if (DIRECT_KEYWORDS[word]) return { ok: true, text, kind: "direct" };
	return { ok: false, error: `only a query runs here - SELECT, WITH, VALUES, TABLE, SHOW or EXPLAIN - not ${word ? word.toUpperCase() : "that"}` };
}

/** The row cap a call asks for: SQL_DEFAULT_ROWS unless a positive number, never above SQL_MAX_ROWS. */
export function rowLimit(maxRows: unknown): number {
	const n = typeof maxRows === "number" && Number.isFinite(maxRows) ? Math.floor(maxRows) : 0;
	return n > 0 ? Math.min(n, SQL_MAX_ROWS) : SQL_DEFAULT_ROWS;
}

// ── The URL and its secrets ─────────────────────────────────────

const URL_SHAPE = "key_url must be a postgres://user:password@host:port/database URL";

/** The URL parsed, refused (without echoing it) unless it is a postgres:// one with a host. */
function parsePostgresUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		throw new Error(URL_SHAPE);
	}
	if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") || !parsed.hostname) throw new Error(URL_SHAPE);
	return parsed;
}

/** What of a database URL is secret: the URL itself and its password, as written and decoded. */
export function urlSecrets(url: string): string[] {
	const out = [url, url.trim()];
	try {
		const password = new URL(url.trim()).password;
		out.push(password);
		out.push(decodeURIComponent(password));
	} catch {
		/* not a URL: the text itself is the secret */
	}
	return secretList(out);
}

// ── Running it ──────────────────────────────────────────────────

/** A value as plain JSON the model can read: times as ISO text, bytes as \x hex, big integers as text. */
function cell(value: unknown): unknown {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
	if (Array.isArray(value)) return value.map(cell);
	return value;
}

/** A query through a cursor: limit + 1 rows say whether there are more; the first row read again by name gives the columns. */
async function viaCursor(db: ReservedSQL, text: string, limit: number): Promise<SqlResult> {
	await db`declare roostr_sql scroll cursor for ${db.unsafe(`${text}\n`)}`;
	const fetched = (await db.unsafe(`fetch forward ${limit + 1} from ${CURSOR}`).values()) as unknown[][];
	let columns: string[] = [];
	if (fetched.length > 0) {
		const [first] = (await db.unsafe(`fetch absolute 1 from ${CURSOR}`)) as Array<Record<string, unknown>>;
		columns = Object.keys(first ?? {});
		// Two columns sharing a name read back as one: number them instead.
		if (columns.length !== fetched[0].length) columns = fetched[0].map((_, i) => `column${i + 1}`);
	}
	const rows = fetched.slice(0, limit).map((r) => r.map(cell));
	return { columns, rows, rowCount: rows.length, truncated: fetched.length > limit };
}

/** SHOW or EXPLAIN, run as it is: their answers are short. */
async function direct(db: ReservedSQL, text: string, limit: number): Promise<SqlResult> {
	const result = (await db`${db.unsafe(`${text}\n`)}`) as Array<Record<string, unknown>>;
	const columns = Object.keys(result[0] ?? {});
	const rows = result.slice(0, limit).map((r) => columns.map((c) => cell(r[c])));
	return { columns, rows, rowCount: rows.length, truncated: result.length > limit };
}

/**
 * Run one statement against `url` read-only (see the file comment), at
 * most `maxRows` rows back (rowLimit), stopped after `timeout` (a Postgres
 * interval; the 30s default - a test passes a short one). Throws an Error
 * saying why it did not run; neither the answer nor the error carries the
 * URL or password.
 */
export async function runReadOnly(url: string, sql: string, maxRows: number = SQL_DEFAULT_ROWS, timeout = STATEMENT_TIMEOUT): Promise<SqlResult> {
	const secrets = urlSecrets(url);
	const statement = singleStatement(sql);
	if (!statement.ok) throw new Error(statement.error);
	const limit = rowLimit(maxRows);
	const target = parsePostgresUrl(url);
	const client = new SQL(target.toString(), { adapter: "postgres", max: 1, idleTimeout: 0, connectionTimeout: CONNECT_TIMEOUT_S });
	try {
		const db = await client.reserve();
		try {
			await db`begin read only`;
			try {
				await db.unsafe(`set local statement_timeout = '${timeout.replace(/'/g, "")}'`);
				const result = statement.kind === "cursor" ? await viaCursor(db, statement.text, limit) : await direct(db, statement.text, limit);
				return blankSecretsDeep(result, secrets) as SqlResult;
			} finally {
				await db`rollback`.catch(() => {});
			}
		} finally {
			db.release();
		}
	} catch (error) {
		throw new Error(blankSecrets(errorText(error), secrets));
	} finally {
		await client.close({ timeout: 0 }).catch(() => {});
	}
}

// ── SSH tunnels ─────────────────────────────────────────────────

interface Tunnel {
	proc: Subprocess;
	port: number;
	/** ssh host and remote host:port: a credential whose route changed gets a new tunnel. */
	route: string;
}

/** Open (or opening) tunnels, by credential id. */
const tunnels = new Map<string, Promise<Tunnel>>();

/** An ssh destination this computer will hand to ssh: `user@host` or `host`, never something ssh would read as an option. */
export function sshHostProblem(sshHost: string): string {
	if (!sshHost) return "ssh_host is empty";
	if (sshHost.startsWith("-") || !/^[\w.@:[\]%-]+$/.test(sshHost)) return "ssh_host must be an ssh destination like root@1.2.3.4 (letters, digits, . - _ @ : only)";
	return "";
}

/** The ssh command that forwards 127.0.0.1:`localPort` to the URL's host:port through `sshHost`; refused for an ssh host ssh would misread. */
export function tunnelCommand(url: string, sshHost: string, localPort: number): string[] {
	const target = parsePostgresUrl(url);
	const problem = sshHostProblem(sshHost);
	if (problem) throw new Error(problem);
	const forward = `127.0.0.1:${localPort}:${target.hostname}:${Number(target.port) || 5432}`;
	return ["ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-N", "-L", forward, sshHost];
}

function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.unref();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		server.close(() => (port ? resolve(port) : reject(new Error("no free local port"))));
	});
	return promise;
}

function accepts(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = createConnection({ host: "127.0.0.1", port });
	socket.once("connect", () => {
		socket.destroy();
		resolve(true);
	});
	socket.once("error", () => resolve(false));
	return promise;
}

/** Running tunnel processes, by credential id: what the exit hook kills. */
const running = new Map<string, Subprocess>();

/** Kill every tunnel this process opened. */
export function closeTunnels(): void {
	for (const proc of running.values()) proc.kill();
	running.clear();
	tunnels.clear();
}

let exitHooked = false;
/** Tunnels die with the harness: on exit, and on a signal nothing else handles. */
function hookExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	process.once("exit", closeTunnels);
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
		if (process.listenerCount(signal) > 0) continue;
		process.once(signal, () => {
			closeTunnels();
			process.exit(code);
		});
	}
}

async function openTunnel(id: string, route: string, args: string[], sshHost: string, localPort: number): Promise<Tunnel> {
	hookExit();
	const proc = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	running.set(id, proc);
	void proc.exited.then(() => {
		if (running.get(id) === proc) running.delete(id);
	});
	const stderr = new Response(proc.stderr).text();
	const deadline = Date.now() + TUNNEL_READY_MS;
	while (Date.now() < deadline) {
		if (proc.exitCode !== null || proc.signalCode !== null) {
			const said = (await stderr).trim().split("\n").slice(-3).join(" ");
			throw new Error(`the SSH tunnel through ${sshHost} closed: ${said || `ssh exited ${proc.exitCode ?? proc.signalCode}`}`);
		}
		if (await accepts(localPort)) return { proc, port: localPort, route };
		await Bun.sleep(150);
	}
	proc.kill();
	throw new Error(`the SSH tunnel through ${sshHost} did not open within ${TUNNEL_READY_MS / 1000}s`);
}

/** The local port of the credential's tunnel: the open one when it still lives on the same route, else a new one. */
async function tunnelPort(id: string, url: string, sshHost: string): Promise<number> {
	const target = parsePostgresUrl(url);
	const route = `${sshHost}|${target.hostname}:${Number(target.port) || 5432}`;
	const current = tunnels.get(id);
	if (current) {
		const t = await current.catch(() => null);
		if (t && t.route === route && t.proc.exitCode === null && t.proc.signalCode === null && !t.proc.killed) return t.port;
		if (tunnels.get(id) === current) tunnels.delete(id);
		t?.proc.kill();
		// Another call reopened it meanwhile: share that one.
		const reopened = tunnels.get(id);
		if (reopened) return (await reopened).port;
	}
	const opening = (async () => {
		const port = await freePort();
		return openTunnel(id, route, tunnelCommand(url, sshHost, port), sshHost, port);
	})();
	tunnels.set(id, opening);
	try {
		return (await opening).port;
	} catch (error) {
		if (tunnels.get(id) === opening) tunnels.delete(id);
		throw error;
	}
}

/** The credential's URL as this computer reaches it: through its SSH tunnel when it names an ssh host. */
export async function reachableUrl(target: PostgresTarget): Promise<string> {
	const sshHost = target.sshHost.trim();
	if (!sshHost) return target.url;
	const url = parsePostgresUrl(target.url);
	url.hostname = "127.0.0.1";
	url.port = String(await tunnelPort(target.id, target.url, sshHost));
	return url.toString();
}

/** One read-only statement against the credential's database (runReadOnly), through its tunnel when it has one; errors carry no secret. */
export async function queryPostgres(target: PostgresTarget, sql: string, maxRows: number = SQL_DEFAULT_ROWS): Promise<SqlResult> {
	const secrets = urlSecrets(target.url);
	try {
		const statement = singleStatement(sql);
		if (!statement.ok) throw new Error(statement.error);
		return await runReadOnly(await reachableUrl(target), sql, maxRows);
	} catch (error) {
		throw new Error(blankSecrets(errorText(error), secrets));
	}
}

/** The live check: connect and `select 1`. "" when it works, else why not (no secret in it). */
export async function checkPostgres(target: PostgresTarget): Promise<string> {
	try {
		await queryPostgres(target, "select 1", 1);
		return "";
	} catch (error) {
		return errorText(error);
	}
}
