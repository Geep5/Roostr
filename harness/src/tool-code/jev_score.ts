import type { Roostr } from "../tool-sdk";

export const description =
	"Run one of your Jev Skills (a Skill with an Answer: Score, Choice or Yes or no) on objects: TypeSafe's Jev answers the Skill's question about each object in about a second, cheaply, and the answer is written as the Skill's property (e.g. Spam meter = 9) with how sure Jev was, so people can sort and filter by it. Pass many objects at once. Returns each object's value, the answer in words and how sure; act on those. Needs a TypeSafe credential in your Credentials.";
export const inputs =
	"skill: string - the Jev Skill's name (from your Skills list)\nobject_ids: string[] - the objects to score, in this space";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const skill = typeof input.skill === "string" ? input.skill.trim() : "";
	if (!skill) return "error: skill is required - the name of one of your Jev Skills";
	// Models sometimes send the list as JSON text, or one id as a string: read all three.
	let ids: unknown = input.object_ids;
	if (typeof ids === "string") {
		try {
			ids = JSON.parse(ids);
		} catch {
			ids = [ids];
		}
	}
	const list = (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim());
	if (list.length === 0) return "error: object_ids is empty - pass the ids of the objects to score";
	// Only objects in this space, like every built-in that takes ids.
	for (const id of list) await roostr.getInSpace(id);
	const rows = await roostr.jev(skill, list);
	for (const id of list) roostr.touch(id);
	return JSON.stringify(rows);
}
