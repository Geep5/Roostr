/**
 * Skills — OMP's progressive-disclosure pattern (skill:// + description-only
 * prompt listing) on DAG objects instead of SKILL.md dirs:
 *   skill object  {name, description, key?} + body text blocks
 * The system prompt lists name+description only; the agent reads the body
 * on demand via the skill_read tool. Channel `instructions` objects are the
 * CLAUDE.md analog: their text is inlined into every prompt for agents in
 * that channel.
 *
 * An agent (or any object) lists the skills its work uses in its Skills
 * property (`skills`, links to skill objects). A skill with a `key` is
 * catalog software (browserless, google): the work then only runs on a
 * computer that has it working - the engine's serving resolver reads the
 * same links (core/serving.odin).
 */

import { fetchObject, query, queryAll, str, type ObjectJSON, type ValueJSON } from "./api";
import { machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { blockLine, listOrdinals } from "./surfaces";

export const SKILL_TYPE = "skill";
export const SKILLS_KEY = "skills";
/** The Roostr Guide Skill's `seed_key` (guide.ts): listed for every agent. */
export const GUIDE_SEED_KEY = "roostr-guide";

/** Skill object ids an object lists in its Skills property. */
export function skillIds(fields: Record<string, ValueJSON>): string[] {
	const v = fields[SKILLS_KEY];
	if (!v) return [];
	const items = v.valuesValue?.items ?? [v];
	return items.map((i) => i.linkValue?.targetId || i.stringValue || "").filter(Boolean);
}

/** The catalog keys of the machine skills an object's Skills need (skills with a `key`). */
export async function machineSkillKeys(fields: Record<string, ValueJSON>): Promise<string[]> {
	const keys: string[] = [];
	for (const id of skillIds(fields)) {
		const skill = await fetchObject(id).catch(() => null);
		const key = skill && !skill.deleted && skill.typeKey === SKILL_TYPE ? str(skill.fields, "key") : "";
		if (key && !keys.includes(key)) keys.push(key);
	}
	return keys;
}

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
	const ordinals = listOrdinals(obj);
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const roots = obj.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__discussion__");
	const out: string[] = [];
	const walk = (id: string) => {
		const b = byId.get(id);
		if (!b) return;
		const kind = b.content.custom?.contentType;
		if (kind === "chat" || kind === "discussion") return;
		const line = blockLine(b, ordinals.get(b.id));
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
 * from anywhere. An agent's Skills property narrows the list to the skills
 * it names; empty means everything above. The Roostr Guide (guide.ts) is
 * listed regardless: it is how Roostr itself works, which every agent
 * works in. A machine skill (one with a
 * `key`) is listed only while this machine has it working, and only to an
 * agent with the shell: `granted` = the gated built-ins its Tools give it
 * (tool-objects.ts), omitted = no agent to ask about.
 */
export async function listSkills(agentId?: string, granted?: ReadonlySet<string>): Promise<SkillListing[]> {
	// Dynamic: skillmgr imports objectText from this module, so a static
	// import here would be a module cycle.
	const { capabilities } = await import("./skillmgr");
	// A catalog skill is offered only once its capability object on this
	// machine is active - before that the skill stays invisible, however
	// the toggle looks.
	const ready = new Set(await capabilities());
	const agent = agentId ? await fetchObject(agentId).catch(() => null) : null;
	const only = new Set(agent ? skillIds(agent.fields) : []);
	const shell = !granted || granted.has("shell_exec");
	const rows = await queryAll({ type: SKILL_TYPE });
	return rows
		.map((r) => ({
			id: r.id,
			name: str(r.fields, "name") || r.id.slice(0, 8),
			description: str(r.fields, "description"),
			owner: str(r.fields, "agent"),
			key: str(r.fields, "key"),
			always: str(r.fields, "seed_key") === GUIDE_SEED_KEY,
		}))
		.filter((s) => {
			// Someone else's playbook: invisible, whoever is asking.
			if (s.owner !== "" && s.owner !== agentId) return false;
			if (only.size > 0 && !only.has(s.id) && !s.always) return false;
			// Machine skills are shell tools: no shell, no use listing them.
			if (s.key && !shell) return false;
			return !s.key || ready.has(s.key);
		})
		.map(({ key: _key, always: _always, ...listing }) => listing);
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
