/**
 * Genesis: an agent's first look at where it is. Before the first model
 * call of a conversation - and again whenever one of its important
 * properties changes - the runner has the agent read, as real tool calls
 * kept in the transcript:
 *   object_get(itself)                  its properties and page body
 *   object_get(the object it is on)     when that is another object
 *   discussion_read(this conversation)  what has been said here
 * Every later turn sees those reads in its history, so they are not
 * repeated. The first read carries the genesis fingerprint in its input
 * (`genesis`), which is how a conversation remembers which version of the
 * agent last read itself; handlers ignore the extra key.
 */

import type { ObjectJSON, ValueJSON } from "./api";
import { HUMAN_THREAD, type ConvRef } from "./conv";
import type { ClassifiedItem } from "./types";

/** Properties whose change means the agent should look at itself again. */
export const GENESIS_KEYS = ["name", "prompt", "skills", "credentials", "served_by", "repo_path"] as const;

/** Stable text for a field however it is stored (string, link, list of either). */
function fieldText(v: ValueJSON | undefined): string {
	if (!v) return "";
	if (v.stringValue !== undefined) return v.stringValue;
	if (v.linkValue) return v.linkValue.targetId;
	if (v.valuesValue) return v.valuesValue.items.map((i) => i.linkValue?.targetId ?? i.stringValue ?? "").join(",");
	return JSON.stringify(v);
}

/**
 * The agent's identity as genesis sees it: name, model, prompt (link and the
 * prompt's text, so editing the prompt object counts), skills, credentials,
 * computer and project folder. `model` is the one the turn resolved (the
 * agent's Model, else its prompt's). Anything else - tags, status, memory -
 * leaves it unchanged.
 */
export function genesisFingerprint(agent: Pick<ObjectJSON, "fields">, model: string, promptText: string): string {
	const parts = [...GENESIS_KEYS.map((k) => `${k}=${fieldText(agent.fields[k])}`), `model=${model}`, `prompt_text=${promptText}`];
	return Bun.hash(parts.join("\n")).toString(16);
}

/** The fingerprint of the latest genesis still in this conversation's context, or "". */
export function lastGenesis(items: ClassifiedItem[]): string {
	for (let i = items.length - 1; i >= 0; i--) {
		const it = items[i];
		if (it.kind === "tool_use" && typeof it.input["genesis"] === "string") return it.input["genesis"];
	}
	return "";
}

export interface GenesisCall {
	name: string;
	input: Record<string, unknown>;
}

/** The reads genesis makes, in order; the first carries the fingerprint. */
export function genesisCalls(agent: Pick<ObjectJSON, "id" | "fields">, ref: ConvRef, fingerprint: string): GenesisCall[] {
	const calls: GenesisCall[] = [{ name: "object_get", input: { id: agent.id, genesis: fingerprint } }];
	if (ref.objectId !== agent.id) calls.push({ name: "object_get", input: { id: ref.objectId } });
	calls.push({ name: "discussion_read", input: ref.threadId === HUMAN_THREAD ? { id: ref.objectId } : { id: ref.objectId, thread_id: ref.threadId } });
	return calls;
}
