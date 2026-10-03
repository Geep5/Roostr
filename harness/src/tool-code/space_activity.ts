import type { Roostr, ValueJSON } from "../tool-sdk";

export const description =
	"Recent life of this space: latest edited objects, the newest human discussion messages, recurring work due soon or overdue, and open capability holdups. Use it to brief the human on what is new and what matters - especially when they write without a specific request.";
export const inputs = "limit?: number";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const limit = Math.min(typeof input.limit === "number" ? input.limit : 12, 25);
	const nameOf = (r: { id: string; fields: Record<string, ValueJSON> }) => r.fields.name?.stringValue || r.id.slice(0, 8);
	const rows = (await roostr.query({ filters: [await roostr.spaceFilter()] })).filter((r) => !["agent", "machine", "relation", "type", "template", "skill", "channel"].includes(r.typeKey));
	const newest = [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
	const out: string[] = ["RECENTLY EDITED (newest first):"];
	for (const r of newest.slice(0, limit)) out.push(`- ${r.typeKey} "${nameOf(r)}" ${new Date(r.updatedAt).toLocaleString()}`);
	const now = Date.now();
	const due = rows
		.flatMap((r) => {
			const next = r.fields.repeat?.mapValue?.entries?.next?.intValue;
			return next === undefined || next > now + 48 * 3600_000 ? [] : [{ name: nameOf(r), next: Number(next) }];
		})
		.sort((a, b) => a.next - b.next)
		.slice(0, 8);
	if (due.length > 0) {
		out.push("", "RECURRING WORK (next occurrence):");
		for (const d of due) out.push(`- "${d.name}" ${d.next < now ? "OVERDUE since" : "due"} ${new Date(d.next).toLocaleString()}`);
	}
	// A human message lands in the object's own discussion and bumps the
	// object's updatedAt: the newest objects are where the newest human talk is.
	const msgs: string[] = [];
	for (const r of newest.slice(0, 6)) {
		const obj = await roostr.get(r.id).catch(() => null);
		if (!obj) continue;
		for (const m of roostr.conversation(obj, "").slice(-4)) {
			const custom = m.block.content.custom;
			if (custom?.contentType !== "chat") continue;
			const meta = custom.meta ?? {};
			if (roostr.isAgentAuthor(String(meta.author ?? "")) || meta.origin) continue;
			msgs.push(`- ${String(meta.author || "human")} on "${nameOf(obj)}": ${String(meta.text ?? "").slice(0, 140)}`);
		}
	}
	if (msgs.length > 0) out.push("", "LATEST HUMAN MESSAGES:", ...msgs.slice(-5));
	// This computer's installations that hold an error, one per catalog key (a Google account's own row aside).
	const mine = new Map((await roostr.installations().catch(() => [])).filter((row) => row.machineId === roostr.context.machineId && !(row.key === "google" && row.account)).map((row) => [row.key, row]));
	const failing = [...mine.values()].filter((row) => row.error !== "");
	if (failing.length > 0) {
		out.push("", "OPEN HOLDUPS (capabilities missing):");
		for (const row of failing.slice(0, 5)) out.push(`- ${row.key}: ${row.error.slice(0, 140)}`);
	}
	return out.join("\n");
}
