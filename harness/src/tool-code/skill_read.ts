import type { Roostr } from "../tool-sdk";

export const description = "Load a skill's full instructions by name. Call BEFORE starting any task that matches a listed skill.";
export const inputs = "name: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const name = typeof input.name === "string" ? input.name : "";
	// Only the skills this agent may read: someone else's playbook is not among them.
	const skills = await roostr.skills();
	const hit = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
	if (!hit) return `No skill named "${name}". Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`;
	return roostr.text(await roostr.get(hit.id)) || hit.description || "(skill has no body)";
}
