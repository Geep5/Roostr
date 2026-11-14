import type { Roostr } from "../tool-sdk";

export const description = "Read one conversation on an object (object_get shows only the body). Returns the last messages oldest-first with author names and timestamps; an emoji reaction reads as one line saying who reacted with what to which message. Use it when the current message refers to earlier conversation on that object.";
export const inputs = "id: string\nthread_id?: string - a conversation on that object; omit for the human discussion\nlimit?: number - max messages, default 30";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const threadId = typeof input.thread_id === "string" ? input.thread_id : "";
	const obj = await roostr.getInSpace(typeof input.id === "string" ? input.id : "");
	roostr.touch(obj.id);
	const msgs: Array<{ author: string; text: string; ts: number; reaction?: { meta: Record<string, string>; target: Record<string, string> | undefined } }> = [];
	const rows = roostr.conversation(obj, threadId);
	for (const { block } of rows) {
		const c = block.content.custom;
		if (c?.contentType !== "chat") continue;
		const meta = c.meta ?? {};
		const ts = Number(meta["ts"] ?? 0);
		// A reaction is an event on another message, never words of its own.
		if (roostr.isReaction(meta)) {
			const target = rows.find((r) => r.id === meta["replyTo"])?.block.content.custom?.meta;
			msgs.push({ author: meta["author"] ?? "", text: "", ts, reaction: { meta, target } });
			continue;
		}
		if (!(meta["text"] ?? "").trim()) continue;
		msgs.push({ author: meta["author"] ?? "", text: meta["text"] ?? "", ts });
	}
	// Agent-to-agent messages ride in the object's mailbox, each on its exchange thread.
	for (const entry of obj.mailbox ?? []) {
		if (entry.threadId !== threadId) continue;
		const message = entry.message;
		msgs.push({ author: message.sender.agentId || message.author || message.sender.objectId, text: message.text, ts: message.sentAt });
	}
	msgs.sort((a, b) => a.ts - b.ts);
	if (msgs.length === 0) return threadId ? "(no messages in that conversation)" : "(no discussion on this object)";
	const limit = Math.max(1, Math.min(200, Number(input.limit) || 30));
	const tail = msgs.slice(-limit);
	const names = new Map<string, string>();
	for (const author of tail.flatMap((m) => [m.author, m.reaction?.target?.["author"] ?? ""])) {
		if (names.has(author)) continue;
		if (author === roostr.context.agentId) names.set(author, "you");
		// A uuid author is an agent; anything else is a person's key.
		else if (roostr.isAgentAuthor(author)) {
			const agent = await roostr.get(author).catch(() => null);
			names.set(author, agent?.fields.name?.stringValue || author.slice(0, 8));
		} else names.set(author, "user");
	}
	const lines = tail.map((m) => {
		const when = new Date(m.ts).toISOString().slice(0, 16);
		if (!m.reaction) return `${names.get(m.author)} \u00b7 ${when}: ${m.text}`;
		const target = m.reaction.target;
		return `${when}: ${roostr.reactionLine(names.get(m.author) ?? "user", m.reaction.meta, target ? { author: names.get(target["author"] ?? "") ?? "user", text: target["text"] ?? "" } : null)}`;
	});
	return `${msgs.length} message(s) total, last ${tail.length}:\n${lines.join("\n")}`;
}
