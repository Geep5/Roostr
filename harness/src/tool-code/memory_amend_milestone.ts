import type { Roostr } from "../tool-sdk";

export const description = "Correct an existing milestone in place — prefer over supersedes for small changes.";
export const inputs = "id: string\ntitle?: string\nnarrative?: string\ntopics?: string[]\nstatus?: active|completed|superseded";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	// Only what was passed changes.
	const ok = await roostr.memory.amendMilestone(asText(input.id), {
		title: input.title === undefined ? undefined : asText(input.title),
		narrative: input.narrative === undefined ? undefined : asText(input.narrative),
		topics: input.topics === undefined ? undefined : Array.isArray(input.topics) ? input.topics.filter((x): x is string => typeof x === "string") : [],
		status: input.status === undefined ? undefined : asText(input.status),
	});
	return ok ? "ok" : "milestone not found (or not yours)";
}
