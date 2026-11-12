/**
 * A property's role: the Properties pane section it shows under (Who, When,
 * State, Setup, Details), held in the relation's `role` field. The app reads
 * the same built-in places (gpui roostr-properties role.rs) for a relation
 * with no `role`; this seeds them so every reader agrees, and agents see the
 * same sections (object_get's `sections`).
 */

import { queryAll, setField, str, sv, type ValueJSON } from "./api";

export const ROLES = ["who", "when", "state", "setup", "details"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { who: "Who", when: "When", state: "State", setup: "Setup", details: "Details" };

/** The built-in places; any other property is Details. */
export const BUILTIN_ROLES: Readonly<Record<string, Role>> = {
	agent: "who",
	assignee: "who",
	served_by: "who",
	repo_path: "who",
	repeat: "when",
	repeat_instructions: "when",
	check_first: "when",
	due_date: "when",
	done: "state",
	status: "state",
	model: "setup",
	prompt: "setup",
	skills: "setup",
	tools: "setup",
	credentials: "setup",
	chat_color: "setup",
	capability: "setup",
	tool_inputs: "setup",
	tool_builtin: "setup",
	tool_version: "setup",
	jev_answer: "setup",
	jev_writes: "setup",
};

const isRole = (s: string): s is Role => (ROLES as readonly string[]).includes(s);

/** The role a relation's fields give it: its `role`, else the built-in place for its key. */
export function roleOf(fields: Record<string, ValueJSON>): Role {
	const set = str(fields, "role");
	return isRole(set) ? set : (BUILTIN_ROLES[str(fields, "key")] ?? "details");
}

/**
 * Boot: the built-in properties in every space get their role. Only where
 * `role` is absent - a role a person picked (on the property's page) is never
 * overwritten, and the next boot writes nothing. Returns how many it wrote.
 */
export async function seedPropertyRoles(): Promise<number> {
	let wrote = 0;
	for (const r of await queryAll({ type: "relation" })) {
		const role = BUILTIN_ROLES[str(r.fields, "key")];
		if (!role || r.fields["role"] !== undefined) continue;
		await setField(r.id, "role", sv(role));
		r.fields["role"] = sv(role);
		wrote += 1;
	}
	return wrote;
}
