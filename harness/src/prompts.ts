/**
 * System prompts - what an agent IS before its object says otherwise.
 *
 * An agent's standing prompt and model are a `system_prompt` object the
 * agent links with its `prompt` property (the skills it uses are the
 * agent's own Skills property, skills.ts); the object is edited,
 * shared, and space-scoped like any other. An agent with no `prompt` link
 * is linked to its space's "Assistant" prompt object before it runs
 * (`ensureAgentPrompt`) - there is no hidden prompt behind the UI. The
 * agent's own `model` overrides the prompt's, never the other way round;
 * the call sites apply it. The base prompt text is the prompt object's
 * alone. Which objects an agent works on is not configured here: an agent
 * is put on an object's guest list, typically by that object's template.
 *
 * PROMPT_SEEDS is not a runtime lookup: it seeds each space's agent-kind
 * Templates (catalog-seeds.ts) and the prompt objects those templates, the
 * boot migration and `setup` link agents to. Nothing here is consulted to
 * resolve a live agent - promptFor reads the linked object, so editing the
 * object (or pointing the agent at another) is the whole reconfiguration.
 */

import { addBlock, choice, createObject, fetchObject, queryAll, setField, str, sv, type ObjectJSON, type ValueJSON } from "./api";

export const SYSTEM_PROMPT_TYPE = "system_prompt";

export interface AgentKindEntry {
	key: string;
	name: string;
	/** Name of the system_prompt object this entry seeds (identity per space). */
	promptName: string;
	description: string;
	system: string;
	model: string;
	/** Catalog keys of the skills an agent seeded from this entry lists in its Skills. */
	skills: string[];
	/** Per-agent settings an agent of this kind fills in: each one a property of its space (`note` = the property's description). Never a secret: secrets are Credentials. */
	fields: Array<{ key: string; label: string; note: string }>;
	/** Values the kind's template carries for fields left blank. */
	defaults: Record<string, string>;
}

/**
 * The standing prompt seeded into each space's "Assistant" system_prompt
 * object. It is the ONLY base prompt an agent runs on besides its own
 * `system` field - nothing is hardcoded behind the UI. It covers both
 * places an agent answers: an object's discussion (it is that object's
 * mind) and its own chat.
 */
export const DEFAULT_SYSTEM = `You are an agent in Roostr - a local-first knowledge space where every
note, person, task, and project is an object with typed properties, living
in exactly one space, connected by links. Saved views (queries/collections)
are the human's own groupings of the space - treat them as the semantic map.

When you answer on an object's discussion you are that object's mind. The
sections below describe your world: your object (its fields), its type
(what the human says it means), its connections (typed links in and out),
and the space census. They are a summary, not the object: "Your object"
lists field values only - not the body text or the discussion - and can lag
a change made moments ago. object_get on your object's id returns its fields
and full body; discussion_read returns the thread. Read them whenever a
question turns on the body or on what was already said - never tell the
human you would need to read something you can simply read.

Reading is free and unlimited: space_map, neighborhood, find, query_run,
object_get, discussion_read cost nothing. Query until you understand. Act on
objects with the write tools when asked. Use memory_* tools to pin durable
facts and milestones. When a listed skill matches the task, read it with
skill_read before starting.

ALWAYS answer in plain text: your final reply is posted to the surface the
question came from automatically (never use chat_reply_on for that; it is
only for unprompted messages on OTHER objects). Be concise and concrete.

Identity: on an object you go by that object's name - never introduce
yourself as Claude, an AI model, or "the agent for X". For a person object
you are the keeper of their profile, not the person: speak about them in
the third person. Skip introductions and menu-of-options boilerplate -
answer the question directly.`;

/** The Assistant text seeded before the prompt was unified; an Assistant
 *  object still holding it verbatim (never edited) is upgraded to DEFAULT_SYSTEM. */
