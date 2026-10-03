import type { ObjectJSON, Roostr } from "../tool-sdk";

export const description =
	"Send a durable question to agents on ANOTHER object's guest list (its Agent property), as a separate exchange thread. For an agent that is in this chat with you (a guest on the object you're working on), don't use this - make your reply the question, starting with \"@Their Name \", and they answer in the same chat. Every recipient receives its own DAG copy and answers asynchronously on its serving machine, including after being offline. Read replies with discussion_read using the returned threadId. To ask an agent that is not yet on the object, add it first with object_set_field(key=agent). Agents never create minds. Specify the complete group audience for each message; a reply preserves its exchange_id and reply_to.";
export const inputs =
	"object_ids: string[] - objects whose existing agents should receive this message\ntext: string\nexchange_id?: string - existing exchange id, or omit for a new exchange\nreply_to?: string - message id being answered in that exchange\ntitle?: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	// The request is kept on the object this turn is about, so that object
	// sees the reply; on the agent's own page, on the agent (its home). The
	// harness sends it from there, and only from a top-level turn.
	// Guest list rule: a recipient object must name the asked agent in its
	// `agent` property - adding someone there IS how they are brought in.
	const text = typeof input.text === "string" ? input.text.trim() : "";
	const ids = [...new Set(Array.isArray(input.object_ids) ? input.object_ids.filter((x): x is string => typeof x === "string") : [])];
	if (!ids.length || !text) throw new Error("recipient objects and nonempty text are required");
	const me = await roostr.get(roostr.context.agentId);
	const subject = await roostr.get(roostr.context.objectId || me.id);
	const space = await roostr.space();
	const nameOf = (o: ObjectJSON, fallback: string) => o.fields.name?.stringValue || fallback;
	const recipients: Array<{ objectId: string; agentId: string }> = [];
	for (const id of ids) {
		const target = await roostr.get(id);
		// The space itself may be asked (its own guests answer); anything else must live in it.
		if (target.typeKey !== "channel" || target.id !== space) await roostr.getInSpace(id);
		// An agent is reached at its home, its own object; anyone else at the object naming them.
		const endpoint = target.id;
		let holder: ObjectJSON | null = target;
		if (target.typeKey !== "agent") {
			const guests = roostr.guests(target.fields).filter((aid) => aid !== me.id);
			if (guests.length === 0) throw new Error(`"${nameOf(target, id)}" has no other agent on its guest list; add one with object_set_field(id, "agent", "<agent id>") first`);
			// One recipient per object: the first guest that is not the asker.
			holder = await roostr.get(guests[0]).catch(() => null);
		}
		if (!holder || holder.typeKey !== "agent") throw new Error(`the agent named on "${nameOf(target, id)}" does not exist`);
		if (holder.id === me.id) throw new Error("an agent cannot send a request to itself");
		// Both in this object's chat: a visible @-tag there reaches them and
		// keeps the person in the loop; a hidden exchange about this same
		// object only splits the conversation - continuing an old one too.
		if (roostr.context.objectId && roostr.guests(subject.fields).includes(holder.id)) {
			const name = nameOf(holder, "the agent");
			throw new Error(`${name} is in this chat with you. Don't use agent_ask, not even to continue an exchange: make your reply the question itself, starting "@${name} " - they see it and answer here.`);
		}
		if (recipients.some((r) => r.objectId === endpoint)) throw new Error("each recipient object must be distinct");
		recipients.push({ objectId: endpoint, agentId: holder.id });
	}
	const replyTo = typeof input.reply_to === "string" ? input.reply_to : "";
	const parent = replyTo ? subject.mailbox?.find((entry) => entry.message.id === replyTo)?.message : undefined;
	if (replyTo && !parent) throw new Error("reply_to must identify a message on your own object");
	const exchangeId = (typeof input.exchange_id === "string" ? input.exchange_id : "") || parent?.exchangeId || crypto.randomUUID();
	if (parent && parent.exchangeId !== exchangeId) throw new Error("reply belongs to a different exchange");
	const title = (typeof input.title === "string" ? input.title : "") || parent?.title || nameOf(me, me.id);
	const sent = await roostr.ask({ recipients, text, exchangeId, replyTo, title });
	return { ...sent, status: "queued", recipients };
}
