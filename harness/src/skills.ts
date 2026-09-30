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

import { createObject, fetchObject, mutate, query, queryAll, setField, str, sv, type ObjectJSON, type ValueJSON } from "./api";
import { machines, serverOf } from "./machine";
import { machineId } from "./roster";
import { blockLine, listOrdinals } from "./surfaces";

export const SKILL_TYPE = "skill";
export const SKILLS_KEY = "skills";

/**
 * Tools a skill grants (`grants` = a tool name). Running commands on the
 * serving computer and fetching the web are the two powers an agent could
 * turn against that computer or use to send data out, so they are page
 * items like any other: an agent has them only while its Skills list the
 * skill - a normal agent lists both, a support agent that reads mail from
 * strangers simply doesn't. Grant skills count only when named: they never
 * narrow an agent's other skills, and "no skills listed" never grants them.
 */
export const GRANTS_KEY = "grants";
export const GRANT_SKILLS: Array<{ name: string; tool: string; description: string }> = [
	{ name: "shell", tool: "shell_exec", description: "Run commands on the computer that serves you (shell_exec). Machine skills like google and browserless need it." },
	{ name: "web", tool: "web_fetch", description: "Fetch public web pages (web_fetch)." },
];
/** Tools only a granting skill unlocks. */
export const GATED_TOOLS = new Set(GRANT_SKILLS.map((g) => g.tool));

/** The gated tools an agent's Skills grant it. */
export async function grantedTools(fields: Record<string, ValueJSON>): Promise<Set<string>> {
	const out = new Set<string>();
	for (const id of skillIds(fields)) {
		const skill = await fetchObject(id).catch(() => null);
		const tool = skill && !skill.deleted && skill.typeKey === SKILL_TYPE ? str(skill.fields, GRANTS_KEY) : "";
		if (tool) out.add(tool);
	}
	return out;
}

/**
 * Make the grant skills exist, once for the vault. The run that creates
 * them also lists them on every agent and every agent template there is,
 * so no existing agent loses a power it had; after that they are ordinary
 * page items - remove one and it stays removed.
 */
export async function seedGrantSkills(): Promise<{ created: string[]; agents: number; templates: number }> {
	const rows = await queryAll({ type: SKILL_TYPE });
	const created: string[] = [];
	const ids: string[] = [];
	for (const g of GRANT_SKILLS) {
		const hit = rows.find((r) => str(r.fields, GRANTS_KEY) === g.tool);
		if (hit) {
			ids.push(hit.id);
			continue;
		}
		const { id } = await createObject(g.name, SKILL_TYPE, { name: sv(g.name), description: sv(g.description), [GRANTS_KEY]: sv(g.tool), scope: sv("global") });
		created.push(g.name);
		ids.push(id);
	}
	if (created.length === 0) return { created, agents: 0, templates: 0 };
	const add = async (obj: { id: string; fields: Record<string, ValueJSON> }) => {
		const have = skillIds(obj.fields);
		const next = [...have, ...ids.filter((id) => !have.includes(id))];
		if (next.length === have.length) return false;
		await setField(obj.id, SKILLS_KEY, { valuesValue: { items: next.map((id) => ({ linkValue: { relationKey: SKILLS_KEY, targetId: id } })) } });
		return true;
	};
	let agents = 0;
	for (const a of await queryAll({ type: "agent" })) if (!str(a.fields, "spawn_parent") && (await add(a))) agents += 1;
	let templates = 0;
	for (const t of await queryAll({ type: "template" })) if (str(t.fields, "target_type").startsWith("bundled-type-agent-") && (await add(t))) templates += 1;
	return { created, agents, templates };
}

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

/** The skill object for a catalog key, if one exists yet (a machine creates it on first install). */
export async function skillForKey(key: string): Promise<{ id: string; name: string } | null> {
	const hit = (await queryAll({ type: SKILL_TYPE })).find((r) => str(r.fields, "key") === key);
	return hit ? { id: hit.id, name: str(hit.fields, "name") || key } : null;
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
 * it names; empty means everything above. A machine skill (one with a
 * `key`) is listed only while this machine has it working.
 */
export async function listSkills(agentId?: string): Promise<SkillListing[]> {
	// Dynamic: skillmgr imports objectText from this module, so a static
	// import here would be a module cycle.
	const { capabilities } = await import("./skillmgr");
	// A catalog skill is offered only once its capability object on this
	// machine is fully set up (served_by + active install) - before that the
	// skill stays invisible, however the toggle looks.
	const ready = new Set(await capabilities());
	const agent = agentId ? await fetchObject(agentId).catch(() => null) : null;
	const rows = await queryAll({ type: SKILL_TYPE });
	const grantIds = new Set(rows.filter((r) => str(r.fields, GRANTS_KEY)).map((r) => r.id));
	const listed = agent ? skillIds(agent.fields) : [];
	// Grant skills never narrow: "only these" is about the other skills.
	const only = new Set(listed.filter((id) => !grantIds.has(id)));
	const shell = !agent || listed.some((id) => rows.find((r) => r.id === id && str(r.fields, GRANTS_KEY) === "shell_exec"));
	return rows
		.map((r) => ({
			id: r.id,
			name: str(r.fields, "name") || r.id.slice(0, 8),
			description: str(r.fields, "description"),
			owner: str(r.fields, "agent"),
			key: str(r.fields, "key"),
			grant: grantIds.has(r.id),
		}))
		.filter((s) => {
			// Someone else's playbook: invisible, whoever is asking.
			if (s.owner !== "" && s.owner !== agentId) return false;
			// A grant skill is listed only where it is named.
			if (s.grant) return !agent || listed.includes(s.id);
			if (only.size > 0 && !only.has(s.id)) return false;
			// Machine skills are shell tools: no shell, no use listing them.
			if (s.key && !shell) return false;
			return !s.key || ready.has(s.key);
		})
		.map(({ key: _key, grant: _grant, ...listing }) => listing);
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
