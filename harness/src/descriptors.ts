/**
 * Publish what this machine knows, as data.
 *
 * Two kinds of row, and the split is the design (`docs/descriptors.md`):
 *
 *  - a **descriptor** says what a thing IS - an X login needs four fields,
 *    two of them secret, and authenticates by browser profile or API key.
 *    It is machine-authored and versioned, so it travels as protobuf bytes in
 *    a block: a client older than the descriptor renders what it understands
 *    and hands the rest back untouched.
 *  - an **installation** says what is TRUE on one machine right now - active,
 *    needs auth, broken, and the error text. Those are object FIELDS, so
 *    `error` lands on the bundled Error property and every view, sort and
 *    badge already works on it.
 *
 * The catalogs (`CATALOG`, `CREDENTIALS`) stop being the runtime source of
 * truth and become the seed, exactly how `BUNDLED_TYPES` seeds types. That
 * kills the hand-copy the website admits to keeping in
 * `src/lib/serving.ts` ("Mirrors the harness catalogs …").
 *
 * No secret value can appear here. `FieldSpec.secret` says a value exists on
 * some machine; the value stays in `credentials.json`, a Chrome profile, or a
 * `gws` config dir.
 */

import { API, apiFetch, createObject, fetchObject, mutate, queryAll, str, sv, iv, type ValueJSON } from "./api";
import { CREDENTIALS } from "./credentials";
import { CATALOG } from "./skillmgr";
import { machineId } from "./roster";
import { listGoogleAccounts } from "./google";
import { hostname } from "node:os";

export const DESCRIPTOR_TYPE = "descriptor";
export const INSTALL_TYPE = "install";

/** Bumped when a catalog entry's meaning changes, not on every text tweak. */
const DESCRIPTOR_VERSION = "1";

export type InstallStatus = "active" | "needs_auth" | "needs_approval" | "processing" | "missing" | "broken" | "disabled";
export type AuthMethod = "browser_profile" | "oauth" | "api_key" | "none";

export interface DescriptorJSON {
	key: string;
	name: string;
	description: string;
	kind: "skill" | "integration" | "agent";
	fields: Array<{ key: string; label: string; secret: boolean; format: string; note: string }>;
	auths: AuthMethod[];
	check?: { command: string; expectContains: string; timeoutMs: number };
	install?: { prompt: string; uninstallPrompt: string; docsUrl: string };
	version: string;
	author: string;
	/** Bytes a newer writer added; re-emitted verbatim. */
	unknown?: string;
}

/**
 * The codec lives in the shared core (`core/descriptor.odin`). The harness has
 * no WASM core, so it asks the daemon rather than growing a second protobuf
 * implementation - which is the whole failure this work removes.
 */
async function codec<T>(action: "encode" | "decode", type: string, payload: Record<string, unknown>): Promise<T> {
	const res = await apiFetch(`${API}/api/descriptor`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action, type, ...payload }),
	});
	const out = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; error?: string } | null;
	if (!res.ok || !out?.ok) throw new Error(out?.error || `descriptor ${action}: ${res.status}`);
	return out.result as T;
}

/**
 * Who published a card. The vault's own author id (`GET /api/settings`), so a
 * client can show provenance next to a form that asks for a password -
 * descriptors are unsigned data by design, and "who wrote this" is the only
 * defence a human gets.
 */
let cachedAuthor = "";
export async function vaultAuthorId(): Promise<string> {
	if (cachedAuthor) return cachedAuthor;
	const res = await apiFetch(`${API}/api/settings`);
	const out = (await res.json().catch(() => null)) as { authorId?: string } | null;
	cachedAuthor = out?.authorId ?? "";
	return cachedAuthor;
}

export const encodeDescriptor = (value: DescriptorJSON): Promise<string> =>
	codec<string>("encode", "descriptor", { value });

export const decodeDescriptor = (bytes: string): Promise<DescriptorJSON> =>
	codec<DescriptorJSON>("decode", "descriptor", { bytes });

/** Catalog skill -> descriptor card. */
function skillDescriptor(entry: (typeof CATALOG)[number], author: string): DescriptorJSON {
	return {
		key: entry.key,
		name: entry.label ?? entry.name,
		description: entry.description,
		kind: "skill",
		fields: [],
		// A skill is a tool on PATH: nothing to authenticate unless its own
		// auth check says otherwise.
		auths: entry.authCheckCmd ? ["browser_profile"] : ["none"],
		check: { command: entry.checkCmd, expectContains: "", timeoutMs: 0 },
		install: { prompt: entry.installPrompt, uninstallPrompt: entry.uninstallPrompt, docsUrl: "" },
		version: DESCRIPTOR_VERSION,
		author,
	};
}

