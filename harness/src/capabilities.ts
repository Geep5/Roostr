/**
 * Capability objects - the unit the serving resolver reasons over.
 *
 * A capability is ONE catalog skill (or service credential) offered by ONE
 * machine: type `capability`, fields `key` (catalog key), `served_by`
 * (link whose target is the machine id), `install` (link to the install
 * object for that key on that machine). It replaces `machine.capabilities`,
 * the flat string list: "what a machine can do" is now the set of
 * capability objects that name it as `served_by` and whose install is
 * `active`.
 *
 * A capability is invisible until fully set up (`served_by` set AND the
 * linked install `status == "active"`): before that it does not appear in
 * listSkills, the auth contract, or the resolver's candidates. An object's
 * `requires` names capability objects by link, not catalog keys by string
 * (legacy string items still read as keys until migrate-capabilities
 * converts them).
 *
 * Identity is (key x machine): syncCapabilities creates/updates
 * idempotently and vanishes the object when the skill leaves the machine,
 * so a disabled capability cannot linger and keep resolving.
 */

import { createObject, deleteField, mutate, queryAll, setField, str, sv, type QueryRow, type ValueJSON } from "./api";
import { fetchInstallations } from "./descriptors";
import { machineId } from "./roster";

export const CAPABILITY_TYPE = "capability";

export interface CapabilityRow {
	id: string;
	key: string;
	/** Machine id (the roster UUID) of the serving machine; "" until set. */
	servedBy: string;
	installId: string;
	/** Live status of the linked install object ("" when unlinked/missing). */
	installStatus: string;
}

/** A link field value. The served_by/install relations ride as links. */
export const linkValue = (targetId: string): ValueJSON => ({ linkValue: { targetId } });

/** A link-or-string field's target: links during and after the cutover, plain strings before it. */
export function linkTarget(fields: Record<string, ValueJSON>, key: string): string {
	const v = fields[key];
	return v?.linkValue?.targetId || v?.stringValue || "";
}

function rowToCapability(r: QueryRow, installStatus: Map<string, string>): CapabilityRow {
	const installId = linkTarget(r.fields, "install");
	return {
		id: r.id,
		key: str(r.fields, "key"),
		servedBy: linkTarget(r.fields, "served_by"),
		installId,
		installStatus: installStatus.get(installId) ?? "",
	};
}

/** Every capability object, with its install's live status resolved. */
export async function fetchCapabilities(): Promise<CapabilityRow[]> {
	const installStatus = new Map((await fetchInstallations()).map((i) => [i.id, i.status]));
	return (await queryAll({ type: CAPABILITY_TYPE })).map((r) => rowToCapability(r, installStatus));
}

/** Fully set up = served by a machine AND its install active; only then is a capability offered. */
export const fullySetUp = (c: CapabilityRow): boolean => c.servedBy !== "" && c.installStatus === "active";

/** Fully-set-up capability keys served by `machine` (default: this machine). */
export async function activeCapabilityKeys(machine = ""): Promise<string[]> {
	const id = machine || (await machineId());
	return (await fetchCapabilities())
		.filter((c) => c.servedBy === id && fullySetUp(c))
		.map((c) => c.key)
		.sort();
}

/**
 * Pick the capability object a requirement should link: a fully-set-up one
 * on the requiring machine first, then the lowest machine id among the
 * fully set up (the resolver's own tiebreak), else the deterministic first
 * of whatever exists - requiring a not-yet-active capability is allowed;
 * it resolves as unsatisfied and files the holdup.
 */
export function chooseCapability(forKey: CapabilityRow[], me: string): CapabilityRow | null {
	const sorted = [...forKey].sort((a, b) => a.servedBy.localeCompare(b.servedBy));
	const ready = sorted.filter(fullySetUp);
	return ready.find((c) => c.servedBy === me) ?? ready[0] ?? sorted[0] ?? null;
}

/** Raw `requires` items, either shape hosts have written. */
export function requiresItems(fields: Record<string, ValueJSON>): ValueJSON[] {
	const v = fields["requires"];
	return v?.valuesValue?.items ?? (v?.stringValue ? [sv(v.stringValue)] : []);
}

/**
 * An object's `requires` as catalog keys. Link items resolve through their
 * capability object; legacy string items (pre-migration) pass through.
 */
export async function requiredKeys(fields: Record<string, ValueJSON>, caps?: CapabilityRow[]): Promise<string[]> {
	const items = requiresItems(fields);
	const keys = items.map((i) => i.stringValue ?? "").filter(Boolean);
	const linkIds = items.map((i) => i.linkValue?.targetId ?? "").filter(Boolean);
	if (linkIds.length === 0) return keys;
	const byId = new Map((caps ?? (await fetchCapabilities())).map((c) => [c.id, c.key]));
	for (const id of linkIds) {
		const key = byId.get(id);
		if (key) keys.push(key);
	}
	return [...new Set(keys)];
}

/**
 * The engine returns an object's `requires` verbatim: capability object
 * ids where links were written, catalog keys where strings remain. Map
 * both to catalog keys for prompt/holdup text.
 */
