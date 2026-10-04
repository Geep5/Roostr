import type { Roostr } from "../tool-sdk";

export const description = "List capability objects (one catalog skill on one computer) with their id, computer and status across computers. Returns status and errors, never credential values.";
export const inputs = "key?: string - optional catalog key";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const key = typeof input.key === "string" ? input.key : "";
	return (await roostr.capabilities()).filter((row) => !key || row.key === key);
}
