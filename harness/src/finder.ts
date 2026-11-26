/**
 * Finder: a person's private chat that gets a request to the right page and
 * agent of a space (space-defaults.ts seeds each space's Finder agent).
 *
 * A session is a `finder_session` object with no space - so it lives in the
 * person's own private stream - naming the space in `finder_space` and, in
 * `served_by`, the computer the app that opened it talks to. The app makes a
 * new one each time the Finder bubble opens. When the person posts, that
 * computer answers in the session as Finder (`finderComputer`):
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

/** A button under Finder's message: a page card, a new page, or a step of the confirm. */
export interface FinderOption {
	id: string;
	name: string;
	kind: "page" | "new" | "do" | "pick_agent" | "agent";
	type?: string;
	icon?: string;
}

/** A hand-off waiting on [✓ Do it]. */
interface Pending {
	page: string;
	agent: string;
	message: string;
}

const TOOLS: ToolDef[] = [
	{
		name: "find_pages",
		description: "Search this space's pages (objects, queries, collections) by name. Returns up to 8: id, name, type.",
		input_schema: { type: "object", properties: { query: { type: "string", description: "words from the request" } }, required: ["query"] },
	},
	{
		name: "show_pages",
		description: "Show pages as cards the person taps to choose (a '+ New page' card is added). Use this whenever you have candidate pages - never ask about a page in words. Ends your turn.",
		input_schema: {
			type: "object",
			properties: { prompt: { type: "string", description: "one short line above the cards" }, page_ids: { type: "array", items: { type: "string" } } },
			required: ["prompt", "page_ids"],
		},
	},
	{
		name: "new_page",
		description: "Make a new page in this space; only after the person tapped '+ New page'. Returns its id for hand_off.",
		input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
	},
	{
		name: "open_page",
		description: "Open a page for the person, and nothing else: no agent is asked. Use it when they want to find, see, open, read or check something. Ends your turn.",
		input_schema: { type: "object", properties: { page_id: { type: "string" } }, required: ["page_id"] },
	},
	{
		name: "hand_off",
		description: "Give the request to an agent on a page - only when an agent has work to do there (add, write, change, send, sort out…); to find or see something use open_page. Leave agent_id out when no agent's Role / Good for clearly fits: the page's agent, else the space agent, takes it. sure=false shows the person [Do it] first. Ends your turn.",
		input_schema: {
			type: "object",
			properties: {
				page_id: { type: "string" },
				agent_id: { type: "string" },
				message: { type: "string", description: "the person's request, briefly, as theirs (\"Grant asks: …\")" },
				sure: { type: "boolean", description: "the page and agent are clearly right" },
			},
			required: ["page_id", "message", "sure"],
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

/** The agent a hand-off goes to: the one asked for, else the page's own, else the space agent. `fallback`: not the one asked for. */
export function handOffAgent(rows: QueryRow[], page: QueryRow, space: string, spaceName: string, asked: string): { id: string; fallback: boolean } | null {
	const agents = rows.filter((r) => r.typeKey === "agent" && !r.id.startsWith("finder-agent-"));
	if (asked && agents.some((a) => a.id === asked)) return { id: asked, fallback: false };
	const own = page.fields["agent"]?.valuesValue?.items?.map((i) => i.linkValue?.targetId ?? "") ?? [page.fields["agent"]?.linkValue?.targetId ?? ""];
	const onPage = own.find((id) => agents.some((a) => a.id === id));
	if (onPage) return { id: onPage, fallback: true };
	const spaceAgent = agents.find((a) => a.id === `space-agent-${space}`) ?? agents.find((a) => str(a.fields, "name") === `${spaceName} Space`);
	return spaceAgent ? { id: spaceAgent.id, fallback: true } : null;
}

function parseJson<T>(raw: string, fallback: T): T {
	try {
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

const inFlight = new Set<string>();
/** The person's messages answered (session id:ts): each is answered once, whatever events follow. */
const answered = new Set<string>();

/**
 * The computer that answers a session: the one the app that opened it talks to (the
 * session's own `served_by`, stamped by the app), so every computer runs Finder for its own
 * people. A session without one - opened before sessions were stamped, or by a browser
 * with no computer of its own - falls back to the computer the space's Finder names.
 */
export async function finderComputer(session: ObjectJSON, finder: ObjectJSON): Promise<string> {
	return (await pinOf(session.fields)) || (await pinOf(finder.fields));
}

/** A session changed: answer its newest message when it is the person's and this computer answers the session. */
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
	if ((await finderComputer(session, finder)) !== (await machineId())) return;
	answered.add(key);
	inFlight.add(session.id);
	try {
		const rows = await queryAll({ filters: [{ key: "channel", condition: "equal", value: space }] });
		const spaceName = str((await fetchObject(space)).fields, "name");
		const ctx: Ctx = { session, space, spaceName, finder, rows };
		if (!(await tapped(ctx, (newest["text"] ?? "").trim()))) await answer(ctx, msgs);
	} catch (err) {
		await chatPost(session.id, `Finder couldn't run: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400), finder.id);
	} finally {
		inFlight.delete(session.id);
	}
}

interface Ctx {
	session: ObjectJSON;
	space: string;
	spaceName: string;
	finder: ObjectJSON;
	rows: QueryRow[];
}

/** Write the buttons under Finder's next message, and that message. */
async function offer(ctx: Ctx, line: string, options: FinderOption[]): Promise<void> {
	await setField(ctx.session.id, "finder_options", sv(JSON.stringify(options)));
	await chatPost(ctx.session.id, line, ctx.finder.id);
}

/** A tap on one of the buttons offered (its name, posted): Do it and the agent buttons act here. True when handled. */
async function tapped(ctx: Ctx, text: string): Promise<boolean> {
	const options = parseJson<FinderOption[]>(str(ctx.session.fields, "finder_options"), []);
	const hit = options.find((o) => o.name === text);
	if (!hit || hit.kind === "page" || hit.kind === "new") return false;
	const pending = parseJson<Pending | null>(str(ctx.session.fields, "finder_pending"), null);
	if (!pending) return false;
	if (hit.kind === "do") {
		await send(ctx, pending);
		return true;
	}
	if (hit.kind === "pick_agent") {
		const agents = ctx.rows.filter((r) => r.typeKey === "agent" && !r.id.startsWith("finder-agent-"));
		await offer(ctx, "Which agent?", agents.map((a) => ({ id: a.id, name: str(a.fields, "name"), kind: "agent" as const, icon: str(a.fields, "iconEmoji") })));
		return true;
	}
	await send(ctx, { ...pending, agent: hit.id });
	return true;
}

/** A page as chat shows it: a link the app draws as the page's pill. */
function pageLink(page: { id: string; fields: QueryRow["fields"] }): string {
	return `[${str(page.fields, "name").replace(/[[\]]/g, "")}](/app/object/${page.id})`;
}

/** Post the request on the page as Finder, tagging the agent, and open the page. */
async function send(ctx: Ctx, p: Pending): Promise<void> {
	const page = ctx.rows.find((r) => r.id === p.page) ?? (await fetchObject(p.page).catch(() => null));
	const agent = ctx.rows.find((r) => r.id === p.agent);
	if (!page || !agent) {
		await chatPost(ctx.session.id, "That page or agent is gone - tell me again what you need.", ctx.finder.id);
		return;
	}
	const agentName = str(agent.fields, "name");
	await chatPost(page.id, `@${agentName} ${p.message}`, ctx.finder.id);
	await setField(ctx.session.id, "finder_handoff", sv(JSON.stringify({ page: page.id, at: Date.now() })));
	await setField(ctx.session.id, "finder_options", sv(""));
	await setField(ctx.session.id, "finder_pending", sv(""));
	await chatPost(ctx.session.id, `➡️ Sent to @${agentName} on ${pageLink(page)}.`, ctx.finder.id);
}

/** Open the page in the person's app (the hand-off field the app follows), asking no agent. */
async function openPage(ctx: Ctx, page: { id: string; fields: QueryRow["fields"] }): Promise<void> {
	await setField(ctx.session.id, "finder_handoff", sv(JSON.stringify({ page: page.id, at: Date.now() })));
	await setField(ctx.session.id, "finder_options", sv(""));
	await setField(ctx.session.id, "finder_pending", sv(""));
	await chatPost(ctx.session.id, `Opened ${pageLink(page)}.`, ctx.finder.id);
}

/** Page cards for `ids` (pages of the space only), then "+ New page". */
function pageCards(rows: QueryRow[], ids: string[]): FinderOption[] {
	const cards = ids
		.map((id) => rows.find((r) => r.id === id && !NOT_PAGES.has(r.typeKey)))
		.filter((r): r is QueryRow => !!r)
		.slice(0, 3)
		.map((r) => ({ id: r.id, name: str(r.fields, "name"), kind: "page" as const, type: r.typeKey, icon: str(r.fields, "iconEmoji") }));
	return [...cards, { id: "new", name: "＋ New page", kind: "new" }];
}

async function answer(ctx: Ctx, msgs: Array<Record<string, string>>): Promise<void> {
	const { session, space, finder } = ctx;
	let rows = ctx.rows;
	const model = finder.fields["model"]?.valuesValue?.items?.[0]?.stringValue || str(finder.fields, "model") || "claude-haiku-4-5";
	const apiKey = (await agentModelKey(finder, modelProvider(model))) ?? undefined;
	const promptId = finder.fields["prompt"]?.linkValue?.targetId ?? "";
	const prompt = promptId ? objectText(await fetchObject(promptId)) : "";
	const agents = rows.filter((r) => r.typeKey === "agent" && r.id !== finder.id);
	const offered = parseJson<FinderOption[]>(str(session.fields, "finder_options"), []);
	const system = [
		prompt,
		`This space: ${ctx.spaceName} (id ${space}).`,
		"When the person only wants to find, see, open or look something up, open the page with open_page once they picked it (or it is the one clear match) - never hand it to an agent. Hand off only when an agent has work to do.",
		`Its agents:\n${rosterText(agents)}`,
		offered.length ? `Buttons you last showed (name → id): ${offered.map((o) => `${o.name} → ${o.id}`).join("; ")}` : "",
	]
		.filter(Boolean)
		.join("\n\n");
	const turns: Turn[] = msgs.slice(-12).map((m) => ({ role: m["author"] === finder.id || isAgentAuthor(m["author"] ?? "") ? "assistant" : "user", content: m["text"] ?? "" }));
	while (turns.length > 0 && turns[0].role === "assistant") turns.shift();
	let lastHits: string[] = [];
	// A new page only once the person asked for one: the "+ New page" card.
	const wantsNew = (msgs[msgs.length - 1]?.["text"] ?? "").trim() === "＋ New page";
	for (let step = 0; step < MAX_STEPS; step++) {
		const res = await callLLM({ model, system, turns, tools: TOOLS, maxTokens: 1024, apiKey });
		if (res.toolUses.length === 0) {
			// Show, don't ask: pages it found go out as cards, whatever it wrote.
			if (lastHits.length > 0) await offer(ctx, res.text.trim().split("\n")[0] || "Which page?", pageCards(rows, lastHits));
			else if (res.text.trim()) await chatPost(session.id, res.text.trim(), finder.id);
			return;
		}
		const assistant: AnthropicContent[] = [...(res.text ? [{ type: "text" as const, text: res.text }] : []), ...res.toolUses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input }))];
		const results: AnthropicContent[] = [];
		for (const use of res.toolUses) {
			if (use.name === "find_pages") {
				const hits = rankPages(rows, space, String(use.input["query"] ?? ""));
				lastHits = hits.map((h) => h.id);
				results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(hits.map(({ id, name, type }) => ({ id, name, type }))) });
				continue;
			}
			if (use.name === "show_pages") {
				const ids = Array.isArray(use.input["page_ids"]) ? use.input["page_ids"].map(String) : lastHits;
				await offer(ctx, String(use.input["prompt"] ?? "Which page?"), pageCards(rows, ids));
				return;
			}
			if (use.name === "new_page") {
				if (!wantsNew) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "not yet: show_pages first; a new page is made only after the person taps '+ New page'", is_error: true });
					continue;
				}
				const name = String(use.input["name"] ?? "").trim() || "New page";
				const made = (await mutate("create", { name, type_key: "page", fields: { channel: sv(space) } })) as { id?: string };
				if (made.id) rows = [...rows, { id: made.id, typeKey: "page", createdAt: Date.now(), updatedAt: Date.now(), fields: { name: sv(name), channel: sv(space) } }];
				results.push({ type: "tool_result", tool_use_id: use.id, content: made.id ? JSON.stringify({ id: made.id, name }) : "could not make the page", is_error: !made.id });
				continue;
			}
			if (use.name === "open_page") {
				const page = rows.find((r) => r.id === use.input["page_id"] && !NOT_PAGES.has(r.typeKey));
				if (!page) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "page_id must be a page id from find_pages", is_error: true });
					continue;
				}
				await openPage({ ...ctx, rows }, page);
				return;
			}
			if (use.name === "hand_off") {
				const page = rows.find((r) => r.id === use.input["page_id"] && !NOT_PAGES.has(r.typeKey));
				const message = String(use.input["message"] ?? "").trim();
				if (!page || !message) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "page_id must be a page id from find_pages or new_page, and message not empty", is_error: true });
					continue;
				}
				const who = handOffAgent(rows, page, space, ctx.spaceName, String(use.input["agent_id"] ?? ""));
				if (!who) {
					results.push({ type: "tool_result", tool_use_id: use.id, content: "this space has no agent to take it", is_error: true });
					continue;
				}
				const pending: Pending = { page: page.id, agent: who.id, message };
				if (use.input["sure"] === true && !who.fallback) {
					await send({ ...ctx, rows }, pending);
					return;
				}
				await setField(session.id, "finder_pending", sv(JSON.stringify(pending)));
				const agentName = str(rows.find((r) => r.id === who.id)?.fields ?? {}, "name");
				await offer({ ...ctx, rows }, `${message.replace(/^Grant asks:\s*/i, "")} - on ${pageLink(page)}, with @${agentName}?`, [
					{ id: "do", name: "✅ Do it", kind: "do" },
					{ id: "pick", name: "Pick another agent", kind: "pick_agent" },
				]);
				return;
			}
			results.push({ type: "tool_result", tool_use_id: use.id, content: `no tool ${use.name}`, is_error: true });
		}
		turns.push({ role: "assistant", content: assistant }, { role: "user", content: results });
	}
	if (lastHits.length > 0) await offer(ctx, "Which page?", pageCards(rows, lastHits));
	else await chatPost(session.id, "I couldn't find where this goes - tell me the page's name.", finder.id);
}

/**
 * Answer what was posted while this computer wasn't listening (it was starting, or the
 * store's feed reconnected): every session touched in the last hour whose newest message is
 * still the person's. handleFinderSession skips the rest.
 */
export async function catchUpFinderSessions(now = Date.now()): Promise<void> {
	for (const row of await queryAll({ type: FINDER_SESSION_TYPE })) {
		if ((row.updatedAt ?? 0) < now - 3_600_000) continue;
		const session = await fetchObject(row.id).catch(() => null);
		if (session) await handleFinderSession(session);
	}
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
