import type { Roostr } from "../tool-sdk";

export const description = "Record a narrative arc. Pass supersedes=[id,...] to replace older milestones.";
export const inputs = "title: string\nnarrative: string\ntopics?: string[]\nsupersedes?: string[]\nstatus?: active|completed|superseded\nconfidence?: low|med|high";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	const id = await roostr.memory.upsertMilestone({
		title: asText(input.title),
		narrative: asText(input.narrative),
		topics: Array.isArray(input.topics) ? input.topics.filter((x): x is string => typeof x === "string") : [],
		supersedes: Array.isArray(input.supersedes) ? input.supersedes.filter((x): x is string => typeof x === "string") : [],
		status: asText(input.status) || "active",
		confidence: asText(input.confidence) || "med",
	});
	return JSON.stringify({ id });
}
