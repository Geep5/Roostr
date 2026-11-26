/**
 * Finder: a person's private chat that gets a request to the right page and
 * agent of a space (space-defaults.ts seeds each space's Finder agent).
 *
 * A session is a `finder_session` object with no space - so it lives in the
 * person's own private stream - naming the space in `finder_space`. The app
 * makes a new one each time the Finder bubble opens. When the person posts,
 * the computer serving that space's Finder answers in the session as Finder:
 * with the agent's own System prompt, Model and Credentials, it searches the
 * space's pages (`find_pages`), offers choices (`ask`: written to
 * `finder_options`, shown as buttons) and hands off (`hand_off`): it posts
 * "@Agent <the request>" as Finder on the page's chat - the @ wakes the
 * agent - and writes the page to `finder_handoff`, which the app opens.
 *
 * Sessions older than a week are removed.
 */

import { fetchObject, mutate, queryAll, setField, str, sv, chatPost, type ObjectJSON, type QueryRow } from "./api";
import { humanRef } from "./conv";
import { agentModelKey, pinOf } from "./credential-objects";
import { callLLM, modelProvider } from "./llm";
import { machineId } from "./roster";
import { objectText } from "./skills";
import { chatBlocks, isAgentAuthor } from "./surfaces";
import type { AnthropicContent, ToolDef, Turn } from "./types";

export const FINDER_SESSION_TYPE = "finder_session";
const SESSION_TTL_MS = 7 * 86_400_000;
/** Tool calls one answer may make before it must reply. */
const MAX_STEPS = 6;
/** Types that are setup, not pages a request belongs on. */
const NOT_PAGES = new Set(["relation", "type", "agent", "credential", "system_prompt", "tool", "skill", "template", "machine", "capability", "channel", "file", "reaction", FINDER_SESSION_TYPE]);

/** One page as Finder sees it. */
interface PageHit {
	id: string;
	name: string;
	type: string;
	updatedAt: number;
}

