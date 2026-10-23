/**
 * Every problem an agent runs into is on the agent's own Error, not only on
 * the object it was working on: a failed turn, a failed helper, a signed-out
 * login, missing software, failed scoring. The agent is where a person looks
 * when "it doesn't work".
 *
 * Per turn: whatever is raised during a turn stays; a later turn that runs
 * clean - nothing raised, nothing thrown - clears it. Only these automatic
 * badges are ever touched: an Error a person (or another writer: Project
 * folder, a credential that is not connected) put there is left alone.
 */

import { deleteField, fetchObject, setField, str, sv } from "./api";

/** The automatic badges this module owns, by prefix. */
export const RUN_FAILED = "run failed: ";
const OWN = [RUN_FAILED, "helper agent failed: ", "credential signed out: ", "credential missing: ", "needs ", "scoring failed: "];

const owned = (text: string) => OWN.some((p) => text.startsWith(p));

/** Agents that raised something during their current turn. */
const raised = new Set<string>();

/** A turn starts: nothing raised yet. */
export function beginAgentTurn(agentId: string): void {
	raised.delete(agentId);
}

/** Whether the agent's current turn has raised anything: a turn that did is not a clean one. */
export function raisedThisTurn(agentId: string): boolean {
	return raised.has(agentId);
}

/** Put `text` on the agent's Error (unless it carries an Error this module doesn't own). Never throws. */
export async function flagAgent(agentId: string, text: string): Promise<void> {
	raised.add(agentId);
	try {
		const current = str((await fetchObject(agentId)).fields, "error");
		const next = text.slice(0, 300);
		if ((!current || owned(current)) && current !== next) await setField(agentId, "error", sv(next));
	} catch (err) {
		console.error(`[harness] error badge failed for ${agentId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
	}
}

/** A turn ended: a failure is its Error; a clean turn clears what an earlier one raised. Never throws. */
export async function settleAgentTurn(agentId: string, failure: string): Promise<void> {
	if (failure) return flagAgent(agentId, RUN_FAILED + failure);
	if (raised.has(agentId)) return;
	try {
		if (owned(str((await fetchObject(agentId)).fields, "error"))) await deleteField(agentId, "error");
	} catch (err) {
		console.error(`[harness] error badge failed for ${agentId.slice(0, 8)}:`, err instanceof Error ? err.message : err);
	}
}
