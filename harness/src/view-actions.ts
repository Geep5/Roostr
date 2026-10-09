/**
 * Views that act: a saved query with an action property does it to every
 * object it matches.
 *
 * The actions are ordinary properties on the query, seeded in every space:
 *
 * - Move to bin (`view_move_to_bin`, checkbox)
 * - Mark done (`view_mark_done`, checkbox)
 * - Tag agents (`view_tag_agents`, agent links): added to the object's
 *   guests and @-mentioned in its chat, which wakes them there
 * - Set property + Set value (`view_set_property` = a property's name,
 *   `view_set_value` = the value as text)
 *
 * The query's filters are the condition, so whatever the query shows is
 * exactly what it acts on - including what already matched when the action
 * was switched on. Each object is acted on once per query: the object keeps
 * which queries acted (`view_acted`), so a person who restores a binned
 * object, or clears a done box, overrules that query for it for good.
 * Binning comes last, after the note is written.
 *
 * Every action leaves one line in the object's chat saying what and which
 * query; a query whose action fails says so on its own Error ("view action
 * failed: …") until a run of it works.
 *
 * Runs on the computer that serves the query (its Served by, else its
 * first Agent's computer; an unserved acting query says so on its Error): on boot, shortly after any
 * change (debounced), every 5 minutes as a safety net, and synchronously
 * from the scheduler right after a Check first's finds are scored, so what
 * a query bins is never shown to the agent.
 */
import { chatPost, deleteField, fetchObject, guestAgents, mutate, queryAll, setField, str, sv, bv, type ObjectJSON, type QueryRow, type ValueJSON } from "./api";
import { relationFields } from "./jev";
import { primeServing, serverOf, servesHere } from "./machine";
import { relationDefs, savedViewBody } from "./spacemap";

export const BIN_KEY = "view_move_to_bin";
export const DONE_KEY = "view_mark_done";
export const TAG_KEY = "view_tag_agents";
export const SET_PROPERTY_KEY = "view_set_property";
export const SET_VALUE_KEY = "view_set_value";
/** On an acted-on object: query id -> {at, did}. */
export const ACTED_FIELD = "view_acted";

const BADGE = "view action failed:";
const SWEEP_MS = 5 * 60_000;
const SETTLE_MS = 2_000;

/** The action properties in every space, made once. */
export async function seedViewActions(): Promise<number> {
	let made = 0;
	const [spaces, relations, types] = await Promise.all([queryAll({ type: "channel" }), queryAll({ type: "relation" }), queryAll({ type: "type" })]);
	for (const space of spaces) {
		const have = new Set(relations.filter((r) => str(r.fields, "channel") === space.id).map((r) => str(r.fields, "key")));
		const agentType = types.find((t) => str(t.fields, "key") === "agent" && (str(t.fields, "channel") === space.id || t.fields["bundled"]?.boolValue === true));
		const wanted: Array<[key: string, name: string, format: string, emoji: string]> = [
			[BIN_KEY, "Move to bin", "checkbox", "🗑️"],
			[DONE_KEY, "Mark done", "checkbox", "✅"],
			[TAG_KEY, "Tag agents", "object", "🏷️"],
			[SET_PROPERTY_KEY, "Set property", "shorttext", "✏️"],
			[SET_VALUE_KEY, "Set value", "shorttext", "✏️"],
		];
		for (const [key, name, format, emoji] of wanted) {
			if (have.has(key)) continue;
			const fields = relationFields(space.id, key, name, format, emoji, []);
			if (key === TAG_KEY && agentType) fields["object_types"] = { valuesValue: { items: [sv(agentType.id)] } };
			fields["description"] = sv(
				key === TAG_KEY
					? "On a query: agents added to everything it matches, and @-mentioned there"
					: key === SET_PROPERTY_KEY
						? "On a query: the name of a property to set on everything it matches (with Set value)"
						: key === SET_VALUE_KEY
							? "On a query: the value Set property gets on everything it matches"
							: `On a query: ${name.toLowerCase()} everything it matches`,
			);
			await mutate("create", { name, type_key: "relation", fields });
			made += 1;
		}
	}
	return made;
}

interface Actions {
	bin: boolean;
	done: boolean;
	tag: string[];
	setProperty: string;
	setValue: string;
}

function actionsOf(q: QueryRow | ObjectJSON): Actions | null {
	const tag = guestAgents({ agent: q.fields[TAG_KEY] ?? { valuesValue: { items: [] } } });
	const a: Actions = {
		bin: q.fields[BIN_KEY]?.boolValue === true,
		done: q.fields[DONE_KEY]?.boolValue === true,
		tag,
		setProperty: str(q.fields, SET_PROPERTY_KEY).trim(),
		setValue: str(q.fields, SET_VALUE_KEY).trim(),
	};
	return a.bin || a.done || a.tag.length > 0 || a.setProperty ? a : null;
}

/** A Set value's text as the property's value. */
export function valueFor(format: string, text: string): ValueJSON {
	if (format === "number") {
		const n = Number(text);
		if (!Number.isFinite(n)) throw new Error(`"${text}" is not a number`);
		return { floatValue: n };
	}
	if (format === "checkbox") return bv(/^(yes|true|on|1|checked|✓)$/i.test(text));
	if (format === "tag") return { valuesValue: { items: [sv(text)] } };
	if (["status", "shorttext", "text", "longtext", "url", "email", "phone"].includes(format)) return sv(text);
	throw new Error(`Set property can't set a ${format} property`);
}

