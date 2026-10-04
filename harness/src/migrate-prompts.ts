/**
 * Boot migration into the system_prompt object model (prompts.ts):
 * an agent's `kind` string becomes a `prompt` link to a system_prompt
 * object in the agent's space carrying the seed's standing prompt, model,
 * requirements, and skills. One object per (prompt x space): the first
 * agent of a kind in a space creates it, the rest reuse it, so editing
 * the object reconfigures every agent linked to it. assistant -> the
 * "Assistant" prompt (DEFAULT_SYSTEM, default model); a kind a private
 * extension adds (extensions.ts) -> that kind's prompt. A kind this
 * computer doesn't know may be an extension's it doesn't load: the agent
 * keeps its `kind` for a computer that does, and is not linked here.
 *
 * Runs with the other boot migrations, after migrate-capabilities, so
 * the prompt's `requires` links land on capability objects. Idempotent:
 * the `kind` field is deleted once the link lands, and a re-run finds
 * no `kind`.
 */
import { deleteField, fetchObject, queryAll, setField, str } from "./api";
import { linkValue } from "./capabilities";
import { DEFAULT_PROMPT, DEFAULT_SYSTEM, LEGACY_DEFAULT_SYSTEM, PROMPT_SEEDS, SYSTEM_PROMPT_TYPE, ensureAgentPrompt, ensureSystemPrompt, pageText, writePageText } from "./prompts";

export async function migratePrompts(): Promise<{ created: number; reused: number; linked: number; upgraded: number; moved: number }> {
	let created = 0;
	let reused = 0;
	let linked = 0;
	let upgraded = 0;
	for (const agent of await queryAll({ type: "agent", filters: [{ key: "kind", condition: "notEmpty" }] })) {
		const key = str(agent.fields, "kind");
		const seed = PROMPT_SEEDS.find((s) => s.key === key);
		if (!seed) continue;
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
	// No agent runs on a prompt the UI does not show: every non-subagent
	// without a live prompt link is pointed at its space's Assistant object.
	for (const agent of await queryAll({ type: "agent" })) {
		if (str(agent.fields, "spawn_parent")) continue;
		// Still waiting on a computer that knows its kind (above).
		if (str(agent.fields, "kind")) continue;
		try {
			const before = agent.fields["prompt"];
			const after = await ensureAgentPrompt({ ...agent, blocks: [], deleted: false, mailbox: [] });
			if (JSON.stringify(after.fields["prompt"]) !== JSON.stringify(before)) linked++;
		} catch (err) {
			console.error(`[migrate] prompt link failed for ${agent.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	// A prompt's text lived in a hidden `system` field; it now IS the page.
	// An Assistant object nobody edited still holds the pre-unification seed
	// verbatim and gets the unified text; everything else moves as written.
	// Only a page with no text of its own takes the field, so a human's page
	// edits are never overwritten; the field is then removed either way.
	let moved = 0;
	for (const row of await queryAll({ type: SYSTEM_PROMPT_TYPE })) {
		const legacy = str(row.fields, "system");
		if (!legacy) continue;
		const text = str(row.fields, "name") === DEFAULT_PROMPT.promptName && legacy === LEGACY_DEFAULT_SYSTEM ? DEFAULT_SYSTEM : legacy;
		if (text !== legacy) upgraded++;
		try {
			const prompt = await fetchObject(row.id);
			if (!pageText(prompt)) {
				await writePageText(row.id, text);
				moved++;
			}
			await deleteField(row.id, "system");
		} catch (err) {
			console.error(`[migrate] prompt text move failed for ${row.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
		}
	}
	return { created, reused, linked, upgraded, moved };
}
