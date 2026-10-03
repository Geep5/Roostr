import type { Roostr } from "../tool-sdk";

export const description = "Read one conversation on an object (object_get shows only the body). Returns the last messages oldest-first with author names and timestamps. Use it when the current message refers to earlier conversation on that object.";
export const inputs = "id: string\nthread_id?: string - a conversation on that object; omit for the human discussion\nlimit?: number - max messages, default 30";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const threadId = typeof input.thread_id === "string" ? input.thread_id : "";
	const obj = await roostr.getInSpace(typeof input.id === "string" ? input.id : "");
	roostr.touch(obj.id);
	const msgs: Array<{ author: string; text: string; ts: number }> = [];
	for (const { block } of roostr.conversation(obj, threadId)) {
		const c = block.content.custom;
		if (c?.contentType !== "chat") continue;
		const meta = c.meta ?? {};
		if (!(meta["text"] ?? "").trim()) continue;
		msgs.push({ author: meta["author"] ?? "", text: meta["text"] ?? "", ts: Number(meta["ts"] ?? 0) });
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
	for (const m of tail) {
		if (names.has(m.author)) continue;
		if (m.author === roostr.context.agentId) names.set(m.author, "you");
		// A uuid author is an agent; anything else is a person's key.
		else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(m.author)) {
			const agent = await roostr.get(m.author).catch(() => null);
			names.set(m.author, agent?.fields.name?.stringValue || m.author.slice(0, 8));
		} else names.set(m.author, "user");
	}
	const lines = tail.map((m) => `${names.get(m.author)} \u00b7 ${new Date(m.ts).toISOString().slice(0, 16)}: ${m.text}`);
	return `${msgs.length} message(s) total, last ${tail.length}:\n${lines.join("\n")}`;
}
