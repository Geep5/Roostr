import type { Roostr } from "../tool-sdk";

export const description = "Post an UNPROMPTED chat message on some object's discussion. NEVER use this to answer the message you are currently replying to — your final reply text is delivered to the asking surface automatically.";
export const inputs = "object_id: string\ntext: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = typeof input.object_id === "string" ? input.object_id : "";
	await roostr.getInSpace(id);
	// An object id alone addresses its human discussion; agent-to-agent
	// talk has its own thread (agent_ask) and never lands here.
	await roostr.reply(id, typeof input.text === "string" ? input.text : "");
	return "ok";
}
