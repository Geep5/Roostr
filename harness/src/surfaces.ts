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

import { fetchObject, guestAgents, queryAll, str, type BlockJSON, type ObjectJSON } from "./api";
import { addConvBlock, convBlocks, convKey, HUMAN_THREAD, isHuman, parseConvKey, type ConvRef } from "./conv";
import { messageFiles } from "./attachments";
import { bareEmoji, isReaction, REACTION_AGENT_KEY, REACTION_EMOJI_KEY, REACTION_TYPE, reactionLine, reactionRemoved, reactionSuperseded } from "./reactions";
import { defaultSpaceId } from "./spacemap";

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
	/** File object ids attached to the message (pasted images), from meta `files`. */
	files: string[];
}

/** A conversation's message blocks, in append order. */
export function chatBlocks(obj: ObjectJSON, ref: ConvRef): Array<{ id: string; block: BlockJSON }> {
	return convBlocks(obj, ref.threadId).filter((row) => row.block.content.custom?.contentType === "chat");
}

/** A uuid author is an agent; anything else is a human's pubkey. */
export function isAgentAuthor(author: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(author);
}

/** Whether `text` @-mentions `name` (whole name, any case): "@Marco Dev Bot" yes, "tag marco" no. */
export function mentions(text: string, name: string): boolean {
	return !!name && new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text);
}

type Placed = Pick<ObjectJSON, "id" | "typeKey" | "fields">;

/** The space an object lives in: a space is its own; an unstamped object is in the default space. */
export function spaceOfObject(obj: Placed, defaultSpace: string): string {
	return obj.typeKey === "channel" ? obj.id : str(obj.fields, "channel") || defaultSpace;
}

/**
 * Who an @-mention on `obj` can wake: its default agents (`agent`) first,
 * then every other agent of its space - any of them works on any object
 * there. Agents of other spaces and spawned helpers are never addressable.
 */
export function addressableAgents(obj: Placed, roster: Placed[], defaultSpace: string): string[] {
	const space = spaceOfObject(obj, defaultSpace);
	const out = [...guestAgents(obj.fields)];
	for (const agent of roster) {
		if (agent.typeKey !== "agent" || str(agent.fields, "spawn_parent") || out.includes(agent.id)) continue;
		if (spaceOfObject(agent, defaultSpace) === space) out.push(agent.id);
	}
	return out;
}

type ChatRow = { id: string; block: BlockJSON };

/**
 * Whether `msgs[at]` answers a question guest `agentId` asked: it is another
 * agent's first post since the guest's latest message, that message
 * @-mentioned the answering agent, and nobody else tagged the answering
 * agent in between - then it is answering them. Agents rarely tag the asker
 * back, so without this the asker never sees the answer it is waiting for.
 * A person asked "@Marco Dev Bot" for stats after an agent's message merely
 * suggested asking Marco, and Marco's answer woke that agent.
 * `msgs` is chronological.
 */
export async function answersGuestQuestion(msgs: ChatRow[], at: number, agentId: string): Promise<boolean> {
	const own = msgs[at].block.content.custom?.meta ?? {};
	// A reaction is not an answer, and never stands between a question and its answer.
	if (isReaction(own)) return false;
	const author = own["author"] ?? "";
	if (!isAgentAuthor(author) || author === agentId) return false;
	const answerer = await fetchObject(author).catch(() => null);
	const answererName = answerer ? str(answerer.fields, "name") : "";
	if (!answererName) return false;
	for (let i = at - 1; i >= 0; i--) {
		const meta = msgs[i].block.content.custom?.meta ?? {};
		if (isReaction(meta)) continue;
		if (meta["author"] === author) return false; // it already answered
		if (meta["author"] !== agentId) {
			// Someone else asked the answerer since: the answer is theirs.
			if (mentions(meta["text"] ?? "", answererName)) return false;
			continue;
		}
		return mentions(meta["text"] ?? "", answererName);
	}
	return false;
}

/**
 * Unhandled user messages in a conversation, oldest first. Origin-tagged
 * copies (already ingested from another surface) never count. Seeding rules
 * per the bridge's seed_mark.
 *
 * `addressedAs`: the agent's name. Only messages that @-mention it are its
 * to answer - a person's, or another agent's that tagged it ("@Marco Dev
 * Bot, which tournaments?") - plus an agent's answer to a question it asked
 * (answersGuestQuestion), and a reaction it is the one to act on
 * (`reactionWake`; its text is the reaction's context). On every object,
 * the agent's own page included: nothing else wakes an agent.
 */
