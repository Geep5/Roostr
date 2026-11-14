/**
 * Emoji reactions in a chat. A reaction is its own chat line (chat_post
 * `reaction`): meta `kind` "reaction", `emoji`, `replyTo` the message it is
 * on, and `removed` "1" when its author takes it back. The latest line per
 * (author, emoji, replyTo) is the reaction's state. A reaction is never
 * words: nothing that reads messages takes one for text, and an agent reads
 * it as one line (`reactionLine`).
 *
 * What an emoji means is a space's to say: an object of type Reaction (its
 * Name the meaning, `emoji`, `reaction_agent`, its page the instructions).
 * Who a reaction wakes is surfaces.ts `reactionWake`.
 */

export const REACTION_TYPE = "reaction";
/** On a Reaction: the emoji it gives a meaning to. */
export const REACTION_EMOJI_KEY = "emoji";
/** On a Reaction: the agent a reaction with its emoji wakes. */
export const REACTION_AGENT_KEY = "reaction_agent";

type Meta = Record<string, string>;

/** Whether a chat line is a reaction rather than a message. */
export const isReaction = (meta: Meta | undefined): boolean => meta?.["kind"] === "reaction";

/** Whether a reaction line takes the reaction back. */
export const reactionRemoved = (meta: Meta): boolean => meta["removed"] === "1";

/** An emoji compared without its presentation selectors: ❤ and ❤️ are one reaction. */
export const bareEmoji = (emoji: string): string => emoji.replace(/[\uFE0E\uFE0F]/g, "").trim();

const TARGET_LIMIT = 200;

/**
 * A reaction as one line an agent reads: `reactor` reacted (or took back)
 * its emoji on `target` - the message's author as a name ("you" for the
 * reader) and its text; null when that message is gone.
 */
export function reactionLine(reactor: string, meta: Meta, target: { author: string; text: string } | null): string {
	const emoji = meta["emoji"] ?? "";
	let on = "a message that is no longer there";
	if (target) {
		const flat = target.text.replace(/\s+/g, " ").trim();
		const text = flat.length > TARGET_LIMIT ? `${flat.slice(0, TARGET_LIMIT)}…` : flat;
		on = `${target.author === "you" ? "your" : `${target.author}'s`} message: "${text}"`;
	}
	return reactionRemoved(meta) ? `${reactor} removed their ${emoji} reaction from ${on}` : `${reactor} reacted ${emoji} to ${on}`;
}

/**
 * Whether `metas[at]` is no longer its reaction's state: a later line (in
 * `metas`' chronological order) from the same author, with the same emoji,
 * on the same message.
 */
export function reactionSuperseded(metas: Meta[], at: number): boolean {
	const own = metas[at];
	const emoji = bareEmoji(own["emoji"] ?? "");
	for (let i = at + 1; i < metas.length; i++) {
		const m = metas[i];
		if (isReaction(m) && m["author"] === own["author"] && m["replyTo"] === own["replyTo"] && bareEmoji(m["emoji"] ?? "") === emoji) return true;
	}
	return false;
}
