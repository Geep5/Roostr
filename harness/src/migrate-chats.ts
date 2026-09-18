/**
 * One-off migration: every chat moves into the object it is about.
 *
 * Before: a conversation WAS an object. Each agent had a `chat` object holding
 * its whole transcript (human turns, ingested copies, tool_use/tool_result,
 * compaction summaries) under that object's own `__discussion__`, and an A2A
 * pair got another `chat` object. The object the conversation was actually
 * about held none of it, so an object's protobuf did not carry its own chats.
 *
 * After: one conversation per thread INSIDE the subject object
 * (`core/conversation.odin`), so reading one object reads every conversation
 * it has had - which is the whole point of the schema.
 *
 * Where each chat goes, and why:
 *
 *   rule   | source                                  | target
 *   -------|-----------------------------------------|---------------------------
 *   bound  | agent chat, agent has `bound_object`    | that object, agent_private
 *   space  | chat pinned in a channel's `pinnedIds`  | the channel, human thread
 *   self   | agent chat, agent has no bound object   | the agent object, agent_private
 *   a2a    | `a2a_pair` chat                         | the asking agent's bound object, a2a
 *
 * Messages are MOVED, not re-posted: each block is added verbatim - same
 * block id, same meta (author, ts, replyTo, reactions, tool payloads) - so
 * nothing is rewritten and re-running is a no-op (`apply_block_add` skips an
 * id it already holds, `core/dag.odin:399`).
 *
 *   bun run src/migrate-chats.ts           # plan only, writes nothing
 *   bun run src/migrate-chats.ts --apply   # move, verify, then delete sources
 */

import { fetchObject, list, mutate, queryAll, str, sv, lv, type BlockJSON, type ObjectJSON } from "./api";

const APPLY = process.argv.includes("--apply");
const POSITION_INNER = 5; // glon.proto Position.INNER: inside target, last child
const LEGACY_HUMAN_ROOT = "__discussion__";

type Rule = "bound" | "space" | "self" | "a2a";

interface ConversationJSON {
	id: string;
	kind: string;
	title: string;
	participants: string[];
	messageCount: number;
}

type Described = ObjectJSON & { conversations?: ConversationJSON[] };

interface Move {
	chat: string;
	name: string;
	rule: Rule;
	target: string;
	kind: "human" | "a2a" | "agent_private";
	participants: string[];
	blocks: BlockJSON[];
	pinnedBy?: string;
	/** The chat's own space, used only when its target no longer exists. */
	channel?: string;
}

const messagesOf = (object: ObjectJSON, rootId = LEGACY_HUMAN_ROOT): BlockJSON[] => {
	const byId = new Map(object.blocks.map((b) => [b.id, b]));
	const root = byId.get(rootId);
	if (!root) return [];
	// Source order is merge order, which is the order the thread must keep.
	return root.childrenIds.map((id) => byId.get(id)).filter((b): b is BlockJSON => !!b);
};

async function plan(): Promise<Move[]> {
	const [chats, channels, agents] = await Promise.all([
		queryAll({ type: "chat" }),
		queryAll({ type: "channel" }),
		queryAll({ type: "agent" }),
	]);
	const agentById = new Map(agents.map((a) => [a.id, a]));
	// A channel pins its front-door chat; that pin is also how we recognise it.
	const pinnedBy = new Map<string, string>();
	for (const channel of channels) for (const id of list(channel.fields, "pinnedIds")) pinnedBy.set(id, channel.id);

	const moves: Move[] = [];
	for (const row of chats) {
		const object = (await fetchObject(row.id)) as Described;
		const blocks = messagesOf(object);
		const name = str(row.fields, "name");
		const pair = str(row.fields, "a2a_pair");
		const agentId = str(row.fields, "agent");
		const channelPin = pinnedBy.get(row.id);

		if (pair) {
			const ids = pair.split(":").filter(Boolean);
			const bound = ids.map((id) => ({ id, object: str(agentById.get(id)?.fields ?? {}, "bound_object") })).filter((a) => a.object);
			// The asker is the agent whose object the pair is named after
			// ("<their object> ⇄ <other agent>"); that object is what the
			// conversation is about.
			let asker = bound[0];
			for (const candidate of bound) {
				const target = await fetchObject(candidate.object).catch(() => undefined);
				const targetName = target ? str(target.fields, "name") : "";
				if (targetName && name.startsWith(targetName)) asker = candidate;
			}
			if (!asker) {
				console.warn(`[migrate] no bound object for pair chat ${row.id} (${name}); skipped`);
				continue;
			}
			moves.push({ chat: row.id, name, rule: "a2a", target: asker.object, kind: "a2a", participants: ids, blocks, channel: str(row.fields, "channel") });
			continue;
		}

		const bound = str(agentById.get(agentId)?.fields ?? {}, "bound_object");
		if (bound) {
			moves.push({ chat: row.id, name, rule: "bound", target: bound, kind: "agent_private", participants: [agentId], blocks, channel: str(row.fields, "channel") });
		} else if (channelPin) {
			// The space's front door is the space's own human chat.
			moves.push({ chat: row.id, name, rule: "space", target: channelPin, kind: "human", participants: [], blocks, pinnedBy: channelPin });
		} else if (agentId) {
			// An unbound agent's transcript belongs to the agent, which is an
			// object like any other.
			moves.push({ chat: row.id, name, rule: "self", target: agentId, kind: "agent_private", participants: [agentId], blocks, channel: str(row.fields, "channel") });
		} else {
			console.warn(`[migrate] chat ${row.id} (${name}) has no agent, no pair and no pin; skipped`);
		}
	}
	return moves;
}

