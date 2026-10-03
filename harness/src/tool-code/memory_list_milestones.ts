import type { Roostr } from "../tool-sdk";

export const description = "List milestones, optionally by status.";
export const inputs = "status?: active|completed|superseded";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const rows = await roostr.memory.listMilestones((typeof input.status === "string" ? input.status : "") || undefined);
	return JSON.stringify(rows.map((r) => ({ id: r.id, title: r.fields.title?.stringValue ?? "", status: r.fields.status?.stringValue ?? "", narrative: (r.fields.narrative?.stringValue ?? "").slice(0, 200) })));
}