export async function pendingMessages(obj: ObjectJSON, ref: ConvRef, agentId: string, addressedAs: string): Promise<PendingMessage[]> {
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
			const meta = msgs[i].block.content.custom?.meta ?? {};
			if ((meta["author"] ?? "") === agentId && !isReaction(meta)) {
				startAfter = msgs[i].id;
				break;
			}
		}
	}

	const markAt = startAfter === undefined ? -1 : msgs.findIndex((x) => x.id === startAfter);
	const metas = msgs.map((x) => x.block.content.custom?.meta ?? {});
	const pending: PendingMessage[] = [];
	// Newest last, so the caller's `pending[last]` mark only ever advances.
	for (let at = markAt + 1; at < msgs.length; at++) {
		const { id } = msgs[at];
		const meta = metas[at];
		const author = meta["author"] ?? "";
		if (author === agentId) continue;
		if (meta["origin"]) continue; // ingested copy, handled with its origin surface
		if (isReaction(meta)) {
			// One taken back, or changed since, asks nothing.
			if (reactionRemoved(meta) || reactionSuperseded(metas, at)) continue;
			const wake = await reactionWake(obj, msgs, at);
			if (wake?.agentId === agentId) pending.push({ blockId: id, author, text: wake.context, files: [] });
			continue;
		}
		const text = meta["text"] ?? "";
		// An agent answers what is addressed to it, whoever wrote it.
		if (!mentions(text, addressedAs) && !(await answersGuestQuestion(msgs, at, agentId))) continue;
		pending.push({ blockId: id, author, text, files: messageFiles(meta) });
	}

	// Never-spoken surface with no mark: only the newest message is live
	// (a full-history replay of an old discussion would be noise).
	if (startAfter === undefined && pending.length > 1) return pending.slice(-1);
	return pending;
}

/** The agent a reaction wakes, and what its turn is told. */
export interface ReactionWake {
	agentId: string;
	/** Who reacted with what to which message, and what the space says the emoji means. */
	context: string;
}

/**
 * Who acts on the reaction `msgs[at]` (`msgs` chronological), first that
 * applies, among the agents of the object's space:
 *  1. the agent of the space's Reaction for that emoji;
 *  2. the agent that wrote the message reacted to;
 *  3. the agent that runs the object's Repeat;
 *  4. the space's own "<Space> Space" agent.
 * Null for a removed reaction, or when the space has none of them.
 */
export async function reactionWake(obj: ObjectJSON, msgs: ChatRow[], at: number): Promise<ReactionWake | null> {
	const meta = msgs[at].block.content.custom?.meta ?? {};
	const emoji = bareEmoji(meta["emoji"] ?? "");
	if (!isReaction(meta) || reactionRemoved(meta) || !emoji) return null;
	const dflt = await defaultSpaceId();
	const space = spaceOfObject(obj, dflt);
	const [roster, reactions] = await Promise.all([queryAll({ type: "agent" }), queryAll({ type: REACTION_TYPE })]);
	const ofSpace = addressableAgents(obj, roster, dflt);
	const inSpace = (id: string | undefined): id is string => !!id && ofSpace.includes(id);
	// The space's meaning for the emoji; the oldest, should two say it.
	const meaning = reactions
		.filter((r) => spaceOfObject(r, dflt) === space && bareEmoji(str(r.fields, REACTION_EMOJI_KEY)) === emoji)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
	const target = msgs.find((row) => row.id === meta["replyTo"])?.block.content.custom?.meta;
	const targetAuthor = target?.["author"] ?? "";
	// Only agents of the space qualify (`inSpace`): a person's message, or another space's agent, falls through.
	const candidates = [
		...(meaning ? guestAgents({ agent: meaning.fields[REACTION_AGENT_KEY] }).slice(0, 1) : []),
		targetAuthor,
		// Who runs the Repeat: the one its editor picked, else the first on the guest list (schedule.ts ownerOf).
		...(obj.fields["repeat"] ? [...guestAgents({ agent: obj.fields["assignee"] }), ...guestAgents(obj.fields)] : []),
		`space-agent-${space}`,
	];
	let agentId = candidates.find(inSpace);
	if (!agentId) {
		// A space whose own agent predates the fixed id: the one by its name.
		const spaceName = str((await fetchObject(space).catch(() => null))?.fields ?? {}, "name");
		if (spaceName) agentId = roster.find((a) => inSpace(a.id) && str(a.fields, "name") === `${spaceName} Space`)?.id;
	}
	if (!agentId) return null;

	const nameOf = (id: string): string => (id === agentId ? "you" : str(roster.find((a) => a.id === id)?.fields ?? {}, "name") || (isAgentAuthor(id) ? "an agent" : "user"));
	const parts = [reactionLine(nameOf(meta["author"] ?? ""), meta, target ? { author: nameOf(targetAuthor), text: target["text"] ?? "" } : null)];
	if (meaning) {
		const page = await fetchObject(meaning.id).then((o) => serializeBody(o).body.trim(), () => "");
		const said = page ? `Its instructions:\n${page}` : "It has no instructions written: act on the message as that meaning asks.";
		parts.push(`In this space ${meta["emoji"]} means "${str(meaning.fields, "name") || "(unnamed)"}" (Reaction ${meaning.id}). ${said}`);
	} else {
		parts.push(`No Reaction in this space says what ${meta["emoji"]} means: read it as the person's answer to that message, and act on it if it asks for something.`);
	}
	return { agentId, context: parts.join("\n") };
}

// ── Host framing (bot.odin build_user_message + host_info) ────────

const HOST_BODY_LIMIT = 2000;
const STYLE_PREFIX: Record<number, string> = { 1: "# ", 2: "## ", 3: "### ", 4: "> ", 6: "- ", 7: "1. ", 8: "- [ ] " };

