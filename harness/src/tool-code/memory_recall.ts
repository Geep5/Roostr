import type { Roostr } from "../tool-sdk";

export const description = "Search facts + milestones by substring query and/or topics.";
export const inputs = "query?: string\ntopics?: string[]\nlimit_facts?: number\nlimit_milestones?: number\ninclude_superseded?: boolean";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const out = await roostr.memory.recall({
		query: typeof input.query === "string" ? input.query : "",
		topics: Array.isArray(input.topics) ? input.topics.filter((x): x is string => typeof x === "string") : [],
		limit_facts: typeof input.limit_facts === "number" ? input.limit_facts : undefined,
		limit_milestones: typeof input.limit_milestones === "number" ? input.limit_milestones : undefined,
		include_superseded: input.include_superseded === true,
	});
	return JSON.stringify({
		facts: out.facts.map((r) => ({ key: r.fields.key?.stringValue ?? "", value: r.fields.value?.stringValue ?? "" })),
		milestones: out.milestones.map((r) => ({ id: r.id, title: r.fields.title?.stringValue ?? "", narrative: (r.fields.narrative?.stringValue ?? "").slice(0, 300) })),
	});
}