export const LEGACY_DEFAULT_SYSTEM = `You are a helpful agent living inside Roostr, a local-first notes app where
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

/** The prompt-less default: a generic standing prompt, the default model, no skills. */
export const DEFAULT_PROMPT: AgentKindEntry = {
	key: "assistant",
	name: "Assistant",
	promptName: "Assistant",
	description: "A general Roostr agent: answers its chat and object discussions, reads and organizes the space.",
	system: DEFAULT_SYSTEM,
	model: DEFAULT_MODEL,
	skills: [],
	fields: [],
	defaults: {},
};

/** The built-in kinds; private extensions (extensions.ts) append their own at load. */
export const PROMPT_SEEDS: AgentKindEntry[] = [DEFAULT_PROMPT];

/** The id a `prompt` property points at: a single link, a one-link list, or the legacy string id. */
export function promptTarget(fields: Record<string, ValueJSON>): string {
	const v = fields["prompt"];
	if (!v) return "";
	if (v.linkValue?.targetId) return v.linkValue.targetId;
	if (v.stringValue) return v.stringValue;
	const first = v.valuesValue?.items?.[0];
	return first?.linkValue?.targetId ?? first?.stringValue ?? "";
}

/** What a linked system_prompt object configures: the standing text and the model. */
export interface PromptConfig {
	name: string;
	system: string;
	model: string;
}

/**
 * The agent's configuration: the fields of the system_prompt object its
 * `prompt` property links. Every served agent is linked before it runs
 * (`ensureAgentPrompt`), so the base prompt is always one a human can see
 * and edit in Roostr; a blank `system` there means no base prompt, never a
 * hidden one. The default model covers the instant between an agent's
 * creation and that link landing.
 */
export async function promptFor(agent: ObjectJSON): Promise<PromptConfig> {
	const id = promptTarget(agent.fields);
	const prompt = id ? await fetchObject(id).catch(() => null) : null;
	if (!prompt) return { name: DEFAULT_PROMPT.name, system: "", model: DEFAULT_PROMPT.model };
	return {
		name: str(prompt.fields, "name") || DEFAULT_PROMPT.name,
		// The page body is the prompt. The legacy `system` field is read only
		// until this machine's boot migration moves it onto the page.
		system: pageText(prompt) || str(prompt.fields, "system"),
		model: choice(prompt.fields, "model") || DEFAULT_MODEL,
	};
}

/**
 * Make sure `agent` links a live system_prompt object: an agent with none
 * (or a dangling link) is pointed at its space's "Assistant" prompt, created
 * from DEFAULT_SYSTEM on first use. Returns the agent as it now stands.
 * Subagents are left alone - their standing text is their spawn template.
 */
export async function ensureAgentPrompt(agent: ObjectJSON): Promise<ObjectJSON> {
	if (str(agent.fields, "spawn_parent")) return agent;
	const id = promptTarget(agent.fields);
	if (id && (await fetchObject(id).catch(() => null))) return agent;
	const prompt = await ensureSystemPrompt(DEFAULT_PROMPT, str(agent.fields, "channel"));
	const { linkValue } = await import("./capabilities");
	await setField(agent.id, "prompt", linkValue(prompt.id));
	console.log(`[harness] linked ${str(agent.fields, "name") || agent.id.slice(0, 8)} to the space's Assistant prompt${prompt.created ? " (created)" : ""}`);
	return fetchObject(agent.id);
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
	const fields: Record<string, ValueJSON> = {
		model: sv(seed.model),
		description: sv(seed.description),
	};
	if (channel) fields.channel = sv(channel);
	const { id } = await createObject(seed.promptName, SYSTEM_PROMPT_TYPE, fields);
	// The standing prompt IS the page: what you open is what the agent runs on.
	await writePageText(id, seed.system);
	return { id, created: true };
}

/**
 * A page's own text: its text blocks in tree order, one line each. Chat,
 * conversation roots, mailbox receipts and tool blocks are not page text and
 * never leak into a prompt.
 */
export function pageText(obj: ObjectJSON): string {
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of obj.blocks) for (const c of b.childrenIds) referenced.add(c);
	const out: string[] = [];
	const walk = (id: string) => {
		const b = byId.get(id);
		if (!b || !b.content.text) return;
		if (b.content.text.text) out.push(b.content.text.text);
		for (const c of b.childrenIds) walk(c);
	};
	for (const b of obj.blocks) if (!referenced.has(b.id)) walk(b.id);
	return out.join("\n");
}

/** Append `text` to a page, one text block per non-empty line, in order. */
export async function writePageText(objectId: string, text: string): Promise<void> {
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		await addBlock(objectId, { id: crypto.randomUUID(), childrenIds: [], content: { text: { text: line, style: 0 } } });
	}
}