export function requirementKeys(tokens: string[], caps: CapabilityRow[]): string[] {
	const byId = new Map(caps.map((c) => [c.id, c.key]));
	return tokens.map((t) => byId.get(t) ?? t);
}

/** What a capability object is called and says, from the catalog that owns the key. */
export interface CapabilitySeed {
	key: string;
	name: string;
	description: string;
}

/**
 * A `requires` value for catalog keys: a link to the best capability
 * object where one exists, else the legacy key string (migrate-capabilities
 * converts it on a later boot, once some machine offers the capability).
 */
export async function requiresValueForKeys(keys: string[]): Promise<ValueJSON> {
	const caps = await fetchCapabilities();
	const me = await machineId();
	const items: ValueJSON[] = [];
	for (const key of [...new Set(keys)]) {
		const chosen = chooseCapability(caps.filter((c) => c.key === key), me);
		items.push(chosen ? linkValue(chosen.id) : sv(key));
	}
	return { valuesValue: { items } };
}
/**
 * The space each capability key belongs to. One vault scan: the space whose
 * objects require the key most, then a space named like the capability,
 * else the vault's default (oldest) space. syncCapabilities converges every
 * capability object's `channel` to this; install rows follow it.
 */
async function integrationSpaces(seeds: CapabilitySeed[], channels: QueryRow[]): Promise<Map<string, string>> {
	const live = new Set(channels.map((c) => c.id));
	const capKeyById = new Map((await queryAll({ type: CAPABILITY_TYPE })).map((r) => [r.id, str(r.fields, "key")]));
	// key -> channel -> objects requiring it there
	const usage = new Map<string, Map<string, number>>();
	for (const row of await queryAll({})) {
		const ch = str(row.fields, "channel");
		if (!ch || !live.has(ch)) continue;
		for (const item of requiresItems(row.fields)) {
			const key = item.stringValue || capKeyById.get(item.linkValue?.targetId ?? "") || "";
			if (!key) continue;
			const byChannel = usage.get(key) ?? new Map<string, number>();
			byChannel.set(ch, (byChannel.get(ch) ?? 0) + 1);
			usage.set(key, byChannel);
		}
	}
	const home = [...channels].sort((a, b) => a.createdAt - b.createdAt)[0]?.id ?? "";
	const out = new Map<string, string>();
	for (const seed of seeds) {
		const byChannel = usage.get(seed.key);
		const best = byChannel ? [...byChannel.entries()].sort((a, b) => b[1] - a[1])[0][0] : "";
		if (best) {
			out.set(seed.key, best);
			continue;
		}
		const named = channels.find((c) => {
			const n = str(c.fields, "name").toLowerCase();
			return n && (n === seed.key.toLowerCase() || n === seed.name.toLowerCase());
		});
		out.set(seed.key, named?.id ?? home);
	}
	return out;
}


/**
 * Reconcile this machine's capability objects with `seeds` (the skills and
 * logins currently on here). Creates/updates idempotently - (key x this
 * machine) is the identity, and the `install` link follows the live
 * install row - and VANISHES objects whose key left the set: a tombstoned
 * capability keeps resolving on replicas that missed the delete, a
 * vanished one is in the ledger and stays gone everywhere.
 *
 * Never throws: the published set is what OTHER machines resolve against,
 * never a precondition for serving here.
 */
export async function syncCapabilities(seeds: CapabilitySeed[]): Promise<void> {
	try {
		const id = await machineId();
		const installs = await fetchInstallations();
		const installIdFor = (key: string) => installs.find((i) => i.machineId === id && i.key === key && !i.account)?.id ?? "";
		const channels = await queryAll({ type: "channel" });
		const spaces = await integrationSpaces(seeds, channels);
		const mine = (await queryAll({ type: CAPABILITY_TYPE })).filter((r) => linkTarget(r.fields, "served_by") === id);
		const wanted = new Map(seeds.map((s) => [s.key, s]));
		for (const [key, seed] of wanted) {
			const installId = installIdFor(key);
			const space = spaces.get(key) ?? "";
			const hit = mine.find((r) => str(r.fields, "key") === key);
			if (!hit) {
				await createObject(seed.name, CAPABILITY_TYPE, {
					key: sv(key),
					served_by: linkValue(id),
					...(installId ? { install: linkValue(installId) } : {}),
					...(space ? { channel: sv(space) } : {}),
					description: sv(seed.description),
				});
				continue;
			}
			// The channel is machine-derived, not a preference: an integration
			// belongs to the space it serves, and rows created before that rule
			// carry the daemon's creation fallback - converge those too.
			if (space && str(hit.fields, "channel") !== space) await setField(hit.id, "channel", sv(space));
			if (linkTarget(hit.fields, "install") !== installId) {
				if (installId) await setField(hit.id, "install", linkValue(installId));
				else await deleteField(hit.id, "install");
			}
			if (str(hit.fields, "description") !== seed.description) await setField(hit.id, "description", sv(seed.description));
		}
		const stale = mine.filter((r) => !wanted.has(str(r.fields, "key")));
		if (stale.length > 0) await mutate("vanish", { object_ids: stale.map((r) => r.id) });
	} catch (err) {
		console.error("[harness] could not publish capability objects:", err instanceof Error ? err.message : err);
	}
}
