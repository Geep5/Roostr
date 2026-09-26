/**
 * System prompts - what an agent IS before its object says otherwise.
 *
 * An agent's configuration (standing prompt, model, the machine
 * capabilities it `requires`, the skills it sees, the types it answers
 * for) is a `system_prompt` object the agent links with its `prompt`
 * property; the object is edited, shared, and space-scoped like any
 * other. An agent with no `prompt` link runs on DEFAULT_PROMPT - the
 * assistant defaults every agent had before prompts existed. Per-agent
 * fields (`system`, `model`, `responsible_types`) override the prompt,
 * never the other way round; the call sites apply them.
 *
 * PROMPT_SEEDS is not a runtime lookup: it seeds the descriptor cards a
 * setup form renders from and the prompt objects the boot migration and
 * `setup` link agents to. Nothing here is consulted to resolve a live
 * agent - promptFor reads the linked object, so editing the object (or
 * pointing the agent at another) is the whole reconfiguration.
 */

import { readFileSync } from "node:fs";
import { createObject, fetchObject, list, lv, queryAll, str, sv, type ObjectJSON, type ValueJSON } from "./api";

export const SYSTEM_PROMPT_TYPE = "system_prompt";

export interface AgentKindEntry {
	key: string;
	name: string;
	/** Name of the system_prompt object this entry seeds (identity per space). */
	promptName: string;
	description: string;
	system: string;
	model: string;
	/** Capability keys (resolved from the prompt object's `requires` links for a live agent). */
	requires: string[];
	/** Skill keys surfaced to this prompt, by skill name; empty = all. */
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

/** The prompt-less default: a generic standing prompt, the default model, no requires/skills/responsibleTypes. */
export const DEFAULT_PROMPT: AgentKindEntry = {
	key: "assistant",
	name: "Assistant",
	promptName: "Assistant",
	description: "A general Roostr agent: answers its chat and object discussions, reads and organizes the space.",
	system: DEFAULT_SYSTEM,
	model: DEFAULT_MODEL,
	requires: [],
	skills: [],
	responsibleTypes: [],
	fields: [],
	defaults: {},
};

export const PROMPT_SEEDS: AgentKindEntry[] = [
	DEFAULT_PROMPT,
	{
		key: "marco",
		name: "Marco (Matcherino dev bot)",
		promptName: "Marco",
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

/** The id a `prompt` property points at: a single link, a one-link list, or the legacy string id. */
export function promptTarget(fields: Record<string, ValueJSON>): string {
	const v = fields["prompt"];
	if (!v) return "";
	if (v.linkValue?.targetId) return v.linkValue.targetId;
	if (v.stringValue) return v.stringValue;
	const first = v.valuesValue?.items?.[0];
	return first?.linkValue?.targetId ?? first?.stringValue ?? "";
}

/** Skill names a prompt's `skills` links point at; a legacy string item reads as a name. */
async function promptSkillNames(fields: Record<string, ValueJSON>): Promise<string[]> {
	const v = fields["skills"];
	const items = v?.valuesValue?.items ?? (v?.linkValue ? [v] : v?.stringValue ? [sv(v.stringValue)] : []);
	const names: string[] = [];
	for (const item of items) {
		const target = item.linkValue?.targetId ?? "";
		if (!target) {
			if (item.stringValue) names.push(item.stringValue);
			continue;
		}
		const skill = await fetchObject(target).catch(() => null);
		if (skill) names.push(str(skill.fields, "name") || skill.id.slice(0, 8));
	}
	return names;
}

/**
 * The agent's configuration: the fields of the system_prompt object its
 * `prompt` property links, else DEFAULT_PROMPT (blank prompt, dangling
 * link). `requires` comes back as capability keys - the same id→key
 * mapping the agent's own `requires` gets - so the gating call sites
 * compare like with like.
 */
export async function promptFor(agent: ObjectJSON): Promise<AgentKindEntry> {
	const id = promptTarget(agent.fields);
	const prompt = id ? await fetchObject(id).catch(() => null) : null;
	if (!prompt) return DEFAULT_PROMPT;
	// Dynamic, as in skills.ts: capabilities -> descriptors -> skillmgr ->
	// skills -> here would be a module cycle.
	const { requiredKeys } = await import("./capabilities");
	const name = str(prompt.fields, "name");
	return {
		key: name || prompt.id.slice(0, 8),
		name: name || DEFAULT_PROMPT.name,
		promptName: name || DEFAULT_PROMPT.promptName,
		description: str(prompt.fields, "description"),
		system: str(prompt.fields, "system") || DEFAULT_SYSTEM,
		model: str(prompt.fields, "model") || DEFAULT_MODEL,
		requires: await requiredKeys(prompt.fields),
		skills: await promptSkillNames(prompt.fields),
		responsibleTypes: list(prompt.fields, "responsible_types"),
		fields: [],
		defaults: {},
	};
}

/**
 * The system_prompt object for `seed` in `channelId`, created on first
 * use. Identity is (prompt name x space): every agent seeded from the
 * same entry in one space links the same object, so editing it edits
 * them all. A channel-less agent seeds into the vault's oldest channel -
 * the engine's own creation fallback, resolved here so reuse matches.
 */
export async function ensureSystemPrompt(seed: AgentKindEntry, channelId: string): Promise<{ id: string; created: boolean }> {
	let channel = channelId;
	if (!channel) {
		const channels = await queryAll({ type: "channel" });
		channel = channels.sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? "";
	}
	const existing = (await queryAll({ type: SYSTEM_PROMPT_TYPE })).find(
		(r) => str(r.fields, "name") === seed.promptName && str(r.fields, "channel") === channel,
	);
	if (existing) return { id: existing.id, created: false };
	// Dynamic: the module cycle noted in promptFor.
	const { requiresValueForKeys } = await import("./capabilities");
	const fields: Record<string, ValueJSON> = {
		system: sv(seed.system),
		model: sv(seed.model),
		description: sv(seed.description),
	};
	if (channel) fields.channel = sv(channel);
	if (seed.requires.length > 0) fields.requires = await requiresValueForKeys(seed.requires);
	if (seed.responsibleTypes.length > 0) fields.responsible_types = lv(seed.responsibleTypes);
	const { id } = await createObject(seed.promptName, SYSTEM_PROMPT_TYPE, fields);
	return { id, created: true };
}
