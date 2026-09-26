/**
 * Boot migration into the system_prompt object model (prompts.ts):
 * an agent's `kind` string becomes a `prompt` link to a system_prompt
 * object in the agent's space carrying the seed's standing prompt, model,
 * requirements, and skills. One object per (prompt x space): the first
 * agent of a kind in a space creates it, the rest reuse it, so editing
 * the object reconfigures every agent linked to it. assistant -> the
 * "Assistant" prompt (DEFAULT_SYSTEM, default model); marco -> the
 * "Marco" prompt (kinds/marco.md, kimi-k3, requires links to the
 * matcherino-dev and discord-bot capability objects). An unknown kind
 * key seeds from the assistant defaults.
 *
 * Runs with the other boot migrations, after migrate-capabilities, so
 * the prompt's `requires` links land on capability objects. Idempotent:
 * the `kind` field is deleted once the link lands, and a re-run finds
 * no `kind`.
 */
import { deleteField, queryAll, setField, str } from "./api";
import { linkValue } from "./capabilities";
import { DEFAULT_PROMPT, PROMPT_SEEDS, ensureSystemPrompt } from "./prompts";

export async function migratePrompts(): Promise<{ created: number; reused: number; linked: number }> {
	let created = 0;
	let reused = 0;
	let linked = 0;
	for (const agent of await queryAll({ type: "agent", filters: [{ key: "kind", condition: "notEmpty" }] })) {
		const key = str(agent.fields, "kind");
		const seed = PROMPT_SEEDS.find((s) => s.key === key) ?? DEFAULT_PROMPT;
		try {
			const prompt = await ensureSystemPrompt(seed, str(agent.fields, "channel"));
			if (prompt.created) created++;
			else reused++;
			await setField(agent.id, "prompt", linkValue(prompt.id));
			await deleteField(agent.id, "kind");
			linked++;
		} catch (err) {
			const name = str(agent.fields, "name") || agent.id.slice(0, 8);
			console.error(`[migrate] prompt cutover failed for "${name}":`, err instanceof Error ? err.message : err);
		}
	}
	return { created, reused, linked };
}
