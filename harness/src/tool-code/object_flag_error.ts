import type { Roostr } from "../tool-sdk";

export const description = "Flag the object of this conversation as broken: set its Error property so the human sees it in their views (they can sort and filter by it). Pass a short reason. Call again with an empty message once the problem is resolved to clear it. Only turns running on an object can call this.";
export const inputs = "message?: string - short reason; empty clears the flag";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = roostr.context.objectId;
	if (!id) return "error: this turn is not running on an object, so there is nothing to flag";
	const message = (typeof input.message === "string" ? input.message : "").trim().slice(0, 300);
	roostr.touch(id);
	if (!message) {
		await roostr.deleteField(id, "error");
		return "ok: error flag cleared";
	}
	await roostr.setField(id, "error", { stringValue: message });
	return `ok: error flagged ("${message}") - it shows in the human's views until cleared. Tell them plainly.`;
}
