/**
 * One-time move of shell and web from Skills to Tools.
 *
 * The 'shell' and 'web' skills (`grants` = shell_exec / web_fetch) once
 * granted those built-ins; now an agent's Tools property does
 * (tool-objects.ts). Every agent and agent template that lists one of those
 * skills gets the matching built-in Tool object of its space in its Tools,
 * and the skill leaves its Skills - so nothing loses access, and the skills
 * no longer narrow its skill list. The skill objects themselves stay.
 *
 * An agent is migrated by the computer that serves it (whose old harness
 * still reads the skills until it updates); unserved agents and templates
 * by any computer. Idempotent: a re-run finds nothing left to move.
 */
import { deleteField, queryAll, setField, str, type QueryRow } from "./api";
import { machineId } from "./roster";
import { SKILL_TYPE, SKILLS_KEY, skillIds } from "./skills";
import { TOOLS_KEY, ensureBuiltinTools, linkIds, linkList } from "./tool-objects";

export async function migrateToolGrants(): Promise<{ agents: number; templates: number }> {
	// skill id -> the built-in it granted
	const grants = new Map<string, string>();
	for (const r of await queryAll({ type: SKILL_TYPE })) if (str(r.fields, "grants")) grants.set(r.id, str(r.fields, "grants"));
	if (grants.size === 0) return { agents: 0, templates: 0 };
	const me = await machineId();

	const move = async (obj: QueryRow): Promise<boolean> => {
		const skills = skillIds(obj.fields);
		const space = str(obj.fields, "channel");
		if (!space || !skills.some((id) => grants.has(id))) return false;
		const builtins = await ensureBuiltinTools(space);
		const tools = linkIds(obj.fields, TOOLS_KEY);
		const moved = new Set<string>();
		for (const skill of skills) {
			const toolId = builtins.get(grants.get(skill) ?? "");
			if (!toolId) continue;
			if (!tools.includes(toolId)) tools.push(toolId);
			moved.add(skill);
		}
		if (moved.size === 0) return false;
		await setField(obj.id, TOOLS_KEY, linkList(TOOLS_KEY, tools));
		const keep = skills.filter((id) => !moved.has(id));
		await (keep.length ? setField(obj.id, SKILLS_KEY, linkList(SKILLS_KEY, keep)) : deleteField(obj.id, SKILLS_KEY));
		return true;
	};

	let agents = 0;
	for (const a of await queryAll({ type: "agent" })) {
		if (str(a.fields, "spawn_parent")) continue;
		const pin = str(a.fields, "served_by");
		if (pin && pin !== me) continue;
		if (await move(a)) agents += 1;
	}
	let templates = 0;
	for (const t of await queryAll({ type: "template" })) {
		if (str(t.fields, "target_type").startsWith("bundled-type-agent-") && (await move(t))) templates += 1;
	}
	return { agents, templates };
}