/** Credential entry -> descriptor card. */
function credentialDescriptor(entry: (typeof CREDENTIALS)[number], author: string): DescriptorJSON {
	const auths: AuthMethod[] = [];
	if (entry.loginUrl) auths.push("browser_profile");
	if (entry.passwordFields?.length) auths.push("api_key");
	if (auths.length === 0) auths.push("none");
	return {
		key: entry.key,
		name: entry.label,
		description: entry.note,
		kind: "integration",
		fields: (entry.passwordFields ?? []).map((f) => ({
			key: f.key,
			label: f.label,
			secret: f.secret,
			// A secret field is a password box; everything else is text. The
			// client needs no table of its own to draw the form.
			format: f.secret ? "password" : "text",
			note: "",
		})),
		auths,
		install: { prompt: "", uninstallPrompt: "", docsUrl: entry.loginUrl ?? "" },
		version: DESCRIPTOR_VERSION,
		author,
	};
}

export function catalogDescriptors(author: string): DescriptorJSON[] {
	return [
		...CATALOG.map((c) => skillDescriptor(c, author)),
		...CREDENTIALS.map((c) => credentialDescriptor(c, author)),
	];
}

async function descriptorRows(): Promise<Map<string, { id: string; fields: Record<string, ValueJSON> }>> {
	const rows = await queryAll({ type: DESCRIPTOR_TYPE });
	const out = new Map<string, { id: string; fields: Record<string, ValueJSON> }>();
	for (const r of rows) out.set(str(r.fields, "key"), { id: r.id, fields: r.fields });
	return out;
}

/** The card block on a descriptor object, if it has one. */
async function cardBlock(objectId: string): Promise<{ id: string; bytes: string } | undefined> {
	const object = await fetchObject(objectId);
	for (const block of object.blocks ?? []) {
		const custom = block.content?.custom;
		if (custom?.contentType !== "descriptor") continue;
		return { id: block.id, bytes: custom.data ?? "" };
	}
	return undefined;
}

/**
 * Seed or refresh this machine's descriptor cards. Idempotent: an unchanged
 * card writes nothing, because a restart must not cost a change per skill.
 *
 * The card rides in a BLOCK, not a field, so the core can decode it into
 * every object it serves (`descriptor` on the object JSON) - a client renders
 * the form without its own protobuf reader. The row's fields stay as the
 * cheap projection lists and queries need.
 */
export async function publishDescriptors(author?: string): Promise<{ created: number; updated: number }> {
	const writer = author ?? (await vaultAuthorId());
	const existing = await descriptorRows();
	let created = 0;
	let updated = 0;
	for (const descriptor of catalogDescriptors(writer)) {
		const bytes = await encodeDescriptor(descriptor);
		const row = {
			key: sv(descriptor.key),
			kind: sv(descriptor.kind),
			description: sv(descriptor.description),
			version: sv(descriptor.version),
		};
		const hit = existing.get(descriptor.key);
		if (!hit) {
			const { id } = await createObject(descriptor.name, DESCRIPTOR_TYPE, row);
			await mutate("block_add", {
				object_id: id,
				block: { content: { custom: { contentType: "descriptor", data: bytes, meta: {} } } },
			});
			created += 1;
			continue;
		}
		const card = await cardBlock(hit.id);
		if (card?.bytes === bytes) continue;
		if (card) {
			await mutate("block_update", {
				object_id: hit.id,
				block_id: card.id,
				content: { custom: { contentType: "descriptor", data: bytes, meta: {} } },
			});
		} else {
			await mutate("block_add", {
				object_id: hit.id,
				block: { content: { custom: { contentType: "descriptor", data: bytes, meta: {} } } },
			});
			// Rows seeded before the card was a block carried it as a field;
			// drop that so there is exactly one copy of the bytes.
			if (str(hit.fields, "descriptor") !== "") {
				await mutate("delete_field", { object_id: hit.id, key: "descriptor" });
			}
		}
		await mutate("set_field", { object_id: hit.id, key: "version", value: sv(descriptor.version) });
		updated += 1;
	}
	return { created, updated };
}

export interface InstallationRow {
	id: string;
	key: string;
	machineId: string;
	status: InstallStatus;
	account: string;
	auth: AuthMethod | "";
	error: string;
	checkedAt: number;
}

function rowToInstallation(r: { id: string; fields: Record<string, ValueJSON> }): InstallationRow {
	return {
		id: r.id,
		key: str(r.fields, "key"),
		machineId: str(r.fields, "machine_id"),
		status: (str(r.fields, "status") || "missing") as InstallStatus,
		account: str(r.fields, "account"),
		auth: (str(r.fields, "auth") || "") as AuthMethod | "",
		error: str(r.fields, "error"),
		checkedAt: r.fields["checked_at"]?.intValue ?? 0,
	};
}

export async function fetchInstallations(): Promise<InstallationRow[]> {
	return (await queryAll({ type: INSTALL_TYPE })).map(rowToInstallation);
}

/** This machine's installations, keyed by descriptor key. */
export async function myInstallations(): Promise<Map<string, InstallationRow>> {
	const id = await machineId();
	const out = new Map<string, InstallationRow>();
	for (const row of await fetchInstallations()) {
		if (row.machineId === id && !(row.key === "google" && row.account)) out.set(row.key, row);
	}
	return out;
}

export interface InstallationState {
	status: InstallStatus;
	account?: string;
	auth?: AuthMethod;
	error?: string;
}

