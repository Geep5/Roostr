/**
 * Runs one custom Tool's TypeScript in its own Bun process, so a tool that
 * hangs, crashes or leaks cannot take the harness with it.
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
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoostr, type Roostr, type ToolRunContext } from "./tool-sdk";

export const TOOL_TIMEOUT_MS = 120_000;

/** One run: the value the code returned (null for nothing), or why there is none. `log` is what it wrote to stderr. */
export type ToolRun = { ok: true; value: unknown; log: string } | { ok: false; error: string; log: string };

/** What the harness sends the child, and the one line the child prints back. */
interface HostRequest {
	code: string;
	input: Record<string, unknown>;
	context: ToolRunContext;
}
type HostReply = { ok: true; value: unknown } | { ok: false; error: string };
/** The module `toolModule` writes. */
interface ToolModule {
	default: (input: Record<string, unknown>, roostr: Roostr) => Promise<unknown>;
}

const SDK_PATH = join(import.meta.dir, "tool-sdk.ts");

/** The code as a module whose default export is the tool. */
export function toolModule(code: string): string {
	return `import type { Roostr } from ${JSON.stringify(SDK_PATH)};\nexport default async function (input: Record<string, unknown>, roostr: Roostr) {\n${code}\n}\n`;
}

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
		return { ok: false, error: `the tool ran longer than ${Math.round(timeoutMs / 1000)}s and was stopped`, log: "" };
	}
	const [out, log, exitCode] = outcome;
	let reply: HostReply;
	try {
		// The child prints exactly one HostReply (below); anything else on stdout is the tool writing there itself.
		reply = JSON.parse(out) as HostReply;
	} catch {
		return { ok: false, error: `the tool process exited (${exitCode}) without a result${log.trim() ? `: ${log.trim().slice(-500)}` : ""}`, log };
	}
	return reply.ok ? { ok: true, value: reply.value ?? null, log } : { ok: false, error: reply.error, log };
}

/** The child: run the request on stdin, print `{ok, value}` or `{ok: false, error}`. */
async function host(): Promise<void> {
	// Written by runToolCode above: the shape is ours.
	const req = JSON.parse(await Bun.stdin.text()) as HostRequest;
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;
	const file = join(tmpdir(), `roostr-tool-${crypto.randomUUID()}.ts`);
	let reply: HostReply;
	try {
		await Bun.write(file, toolModule(req.code));
		// Dynamic on purpose: the module is the tool's code, written just now.
		const mod = (await import(file)) as ToolModule;
		const value = await mod.default(req.input, createRoostr(req.context));
		reply = { ok: true, value: value ?? null };
	} catch (err) {
		reply = { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		await rm(file, { force: true });
	}
	let line: string;
	try {
		line = JSON.stringify(reply);
	} catch (err) {
		line = JSON.stringify({ ok: false, error: `the tool's result can't be sent as JSON: ${err instanceof Error ? err.message : String(err)}` } satisfies HostReply);
	}
	await Bun.write(Bun.stdout, line);
	// Timers or sockets the tool left open must not keep the process alive.
	process.exit(0);
}

if (import.meta.main) await host();
