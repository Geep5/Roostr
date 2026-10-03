import type { Roostr } from "../tool-sdk";

export const description = "The space census: every type (with the human's definition and count), every saved view, every agent alive. Free - use it to orient.";
export const inputs = "";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	// The same census the agent's prompt carries, built by the harness for both.
	return await roostr.spaceMap();
}
