/**
 * Runs one Tool's TypeScript in its own Bun process, so a tool that hangs,
 * crashes or leaks cannot take the harness with it. A fresh process per call
 * costs ~20ms on an M-series Mac against a turn's seconds of model time, so
 * there is no warm pool to keep honest: each call starts clean, and a
 * broken version can't poison the next one.
 *
 * The harness side (`runToolCode`) writes `{code, input, context}` to the
 * child's stdin and reads one JSON line from its stdout; past the timeout
 * the child is killed. The child side (this file run directly) wraps the
 * code as a module -
 *
 *   export default async function (input: Record<string, unknown>, roostr: Roostr) { <code> }
 *
 * - imports it, calls it with `roostr` (tool-sdk.ts) and prints the result.
 * The tool's own console output goes to stderr: stdout carries the result.
 *
 * A run that fails says whether the code itself is broken (`crashed`): it
 * would not load, threw a JavaScript error of its own (TypeError,
 * ReferenceError, SyntaxError, RangeError - the SDK only ever throws plain
 * Errors), killed its process, or returned something that isn't data. A
 * plain Error thrown on purpose, or a run past its time, is an ordinary
 * failure the agent reads.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoostr, type ToolRunContext } from "./tool-sdk";

export const TOOL_TIMEOUT_MS = 120_000;

/** One run: the value the code returned (null for nothing), or why there is none. `log`: what it wrote to stderr; `touched`: objects it marked. */
export type ToolRun = { ok: true; value: unknown; log: string; touched: string[] } | { ok: false; error: string; crashed: boolean; log: string; touched: string[] };

/** What the harness sends the child, and the one line the child prints back. */
interface HostRequest {
	code: string;
	input: Record<string, unknown>;
	context: ToolRunContext;
}
type HostReply = { ok: true; value: unknown; touched: string[] } | { ok: false; error: string; crashed: boolean; touched: string[] };
/** The module `toolModule` writes. */
interface ToolModule {
	default?: unknown;
}

const SDK_PATH = join(import.meta.dir, "tool-sdk.ts");

/** The header line every Tool's code is wrapped in; the built-ins' shipped code files open with it too (tool-code.ts). */
export const TOOL_HEADER = "export default async function (input: Record<string, unknown>, roostr: Roostr) {";

/** The code as a module whose default export is the tool. */
export function toolModule(code: string): string {
	return `import type { ObjectJSON, QueryRow, Roostr, ValueJSON } from ${JSON.stringify(SDK_PATH)};\n${TOOL_HEADER}\n${code}\n}\n`;
}

/** Errors the JavaScript engine raises for broken code; anything else thrown is the tool (or the SDK) saying no. */
const CODE_ERRORS = [ReferenceError, TypeError, SyntaxError, RangeError];

/** The tool's module would not load. */
class LoadError extends Error {}

/** Run `code` with `input` in a child process; never throws. */
export async function runToolCode(code: string, input: Record<string, unknown>, context: ToolRunContext, timeoutMs = TOOL_TIMEOUT_MS): Promise<ToolRun> {
	const proc = Bun.spawn([process.execPath, import.meta.path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(JSON.stringify({ code, input, context } satisfies HostRequest));
	await proc.stdin.end();
	const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	const { promise: expired, resolve: expire } = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => expire("timeout"), timeoutMs);
	const outcome = await Promise.race([finished, expired]);
	clearTimeout(timer);
	if (outcome === "timeout") {
		// Not waiting on its pipes: a process the tool started may hold them open.
		proc.kill("SIGKILL");
		return { ok: false, error: `the tool ran longer than ${Math.round(timeoutMs / 1000)}s and was stopped`, crashed: false, log: "", touched: [] };
	}
	const [out, log, exitCode] = outcome;
	let reply: HostReply;
	try {
		// The child prints exactly one HostReply (below); anything else on stdout is the tool writing there itself.
		reply = JSON.parse(out) as HostReply;
	} catch {
		return { ok: false, error: `the tool process exited (${exitCode}) without a result${log.trim() ? `: ${log.trim().slice(-500)}` : ""}`, crashed: true, log, touched: [] };
	}
	return reply.ok ? { ok: true, value: reply.value ?? null, log, touched: reply.touched } : { ok: false, error: reply.error, crashed: reply.crashed, log, touched: reply.touched };
}

/** The child: run the request on stdin, print `{ok, value}` or `{ok: false, error, crashed}`. */
async function host(): Promise<void> {
	// Written by runToolCode above: the shape is ours.
	const req = JSON.parse(await Bun.stdin.text()) as HostRequest;
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;
	const file = join(tmpdir(), `roostr-tool-${crypto.randomUUID()}.ts`);
	const touched = new Set<string>();
	let reply: HostReply;
	try {
		await Bun.write(file, toolModule(req.code));
		let tool: unknown;
		try {
			// Dynamic on purpose: the module is the tool's code, written just now.
			tool = ((await import(file)) as ToolModule).default;
		} catch (err) {
			throw new LoadError(err instanceof Error ? err.message : String(err));
		}
		if (typeof tool !== "function") throw new LoadError("its code is not a function body");
		const value: unknown = await tool(req.input, createRoostr(req.context, touched));
		reply = { ok: true, value: value ?? null, touched: [...touched] };
	} catch (err) {
		const codeError = CODE_ERRORS.some((kind) => err instanceof kind);
		const error = err instanceof Error ? (codeError ? `${err.name}: ${err.message}` : err.message) : String(err);
		reply = { ok: false, error, crashed: codeError || err instanceof LoadError, touched: [...touched] };
	} finally {
		await rm(file, { force: true });
	}
	let line: string;
	try {
		line = JSON.stringify(reply);
	} catch (err) {
		line = JSON.stringify({ ok: false, error: `the tool's result can't be sent as JSON: ${err instanceof Error ? err.message : String(err)}`, crashed: true, touched: [...touched] } satisfies HostReply);
	}
	await Bun.write(Bun.stdout, line);
	// Timers or sockets the tool left open must not keep the process alive.
	process.exit(0);
}

if (import.meta.main) await host();
