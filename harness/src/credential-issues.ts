/**
 * Credentials a turn found signed out or disconnected, per agent. Tools note
 * them as they hit them; whoever started the turn (the scheduler) takes them
 * afterwards and puts them on the object the run was for. A turn that runs
 * into a dead login still "succeeds" - the agent reads why and says so - so
 * without this the task's Error would stay empty.
 *
 * Turns of one agent never overlap (index.ts `busy`), so per-agent state is
 * per-run state.
 */
const issues = new Map<string, Set<string>>();

/** Error-badge prefix for a dead login, on tasks and agents alike. */
export const CREDENTIAL_BADGE = "credential signed out: ";

export function noteCredentialIssue(agentId: string, credentialName: string): void {
	const names = issues.get(agentId) ?? new Set<string>();
	names.add(credentialName);
	issues.set(agentId, names);
}

/** The credentials this agent's run hit since the last take, and forget them. */
export function takeCredentialIssues(agentId: string): string[] {
	const names = [...(issues.get(agentId) ?? [])];
	issues.delete(agentId);
	return names;
}

/** The Error text naming dead logins. */
export function credentialBadge(names: string[]): string {
	return `${CREDENTIAL_BADGE}${names.join(", ")} - reconnect ${names.length === 1 ? "it" : "them"}`.slice(0, 300);
}
