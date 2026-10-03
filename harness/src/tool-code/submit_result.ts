import type { Roostr } from "../tool-sdk";

export const description = "Submit your final result to the parent agent. Call exactly once when done.";
export const inputs = "content: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	await roostr.submitResult(typeof input.content === "string" ? input.content : "");
	return "result submitted";
}
