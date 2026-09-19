/**
 * Surfaces — port of GrantAgentSetup's discovery.odin + bot.odin message
 * shaping, adapted to the DAG (no probing needed; everything is queryable).
 *
 * A surface is an object's human discussion (`humanRef`): the thread a
 * person writes in. An agent's own transcript is a conversation too, but
 * never a surface - it is where surface messages land, not a place messages
 * are picked up from, so there is no "is this surface my own chat?" test
 * left here.
 *
 * A message on a surface is copied into the agent's transcript tagged with
 * its origin, framed like the bridge does: `[message from X · in note "Y"
 * (id)]` plus the object's body inlined (HOST_BODY_LIMIT, cut on a line
 * boundary). The reply posts back to the surface that asked AND lands in
 * the transcript via the runner.
 *
 * Watermarks (bot.odin marks): per-conversation last-handled block id,
 * persisted locally in GLON_DATA/harness-marks.json — a local fact like the
 * roster, never synced. A conversation with no mark seeds at the agent's own
 * last message (nothing replays); if the agent never spoke there, only the
 * newest message is picked up (their SEED_BACKLOG idea, conservative).
 */

import { str, type BlockJSON, type ObjectJSON } from "./api";
import { addConvBlock, convBlocks, convKey, HUMAN_THREAD, isHuman, parseConvKey, type ConvRef } from "./conv";

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

/** Marks key on the conversation: one object hosts several, each advancing
 * on its own. */
export async function setMark(ref: ConvRef, blockId: string): Promise<void> {
	const m = await loadMarks();
	m[convKey(ref)] = blockId;
	await saveMarks();
}

/**
 * One conversation's watermark.
 *
 * Marks written before conversations were addressed keyed on the object id
 * alone, and parseConvKey reads such a key as that object's human thread -
 * so the watermarks already in harness-marks.json keep counting instead of
 * every discussion looking fresh and replaying its newest message once.
 */
function markFor(m: Record<string, string>, ref: ConvRef): string | undefined {
	const exact = m[convKey(ref)];
	if (exact !== undefined) return exact;
	for (const [key, blockId] of Object.entries(m)) {
		const old = parseConvKey(key);
		if (old.objectId === ref.objectId && old.threadId === ref.threadId) return blockId;
	}
	return undefined;
}

// ── Pending messages (watermarked) ────────────────────────────────

export interface PendingMessage {
	blockId: string;
	author: string;
	text: string;
}

/** A conversation's message blocks, in append order. */
export function chatBlocks(obj: ObjectJSON, ref: ConvRef): Array<{ id: string; block: BlockJSON }> {
	return convBlocks(obj, ref.threadId).filter((row) => row.block.content.custom?.contentType === "chat");
}

/** A uuid author is an agent; anything else is a human's pubkey. */
export function isAgentAuthor(author: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(author);
}

/**
 * Unhandled user messages in a conversation, oldest first. Origin-tagged
 * copies (already ingested from another surface) never count. Seeding rules
 * per the bridge's seed_mark.
 *
 * A human thread is human-to-agent only: another agent's post there never
 * wakes this one. Two agents driven onto one object otherwise answer each
 * other forever, each seeing the other's reply as a new question, and the
 * human's thread fills with agent chatter. Agent-to-agent exchanges use
 * addressed mailbox envelopes, never this human-discussion watermark path.
 */
