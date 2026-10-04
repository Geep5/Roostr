import type { Roostr } from "../tool-sdk";

export const description =
	"Request setup or maintenance from a capability object's computer. This only sends a durable request: a human must approve there before anything executes. Never put passwords, tokens, cookies or other secrets in the text. Use capability_list to find the capability id.";
export const inputs = "capability_object_id: string\noperation: skill.install|skill.enable|skill.disable|skill.uninstall|skill.check\ntext?: string - Why this action is needed; no secrets.";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const sent = await roostr.requestCapability(
		typeof input.capability_object_id === "string" ? input.capability_object_id : "",
		typeof input.operation === "string" ? input.operation : "",
		typeof input.text === "string" ? input.text : "",
	);
	return { ...sent, status: "awaiting owner-machine approval" };
}
