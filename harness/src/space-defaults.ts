/**
 * What every space of yours starts with, so a new space works - or says
 * exactly what it needs - without setup knowledge:
 *
 * - **An "Anthropic" credential**, its key empty until a person pastes one.
 *   New agents list it (website create.ts, `setup`), so an agent with no
 *   key says so on its Error and names this credential, instead of quietly
 *   running on - or failing on - one computer's own Claude sign-in.
 * - **"<Space> Space"**: the space's setup-and-upkeep agent, with its own
 *   System prompt naming the space, served by the computer that seeded it,
 *   on the space's guest list.
 *
 * Only spaces this identity owns (`owner` ""): a space someone shared with
 * you is theirs to set up. Fixed ids (create-if-absent) keep two computers
 * seeding at once from making two of anything; a space that already has
 * an Anthropic credential, or an agent of that name, is left as it is.
 */

import { apiFetch, API, createDefault, fetchObject, lv, queryAll, setField, str, sv, type QueryRow } from "./api";
import { CREDENTIAL_TYPE } from "./credential-objects";
import { fillCredential } from "./credential-seeds";
import { SYSTEM_PROMPT_TYPE, DEFAULT_MODEL, writePageText } from "./prompts";
import { machineId } from "./roster";
import { linkIds, linkList } from "./tool-objects";

export const ANTHROPIC_SERVICE = "anthropic";

/** The page of a seeded Anthropic credential: what to paste, and where it comes from. */
const ANTHROPIC_PAGE = [
	"The Claude login for this space's agents. Every new agent lists it in its Credentials.",
	"Paste one of these into API key or token:",
	"- an Anthropic API key (sk-ant-api…) from console.anthropic.com → API keys, or",
	"- a Claude subscription token (sk-ant-oat…): run `claude setup-token` in a terminal and paste what it prints.",
	"Until a key is here, an agent that lists this credential stops and says so on its Error.",
].join("\n");

/** The standing prompt of a space's "<Space> Space" agent. */
export function spaceAgentPrompt(space: string): string {
	return `You are ${space} Space, the setup and upkeep helper for the ${space} space in Roostr. You keep the space organized: you change objects, their properties, types, templates, queries and collections when a person asks. You don't do the work itself (emails, research, coding) - other agents and people do that.
How Roostr works
Everything is an object. Each object has a type (Task, Email, Person, Page...), a name, properties (typed fields) and a body (blocks of text). It lives in exactly one space, and nothing you do reaches other spaces.
Properties are typed: text, number, date, checkbox, select/status, tags, links to objects, and more. Use object_get to read an object and object_set_field to change one property. Before making a new property, look for an existing one (space_map, find) - never create a second property for the same idea.
Types are objects too. A type's templates are the shape new objects start from: a template's properties and body are copied into every new object of that type, and the type's default template applies automatically. Change a template to change what new objects look like; it never changes existing objects.
Queries are saved filtered lists. A query has the types it lists (Object Type), filters (each is a property, a condition and values - "is", "is any of", "contains", ">=", "is empty", ...) and sorts. Whatever the query shows is exactly what it matches. Collections are hand-picked lists: objects are added or removed one by one, not by filters.
Queries that act: a query with Move to bin, Mark done, Tag agents, or Set property + Set value does that to everything it matches, including what already matched when it was switched on, once per object. Treat these as rules - set them only when a person asks, and check what the query lists first.
Deleting moves an object to the space's Bin; a person can restore it. Emptying the Bin is permanent - never do that.
Agents are objects too: their System prompt, Model, Credentials, Tools, Skills and Served by are properties. A new agent needs this space's "Anthropic" credential in its Credentials to run.
Chat: every object has a chat. Typing @Name addresses an agent and wakes it. Reply in the chat you were asked in.
How to behave
Do only what was asked. If a request is unclear, ask one short question.
Before deleting anything, or changing more than 10 objects at once, say exactly what you will change (how many, which) and wait for a yes.
Say something is done only when the tool's reply shows it done, and describe it that way. A reply starting "error:" means nothing changed.
Reuse what exists: existing properties, types, templates and queries before new ones.
Problems go on the object's Error (object_flag_error), so they show where people look.
Keep replies short: what changed, or the one question you need answered.
When creating new agents, make them terse by default.`;
}