export async function pendingMessages(obj: ObjectJSON, ref: ConvRef, agentId: string): Promise<PendingMessage[]> {
	if (!isHuman(ref)) return [];
	const m = await loadMarks();
	const mark = markFor(m, ref);

	// Chronological, NOT block order. Block order is DAG merge order: a
	// device that commits while its replica is behind lists stale heads as
	// parents, so its message merges in before messages written long
	// before it. Walking positions skipped exactly those - a phone that
	// had been offline could post, sync everywhere, and never be answered.
	// Ties (same millisecond) keep block order, which every device agrees on.
	const msgs = chatBlocks(obj, ref)
		.map((row, index) => ({ ...row, index, ts: Number(row.block.content.custom?.meta?.["ts"] ?? 0) }))
		.sort((a, b) => a.ts - b.ts || a.index - b.index);

	// A mark whose block was deleted must not freeze the surface: an
	// unresolvable mark would otherwise leave nothing pending forever - one
	// deleted message and the agent is deaf on this object for good. Fall
	// back to the fresh-surface seed.
	let startAfter = mark !== undefined && msgs.some((x) => x.id === mark) ? mark : undefined;
	if (startAfter === undefined) {
		// Fresh surface: seed at the agent's own newest message.
		for (let i = msgs.length - 1; i >= 0; i--) {
			if ((msgs[i].block.content.custom?.meta?.["author"] ?? "") === agentId) {
				startAfter = msgs[i].id;
				break;
			}
		}
	}

	const markAt = startAfter === undefined ? -1 : msgs.findIndex((x) => x.id === startAfter);
	const pending: PendingMessage[] = [];
	// Newest last, so the caller's `pending[last]` mark only ever advances.
	for (const { id, block } of msgs.slice(markAt + 1)) {
		const meta = block.content.custom?.meta ?? {};
		const author = meta["author"] ?? "";
		if (author === agentId) continue;
		if (meta["origin"]) continue; // ingested copy, handled with its origin surface
		if (isHuman(ref) && isAgentAuthor(author)) continue;
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

/**
 * One block, as a line an agent can read.
 *
 * Text blocks are not the only content. A page whose body is a bookmark, an
 * embed or a link card used to serialise to nothing, so the framing told the
 * agent "this page is empty" and `object_get` agreed - and the agent said so
 * to a human looking straight at the link. It was answering honestly from a
 * blind input.
 *
 * A link block carries only its target's id, and this stays synchronous, so
 * the id is what gets printed: the agent can resolve it with object_get.
 * Conversation blocks are never reached (they hang under a conversation
 * root, which the walk skips) and are excluded here too, so a future caller
 * that walks them cannot leak a thread into the body.
 */
export function blockLine(b: BlockJSON): string {
	const t = b.content.text;
	if (t?.text) return (STYLE_PREFIX[t.style ?? 0] ?? "") + t.text;
	const custom = b.content.custom;
	if (!custom) return "";
	const meta = custom.meta ?? {};
	switch (custom.contentType) {
		case "bookmark": {
			const url = meta["url"] ?? "";
			if (!url) return "";
			const title = meta["title"] ?? "";
			return title ? `[bookmark] ${title} — ${url}` : `[bookmark] ${url}`;
		}
		case "embed": {
			const url = meta["url"] ?? meta["src"] ?? "";
			if (!url) return "";
			const kind = meta["processor"] ? `${meta["processor"]} ` : "";
			return `[${kind}embed] ${url}`;
		}
		case "link": {
			const target = meta["target"] ?? "";
			return target ? `[link] object ${target}` : "";
		}
		case "divider":
			return meta["style"] === "dots" ? "* * *" : "---";
		case "relation": {
			const key = meta["key"] ?? "";
			return key ? `[property shown here] ${key}` : "";
		}
		default:
			return "";
	}
}

/** Serialize an object's blocks to markdown-ish, line-boundary capped. */
export function serializeBody(obj: ObjectJSON): { body: string; truncated: boolean } {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const lines: string[] = [];
	const walk = (ids: string[]) => {
		for (const id of ids) {
			const b = byId.get(id);
			if (!b) continue;
			if (b.content.custom?.contentType === "chat" || b.content.custom?.contentType === "discussion") continue;
			const line = blockLine(b);
			if (line) lines.push(line);
			if (b.childrenIds.length) walk(b.childrenIds);
		}
	};
	const roots = obj.blocks.filter((b) => !referenced.has(b.id) && b.id !== HUMAN_THREAD).map((b) => b.id);
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
// unchanged, keyed per conversation - one object can host several, and a
// body inlined into one of them was never shown in the others.
// In-memory — a harness restart resends, which is correct.
const BODY_TTL_MS = 30 * 60 * 1000;
const sentBodies = new Map<string, { hash: string; ts: number }>();

function bodyDecision(surfaceKey: string, body: string): "send" | "skip" {
	const hash = String(Bun.hash(body));
	const prev = sentBodies.get(surfaceKey);
	if (prev && prev.hash === hash && Date.now() - prev.ts < BODY_TTL_MS) return "skip";
	sentBodies.set(surfaceKey, { hash, ts: Date.now() });
	return "send";
}

/** The bridge's exact message shape for a surface message. */
export function frameMessage(surface: ObjectJSON, ref: ConvRef, pending: PendingMessage[]): string {
	const kind = surface.typeKey || "object";
	const name = str(surface.fields, "name") || "(untitled)";
	const parts: string[] = [];
	const authors = [...new Set(pending.map((p) => p.author || "user"))].join(", ");
	parts.push(`[message from ${authors} · in ${kind} "${name}" (id ${surface.id})]`);

	const { body, truncated } = serializeBody(surface);
	if (bodyDecision(convKey(ref), body) === "skip") {
		parts.push(`[contents of this ${kind} were included earlier in this conversation and may have changed since — re-read the object if it matters]`);
	} else if (body) {
		parts.push(`--- contents of this ${kind}, as of now ---\n${body}${truncated ? "\n[…truncated; read the object for the rest]" : ""}\n--- end ---`);
	} else {
		parts.push(`--- this ${kind} is empty ---`);
	}

	const chatCount = chatBlocks(surface, ref).filter((row) => (row.block.content.custom?.meta?.["text"] ?? "").trim()).length;
	const earlier = chatCount - pending.length;
	if (earlier > 0) parts.push(`[this ${kind} has ${earlier} earlier discussion message(s) \u2014 discussion_read ${surface.id} to see them]`);

	for (const p of pending) if (p.text.trim()) parts.push(p.text);
	return parts.join("\n");
}

/** Copy a surface message into the agent's transcript, origin-tagged.
 * `originBlock` is the source message's block id - the identity that makes
 * ingestion idempotent across machines and lost marks. */
export async function ingestIntoChat(dest: ConvRef, origin: ConvRef, author: string, text: string, originBlock = ""): Promise<void> {
	// Keep the source object and thread for navigation. Mailbox messages carry
	// their immutable id in origin_block, so retries do not duplicate context.
	await addConvBlock(dest, {
		id: crypto.randomUUID(),
		childrenIds: [],
		content: { custom: { contentType: "chat", meta: { author, text, origin: origin.objectId, origin_thread: origin.threadId, origin_block: originBlock, ts: String(Date.now()) } } },
	});
}

/** Origin block ids already copied into a conversation - the dedupe set. */
export function ingestedOriginBlocks(obj: ObjectJSON, ref: ConvRef): Set<string> {
	const out = new Set<string>();
	for (const { block } of convBlocks(obj, ref.threadId)) {
		const ob = block.content.custom?.meta?.["origin_block"];
		if (ob) out.add(ob);
	}
	return out;
}