/** Pages of `space` matching `query`: every word that matches a name scores, recent edits break ties. */
export function rankPages(rows: QueryRow[], space: string, query: string, limit = 8): PageHit[] {
	const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
	return rows
		.filter((r) => str(r.fields, "channel") === space && !NOT_PAGES.has(r.typeKey) && str(r.fields, "name").trim() !== "")
		.map((r) => {
			const name = str(r.fields, "name").toLowerCase();
			const nameWords = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
			const matched = words.reduce((n, w) => n + (name.includes(w) ? (nameWords.includes(w) ? 2 : 1) : 0), 0);
			// The request names the page outright: every word of its name is in the request.
			const named = matched > 0 && nameWords.every((w) => words.includes(w)) ? 3 : 0;
			const score = matched + named;
			return { hit: { id: r.id, name: str(r.fields, "name"), type: r.typeKey, updatedAt: r.updatedAt ?? 0 }, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || b.hit.updatedAt - a.hit.updatedAt)
		.slice(0, limit)
		.map((x) => x.hit);
}

const TOOLS: ToolDef[] = [
	{
		name: "find_pages",
		description: "Search this space's pages (objects, queries, collections) by name. Returns up to 8: id, name, type.",
		input_schema: { type: "object", properties: { query: { type: "string", description: "words from the request" } }, required: ["query"] },
	},
	{
		name: "ask",
		description: "Ask the person to choose, shown as buttons: the pages (or agents) that could fit. Ends your turn.",
		input_schema: {
			type: "object",
			properties: {
				question: { type: "string" },
				options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"] } },
			},
			required: ["question", "options"],
		},
	},
	{
		name: "hand_off",
		description: "Post the request on the page's chat, tagging the agent (the @ wakes it), and open the page for the person. Ends your turn.",
		input_schema: {
			type: "object",
			properties: {
				page_id: { type: "string" },
				agent_id: { type: "string" },
				message: { type: "string", description: "the person's request, briefly, as theirs (\"Grant asks: …\")" },
			},
			required: ["page_id", "agent_id", "message"],
		},
	},
];

/** The space's agents with their job properties, for the prompt. */
function rosterText(agents: QueryRow[]): string {
	return agents
		.map((a) => {
			const line = (k: string) => str(a.fields, k).replace(/\s*\n\s*/g, "; ").trim();
			return `- ${str(a.fields, "name")} (id ${a.id}): ${line("agent_role") || "no Role yet"}${line("good_for") ? ` | Good for: ${line("good_for")}` : ""}${line("not_for") ? ` | Not for: ${line("not_for")}` : ""}`;
		})
		.join("\n");
}

const inFlight = new Set<string>();
/** The person's messages answered (session id:ts): each is answered once, whatever events follow. */
const answered = new Set<string>();

/** A session changed: answer its newest message when it is the person's and this computer serves the space's Finder. */
export async function handleFinderSession(session: ObjectJSON): Promise<void> {
	if (session.deleted || inFlight.has(session.id)) return;
	const space = str(session.fields, "finder_space");
	if (!space) return;
	const msgs = chatBlocks(session, humanRef(session.id))
		.map((row) => row.block.content.custom?.meta ?? {})
		.sort((a, b) => Number(a["ts"] ?? 0) - Number(b["ts"] ?? 0));
	const newest = msgs[msgs.length - 1];
	// Finder's id isn't a uuid, so isAgentAuthor alone misses its own replies.
	const finderId = `finder-agent-${space}`;
	if (!newest || newest["author"] === finderId || isAgentAuthor(newest["author"] ?? "")) return;
	const key = `${session.id}:${newest["ts"] ?? ""}`;
	if (answered.has(key)) return;
	const finder = await fetchObject(finderId).catch(() => null);
	if (!finder || finder.deleted) return;
	if ((await pinOf(finder.fields)) !== (await machineId())) return;
	answered.add(key);
	inFlight.add(session.id);
	try {
		await answer(session, space, finder, msgs);
	} catch (err) {
		await chatPost(session.id, `Finder couldn't run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), finder.id);
	} finally {
		inFlight.delete(session.id);
	}
}

async function answer(session: ObjectJSON, space: string, finder: ObjectJSON, msgs: Array<Record<string, string>>): Promise<void> {
	const model = str(finder.fields, "model") || finder.fields["model"]?.valuesValue?.items?.[0]?.stringValue || "claude-haiku-4-5";
	const apiKey = (await agentModelKey(finder, modelProvider(model))) ?? undefined;
	const promptId = finder.fields["prompt"]?.linkValue?.targetId ?? "";
	const prompt = promptId ? objectText(await fetchObject(promptId)) : "";
	const rows = await queryAll({ filters: [{ key: "channel", condition: "equal", value: space }] });
	const agents = rows.filter((r) => r.typeKey === "agent" && r.id !== finder.id);
	const spaceName = str((await fetchObject(space)).fields, "name");
	const offered = str(session.fields, "finder_options");
	const system = [
		prompt,
		`This space: ${spaceName} (id ${space}).`,
		`Its agents:\n${rosterText(agents)}`,
		offered ? `Choices you last offered (name → id): ${offered}` : "",
		"Use find_pages to search, ask to offer choices, hand_off to finish. Reply in plain text only to say where something went or when nothing fits.",
	]
		.filter(Boolean)
		.join("\n\n");
	const turns: Turn[] = msgs.slice(-12).map((m) => ({ role: m["author"] === finder.id || isAgentAuthor(m["author"] ?? "") ? "assistant" : "user", content: m["text"] ?? "" }));
	while (turns.length > 0 && turns[0].role === "assistant") turns.shift();
	for (let step = 0; step < MAX_STEPS; step++) {
		const res = await callLLM({ model, system, turns, tools: TOOLS, maxTokens: 1024, apiKey });
		if (res.toolUses.length === 0) {
			if (res.text.trim()) await chatPost(session.id, res.text.trim(), finder.id);
			return;
		}
		const assistant: AnthropicContent[] = [...(res.text ? [{ type: "text" as const, text: res.text }] : []), ...res.toolUses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input }))];
		const results: AnthropicContent[] = [];
		for (const use of res.toolUses) {
			if (use.name === "find_pages") {
				const hits = rankPages(rows, space, String(use.input["query"] ?? ""));
				results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(hits.map(({ id, name, type }) => ({ id, name, type }))) });
				continue;
			}
			if (use.name === "ask") {
				const options = (Array.isArray(use.input["options"]) ? use.input["options"] : []) as Array<{ id?: unknown; name?: unknown }>;
				const valid = options.filter((o) => typeof o.id === "string" && typeof o.name === "string").slice(0, 6) as Array<{ id: string; name: string }>;
				await setField(session.id, "finder_options", sv(JSON.stringify(valid)));
				await chatPost(session.id, String(use.input["question"] ?? "Which one?"), finder.id);
				return;
			}
			if (use.name === "hand_off") {
				const done = await handOff(session, space, finder, rows, use.input);
				if (done.ok) return;
				results.push({ type: "tool_result", tool_use_id: use.id, content: done.error, is_error: true });
				continue;
			}
			results.push({ type: "tool_result", tool_use_id: use.id, content: `no tool ${use.name}`, is_error: true });
		}
		turns.push({ role: "assistant", content: assistant }, { role: "user", content: results });
	}
	await chatPost(session.id, "I couldn't work out where this goes - can you say which page?", finder.id);
}

async function handOff(session: ObjectJSON, space: string, finder: ObjectJSON, rows: QueryRow[], input: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
	const page = rows.find((r) => r.id === input["page_id"]);
	if (!page || NOT_PAGES.has(page.typeKey)) return { ok: false, error: "page_id is not a page of this space; use an id find_pages returned" };
	const agent = rows.find((r) => r.id === input["agent_id"] && r.typeKey === "agent");
	if (!agent) return { ok: false, error: "agent_id is not an agent of this space" };
	const agentName = str(agent.fields, "name");
	const message = String(input["message"] ?? "").trim();
	if (!message) return { ok: false, error: "message is empty" };
	await chatPost(page.id, `@${agentName} ${message}`, finder.id);
	await setField(session.id, "finder_handoff", sv(JSON.stringify({ page: page.id, at: Date.now() })));
	await setField(session.id, "finder_options", sv(""));
	await chatPost(session.id, `→ Sent to ${agentName} on ${str(page.fields, "name")}.`, finder.id);
	return { ok: true };
}

/** Remove this identity's Finder sessions older than a week. */
export async function sweepFinderSessions(now = Date.now()): Promise<number> {
	let removed = 0;
	for (const s of await queryAll({ type: FINDER_SESSION_TYPE })) {
		if ((s.createdAt ?? now) > now - SESSION_TTL_MS) continue;
		await mutate("delete", { object_id: s.id }).catch(() => {});
		removed += 1;
	}
	return removed;
}
