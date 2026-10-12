import type { Roostr } from "../tool-sdk";

export const description = "Empty one of an object's properties (the Properties pane's Remove). key=agent takes agents OFF the object's guest list: the agent ids in `value` (comma-separated), or every agent when `value` is empty. The repeat rule has its own tool (object_clear_repeat); computed dates can't be cleared.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nkey: string\nvalue?: string - key=agent only: the agent id(s) to remove";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing cleared. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const key = typeof input.key === "string" ? input.key : "";
	if (key === "repeat") return "error: nothing cleared. Stop a repeat with object_clear_repeat.";
	if (key === "agent") {
		const guests = roostr.guests(obj.fields);
		const removing = (typeof input.value === "string" ? input.value : "").split(",").map((s) => s.trim()).filter(Boolean);
		const unknown = removing.filter((aid) => !guests.includes(aid));
		if (unknown.length) return `error: nothing removed. Not on this object's guest list: ${unknown.join(", ")}. Guests: ${guests.join(", ") || "none"}.`;
		const keep = removing.length ? guests.filter((aid) => !removing.includes(aid)) : [];
		if (keep.length === guests.length) return "Nothing removed: no agent is on this object's guest list.";
		if (keep.length) await roostr.mutate("set_field", { object_id: obj.id, key, value: { valuesValue: { items: keep.map((s) => ({ stringValue: s })) } } });
		else await roostr.mutate("delete_field", { object_id: obj.id, key });
		const names = await Promise.all(keep.map(async (aid) => (await roostr.get(aid).catch(() => null))?.fields["name"]?.stringValue || aid));
		return `Agent is now: ${names.join(", ") || "(empty)"}`;
	}
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