/** Do one query's actions to one object; bin last, after the note. */
async function act(q: QueryRow, a: Actions, obj: QueryRow): Promise<string[]> {
	const space = str(obj.fields, "channel");
	const did: string[] = [];
	const mentions: string[] = [];
	if (a.setProperty) {
		const rel = [...(await relationDefs(space)).values()].find((r) => r.name.toLowerCase() === a.setProperty.toLowerCase() || r.key === a.setProperty);
		if (!rel) throw new Error(`Set property: no property "${a.setProperty}" in this space`);
		await setField(obj.id, rel.key, valueFor(rel.format, a.setValue));
		did.push(`${rel.name}: ${a.setValue}`);
	}
	if (a.done) {
		await setField(obj.id, "done", bv(true));
		did.push("done");
	}
	if (a.tag.length > 0) {
		const guests = guestAgents(obj.fields);
		const all = [...new Set([...guests, ...a.tag])];
		if (all.length !== guests.length) await setField(obj.id, "agent", { valuesValue: { items: all.map((targetId) => ({ linkValue: { relationKey: "agent", targetId } })) } });
		for (const id of a.tag) {
			const agent = await fetchObject(id).catch(() => null);
			const name = agent ? str(agent.fields, "name") : "";
			if (!name) throw new Error(`Tag agents: agent ${id.slice(0, 8)} not found`);
			mentions.push(`@${name}`);
		}
	}
	if (a.bin) did.push("binned");
	const queryName = str(q.fields, "name") || "a query";
	// One line says what and which query - and its @-mentions wake the tagged agents.
	await chatPost(obj.id, `${[...did, ...mentions].join(", ")} by "${queryName}"`, "scheduler");
	// Noted before any bin: restoring the object overrules this query for it.
	const now = await fetchObject(obj.id);
	const entries = { ...(now.fields[ACTED_FIELD]?.mapValue?.entries ?? {}) };
	entries[q.id] = { mapValue: { entries: { at: { intValue: Date.now() }, did: sv([...did, ...mentions.map((m) => `tag ${m}`)].join(", ")) } } };
	await setField(obj.id, ACTED_FIELD, { mapValue: { entries } });
	if (a.bin) await mutate("delete", { object_id: obj.id });
	return did;
}

let running: Promise<Set<string>> | null = null;
let again = false;

/**
 * Run every acting query this computer serves; returns the ids binned.
 * Concurrent calls share one pass, and a call during a pass queues one more.
 */
export function runViewActions(): Promise<Set<string>> {
	if (running) {
		again = true;
		return running;
	}
	running = (async () => {
		const binned = new Set<string>();
		do {
			again = false;
			for (const id of await pass()) binned.add(id);
		} while (again);
		return binned;
	})().finally(() => {
		running = null;
	});
	return running;
}

async function pass(): Promise<string[]> {
	const binned: string[] = [];
	const queries = (await queryAll({ type: "query" })).filter((q) => actionsOf(q));
	await primeServing(queries.map((q) => q.id));
	for (const q of queries) {
		if (!(await servesHere(q.id))) {
			// Nobody runs it: say so on the query (every computer writes the same text).
			if ((await serverOf(q.id)).machineId === "") {
				const text = `${BADGE} no computer runs this query - set its Served by, or an Agent whose computer should`;
				if (str(q.fields, "error") !== text) await setField(q.id, "error", sv(text)).catch(() => {});
			}
			continue;
		}
		const a = actionsOf(q)!;
		const space = str(q.fields, "channel");
		try {
			const body = await savedViewBody(await fetchObject(q.id), space, await relationDefs(space));
			if (!body) continue;
			const matches = await queryAll(body);
			const failures: string[] = [];
			for (const obj of matches) {
				if (obj.id === q.id || obj.fields[ACTED_FIELD]?.mapValue?.entries?.[q.id]) continue;
				try {
					await act(q, a, obj);
					if (a.bin) binned.push(obj.id);
				} catch (err) {
					failures.push(`${str(obj.fields, "name") || obj.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (failures.length > 0) throw new Error(failures.join("; "));
			if (str(q.fields, "error").startsWith(BADGE)) await deleteField(q.id, "error");
		} catch (err) {
			const text = `${BADGE} ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
			console.error(`[view-actions] "${str(q.fields, "name")}" ${text}`);
			if (str(q.fields, "error") !== text) await setField(q.id, "error", sv(text)).catch(() => {});
		}
	}
	if (binned.length > 0) console.log(`[view-actions] binned ${binned.length}`);
	return binned;
}

let settle: Timer | undefined;

/** A change landed: run the acting queries once things settle. */
export function nudgeViewActions(): void {
	clearTimeout(settle);
	settle = setTimeout(() => void runViewActions().catch((err) => console.error("[view-actions]", err instanceof Error ? err.message : err)), SETTLE_MS);
}

/** Boot: seed the properties, run once, then a slow safety sweep. */
export async function startViewActions(): Promise<void> {
	const made = await seedViewActions();
	if (made > 0) console.log(`[view-actions] seeded ${made} properties`);
	nudgeViewActions();
	setInterval(() => nudgeViewActions(), SWEEP_MS);
}
