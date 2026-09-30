/**
 * Shell and web are granted by Skills: an agent whose Skills don't list
 * them is neither offered them nor able to run them.
 */
import { expect, test } from "bun:test";
import { dispatchTool, toolDefs } from "./tools";

const names = (granted?: Set<string>) => new Set(toolDefs("", 0, true, granted).map((d) => d.name));

test("an agent without grant skills is offered neither shell nor web", () => {
	const none = names(new Set());
	expect(none.has("shell_exec")).toBe(false);
	expect(none.has("web_fetch")).toBe(false);
	// Everything else is still there - taking two tools away, not the agent.
	expect(none.has("object_get")).toBe(true);
	expect(none.has("chat_reply_on")).toBe(true);
});

test("each grant unlocks only its own tool", () => {
	const shellOnly = names(new Set(["shell_exec"]));
	expect(shellOnly.has("shell_exec")).toBe(true);
	expect(shellOnly.has("web_fetch")).toBe(false);
});

test("a gated tool called without its grant is refused before it runs", async () => {
	const ctx = { agentId: "a", channelId: "s", depth: 0, touched: new Set<string>(), granted: new Set<string>() };
	const res = await dispatchTool("shell_exec", { command: "touch /tmp/should-not-exist-grant-test" }, ctx);
	expect(res.content).toContain("not one of your tools");
	expect(await Bun.file("/tmp/should-not-exist-grant-test").exists()).toBe(false);
});
