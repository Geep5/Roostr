import type { Roostr } from "../tool-sdk";

export const description = "Pin an object to its space's sidebar (last, as the app's Pin to space) - or, with pinned=false, unpin it. Changes only where the object shows, nothing about it.";
export const inputs = "id?: string - object id; omit for the object of this conversation\npinned?: boolean - false unpins (default true)";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = (typeof input.id === "string" ? input.id : "") || roostr.context.objectId;
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const pin = input.pinned !== false && input.pinned !== "false";
	const was = Boolean(obj.fields["pin_order"]?.stringValue);
	await roostr.mutate(pin ? "pin" : "unpin", { object_id: obj.id });
	if (pin) return was ? "Already pinned; its place in the sidebar is unchanged." : "Pinned: it is now last in its space's sidebar.";
	return was ? "Unpinned: it is off its space's sidebar." : "It was not pinned; nothing changed.";
}
