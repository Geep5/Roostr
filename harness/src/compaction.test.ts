import { expect, test } from "bun:test";
import { serializeForSummary } from "./compaction";
import type { ClassifiedItem } from "./types";

test("a history far past the context window still gives the summariser a request that fits, newest kept", () => {
	// 600 hourly runs, each a scheduled-run message carrying a long task page plus a big tool result.
	const items: ClassifiedItem[] = [];
	for (let i = 0; i < 600; i++) {
		items.push({ kind: "user_text", blockId: `u${i}`, text: `Scheduled occurrence ${i}. ${"step ".repeat(2000)}`, author: "scheduler" });
		items.push({ kind: "tool_result", blockId: `r${i}`, toolUseId: `t${i}`, content: "x".repeat(20_000), isError: false });
	}
	const out = serializeForSummary(items);
	expect(out.length).toBeLessThanOrEqual(300_200);
	expect(out).toStartWith("[");
	expect(out).toContain("earlier entries left out");
	expect(out).toContain("Scheduled occurrence 599.");
	expect(out).not.toContain("Scheduled occurrence 0.");
});
