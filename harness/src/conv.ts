/**
 * Conversation addressing: every chat lives inside the object it is about.
 *
 * A conversation used to BE an object - a `chat` object per agent (its whole
 * transcript) and another per A2A pair - so the object the conversation was
 * about carried none of it. Now an object holds many conversations, each a
 * thread in its own block tree (`core/conversation.odin`), and the address of
 * a conversation is therefore a PAIR: which object, which thread.
 *
 *   { objectId, threadId }   threadId "__discussion__" = the human thread
 *                            threadId "__thread__<uuid>" = an opened thread
 *
 * Everything the harness used to key on a chat object id now keys on this
 * pair - watermarks, turn state, tool blocks, compaction summaries.
 */

import { addBlock, chatPost, fetchObject, mutate, str, type BlockJSON, type ObjectJSON } from "./api";

/** The human thread's root, auto-created by the first post (mutate.odin). */
export const HUMAN_THREAD = "__discussion__";

export interface ConvRef {
	objectId: string;
	/** Empty is not allowed: an unaddressed conversation is a lost one. */
	threadId: string;
}

export interface ConversationJSON {
	id: string;
	/** "human" | "a2a" | "agent_private"; "" from a newer writer. */
	kind: string;
	title: string;
	participants: string[];
	createdAt: number;
	openedBy: string;
	aboutMessageId: string;
	closed: boolean;
	messageCount: number;
}

type Described = ObjectJSON & { conversations?: ConversationJSON[] };

export const humanRef = (objectId: string): ConvRef => ({ objectId, threadId: HUMAN_THREAD });

/** Stable string for maps, marks files and logs. */
export const convKey = (ref: ConvRef): string => `${ref.objectId}:${ref.threadId}`;

export const parseConvKey = (key: string): ConvRef => {
	const cut = key.indexOf(":");
	if (cut < 0) return humanRef(key); // a pre-migration mark, keyed on the object alone
	return { objectId: key.slice(0, cut), threadId: key.slice(cut + 1) };
};

export const isHuman = (ref: ConvRef): boolean => ref.threadId === HUMAN_THREAD;

/**
 * The agent's home: the agent object itself. Its transcripts for other
 * objects live on THOSE objects (`object.agent` names it, N:1) - see
 * `agentThreadOn`.
 */
export const agentSubject = (agent: Pick<ObjectJSON, "id" | "fields">): string => agent.id;

/** The core decodes every thread and serves them on the object. */
export async function conversationsOf(objectId: string): Promise<ConversationJSON[]> {
	const object = (await fetchObject(objectId)) as Described;
	return object.conversations ?? [];
}

/** Blocks under one conversation, in merge order - the order it happened. */
export function convBlocks(object: ObjectJSON, threadId: string): Array<{ id: string; block: BlockJSON }> {
	const byId = new Map(object.blocks.map((b) => [b.id, b]));
	const root = byId.get(threadId);
	if (!root) return [];
	const out: Array<{ id: string; block: BlockJSON }> = [];
	for (const id of root.childrenIds) {
		const block = byId.get(id);
		if (block) out.push({ id, block });
	}
	return out;
}

/** Post a message into a conversation. */
export const postTo = (ref: ConvRef, text: string, asAuthor = "", replyTo = ""): Promise<{ id: string }> =>
	chatPost(ref.objectId, text, asAuthor, replyTo, isHuman(ref) ? "" : ref.threadId);

/** Append a non-message block (tool_use, tool_result, compaction) to a conversation. */
export const addConvBlock = (ref: ConvRef, block: Partial<BlockJSON>): Promise<unknown> =>
	addBlock(ref.objectId, block, ref.threadId, 5 /* Position.INNER */);

/**
 * In-flight thread openings, claimed synchronously.
 *
 * The roster callback rebuilds every served agent, so several passes can be
 * in the air at once. The old code raced here and gave one agent three chat
 * objects - its conversation split across them and the agent looked amnesiac.
 * One promise per key, and the losers await the winner.
 */
const opening = new Map<string, Promise<ConvRef>>();

async function claim(key: string, open: () => Promise<ConvRef>): Promise<ConvRef> {
	const inFlight = opening.get(key);
	if (inFlight) return inFlight;
	const run = open();
	opening.set(key, run);
	try {
		return await run;
	} finally {
		opening.delete(key);
	}
}

/**
 * The agent's transcript on one object: its holistic conversation about
 * that object - the object that names it (`object.agent`), its space, or the
 * agent object itself, since an agent is an object like any other.
 *
 * Three ways to land on the right thread, in order:
 *
 *  1. a thread this agent already takes part in;
 *  2. else an `agent_private` thread on this subject with no OTHER live
 *     agent in it - adopt it, adding this agent to the participants. That is
 *     what a migrated transcript looks like: the vault had two agent objects
 *     minted for one person, their two chats merged into one thread, and the
 *     twin would otherwise open an empty second transcript and read as
 *     amnesiac - the exact failure the old lowest-id-wins rule existed for;
 *  3. else open one.
 *
 * Deterministic across devices: when two harnesses race, the lowest thread
 * id wins, exactly as the lowest chat id used to.
 */
export async function agentThreadOn(agent: ObjectJSON, subject: string): Promise<ConvRef> {
	const title = str(agent.fields, "name") || "Agent";
	return claim(`agent:${agent.id}:${subject}`, async () => {
		const threads = (await conversationsOf(subject)).filter((c) => c.kind === "agent_private");
		const mine = threads
			.filter((c) => c.participants.includes(agent.id))
			.map((c) => c.id)
			.sort();
		if (mine.length > 0) return { objectId: subject, threadId: mine[0] };

		// An inherited transcript: same name, and nobody else is listed in it.
		const adoptable = threads
			.filter((c) => c.title === title && c.participants.length === 0)
			.concat(threads.filter((c) => c.title === title && c.participants.length > 0))
			.sort((a, b) => b.messageCount - a.messageCount || a.id.localeCompare(b.id))[0];
		if (adoptable) {
			await mutate("conversation_update", {
				object_id: subject,
				thread_id: adoptable.id,
				participants: [...new Set([...adoptable.participants, agent.id])],
			});
			console.log(
				`[harness] adopted transcript "${title}" on ${subject.slice(0, 8)} (${adoptable.id.slice(0, 18)}…, ${adoptable.messageCount} messages)`,
			);
			return { objectId: subject, threadId: adoptable.id };
		}

		const out = (await mutate("conversation_open", {
			object_id: subject,
			kind: "agent_private",
			title,
			participants: [agent.id],
		})) as { id: string };
		console.log(`[harness] opened transcript for "${title}" on ${subject.slice(0, 8)} (${out.id.slice(0, 18)}…)`);
		return { objectId: subject, threadId: out.id };
	});
}

/** The agent's own transcript, on its home (`agentSubject`). */
export const agentThread = (agent: ObjectJSON): Promise<ConvRef> => agentThreadOn(agent, agentSubject(agent));
