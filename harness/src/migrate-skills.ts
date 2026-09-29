/**
 * One-time move from `requires` to the Skills property.
 *
 * `requires` linked per-machine capability objects (or held catalog keys);
 * a system_prompt carried its own `requires` and `skills`. Now an object
 * lists skill objects in Skills and nothing else routes it (skills.ts):
 *
 *  - a catalog key becomes a link to that skill's object;
 *  - a login key (x, discord-bot...) is a Credential now: an agent gets the
 *    matching Credential this computer looks after in its Credentials;
 *  - a prompt's `requires`/`skills` fold into each agent that links it.
 *
 * An agent is migrated by the computer that serves it (the one whose
 * Credentials it can link, and whose old harness still reads `requires`
 * until it updates); other objects by any computer. A prompt's fields are
 * cleared once every agent linking it has been folded. Idempotent: a re-run
 * finds nothing left to move.
 */
import { deleteField, queryAll, setField, str, type QueryRow, type ValueJSON } from "./api";
import { CAPABILITY_TYPE, linkTarget, linkValue } from "./capabilities";
import { localCredentials } from "./credential-objects";
import { seedFor } from "./credentials";
import { promptTarget, SYSTEM_PROMPT_TYPE } from "./prompts";
import { machineId } from "./roster";
import { SKILL_TYPE, SKILLS_KEY, skillIds } from "./skills";

const items = (v: ValueJSON | undefined): ValueJSON[] => (v ? (v.valuesValue?.items ?? [v]) : []);

export async function migrateSkills(): Promise<{ objects: number; agents: number; prompts: number; unresolved: string[] }> {
	const me = await machineId();
	const capKey = new Map((await queryAll({ type: CAPABILITY_TYPE })).map((r) => [r.id, str(r.fields, "key")]));
	const skills = await queryAll({ type: SKILL_TYPE });
	const skillByKey = new Map(skills.filter((r) => str(r.fields, "key")).map((r) => [str(r.fields, "key"), r.id]));
	const skillByName = new Map(skills.map((r) => [str(r.fields, "name").toLowerCase(), r.id]));
	const prompts = new Map((await queryAll({ type: SYSTEM_PROMPT_TYPE })).map((r) => [r.id, r]));
	const unresolved: string[] = [];

	/** Catalog/login keys a `requires` value names. */
	const requiredKeys = (v: ValueJSON | undefined): string[] => items(v).map((i) => (i.linkValue ? capKey.get(i.linkValue.targetId) : i.stringValue) ?? "").filter(Boolean);
	/** Skill ids for keys and a prompt's `skills` items; login keys are returned apart. */
	const resolve = (keys: string[], promptSkills: ValueJSON[]): { skillIds: string[]; logins: string[] } => {
		const ids: string[] = [];
		const logins: string[] = [];
		for (const key of keys) {
			if (seedFor(key)) logins.push(key);
			else if (skillByKey.has(key)) ids.push(skillByKey.get(key)!);
			else unresolved.push(key);
		}
		for (const i of promptSkills) {
			const id = i.linkValue?.targetId || skillByName.get((i.stringValue ?? "").toLowerCase()) || "";
			if (id) ids.push(id);
		}
		return { skillIds: ids, logins };
	};
	const merge = async (row: QueryRow, add: string[], key: string, current: string[]): Promise<void> => {
		const next = [...new Set([...current, ...add])];
		if (next.length > current.length) await setField(row.id, key, { valuesValue: { items: next.map(linkValue) } });
	};
	const credentialIds = (fields: Record<string, ValueJSON>): string[] => items(fields["credentials"]).map((i) => i.linkValue?.targetId || i.stringValue || "").filter(Boolean);

	let objects = 0;
	let agents = 0;
	const agentRows = await queryAll({ type: "agent" });
	const pinOf = (r: QueryRow) => linkTarget(r.fields, "served_by");
	for (const row of agentRows) {
		if (pinOf(row) !== me) continue;
		const prompt = prompts.get(promptTarget(row.fields));
		const keys = [...requiredKeys(row.fields["requires"]), ...(prompt ? requiredKeys(prompt.fields["requires"]) : [])];
		const promptSkills = prompt ? items(prompt.fields["skills"]) : [];
		if (keys.length === 0 && promptSkills.length === 0 && !row.fields["requires"]) continue;
		const { skillIds: ids, logins } = resolve(keys, promptSkills);
		await merge(row, ids, SKILLS_KEY, skillIds(row.fields));
		const creds = localCredentials().filter((c) => logins.includes(c.service) && c.status === "active").map((c) => c.id);
		await merge(row, creds, "credentials", credentialIds(row.fields));
		if (row.fields["requires"]) await deleteField(row.id, "requires");
		agents += 1;
	}
	for (const row of await queryAll({ filters: [{ key: "requires", condition: "notEmpty" }] })) {
		if (row.typeKey === "agent" || row.typeKey === SYSTEM_PROMPT_TYPE) continue;
		const { skillIds: ids } = resolve(requiredKeys(row.fields["requires"]), []);
		await merge(row, ids, SKILLS_KEY, skillIds(row.fields));
		await deleteField(row.id, "requires");
		objects += 1;
	}
	// A prompt is done once no agent linking it still waits on another computer.
	let cleared = 0;
	for (const prompt of prompts.values()) {
		if (!prompt.fields["requires"] && !prompt.fields["skills"]) continue;
		const users = agentRows.filter((a) => promptTarget(a.fields) === prompt.id);
		if (users.some((a) => pinOf(a) !== me)) continue;
		for (const key of ["requires", "skills"]) if (prompt.fields[key]) await deleteField(prompt.id, key);
		cleared += 1;
	}
	return { objects, agents, prompts: cleared, unresolved: [...new Set(unresolved)] };
}
