/**
 * Knowledge base: support-bot articles as ordinary objects, one per topic.
 *
 * Replaces the md-file KBs the Discord ticket bots edit on disk: a file's
 * category becomes the
 * `kb_category` property, the customer-vs-staff filename convention becomes
 * `kb_audience`, and each `##` section becomes one entry whose body is
 * native blocks (`>` response templates stay quote blocks). Edits are DAG
 * changes - history, sync, in-app editing - instead of shell edits on one
 * machine.
 *
 * The support bot gets the whole KB as a deterministic prompt section
 * (runner.ts slowSystemParts) rather than retrieval: the corpus is a few
 * hundred lines, so stuffing beats searching - same bet the md bots made.
 *
 * Import: `import-kb <dir> --space <id>` parses the md files (see
 * parseKbFile) and creates entries, deduped by `kb_source`
 * ("<file>#<section>"), skipping ones that already exist.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ObjectJSON, QueryRow } from "./api";
import { createObject, fetchObject, queryAll, str, sv } from "./api";
import { serializeBody } from "./surfaces";
import { appendMarkdown } from "./markdown";

export const KB_TYPE = "kb_entry";
export const KB_CATEGORIES = ["global", "account", "payment", "tax", "pin", "tournament", "partnership", "bug", "other"] as const;

/** The Knowledge Base Entry type's properties: ordinary relations of the space (never bundled). */
const KB_PROPERTIES: Array<{ key: string; name: string; format: string; emoji: string; options?: Array<[string, string]> }> = [
	{ key: "kb_category", name: "Category", format: "tag", emoji: "🗂️", options: KB_CATEGORIES.map((c) => [c, "grey"]) },
	{ key: "kb_audience", name: "Audience", format: "tag", emoji: "👁", options: [["customer", "blue"], ["staff", "red"], ["both", "purple"]] },
	{ key: "kb_status", name: "Status", format: "status", emoji: "📌", options: [["current", "lime"], ["uncertain", "yellow"], ["outdated", "grey"]] },
	{ key: "kb_source", name: "Source", format: "text", emoji: "📄" },
];

/** Files a customer must never see (the old "staff.md is not loaded" convention, as data). */
const STAFF_FILES = new Set(["staff", "brawlstars", "open_questions"]);

export interface ParsedEntry {
	title: string;
	category: string;
	audience: "customer" | "staff";
	status: "current" | "uncertain";
	markdown: string;
	source: string;
}

