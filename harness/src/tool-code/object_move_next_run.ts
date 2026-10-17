import type { Roostr } from "../tool-sdk";

export const description = "Move the next run of a recurring object to one day, once - e.g. Grant says something will be ready Tuesday, so check back then. It runs that day at the schedule's usual time; afterwards the schedule carries on as before (the rule is not changed). The reply states the new date in words: check it is the day you meant.";
export const inputs = "id?: string - object id; omit for the object of this conversation\ndate: string - the day of the next run, YYYY-MM-DD\nreason: string - why, in a few words (Grant's words when he gave the date)";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const obj = await roostr.writable(typeof input.id === "string" && input.id ? input.id : roostr.context.objectId);
	roostr.touch(obj.id);
	const before = obj.fields["repeat"]?.mapValue?.entries?.["next"]?.intValue;
	// The engine places the run at the rule's time in this computer's local time.
	const { next } = await roostr.mutate("occurrence_move", {
		object_id: obj.id,
		date: String(input.date ?? "").trim().slice(0, 10),
		by: roostr.context.agentId,
		reason: String(input.reason ?? "").trim().slice(0, 200),
		...roostr.clock(),
	});
	const when = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
	return typeof next === "number" ? `ok; next run ${when(next)}${typeof before === "number" ? ` (was ${when(before)})` : ""}` : "ok";
}
