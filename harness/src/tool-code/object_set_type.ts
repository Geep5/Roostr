import type { Roostr } from "../tool-sdk";

export const description = "Change an object's type (e.g. note -> task) to one of this space's types; its text, properties and history stay. Infrastructure (agents, computers, spaces, properties, types, templates, queries, collections) is never retyped.";
export const inputs = "id?: string - object id; omit for the object of this conversation\ntype: string - type key, e.g. task";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing changed. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const key = typeof input.type === "string" ? input.type : "";
	// Infrastructure types: never retyped, and nothing is retyped into them.
	const fixed: Record<string, true> = { agent: true, machine: true, install: true, capability: true, channel: true, relation: true, type: true, template: true, query: true, collection: true, set: true, chat: true, skill: true, tool: true };
	if (fixed[obj.typeKey] === true) return `error: nothing changed. A ${obj.typeKey} object keeps its type.`;
	if (fixed[key] === true) return `error: nothing changed. Objects are not turned into ${key} objects this way.`;
	const types = await roostr.types();
	const t = types.get(key);
	if (!t) {
		const offered = [...types.values()].filter((d) => fixed[d.key] !== true).map((d) => `${d.key} (${d.name})`).join(", ");
		return `error: nothing changed. No type "${key}" in this space; types here: ${offered}.`;
	}
	if (obj.typeKey === key) return `Nothing changed: it is already a ${t.name}.`;
	await roostr.mutate("set_type", { object_id: obj.id, type_key: key });
	const after = await roostr.get(obj.id);
	return `It is now a ${types.get(after.typeKey)?.name ?? after.typeKey}.`;
}
