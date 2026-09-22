/**
 * Agent kinds - what an agent IS before its object says otherwise.
 *
 * A kind supplies the defaults an agent object may leave blank: standing
 * prompt, model, the skills it sees, the types it answers for, and the
 * machine capabilities (`requires`) the serving machine must have. Each
 * kind is published as a `kind: "agent"` descriptor card
 * (`descriptors.ts`), so a client renders the setup form from data and the
 * website keeps no copy of this table.
 *
 * The agent object's `kind` field names the entry; a missing or unknown
 * key is `assistant`, which is exactly what every agent was before kinds
 * existed. Per-agent fields override the kind, never the other way round.
 *
 * Non-secret kind fields are plain string fields on the agent object under
 * the FieldSpec key. Secret fields never touch the object: they live in the
 * machine's credential store under the integration the kind requires.
 */

import { readFileSync } from "node:fs";

export interface AgentKindEntry {
	key: string;
	name: string;
	description: string;
	system: string;
	model: string;
	/** Descriptor keys the serving machine must have active. */
	requires: string[];
	/** Skill keys surfaced to this kind; empty = all. */
	skills: string[];
	responsibleTypes: string[];
	fields: Array<{ key: string; label: string; secret: boolean; format: "text" | "password" | "url" | "email"; note: string }>;
	/** Values written for fields the setup left blank (harness-side; the card's `note` tells the human). */
	defaults: Record<string, string>;
}

export const DEFAULT_SYSTEM = `You are a helpful agent living inside Roostr, a local-first notes app where
everything is an object in a content-addressed DAG. You converse with your
principal through your chat and through any object's discussion — messages
from other objects arrive framed with their origin and the object's contents.
ALWAYS answer in plain text: your final reply is posted to the surface the
question came from automatically (never use chat_reply_on for that; it is
only for unprompted messages on OTHER objects). Use tools to read, search,
create, and organize objects; use memory_* tools to pin durable facts and
milestones. Be concise and concrete. When a listed skill matches the task,
read it with skill_read before starting.`;

export const DEFAULT_MODEL = process.env.GLON_AGENT_MODEL || "claude-sonnet-4-5";

/** Marco's standing prompt travels as a file so the card stays byte-identical to the source it was ported from. */
const MARCO_SYSTEM = readFileSync(`${import.meta.dir}/../kinds/marco.md`, "utf8");

/** Default checkout for the Matcherino dev bot; also the `matcherino-dev` skill's check path. */
export const MATCHERINO_REPO = "/home/geep/Matcherino";

export const AGENT_KINDS: AgentKindEntry[] = [
	{
		key: "assistant",
		name: "Assistant",
		description: "A general Roostr agent: answers its chat and object discussions, reads and organizes the space.",
		system: DEFAULT_SYSTEM,
		model: DEFAULT_MODEL,
		requires: [],
		skills: [],
		responsibleTypes: [],
		fields: [],
		defaults: {},
	},
	{
		key: "marco",
		name: "Marco (Matcherino dev bot)",
		description: "Matcherino admin assistant on Discord: codebase, production read replica, tickets, Shortcut and Google Workspace from this machine's shell.",
		system: MARCO_SYSTEM,
		// Moonshot's model list for the stored key (GET /v1/models): kimi-k3,
		// kimi-k2.7-code, kimi-k2.6. BotAdmin ran on omp's kimi-code/k3.
		model: "kimi-k3",
		requires: ["matcherino-dev", "discord-bot"],
		skills: [],
		responsibleTypes: [],
		fields: [
			{ key: "discord_channel_id", label: "Discord channel id", secret: false, format: "text", note: "Admin channel the bot answers in. Required." },
			{ key: "discord_extra_channel_ids", label: "Extra channel ids", secret: false, format: "text", note: "Comma-separated additional guild channels to answer in." },
			{ key: "discord_allowed_dm_users", label: "Allowed DM users", secret: false, format: "text", note: "Comma-separated Discord user ids whose DMs are answered." },
			{ key: "repo_path", label: "Repository path", secret: false, format: "text", note: `Checkout shell_exec starts in. Default ${MATCHERINO_REPO}.` },
		],
		defaults: { repo_path: MATCHERINO_REPO },
	},
];

/** The kind an agent object names, else assistant - the pre-kinds default. */
export function agentKind(key: string): AgentKindEntry {
	return AGENT_KINDS.find((k) => k.key === key) ?? AGENT_KINDS[0];
}