/** The space's Anthropic credential: an active one if it has several, else the oldest. */
export function spaceAnthropicCredential(creds: QueryRow[], space: string): QueryRow | undefined {
	const mine = creds.filter((c) => str(c.fields, "channel") === space && str(c.fields, "service") === ANTHROPIC_SERVICE).sort((a, b) => a.createdAt - b.createdAt);
	return mine.find((c) => str(c.fields, "status") === "active") ?? mine[0];
}

/**
 * Whether a default is still here under `id` - renamed or in the bin included. One deleted
 * for good reads as absent; createDefault then refuses to make it again.
 */
async function everMade(id: string): Promise<boolean> {
	return fetchObject(id).then(() => true, () => false);
}

export async function seedSpaceDefaults(): Promise<{ credentials: number; agents: number }> {
	const out = { credentials: 0, agents: 0 };
	const spaces = ((await (await apiFetch(`${API}/api/channels`)).json()) as Array<{ id: string; name: string; owner: string }>).filter((s) => !s.owner);
	const me = await machineId();
	const failed: string[] = [];
	for (const space of spaces) {
		// One space's trouble never stops the others; all of it is reported at the end.
		try {
			await seedSpace(space, me, out);
		} catch (err) {
			failed.push(`${space.name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (failed.length > 0) throw new Error(failed.join("; "));
	return out;
}

async function seedSpace(space: { id: string; name: string }, me: string, out: { credentials: number; agents: number }): Promise<void> {
	// 1. The Anthropic credential.
	let cred = spaceAnthropicCredential(await queryAll({ type: CREDENTIAL_TYPE }), space.id);
	const credId = `anthropic-${space.id}`;
	if (!cred && !(await everMade(credId))) {
		// Served by the seeding computer: it keeps Status and Error ("No key yet - paste …"), and marks it active once a key is pasted.
		if (!(await createDefault("Anthropic", CREDENTIAL_TYPE, { channel: sv(space.id), service: sv(ANTHROPIC_SERVICE), served_by: sv(me) }, credId))) return;
		const made = await fetchObject(credId);
		await fillCredential(made);
		if (made.blocks.length === 0) await writePageText(credId, ANTHROPIC_PAGE);
		cred = { id: credId, typeKey: CREDENTIAL_TYPE, fields: made.fields, createdAt: made.createdAt } as QueryRow;
		out.credentials += 1;
	}

	// 2. "<Space> Space" - unless the space has one by that name, or ever had the default one.
	const name = `${space.name} Space`;
	const agentId = `space-agent-${space.id}`;
	const agents = (await queryAll({ type: "agent" })).filter((a) => str(a.fields, "channel") === space.id);
	if (agents.some((a) => str(a.fields, "name") === name) || (await everMade(agentId))) return;
	const prompts = (await queryAll({ type: SYSTEM_PROMPT_TYPE })).filter((p) => str(p.fields, "channel") === space.id && str(p.fields, "name") === name);
	let promptId = prompts[0]?.id;
	if (!promptId) {
		promptId = `space-prompt-${space.id}`;
		if (!(await createDefault(name, SYSTEM_PROMPT_TYPE, { channel: sv(space.id), description: sv(`Setup and upkeep of the ${space.name} space.`) }, promptId))) return;
		const p = await fetchObject(promptId);
		if (p.blocks.length === 0) await writePageText(promptId, spaceAgentPrompt(space.name));
	}
	const made = await createDefault(name, "agent", {
		channel: sv(space.id),
		prompt: { linkValue: { relationKey: "prompt", targetId: promptId } },
		served_by: sv(me),
		model: lv([DEFAULT_MODEL]),
		...(cred ? { credentials: linkList("credentials", [cred.id]) } : {}),
	}, agentId);
	if (!made) return;
	// On the space's guest list: it answers in the space's own chat.
	const spaceObj = await fetchObject(space.id);
	const guests = linkIds(spaceObj.fields, "agent");
	if (!guests.includes(agentId)) await setField(space.id, "agent", linkList("agent", [...guests, agentId]));
	out.agents += 1;
}