/**
 * Reuse the thread this migration would have created, so re-runs converge.
 *
 * A target can be GONE: a chat's `agent` field can name an agent that was
 * deleted, which is how "CASCADE-2" survived its own agent. An empty chat
 * then has nothing to save; a non-empty one falls back to its channel so no
 * message is dropped on the floor.
 */
async function threadFor(move: Move): Promise<string | undefined> {
	if (move.kind === "human") return LEGACY_HUMAN_ROOT; // auto-created by the first post
	const target = (await fetchObject(move.target).catch(() => undefined)) as Described | undefined;
	if (!target || target.deleted) {
		if (move.blocks.length === 0) return undefined; // nothing to keep
		const channel = move.channel;
		if (!channel) throw new Error(`[migrate] ${move.chat} (${move.name}): target ${move.target} is gone and there is no channel to fall back to`);
		console.warn(`[migrate] ${move.name}: target ${move.target} is gone; ${move.blocks.length} blocks go to channel ${channel}`);
		move.target = channel;
		move.kind = "human";
		return LEGACY_HUMAN_ROOT;
	}
	const existing = (target.conversations ?? []).find((c) => c.kind === move.kind && c.title === move.name);
	if (existing) return existing.id;
	const out = (await mutate("conversation_open", {
		object_id: move.target,
		kind: move.kind,
		title: move.name,
		participants: move.participants,
	})) as { id: string };
	return out.id;
}

async function run(): Promise<void> {
	const moves = await plan();
	const totals = { chats: moves.length, blocks: moves.reduce((n, m) => n + m.blocks.length, 0) };
	for (const move of moves) {
		console.log(`[plan] ${String(move.blocks.length).padStart(4)} blocks  ${move.name.slice(0, 30).padEnd(30)} ${move.rule.padEnd(6)} -> ${move.target}`);
	}
	console.log(`[plan] ${totals.chats} chats, ${totals.blocks} blocks`);
	if (!APPLY) {
		console.log("[plan] dry run; pass --apply to migrate");
		return;
	}

	let moved = 0;
	let skipped = 0;
	let deleted = 0;
	for (const move of moves) {
		const threadId = await threadFor(move);
		if (threadId === undefined) {
			console.warn(`[migrate] ${move.name}: empty chat with no surviving target; deleting the husk`);
			await mutate("delete", { object_id: move.chat });
			deleted += 1;
			continue;
		}
		if (move.blocks.length > 0) {
			const before = (await fetchObject(move.target)) as Described;
			const present = new Set(before.blocks.map((b) => b.id));
			for (const block of move.blocks) {
				if (present.has(block.id)) {
					skipped += 1;
					continue;
				}
				await mutate("block_add", {
					object_id: move.target,
					// Verbatim: the id and meta ARE the message.
					block: { id: block.id, childrenIds: block.childrenIds, content: block.content },
					target_id: threadId,
					position: POSITION_INNER,
				});
				moved += 1;
			}
			// Verify before destroying anything: every source block must now
			// be a child of the target thread.
			const after = (await fetchObject(move.target)) as Described;
			const root = after.blocks.find((b) => b.id === threadId);
			const children = new Set(root?.childrenIds ?? []);
			const missing = move.blocks.filter((b) => !children.has(b.id)).map((b) => b.id);
			if (missing.length > 0) {
				throw new Error(`[migrate] ${move.chat} -> ${move.target}: ${missing.length} blocks did not land (${missing[0]}); nothing deleted`);
			}
		}
		// The pin pointed at an object that is about to stop existing.
		if (move.pinnedBy) {
			const channel = await fetchObject(move.pinnedBy);
			const pins = list(channel.fields, "pinnedIds").filter((id) => id !== move.chat);
			await mutate("set_field", { object_id: move.pinnedBy, key: "pinnedIds", value: lv(pins) });
		}
		await mutate("delete", { object_id: move.chat });
		deleted += 1;
		console.log(`[migrate] ${move.name.slice(0, 30)}: ${move.blocks.length} blocks -> ${move.target} thread ${threadId}, source deleted`);
	}
	console.log(`[migrate] done: ${moved} blocks moved, ${skipped} already present, ${deleted} chat objects deleted`);
	void sv;
}

await run();
