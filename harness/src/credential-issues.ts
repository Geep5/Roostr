/**
 * Logins a turn could not use, per agent: one signed out or disconnected,
 * or none at all for a service it needed. Tools note them as they hit them;
 * whoever started the turn (the scheduler) takes them afterwards and puts
 * them on the object the run was for. A turn that runs into a dead or
 * missing login still "succeeds" - the agent reads why and says so - so
 * without this the task's Error would stay empty. The Error names what
 * blocked the run, which is how the scheduler retries it once that is fixed.
 *
 * Turns of one agent never overlap (index.ts `busy`), so per-agent state is
 * per-run state.
 */
export type CredentialIssue = { kind: "signed_out"; name: string } | { kind: "missing"; service: string };

const issues = new Map<string, Map<string, CredentialIssue>>();

/** Error-badge prefix for a dead login, on tasks and agents alike. */
export const CREDENTIAL_BADGE = "credential signed out: ";
/** Error-badge prefix for a login the agent does not list at all. */
export const CREDENTIAL_MISSING_BADGE = "credential missing: ";

export function noteCredentialIssue(agentId: string, issue: CredentialIssue): void {
	const noted = issues.get(agentId) ?? new Map<string, CredentialIssue>();
	noted.set(issue.kind === "signed_out" ? `s:${issue.name}` : `m:${issue.service}`, issue);
	issues.set(agentId, noted);
}

/** The logins this agent's run could not use since the last take, and forget them. */
export function takeCredentialIssues(agentId: string): CredentialIssue[] {
	const out = [...(issues.get(agentId)?.values() ?? [])];
	issues.delete(agentId);
	return out;
}

/** The Error text naming dead logins. */
export function credentialBadge(names: string[]): string {
	return `${CREDENTIAL_BADGE}${names.join(", ")} - reconnect ${names.length === 1 ? "it" : "them"}`.slice(0, 300);
}

/** The Error text naming services the agent has no login for. */
export function missingBadge(services: string[]): string {
	return `${CREDENTIAL_MISSING_BADGE}${services.join(", ")} - add ${services.length === 1 ? "a login for it" : "logins for them"} to the agent's Credentials`.slice(0, 300);
}

/** A blocked run's Error: dead logins first (the one to reconnect), else the missing ones. */
export function issuesBadge(found: CredentialIssue[]): string {
	const dead = found.flatMap((i) => (i.kind === "signed_out" ? [i.name] : []));
	return dead.length > 0 ? credentialBadge(dead) : missingBadge(found.flatMap((i) => (i.kind === "missing" ? [i.service] : [])));
}

/** What a blocked run's Error names, read back: the logins to reconnect, or the services to add. */
export function parseIssuesBadge(text: string): { signedOut: string[]; missing: string[] } | null {
	const list = (body: string, end: string) => body.slice(0, body.lastIndexOf(end) >= 0 ? body.lastIndexOf(end) : body.length).split(", ").map((s) => s.trim()).filter(Boolean);
	if (text.startsWith(CREDENTIAL_BADGE)) return { signedOut: list(text.slice(CREDENTIAL_BADGE.length), " - reconnect "), missing: [] };
	if (text.startsWith(CREDENTIAL_MISSING_BADGE)) return { signedOut: [], missing: list(text.slice(CREDENTIAL_MISSING_BADGE.length), " - add ") };
	return null;
}

/** Put the blocked-login badge on an object, unless it carries another Error (a person's or another writer's). */
export async function badgeLoginIssues(objectId: string, found: CredentialIssue[]): Promise<void> {
	const { fetchObject, setField, str, sv } = await import("./api");
	const current = str((await fetchObject(objectId)).fields, "error");
	const next = issuesBadge(found);
	if ((!current || parseIssuesBadge(current)) && current !== next) await setField(objectId, "error", sv(next));
}
