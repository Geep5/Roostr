/**
 * A turn's reply, against a real daemon (a temporary vault) and the mock
 * model. Field report: a scheduled run wrote its whole answer alongside its
 * call to occurrence_complete, then ended saying nothing more - the answer
 * stayed a note on the tool call, and the object's chat never showed it.
 *
 * The turn runs in its own `bun` process: ./api reads GLON_API when it
 * loads, and the test files of one run share their modules.
 */

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = process.env.GLON_ODIN_BIN ?? resolve(import.meta.dir, "../../glon-odin");
const root = mkdtempSync(join(tmpdir(), "roostr-runner-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A free local port. */
function freePort(): number {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	return port;
}

/** In a fresh process against the daemon: a mock-model agent asked `question` in its own chat, one turn; what it returned and what it posted. */
const TURN = `
const api = await import(${JSON.stringify(join(import.meta.dir, "api.ts"))});
const conv = await import(${JSON.stringify(join(import.meta.dir, "conv.ts"))});
const runner = await import(${JSON.stringify(join(import.meta.dir, "runner.ts"))});
// A real daemon process starting: nothing to await but its API answering, so this polls (bounded).
for (const deadline = Date.now() + 30_000; ; await Bun.sleep(100)) {
	if (await api.queryAll({ type: "agent" }).then(() => true, () => false)) break;
	if (Date.now() > deadline) throw new Error("the test daemon did not start");
}
const { id } = await api.createObject("Publisher Agent", "agent", { model: api.lv(["mock"]) });
await api.chatPost(id, process.env.QUESTION);
const reply = await runner.runTurn(id, { objectId: id, threadId: conv.HUMAN_THREAD });
const posted = (await api.fetchObject(id)).blocks
	.filter((b) => b.content.custom?.contentType === "chat" && b.content.custom.meta?.author === id)
	.map((b) => b.content.custom.meta.text);
console.log(JSON.stringify({ reply, posted }));
`;

test.skipIf(!existsSync(BIN))("an answer written alongside the turn's last tool call is posted when the turn then says nothing", async () => {
	const port = freePort();
	const env = { ...process.env, GLON_DATA: root, GLON_API: `http://127.0.0.1:${port}`, GLON_RECORDS: "1" };
	const daemon = Bun.spawn([BIN, "serve", String(port)], { env, stdout: "ignore", stderr: "ignore" });
	try {
		const turn = Bun.spawn(["bun", "-e", TURN], { env: { ...env, QUESTION: "answer alongside a tool: Work on the Wizards of the Coast pitch deck." }, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(turn.stdout).text(), new Response(turn.stderr).text(), turn.exited]);
		expect(code, err).toBe(0);
		const { reply, posted } = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { reply: string; posted: string[] };
		expect(reply).toBe("Work on the Wizards of the Coast pitch deck.");
		expect(posted).toContain("Work on the Wizards of the Coast pitch deck.");
	} finally {
		daemon.kill();
	}
}, 60_000);
