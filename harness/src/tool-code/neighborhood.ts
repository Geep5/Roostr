import type { Roostr } from "../tool-sdk";

export const description = "Typed connections of an object - links in/out with property names, collection memberships, saved views matching it, and which neighbors have agents. Defaults to your own object. Free - hop the graph with this instead of waking anyone.";
export const inputs = "id?: string - object id; omit for the object of this conversation";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const id = String(input.id ?? "") || roostr.context.objectId;
	if (!id) throw new Error("no id given and this turn is not running on an object");
	await roostr.getInSpace(id);
	return await roostr.neighborhood(id);
}
