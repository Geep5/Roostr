/**
 * Surfaces — port of GrantAgentSetup's discovery.odin + bot.odin message
 * shaping, adapted to the DAG (no probing needed; everything is queryable).
 *
 * One agent, one holistic chat per (agent × channel), many surfaces:
 *   - the agent's chat object (the brain: conversation + tool blocks live here)
 *   - any other object's __discussion__ in the agent's channel
 *
 * A message on a non-chat surface is copied into the chat tagged with its
 * origin, framed like the bridge does: `[message from X · in note "Y" (id)]`
 * plus the object's body inlined (HOST_BODY_LIMIT, cut on a line boundary).
 * The reply posts back to the surface that asked AND lands in the chat via
 * the runner.
 *
 * Watermarks (bot.odin marks): per-surface last-handled block id, persisted
 * locally in GLON_DATA/harness-marks.json — a local fact like the roster,
 * never synced. A surface with no mark seeds at the agent's own last message
 * (nothing replays); if the agent never spoke there, only the newest message
 * is picked up (their SEED_BACKLOG idea, conservative).
 */

import { addBlock, createObject, query, str, sv, type BlockJSON, type ObjectJSON } from "./api";

// ── Marks ─────────────────────────────────────────────────────────

function marksPath(): string {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	return `${root}/harness-marks.json`;
}

let marks: Record<string, string> | null = null;

async function loadMarks(): Promise<Record<string, string>> {
	if (marks) return marks;
	try {
		marks = (await Bun.file(marksPath()).json()) as Record<string, string>;
	} catch {
		marks = {};
	}
	return marks;
}

async function saveMarks(): Promise<void> {
	if (marks) await Bun.write(marksPath(), JSON.stringify(marks));
}

export async function setMark(surfaceId: string, blockId: string): Promise<void> {
	const m = await loadMarks();
	m[surfaceId] = blockId;
	await saveMarks();
}

// ── Default chat per (agent × channel) ────────────────────────────

/** Find or create the agent's holistic chat for its channel. */
export async function ensureChat(agent: ObjectJSON, channelId: string): Promise<string> {
	const rows = await query({
		type: "chat",
		filters: [
			{ key: "agent", condition: "equal", value: agent.id },
			...(channelId ? [{ key: "channel", condition: "equal", value: channelId }] : []),
		],
		limit: 1,
	});
	if (rows.length > 0) return rows[0].id;
	const name = str(agent.fields, "name") || "Agent";
	const fields: Record<string, ReturnType<typeof sv>> = { agent: sv(agent.id) };
	if (channelId) fields.channel = sv(channelId);
	const { id } = await createObject(name, "chat", fields);
	console.log(`[harness] created chat "${name}" (${id.slice(0, 8)}) for agent ${agent.id.slice(0, 8)}`);
	return id;
}

// ── Pending messages (watermarked) ────────────────────────────────

export interface PendingMessage {
	blockId: string;
	author: string;
	text: string;
}

export function chatBlocks(obj: ObjectJSON): Array<{ id: string; block: BlockJSON }> {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const root = byId.get("__discussion__");
	if (!root) return [];
	const out: Array<{ id: string; block: BlockJSON }> = [];
	for (const cid of root.childrenIds) {
		const b = byId.get(cid);
		if (b?.content.custom?.contentType === "chat") out.push({ id: cid, block: b });
	}
	return out;
}

/** A uuid author is an agent; anything else is a human's pubkey. */
export function isAgentAuthor(author: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(author);
}

/**
 * Unhandled user messages on a surface, oldest first. Origin-tagged copies
 * (already ingested from another surface) never count. Seeding rules per
 * the bridge's seed_mark.
 *
 * An object's discussion is human-to-agent only: another agent's post there
 * never wakes this one. Two agents driven onto one object otherwise answer
 * each other forever, each seeing the other's reply as a new question, and
 * the human's thread fills with agent chatter. Agent-to-agent exchanges
 * belong in a pair chat, which is a `chat` object and keeps both authors.
 */
export async function pendingMessages(obj: ObjectJSON, agentId: string): Promise<PendingMessage[]> {
	const m = await loadMarks();
	const msgs = chatBlocks(obj);
	const mark = m[obj.id];

	// A mark whose block was deleted must not freeze the surface: the scan
	// below starts only once it meets `startAfter`, so an unresolvable mark
	// leaves nothing pending forever - one deleted message and the agent is
	// deaf on this object for good. Fall back to the fresh-surface seed.
	let startAfter = mark !== undefined && msgs.some((x) => x.id === mark) ? mark : undefined;
	if (startAfter === undefined) {
		// Fresh surface: seed at the agent's own last message.
		for (let i = msgs.length - 1; i >= 0; i--) {
			if ((msgs[i].block.content.custom?.meta?.["author"] ?? "") === agentId) {
				startAfter = msgs[i].id;
				break;
			}
		}
	}

	let started = startAfter === undefined;
	const pending: PendingMessage[] = [];
	for (const { id, block } of msgs) {
		if (!started) {
			if (id === startAfter) started = true;
			continue;
		}
		const meta = block.content.custom?.meta ?? {};
		const author = meta["author"] ?? "";
		if (author === agentId) continue;
		if (meta["origin"]) continue; // ingested copy, handled with its origin surface
		if (obj.typeKey !== "chat" && isAgentAuthor(author)) continue;
		pending.push({ blockId: id, author, text: meta["text"] ?? "" });
	}

	// Never-spoken surface with no mark: only the newest message is live
	// (a full-history replay of an old discussion would be noise).
	if (startAfter === undefined && pending.length > 1) return pending.slice(-1);
	return pending;
}

