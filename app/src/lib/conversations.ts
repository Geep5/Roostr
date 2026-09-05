/**
 * Conversation discovery for an object: every A2A chat its bound agent
 * participates in (or that links the object), as compact inbox rows.
 * One chat object is one conversation - object pages and the drawer are
 * projections of it, never copies.
 */

import { fetchObject, fetchQuery } from "$lib/api";
import { store } from "$lib/data.svelte";
import type { ObjectJSON } from "$lib/types";

export interface AgentThread {
	id: string;
	title: string;
	count: number;
	last: number;
	snippet: string;
	snippetWho: string;
}

/** meta.author is an agent uuid; resolve a short display name. */
export function whoName(author: string): string {
	if (!author || author.length !== 36) return "you";
	return store.summaries.find((s) => s.id === author)?.name || "agent";
}

/** Last chat message of an object's block tree (discussion or chat). */
export function lastMessage(obj: ObjectJSON): { text: string; author: string; count: number; last: number } {
	const msgs = obj.blocks.filter((b) => b.content.custom?.contentType === "chat");
	const meta = msgs[msgs.length - 1]?.content.custom?.meta ?? {};
	return {
		text: (meta["text"] ?? "").slice(0, 90),
		author: meta["author"] ?? "",
		count: msgs.length,
		last: Math.max(0, ...msgs.map((b) => Number(b.content.custom?.meta?.["ts"] ?? 0))),
	};
}

export async function loadAgentThreads(objectId: string): Promise<AgentThread[]> {
	// This object's bound agent, if one has been minted.
	const agentRes = await fetchQuery({
		type: "agent",
		filters: [{ key: "bound_object", condition: "equal", value: objectId }],
		limit: 1,
	});
	const agentId = agentRes.records[0]?.id ?? "";

	const res = await fetchQuery({ type: "chat", filters: [{ key: "a2a_pair", condition: "notEmpty" }], limit: 500 });
	const mine = res.records.filter((r) => {
		const linksMe = (r.fields["objects"]?.valuesValue?.items ?? []).some((i) => i.linkValue?.targetId === objectId);
		const participates =
			!!agentId && (r.fields["participants"]?.valuesValue?.items ?? []).some((i) => i.stringValue === agentId);
		return linksMe || participates;
	});
	const out: AgentThread[] = [];
	for (const r of mine.slice(0, 30)) {
		const chat = await fetchObject(r.id);
		const m = lastMessage(chat);
		out.push({
			id: r.id,
			title: r.fields["name"]?.stringValue ?? "Agents",
			count: m.count,
			last: m.last,
			snippet: m.text,
			snippetWho: whoName(m.author),
		});
	}
	return out.toSorted((a, b) => b.last - a.last);
}

export function agoShort(ts: number): string {
	if (!ts) return "";
	const m = Math.round((Date.now() - ts) / 60000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	if (m < 48 * 60) return `${Math.round(m / 60)}h`;
	return `${Math.round(m / 1440)}d`;
}