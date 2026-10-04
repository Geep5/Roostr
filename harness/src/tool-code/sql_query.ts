import type { Roostr } from "../tool-sdk";

export const description =
	"Run ONE read-only SQL statement (PostgreSQL) against a database through one of YOUR credentials (a PostgreSQL credential in your Credentials; the harness connects, you never see the password). Read-only: SELECT, WITH, VALUES, TABLE, SHOW or EXPLAIN - anything that writes is refused. One statement per call, no semicolon-separated batches. Always put a LIMIT on queries and select only the columns you need; runs stop after 30 seconds. The database's Skill or guide has its schema - read it before writing queries instead of guessing table names. The answer is the column names, then one JSON array per row, and says when rows were cut.";
export const inputs =
	"sql: string - one read-only statement, with a LIMIT\ncredential?: string - which PostgreSQL credential (its name, see Your credentials) when you have several\nmax_rows?: number - rows to return at most (default 500, at most 2000)";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const sql = typeof input.sql === "string" ? input.sql : "";
	if (!sql.trim()) return "error: pass the statement to run in `sql`";
	const credential = typeof input.credential === "string" && input.credential.trim() ? input.credential.trim() : undefined;
	const maxRows = typeof input.max_rows === "number" ? input.max_rows : undefined;
	// Having the credential is the permission: the harness refuses an agent whose Credentials list no PostgreSQL one.
	const answer = await roostr.credentials.sql("postgres", sql, { credential, maxRows });
	if (!answer.ok) return `error: ${answer.error}`;
	if (answer.columns.length === 0) return "No rows.";
	// The harness keeps 8 KB of a tool's answer: rows past that are dropped here and counted, so the model knows to narrow.
	const budget = 7600;
	const lines = [JSON.stringify(answer.columns)];
	let size = lines[0].length;
	let shown = 0;
	for (const row of answer.rows) {
		const line = JSON.stringify(row);
		if (size + line.length + 1 > budget) break;
		lines.push(line);
		size += line.length + 1;
		shown += 1;
	}
	const notes: string[] = [];
	if (shown < answer.rowCount) notes.push(`only the first ${shown} of ${answer.rowCount} rows fit here - select fewer columns or rows`);
	if (answer.truncated) notes.push(`more rows exist past the ${answer.rowCount} returned - add a tighter WHERE or LIMIT, or raise max_rows`);
	return `${lines.join("\n")}\n(${answer.rowCount} rows${answer.truncated ? ", truncated" : ""}${notes.length ? `; ${notes.join("; ")}` : ""})`;
}