/**
 * Each numbered block's position in its run of numbered siblings (1, 2, 3 -
 * restarting after any other block), as the page shows it. Without it every
 * item read "1.", and an instruction like "stop after step 2" pointed nowhere.
 */
export function listOrdinals(obj: ObjectJSON): Map<string, number> {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const out = new Map<string, number>();
	const number = (ids: string[]) => {
		let n = 0;
		for (const id of ids) {
			const style = byId.get(id)?.content.text?.style;
			n = style === 7 ? n + 1 : 0;
			if (n) out.set(id, n);
		}
	};
	number(obj.blocks.filter((b) => !referenced.has(b.id)).map((b) => b.id));
	for (const b of obj.blocks) if (b.childrenIds.length) number(b.childrenIds);
	return out;
}

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
export function blockLine(b: BlockJSON, ordinal?: number): string {
	const t = b.content.text;
	if (t?.text) return (t.style === 8 && t.checked ? "- [x] " : t.style === 7 && ordinal ? `${ordinal}. ` : (STYLE_PREFIX[t.style ?? 0] ?? "")) + t.text;
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

/** One line of an object's body: its block id, nesting depth and the line a human reads. */
export interface BodyLine {
	id: string;
	depth: number;
	line: string;
	block: BlockJSON;
}

/**
 * The body as addressable lines, in reading order: each block's id, its
 * nesting depth and the line a human reads. Conversation subtrees are not
 * body and never appear; editing tools accept only these ids.
 */
export function bodyBlocks(obj: ObjectJSON): BodyLine[] {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const ordinals = listOrdinals(obj);
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const out: BodyLine[] = [];
	const walk = (id: string, depth: number) => {
		const b = byId.get(id);
		if (!b) return;
		const kind = b.content.custom?.contentType;
		if (kind === "chat" || kind === "discussion" || kind === "agent_message") return;
		out.push({ id, depth, line: blockLine(b, ordinals.get(b.id)), block: b });
		for (const c of b.childrenIds) walk(c, depth + 1);
	};
	for (const b of obj.blocks) if (!referenced.has(b.id) && b.id !== "__discussion__") walk(b.id, 0);
	return out;
}

/** Serialize an object's blocks to markdown-ish, line-boundary capped. */
export function serializeBody(obj: ObjectJSON): { body: string; truncated: boolean } {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const ordinals = listOrdinals(obj);
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const lines: string[] = [];
	const walk = (ids: string[]) => {
		for (const id of ids) {
			const b = byId.get(id);
			if (!b) continue;
			if (b.content.custom?.contentType === "chat" || b.content.custom?.contentType === "discussion") continue;
			const line = blockLine(b, ordinals.get(b.id));
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

/**
 * The bridge's exact message shape for a surface message. Attached files are
 * named with their ids (`fileNames`: id → name), so the agent can link them;
 * the images themselves reach the model beside this text (attachments.ts).
 */
export function frameMessage(surface: ObjectJSON, ref: ConvRef, pending: PendingMessage[], fileNames: ReadonlyMap<string, string> = new Map()): string {
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
		// No page text is not an empty object: a query's results, a task's
		// properties are all still there. "this query is empty" was read as
		// "no results" and repeated to a person looking at a full table.
		parts.push(`--- this ${kind}'s page has no text ---`);
	}
	if (["query", "set", "collection"].includes(surface.typeKey)) parts.push(`[a saved view: query_run ${surface.id} lists what it shows]`);

	// Words only: a reaction is not a message to read back.
	const now = new Set(pending.map((p) => p.blockId));
	const earlier = chatBlocks(surface, ref).filter((row) => !now.has(row.id) && (row.block.content.custom?.meta?.["text"] ?? "").trim()).length;
	if (earlier > 0) parts.push(`[this ${kind} has ${earlier} earlier discussion message(s) \u2014 discussion_read ${surface.id} to see them]`);

	for (const p of pending) {
		if (p.text.trim()) parts.push(p.text);
		for (const id of p.files) parts.push(`[attached: ${fileNames.get(id) || "file"} (${id})]`);
	}
	return parts.join("\n");
}

/** Copy a surface message into the agent's transcript, origin-tagged.
 * `originBlock` is the source message's block id - the identity that makes
 * ingestion idempotent across machines and lost marks. `files` are the
 * message's attached File ids, kept as the copy's meta `files` so the turn
 * shows the model the images (attachments.ts). */
export async function ingestIntoChat(dest: ConvRef, origin: ConvRef, author: string, text: string, originBlock = "", files: string[] = []): Promise<void> {
	// Keep the source object and thread for navigation. Mailbox messages carry
	// their immutable id in origin_block, so retries do not duplicate context.
	const meta: Record<string, string> = { author, text, origin: origin.objectId, origin_thread: origin.threadId, origin_block: originBlock, ts: String(Date.now()) };
	if (files.length) meta["files"] = files.join(",");
	await addConvBlock(dest, {
		id: crypto.randomUUID(),
		childrenIds: [],
		content: { custom: { contentType: "chat", meta } },
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
