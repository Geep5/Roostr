/**
 * Skills — OMP's progressive-disclosure pattern (skill:// + description-only
 * prompt listing) on DAG objects instead of SKILL.md dirs:
 *   skill object  {name, description} + body text blocks
 * The system prompt lists name+description only; the agent reads the body
 * on demand via the skill_read tool. Channel `instructions` objects are the
 * CLAUDE.md analog: their text is inlined into every prompt for agents in
 * that channel.
 */

import { fetchObject, query, str, type ObjectJSON } from "./api";

/** Serialize an object's text blocks in tree order. */
export function objectText(obj: ObjectJSON): string {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const roots = obj.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__discussion__");
	const out: string[] = [];
	const walk = (id: string) => {
		const b = byId.get(id);
		if (!b) return;
		const t = b.content.text?.text;
		if (t) out.push(t);
		for (const c of b.childrenIds) walk(c);
	};
	for (const r of roots) walk(r.id);
	return out.join("\n");
}

export interface SkillListing {
	id: string;
	name: string;
	description: string;
}

export async function listSkills(): Promise<SkillListing[]> {
	const rows = await query({ type: "skill", limit: 100 });
	return rows.map((r) => ({
		id: r.id,
		name: str(r.fields, "name") || r.id.slice(0, 8),
		description: str(r.fields, "description"),
	}));
}

export async function readSkill(name: string): Promise<string> {
	const skills = await listSkills();
	const hit = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
	if (!hit) return `No skill named "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`;
	const obj = await fetchObject(hit.id);
	return objectText(obj) || hit.description || "(skill has no body)";
}

/** Prompt section: descriptions only (OMP system-prompt.md:88-93). */
export function skillsPromptSection(skills: SkillListing[]): string {
	if (skills.length === 0) return "";
	const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
	return `<skills>\nReusable skills. When a task matches one, call skill_read BEFORE starting to load its full instructions:\n${lines.join("\n")}\n</skills>`;
}

/** Channel instructions (CLAUDE.md analog): inlined fully. */
export async function channelInstructions(channelId: string): Promise<string> {
	if (!channelId) return "";
	const rows = await query({
		type: "instructions",
		filters: [{ key: "channel", condition: "equal", value: channelId }],
		limit: 10,
	});
	const parts: string[] = [];
	for (const r of rows) {
		const obj = await fetchObject(r.id);
		const text = objectText(obj);
		if (text) parts.push(text);
	}
	return parts.length > 0 ? `<instructions>\n${parts.join("\n\n")}\n</instructions>` : "";
}
