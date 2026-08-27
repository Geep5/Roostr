/**
 * Long-term memory — port of glon memory.ts over the Roostr HTTP API.
 * Two owner-scoped object types:
 *   pinned_fact  {owner, key, value, confidence, sourcedFromBlockId}
 *                one row per (owner,key); upsert mutates in place so the
 *                DAG keeps the value history.
 *   milestone    {owner, title, narrative, topics[], supersedes[], status,
 *                confidence, startedAt, endedAt}
 *                upsert auto-marks superseded priors.
 * Retrieval is pull-based; `digest` renders the always-in-prompt block
 * (facts high-confidence-first cap 40; live milestones recency cap 8).
 */

import { createObject, iv, list, lv, query, setField, str, sv, type QueryRow } from "./api";

const FACT_LIMIT = 40;
const MILESTONE_LIMIT = 8;

const ownerFilter = (owner: string) => [{ key: "owner", condition: "equal", value: owner }];

export async function listFacts(owner: string, key?: string): Promise<QueryRow[]> {
	const rows = await query({ type: "pinned_fact", filters: ownerFilter(owner), limit: 500 });
	return key ? rows.filter((r) => str(r.fields, "key") === key) : rows;
}

export async function listMilestones(owner: string, status?: string): Promise<QueryRow[]> {
	const rows = await query({ type: "milestone", filters: ownerFilter(owner), limit: 500 });
	return status ? rows.filter((r) => str(r.fields, "status") === status) : rows;
}

export async function upsertFact(
	owner: string,
	key: string,
	value: string,
	confidence = "med",
	sourcedFromBlockId = "",
): Promise<string> {
	const existing = (await listFacts(owner, key))[0];
	if (existing) {
		await setField(existing.id, "value", sv(value));
		await setField(existing.id, "confidence", sv(confidence));
		if (sourcedFromBlockId) await setField(existing.id, "sourcedFromBlockId", sv(sourcedFromBlockId));
		return existing.id;
	}
	const { id } = await createObject(key, "pinned_fact", {
		owner: sv(owner),
		key: sv(key),
		value: sv(value),
		confidence: sv(confidence),
		...(sourcedFromBlockId ? { sourcedFromBlockId: sv(sourcedFromBlockId) } : {}),
	});
	return id;
}

export async function upsertMilestone(
	owner: string,
	args: {
		title: string;
		narrative: string;
		topics?: string[];
		supersedes?: string[];
		status?: string;
		confidence?: string;
		started_at?: number;
		ended_at?: number;
	},
): Promise<string> {
	const { id } = await createObject(args.title, "milestone", {
		owner: sv(owner),
		title: sv(args.title),
		narrative: sv(args.narrative),
		topics: lv(args.topics ?? []),
		supersedes: lv(args.supersedes ?? []),
		status: sv(args.status ?? "active"),
		confidence: sv(args.confidence ?? "med"),
		...(args.started_at ? { startedAt: iv(args.started_at) } : {}),
		...(args.ended_at ? { endedAt: iv(args.ended_at) } : {}),
	});
	// Auto-mark superseded priors (memory.ts:383-392), owner-scoped.
	for (const oldId of args.supersedes ?? []) {
		const rows = await query({ type: "milestone", filters: [...ownerFilter(owner), { key: "id", condition: "equal", value: oldId }] });
		if (rows.length > 0) await setField(oldId, "status", sv("superseded"));
	}
	return id;
}

export async function amendMilestone(
	owner: string,
	id: string,
	patch: { title?: string; narrative?: string; topics?: string[]; status?: string; confidence?: string },
): Promise<boolean> {
	const rows = await query({ type: "milestone", filters: [...ownerFilter(owner), { key: "id", condition: "equal", value: id }] });
	if (rows.length === 0) return false;
	if (patch.title !== undefined) {
		await setField(id, "title", sv(patch.title));
		await setField(id, "name", sv(patch.title));
	}
	if (patch.narrative !== undefined) await setField(id, "narrative", sv(patch.narrative));
	if (patch.topics !== undefined) await setField(id, "topics", lv(patch.topics));
	if (patch.status !== undefined) await setField(id, "status", sv(patch.status));
	if (patch.confidence !== undefined) await setField(id, "confidence", sv(patch.confidence));
	return true;
}

/** Substring recall over facts + milestones (memory.ts:525-548). */
export async function recall(
	owner: string,
	args: { query?: string; topics?: string[]; limit_facts?: number; limit_milestones?: number; include_superseded?: boolean },
): Promise<{ facts: QueryRow[]; milestones: QueryRow[] }> {
	const q = (args.query ?? "").toLowerCase();
	const facts = (await listFacts(owner))
		.filter((r) => !q || str(r.fields, "key").toLowerCase().includes(q) || str(r.fields, "value").toLowerCase().includes(q))
		.slice(0, args.limit_facts ?? 20);
	let milestones = (await listMilestones(owner)).filter(
		(r) =>
			!q ||
			str(r.fields, "title").toLowerCase().includes(q) ||
			str(r.fields, "narrative").toLowerCase().includes(q) ||
			list(r.fields, "topics").some((t) => t.toLowerCase().includes(q)),
	);
	if (!args.include_superseded) milestones = milestones.filter((r) => str(r.fields, "status") !== "superseded");
	if (args.topics?.length) milestones = milestones.filter((r) => list(r.fields, "topics").some((t) => args.topics!.includes(t)));
	return { facts, milestones: milestones.slice(0, args.limit_milestones ?? 10) };
}

const CONF_RANK: Record<string, number> = { high: 0, med: 1, low: 2 };

/** Markdown digest for system-prompt injection (memory.ts:557-620). */
export async function digest(owner: string): Promise<string> {
	const facts = (await listFacts(owner))
		.toSorted((a, b) => (CONF_RANK[str(a.fields, "confidence")] ?? 1) - (CONF_RANK[str(b.fields, "confidence")] ?? 1))
		.slice(0, FACT_LIMIT);
	const milestones = (await listMilestones(owner))
		.filter((r) => str(r.fields, "status") !== "superseded")
		.toSorted((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, MILESTONE_LIMIT);
	if (facts.length === 0 && milestones.length === 0) return "";
	const lines: string[] = ["<memory>"];
	if (facts.length > 0) {
		lines.push("<facts>");
		for (const f of facts) lines.push(`- ${str(f.fields, "key")}: ${str(f.fields, "value")} (${str(f.fields, "confidence") || "med"})`);
		lines.push("</facts>");
	}
	if (milestones.length > 0) {
		lines.push("<milestones>");
		for (const m of milestones) {
			const topics = list(m.fields, "topics");
			lines.push(`- [${str(m.fields, "status") || "active"}] ${str(m.fields, "title")}: ${str(m.fields, "narrative")}${topics.length ? ` (topics: ${topics.join(", ")})` : ""}`);
		}
		lines.push("</milestones>");
	}
	lines.push("</memory>");
	return lines.join("\n");
}
