import type { Roostr } from "../tool-sdk";

export const description =
	"Delegate a self-contained task to a subagent. Templates: task (full tools), explore (read-only research), quick_task (fast, no delegation). Returns the subagent's submitted result.";
export const inputs = "task: string - complete, self-contained instructions\ntemplate?: task|explore|quick_task";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	return await roostr.spawn(typeof input.task === "string" ? input.task : "", typeof input.template === "string" && input.template ? input.template : "task");
}