// ── Host framing (bot.odin build_user_message + host_info) ────────

const HOST_BODY_LIMIT = 2000;
const STYLE_PREFIX: Record<number, string> = { 1: "# ", 2: "## ", 3: "### ", 4: "> ", 6: "- ", 7: "1. ", 8: "- [ ] " };

/** Serialize an object's text blocks to markdown-ish, line-boundary capped. */
export function serializeBody(obj: ObjectJSON): { body: string; truncated: boolean } {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const lines: string[] = [];
	const walk = (ids: string[]) => {
		for (const id of ids) {
			const b = byId.get(id);
			if (!b) continue;
			const t = b.content.text;
			if (t?.text) lines.push((STYLE_PREFIX[t.style ?? 0] ?? "") + t.text);
			if (b.childrenIds.length) walk(b.childrenIds);
		}
	};
	const roots = obj.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__discussion__").map((b) => b.id);
	walk(roots);
	let body = lines.join("\n").trim();
	let truncated = false;
	if (body.length > HOST_BODY_LIMIT) {
		let cut = body.lastIndexOf("\n", HOST_BODY_LIMIT);
		if (cut < HOST_BODY_LIMIT / 2) cut = HOST_BODY_LIMIT;
		body = body.slice(0, cut);
		truncated = true;
	}
	return { body, truncated };
}

// Body dedupe (bodycache.odin): skip re-inlining a body sent recently and
// unchanged. In-memory — a harness restart resends, which is correct.
const BODY_TTL_MS = 30 * 60 * 1000;
const sentBodies = new Map<string, { hash: string; ts: number }>();

function bodyDecision(surfaceId: string, body: string): "send" | "skip" {
	const hash = String(Bun.hash(body));
	const prev = sentBodies.get(surfaceId);
	if (prev && prev.hash === hash && Date.now() - prev.ts < BODY_TTL_MS) return "skip";
	sentBodies.set(surfaceId, { hash, ts: Date.now() });
	return "send";
}

/** The bridge's exact message shape for a non-chat surface. */
export function frameMessage(surface: ObjectJSON, pending: PendingMessage[]): string {
	const kind = surface.typeKey || "object";
	const name = str(surface.fields, "name") || "(untitled)";
	const parts: string[] = [];
	const authors = [...new Set(pending.map((p) => p.author || "user"))].join(", ");
	parts.push(`[message from ${authors} · in ${kind} "${name}" (id ${surface.id})]`);

	const { body, truncated } = serializeBody(surface);
	if (bodyDecision(surface.id, body) === "skip") {
		parts.push(`[contents of this ${kind} were included earlier in this conversation and may have changed since — re-read the object if it matters]`);
	} else if (body) {
		parts.push(`--- contents of this ${kind}, as of now ---\n${body}${truncated ? "\n[…truncated; read the object for the rest]" : ""}\n--- end ---`);
	} else {
		parts.push(`--- this ${kind} is empty ---`);
	}

	const thread = surface.blocks.find((b) => b.id === "__discussion__");
	const chatCount = (thread?.childrenIds ?? []).filter((cid) => {
		const c = surface.blocks.find((b) => b.id === cid)?.content.custom;
		return c?.contentType === "chat" && (c.meta?.["text"] ?? "").trim();
	}).length;
	const earlier = chatCount - pending.length;
	if (earlier > 0) parts.push(`[this ${kind} has ${earlier} earlier discussion message(s) \u2014 discussion_read ${surface.id} to see them]`);

	for (const p of pending) if (p.text.trim()) parts.push(p.text);
	return parts.join("\n");
}

/** Copy an origin-surface message into the holistic chat, origin-tagged. */
export async function ingestIntoChat(chatId: string, surfaceId: string, author: string, text: string): Promise<void> {
	await addBlock(
		chatId,
		{
			id: crypto.randomUUID(),
			childrenIds: [],
			content: { custom: { contentType: "chat", meta: { author, text, origin: surfaceId, ts: String(Date.now()) } } },
		},
		"__discussion__",
		5, // INNER
	);
}