/** One md file -> one entry per `##` section. Preamble under the `#` title becomes an entry named after the file. */
export function parseKbFile(file: string, content: string): ParsedEntry[] {
	const fileKey = basename(file, ".md");
	const category = (KB_CATEGORIES as readonly string[]).includes(fileKey) ? fileKey : "other";
	const audience = STAFF_FILES.has(fileKey) ? "staff" : "customer";
	const status = fileKey === "open_questions" ? "uncertain" : "current";
	const entries: ParsedEntry[] = [];
	let title: string | null = null;
	let body: string[] = [];
	const flush = () => {
		const markdown = body.join("\n").trim();
		if (title !== null && markdown) entries.push({ title, category, audience, status, markdown, source: `${fileKey}.md#${title}` });
	};
	for (const line of content.split("\n")) {
		const h2 = line.match(/^## (.*)$/);
		if (h2) { flush(); title = h2[1].trim(); body = []; continue; }
		if (line.startsWith("# ")) continue; // file title
		if (title === null) { if (line.trim()) { title = fileKey === "global" ? "General" : fileKey[0].toUpperCase() + fileKey.slice(1); body.push(line); } continue; }
		body.push(line);
	}
	flush();
	return entries;
}

export async function seedKbType(space: string): Promise<void> {
	const types = await queryAll({ type: "type" });
	if (!types.some((t) => str(t.fields, "key") === KB_TYPE && str(t.fields, "channel") === space)) {
		await createObject("Knowledge Base Entry", "type", { key: sv(KB_TYPE), name: sv("Knowledge Base Entry"), iconEmoji: sv("📚"), layout: sv("page"), channel: sv(space) });
	}
	const have = new Set((await queryAll({ type: "relation" })).filter((r) => str(r.fields, "channel") === space).map((r) => str(r.fields, "key")));
	for (const p of KB_PROPERTIES) {
		if (have.has(p.key)) continue;
		await createObject(p.name, "relation", {
			channel: sv(space),
			key: sv(p.key),
			name: sv(p.name),
			format: sv(p.format),
			iconEmoji: sv(p.emoji),
			hidden: { boolValue: false },
			readOnly: { boolValue: false },
			maxCount: { intValue: p.format === "status" ? 1 : 0 },
			options: {
				valuesValue: {
					items: (p.options ?? []).map(([text, color], i) => ({
						mapValue: { entries: { id: sv(`${p.key}-${text}`), text: sv(text), color: sv(color), orderId: sv(String(i).padStart(6, "0")) } },
					})),
				},
			},
			bundled: { boolValue: false },
		});
	}
}
export interface ImportKbResult {
	created: string[];
	skipped: number;
}

export async function importKb(opts: { dir: string; space: string }): Promise<ImportKbResult> {
	await seedKbType(opts.space);
	const existing = new Set((await queryAll({ type: KB_TYPE, filters: [{ key: "channel", condition: "equal", value: opts.space }] })).map((r) => str(r.fields, "kb_source")));
	const result: ImportKbResult = { created: [], skipped: 0 };
	for (const file of (await readdir(opts.dir)).filter((f) => f.endsWith(".md")).sort()) {
		for (const entry of parseKbFile(file, await readFile(join(opts.dir, file), "utf8"))) {
			if (existing.has(entry.source)) { result.skipped++; continue; }
			const { id } = await createObject(entry.title, KB_TYPE, {
				kb_category: sv(entry.category), kb_audience: sv(entry.audience), kb_status: sv(entry.status), kb_source: sv(entry.source), channel: sv(opts.space),
			});
			await appendMarkdown(id, entry.markdown);
			result.created.push(id);
		}
	}
	return result;
}

/** Spaces (channels) whose kb_entry objects the agent carries, from its Knowledge bases link list. */
export function knowledgeBaseChannels(agent: ObjectJSON): string[] {
	const v = agent.fields["knowledge_bases"];
	if (!v) return [];
	const items = v.valuesValue?.items ?? [v];
	return items.map((i) => i.linkValue?.targetId || i.stringValue || "").filter(Boolean);
}

/** All kb_entry rows across the agent's linked knowledge bases. */
export async function knowledgeBaseRows(agent: ObjectJSON): Promise<QueryRow[]> {
	const perSpace = await Promise.all(knowledgeBaseChannels(agent).map((ch) => queryAll({ type: KB_TYPE, filters: [{ key: "channel", condition: "equal", value: ch }] })));
	return perSpace.flat();
}

/**
 * The deterministic knowledge-base prompt section: every entry in the
 * knowledge bases the agent links to (its Knowledge bases property),
 * grouped by category, staff entries marked. Whole-corpus stuffing, not
 * retrieval - the KB is a few hundred lines. Opt-in: no links, no section,
 * so agents sharing a space with a KB are not force-fed it. Callers that
 * already queried the rows (runner's fingerprint phase) pass them in.
 */
export async function kbPromptSection(rows: QueryRow[]): Promise<{ entries: ObjectJSON[]; text: string } | null> {
	if (!rows.length) return null;
	const entries = await Promise.all(rows.map((r) => fetchObject(r.id)));
	entries.sort((a, b) => (str(a.fields, "kb_category") + str(a.fields, "name")).localeCompare(str(b.fields, "kb_category") + str(b.fields, "name")));
	const lines: string[] = [
		"Your knowledge base below is the source of truth for product facts, policies and procedures. Never invent a price, date, status or policy that isn't here.",
		"Entries marked [internal] are staff-only: act on them, never quote or reveal them to customers.",
		"",
	];
	let lastCategory = "";
	for (const e of entries) {
		const category = str(e.fields, "kb_category") || "other";
		if (category !== lastCategory) { lines.push(`## ${category}`); lastCategory = category; }
		const staff = str(e.fields, "kb_audience") === "staff";
		const status = str(e.fields, "kb_status");
		const title = `${staff ? "[internal] " : ""}${str(e.fields, "name")}${status === "uncertain" ? " (unconfirmed)" : status === "outdated" ? " (outdated)" : ""}`;
		const { body } = serializeBody(e);
		lines.push(`### ${title}`, body.trim(), "");
	}
	return { entries, text: lines.join("\n").trim() };
}
