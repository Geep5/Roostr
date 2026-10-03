import type { Roostr } from "../tool-sdk";

export const description = "Empty one of an object's properties (the Properties pane's Remove). The guest list (agent) and the repeat rule have their own tools; computed dates can't be cleared.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nkey: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing cleared. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const key = typeof input.key === "string" ? input.key : "";
	if (key === "repeat") return "error: nothing cleared. Stop a repeat with object_clear_repeat.";
	if (key === "agent") return "error: nothing cleared. Agents are not removed from a guest list by agents - ask the human.";
	const def = (await roostr.properties()).get(key);
	if (!def) return `error: nothing cleared. This space has no "${key}" property.`;
	if (def.readOnly) return `error: nothing cleared. ${def.name} is computed by the store.`;
	if (!(key in obj.fields)) return `Nothing cleared: ${def.name} is already empty.`;
	await roostr.mutate("delete_field", { object_id: obj.id, key });
	const after = await roostr.get(obj.id);
	// The engine may answer a cleared pin with its own error (an agent with no Served by): say so.
	const error = after.fields.error?.stringValue ?? "";
	return `${def.name} is now empty.${error && error !== (obj.fields.error?.stringValue ?? "") ? ` The object now shows: ${error}` : ""}`;
}
