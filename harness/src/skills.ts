/**
 * Skills — OMP's progressive-disclosure pattern (skill:// + description-only
 * prompt listing) on DAG objects instead of SKILL.md dirs:
 *   skill object  {name, description} + body text blocks
 * The system prompt lists name+description only; the agent reads the body
 * on demand via the skill_read tool. Channel `instructions` objects are the
 * CLAUDE.md analog: their text is inlined into every prompt for agents in
 * that channel.
 */

import { fetchObject, query, queryAll, str, type ObjectJSON } from "./api";
import { machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { blockLine } from "./surfaces";
import { DEFAULT_PROMPT, promptFor } from "./prompts";

/**
 * Serialize an object's blocks in tree order.
 *
 * Shares one renderer with the host framing. It used to have its own
 * text-only copy, so `object_get` - the tool an agent reaches for to check
 * what the framing told it - was blind to bookmarks and link cards in
 * exactly the same way, and confirmed the emptiness instead of correcting it.
 */
export function objectText(obj: ObjectJSON): string {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const roots = obj.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__discussion__");
	const out: string[] = [];
	const walk = (id: string) => {
		const b = byId.get(id);
		if (!b) return;
		const kind = b.content.custom?.contentType;
		if (kind === "chat" || kind === "discussion") return;
		const line = blockLine(b);
		if (line) out.push(line);
		for (const c of b.childrenIds) walk(c);
	};
	for (const r of roots) walk(r.id);
	return out.join("\n");
}

export interface SkillListing {
	id: string;
	name: string;
	description: string;
	/** Owning agent id, or "" for a global skill every agent sees. */
	owner: string;
}

/**
 * A skill is either global or one agent's own.
 *
 * Global skills (`agent` unset) are shared vocabulary: device
 * capabilities like gws and browserless describe this machine, and a
 * hand-written convention can be published the same way. An owned skill
 * (`agent` = an agent id) is that agent's private playbook: nobody else
 * lists it and nobody else can read it, so a specialist's procedure
 * costs every other agent nothing.
 *
 * Spaces do not enter into it: an agent already belongs to exactly one,
 * so ownership is the finer grain and a global skill stays reachable
 * from anywhere. An agent's system prompt may narrow the list further
 * (the prompt object's `skills` links, by skill name); empty means
 * everything above.
 */
export async function listSkills(agentId?: string): Promise<SkillListing[]> {
	// Dynamic: skillmgr imports objectText from this module, so a static
	// import here would be a module cycle.
	const { CATALOG, capabilities } = await import("./skillmgr");
	// A catalog skill is offered only once its capability object on this
	// machine is fully set up (served_by + active install) - before that the
	// skill stays invisible, however the toggle looks.
	const ready = new Set(await capabilities());
	const managed = new Set(CATALOG.map((c) => c.name.toLowerCase()));
	const agent = agentId ? await fetchObject(agentId).catch(() => null) : null;
	const only = new Set((agent ? await promptFor(agent) : DEFAULT_PROMPT).skills.map((k) => k.toLowerCase()));
	const rows = await queryAll({ type: "skill" });
	return rows
		.map((r) => ({
			id: r.id,
			name: str(r.fields, "name") || r.id.slice(0, 8),
			description: str(r.fields, "description"),
			owner: str(r.fields, "agent"),
		}))
		.filter((s) => {
			// Someone else's playbook: invisible, whoever is asking.
			if (s.owner !== "" && s.owner !== agentId) return false;
			const key = s.name.toLowerCase();
			if (only.size > 0 && !only.has(key)) return false;
			if (!managed.has(key)) return true;
			return ready.has(key);
		});
}

export async function readSkill(name: string, agentId?: string): Promise<string> {
	const skills = await listSkills(agentId);
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

/**
 * Prompt section for an object's agent: catalog capabilities other machines
 * have and this one lacks, so the agent knows that `object_require` can
 * move its object's work there (`docs/object-serving.md`). Keys the
 * object already requires are not repeated - if the work is still here,
 * requiring them again changes nothing. Empty when the turn has no object
 * (the agent's own page) and when nothing is missing.
 */
export async function remoteCapabilitiesSection(objectId: string): Promise<string> {
	if (!objectId) return "";
	// Dynamic, as in listSkills: skillmgr imports objectText from this
	// module, and capabilities.ts pulls in descriptors -> skillmgr.
	const { CATALOG, capabilities } = await import("./skillmgr");
	const { fetchCapabilities, fullySetUp, requirementKeys } = await import("./capabilities");
	const me = await machineId();
	const [local, roster, serving, caps] = await Promise.all([capabilities(), machines(), serverOf(objectId), fetchCapabilities()]);
	const required = requirementKeys(serving.requires, caps);
	const nameOf = new Map(roster.map((m) => [m.machineId, m.name]));
	const lines: string[] = [];
	for (const c of CATALOG) {
		if (local.includes(c.key) || required.includes(c.key)) continue;
		const where = caps
			.filter((cap) => cap.key === c.key && fullySetUp(cap) && cap.servedBy !== me)
			.map((cap) => nameOf.get(cap.servedBy) ?? cap.servedBy.slice(0, 8));
		if (where.length > 0) lines.push(`- ${c.key} (${where.join(", ")})`);
	}
	if (lines.length === 0) return "";
	return `<capabilities-elsewhere>\nCapabilities this machine lacks that other machines have:\n${lines.join("\n")}\nTo use one, call object_require with its key; this object's work then moves to that machine on the next turn.\n</capabilities-elsewhere>`;
}

/** Channel instructions (CLAUDE.md analog): inlined fully. */
export async function channelInstructions(channelId: string): Promise<string> {
	if (!channelId) return "";
	// Capped on purpose: these are inlined verbatim into every prompt for
	// the space, so the ceiling is a token budget, not a read limit.
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
