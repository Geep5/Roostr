import type { Roostr } from "../tool-sdk";

export const description = "Mark the current occurrence of a recurring object done; its schedule advances to the next occurrence. Call it once, after the scheduled work is actually finished. Notes belong in your reply, not on the object.";
export const inputs = "object_id: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const obj = await roostr.writable(typeof input.object_id === "string" ? input.object_id : "");
	roostr.touch(obj.id);
	// The engine plans the next occurrence in this computer's local time.
	const { next } = await roostr.mutate("occurrence_complete", { object_id: obj.id, ...roostr.clock() });
	return typeof next === "number" ? `ok; next occurrence ${new Date(next).toLocaleString()}` : "ok";
}
