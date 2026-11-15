import type { Roostr } from "../tool-sdk";

export const description = "The person's open tabs in the Roostr app for a space, in order, each with what it shows. Tab #1 is the browsing tab (navigation shows pages there). Which tab is selected is up to each device; no tool can select one.";
export const inputs = "space?: string - space id; omit for this conversation's space";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const space = (typeof input.space === "string" ? input.space.trim() : "") || (await roostr.space());
	return roostr.tabs.show(space, await roostr.tabs.get(space));
}