/**
 * Record what is true for one descriptor on THIS machine. One row per
 * (descriptor × machine × account) - never one shared row with a per-machine map,
 * because two machines writing the same field is a silent last-writer-wins,
 * and `error` could then only say one thing.
 */
export async function publishInstallation(key: string, state: InstallationState): Promise<string> {
	const id = await machineId();
	const host = hostname();
	const hit = (await fetchInstallations()).find((row) => row.machineId === id && row.key === key && (key !== "google" || row.account === (state.account ?? "")));
	const now = Date.now();
	const wanted: Record<string, ValueJSON> = {
		key: sv(key),
		machine_id: sv(id),
		status: sv(state.status),
		account: sv(state.account ?? ""),
		auth: sv(state.auth ?? ""),
		error: sv(state.error ?? ""),
		checked_at: iv(now),
	};
	if (!hit) {
		const { id: rowId } = await createObject(`${key}${state.account ? ` (${state.account})` : ""} on ${host}`, INSTALL_TYPE, wanted);
		return rowId;
	}
	// Only the fields that changed, plus the timestamp when anything did: a
	// check every minute must not be a change every minute.
	const current: Record<string, string> = {
		key: hit.key,
		machine_id: hit.machineId,
		status: hit.status,
		account: hit.account,
		auth: hit.auth,
		error: hit.error,
	};
	const changed = Object.entries(wanted).filter(([field, value]) => {
		if (field === "checked_at") return false;
		return (current[field] ?? "") !== (value.stringValue ?? "");
	});
	if (changed.length === 0) return hit.id;
	for (const [field, value] of changed) {
		await mutate("set_field", { object_id: hit.id, key: field, value });
	}
	await mutate("set_field", { object_id: hit.id, key: "checked_at", value: iv(now) });
	return hit.id;
}

/** Existing local Google selectors are individually addressable without opening Settings first. */
export async function publishGoogleInstallations(): Promise<void> {
	const local = await machineId();
	const rows = await fetchInstallations();
	for (const account of await listGoogleAccounts()) {
		const previous = rows.find((row) => row.machineId === local && row.key === "google" && row.account === account.account);
		if (previous?.status === "needs_approval" || previous?.status === "processing") continue;
		const ready = !account.error && !!account.authMethod && account.authMethod !== "none" && account.credentialsExists;
		await publishInstallation("google", {
			account: account.account,
			status: ready ? "active" : "needs_auth",
			auth: ready ? "oauth" : "none",
			error: ready ? "" : "Google account authentication is not ready on this machine.",
		});
	}
}

/**
 * Mirror a holdup onto the installation's `error`, so the failure that has
 * only ever existed in `~/.glon/skills.json` becomes a row a human can see,
 * sort and query. Status is `needs_auth` when the text says so, else `broken`.
 */
export async function publishHoldup(key: string, error: string): Promise<void> {
	const needsAuth = /auth|log ?in|logged-in|credential|profile|token/i.test(error);
	await publishInstallation(key, { status: needsAuth ? "needs_auth" : "broken", error });
}

/** A clean check clears the error rather than leaving a stale one behind. */
export async function clearInstallationError(key: string): Promise<void> {
	const mine = await myInstallations();
	const hit = mine.get(key);
	if (!hit || hit.error === "") return;
	await publishInstallation(key, { status: "active", account: hit.account, auth: (hit.auth || undefined) as AuthMethod | undefined, error: "" });
}

/**
 * Publish this machine's installation rows for every catalog entry, from the
 * state that already decides `capabilities`. Called wherever capabilities are
 * published, so the detailed truth and the flat list never disagree.
 *
 * An existing `error` is preserved when the row is otherwise unchanged: a
 * status sweep must not erase a failure that a tool call recorded, or the
 * holdup becomes invisible again.
 */
export async function publishInstallations(
	skills: Record<string, { installed?: boolean; enabled?: boolean } | undefined>,
	credentials: Array<{ key: string; active: { password: boolean; browser: boolean } }>,
): Promise<void> {
	const mine = await myInstallations();
	for (const entry of CATALOG) {
		const st = skills[entry.key];
		const pending = mine.get(entry.key);
		if (pending?.status === "needs_approval" || pending?.status === "processing") continue;
		const status: InstallStatus = !st?.installed ? "missing" : st.enabled ? "active" : "disabled";
		const previous = mine.get(entry.key);
		// Only a working skill clears its own error; a missing or disabled one
		// keeps whatever the last failure said.
		const error = status === "active" ? "" : (previous?.error ?? "");
		await publishInstallation(entry.key, { status, error, auth: "none" });
	}
	for (const credential of credentials) {
		const pending = mine.get(credential.key);
		if (pending?.status === "needs_approval" || pending?.status === "processing") continue;
		const auth: AuthMethod | undefined = credential.active.browser
			? "browser_profile"
			: credential.active.password
				? "api_key"
				: undefined;
		const previous = mine.get(credential.key);
		if (!auth) {
			await publishInstallation(credential.key, {
				status: previous?.error ? "needs_auth" : "missing",
				error: previous?.error ?? "",
			});
			continue;
		}
		await publishInstallation(credential.key, { status: "active", auth, account: previous?.account ?? "", error: "" });
	}
}
