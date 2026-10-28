/**
 * Page covers: a banner image above a page's title. The page's `cover`
 * property links the File (an ordinary upload, files.ts) and `cover_y` says
 * which band of it shows (0 top … 1 bottom, 0.5 when unset); both are
 * ordinary properties of the space (space-defaults.ts seeds them).
 *
 * Generated covers travel on the page the way Run now does (`run_now`,
 * schedule.ts): any device writes a request field, the computer whose
 * harness should do the work claims it (deletes it) and writes its progress
 * where every device sees it.
 *
 * - `cover_request` {at, prompt}: the app's ask - the person's prompt is
 *   painted as written; an empty one ("Choose for me") has the art director
 *   write an idea from the page first, painted in the house style.
 * - `cover_generation` {at, status, machine, credential, prompt, error,
 *   needs_key}: the run in progress, which the app shows as a spinner -
 *   (`writing` →) `painting`. When the image is stored it becomes the page's
 *   `cover` and this field goes; when it fails it stays as `failed`, with
 *   OpenAI's own message, until the next ask or the person dismisses it.
 *
 * The work runs on the computer serving the space's OpenAI credential (its
 * Served by): the harness holding the key. A key that is blank or refused
 * shows on the credential's Error and on the session (`needs_key`).
 */

import { deleteField, fetchObject, mutate, queryAll, setField, str, type ObjectJSON, type ValueJSON } from "./api";
import { CREDENTIAL_TYPE, pinOf, republishCredential, spaceCredential } from "./credential-objects";
import { credentialKeys, hideCredentialSecrets } from "./credentials";
import { storeUpload } from "./files";
import { COVER_STYLE, noteKeyRefused, OpenAIError, OPENAI_SERVICE, paintCover, writeCoverPrompt } from "./openai";
import { pageText } from "./prompts";
import { machineId } from "./roster";

export const COVER_KEY = "cover";
export const COVER_Y_KEY = "cover_y";
export const COVER_REQUEST_KEY = "cover_request";
export const COVER_GENERATION_KEY = "cover_generation";

/** What the panel says when there is no key to generate with (a blank one, or one OpenAI refused). */
export const NEEDS_KEY = "Add an OpenAI key to this space's OpenAI credential to generate covers";

/** How much of the page's text the art director reads. */
const BODY_CHARS = 3000;

/** The two cover properties every space gets (space-defaults.ts). */
export const COVER_PROPERTIES: Array<{ key: string; name: string; format: string; emoji: string; description: string; pickerType?: string }> = [
	{ key: COVER_KEY, name: "Cover", format: "object", emoji: "🌄", description: "The image shown as a banner above the page's title: a File.", pickerType: "file" },
	{ key: COVER_Y_KEY, name: "Cover position", format: "number", emoji: "↕️", description: "Which band of the cover shows, from 0 (its top) to 1 (its bottom); 0.5 when empty." },
];

export type CoverStatus = "writing" | "painting" | "failed";

export interface CoverGeneration {
	at: number;
	status: CoverStatus;
	machine: string;
	credential: string;
	prompt: string;
	error: string;
	needsKey: boolean;
}

const STATUSES: CoverStatus[] = ["writing", "painting", "failed"];

/** The run on a page, as its `cover_generation` holds it; null when there is none. */
export function coverGeneration(fields: Record<string, ValueJSON>): CoverGeneration | null {
	const e = fields[COVER_GENERATION_KEY]?.mapValue?.entries;
	if (!e) return null;
	const status = e["status"]?.stringValue ?? "";
	return {
		at: e["at"]?.intValue ?? 0,
		status: STATUSES.find((s) => s === status) ?? "failed",
		machine: e["machine"]?.stringValue ?? "",
		credential: e["credential"]?.stringValue ?? "",
		prompt: e["prompt"]?.stringValue ?? "",
		error: e["error"]?.stringValue ?? "",
		needsKey: e["needs_key"]?.boolValue === true,
	};
}

function generationValue(g: CoverGeneration): ValueJSON {
	const entries: Record<string, ValueJSON> = {
		at: { intValue: g.at },
		status: { stringValue: g.status },
		machine: { stringValue: g.machine },
		credential: { stringValue: g.credential },
		prompt: { stringValue: g.prompt },
	};
	if (g.error) entries["error"] = { stringValue: g.error };
	if (g.needsKey) entries["needs_key"] = { boolValue: true };
	return { mapValue: { entries } };
}

/** A stored value as the page shows it: dates as dates, links as the linked objects' names, lists joined. */
async function shownValue(format: string, v: ValueJSON): Promise<string> {
	if (v.boolValue !== undefined) return v.boolValue ? "Yes" : "No";
	const n = v.intValue ?? v.floatValue;
	if (n !== undefined) return format === "date" ? new Date(n).toISOString().slice(0, 10) : String(n);
	const items = v.valuesValue?.items ?? (v.linkValue ? [v] : []);
	if (items.length > 0 || v.valuesValue) {
		const shown = await Promise.all(
			items.map(async (i) => {
				const target = i.linkValue?.targetId ?? (format === "object" ? (i.stringValue ?? "") : "");
				if (!target) return i.stringValue ?? "";
				const o = await fetchObject(target).catch(() => null);
				return o && !o.deleted ? str(o.fields, "name") || "Untitled" : "";
			}),
		);
		return shown.filter(Boolean).join(", ");
	}
	return v.stringValue ?? "";
}

/**
 * What the art director is told about a page: only what the page shows -
 * its title, its type's name, its properties as name: value (the space's
 * visible properties; the cover's own two and a credential's secrets left
 * out) and the first {@link BODY_CHARS} characters of its text.
 */
export async function pageBrief(page: ObjectJSON): Promise<string> {
	const obj = hideCredentialSecrets(page);
	const space = str(obj.fields, "channel");
	const [relations, types] = await Promise.all([queryAll({ type: "relation" }), queryAll({ type: "type" })]);
	const inSpace = (r: { fields: Record<string, ValueJSON> }) => str(r.fields, "channel") === space;
	const typeName = str(types.find((t) => inSpace(t) && str(t.fields, "key") === obj.typeKey)?.fields ?? {}, "name") || obj.typeKey;
	const props = new Map(relations.filter((r) => inSpace(r) && r.fields["hidden"]?.boolValue !== true).map((r) => [str(r.fields, "key"), r.fields]));
	const lines: string[] = [];
	for (const [key, value] of Object.entries(obj.fields)) {
		const def = props.get(key);
		if (!def || key === "name" || key === COVER_KEY || key === COVER_Y_KEY) continue;
		const shown = (await shownValue(str(def, "format"), value)).trim();
		if (shown) lines.push(`- ${str(def, "name") || key}: ${shown}`);
	}
	const body = pageText(obj).trim().slice(0, BODY_CHARS);
	return [`Title: ${str(obj.fields, "name") || "Untitled"}`, `Type: ${typeName}`, ...(lines.length > 0 ? ["Properties:", ...lines] : []), ...(body ? ["Text:", body] : [])].join("\n");
}

/** Pages whose request this computer is working on; `again`: another request arrived meanwhile. */
const working = new Set<string>();
const again = new Set<string>();

/**
 * A page's `cover_request`, if this computer serves the space's OpenAI
 * credential: claim it, run it, write every step on `cover_generation`.
 * One request per page at a time; one arriving meanwhile runs after it.
 * Never throws: what went wrong is on the session, or in the log when even
 * that could not be written.
 */
export async function takeCoverRequest(page: ObjectJSON): Promise<void> {
	const ask = page.fields[COVER_REQUEST_KEY]?.mapValue?.entries;
	if (!ask || page.deleted) return;
	if (working.has(page.id)) {
		again.add(page.id);
		return;
	}
	working.add(page.id);
	try {
		await runCoverRequest(page, ask);
	} catch (err) {
		console.error(`[covers] request on ${page.id.slice(0, 8)}:`, err instanceof Error ? err.message : err);
	} finally {
		working.delete(page.id);
	}
	if (again.delete(page.id)) {
		const fresh = await fetchObject(page.id).catch(() => null);
		if (fresh) await takeCoverRequest(fresh);
	}
}

/** The session is still the one answering `at` (the panel was not closed, nor a newer ask taken). */
async function stillAsked(pageId: string, at: number): Promise<boolean> {
	const now = await fetchObject(pageId).catch(() => null);
	return !!now && !now.deleted && coverGeneration(now.fields)?.at === at;
}

async function runCoverRequest(page: ObjectJSON, ask: Record<string, ValueJSON>): Promise<void> {
	const space = str(page.fields, "channel");
	const cred = spaceCredential(await queryAll({ type: CREDENTIAL_TYPE }), space, OPENAI_SERVICE);
	const me = await machineId();
	if (!cred || (await pinOf(cred.fields)) !== me) return;
	const at = ask["at"]?.intValue ?? Date.now();
	const asked = (ask["prompt"]?.stringValue ?? "").trim();
	await deleteField(page.id, COVER_REQUEST_KEY);

	const session: CoverGeneration = { at, status: asked ? "painting" : "writing", machine: me, credential: cred.id, prompt: asked, error: "", needsKey: false };
	const publish = (next: Partial<CoverGeneration>) => {
		Object.assign(session, next);
		return setField(page.id, COVER_GENERATION_KEY, generationValue(session));
	};

	const key = credentialKeys(cred.fields)?.api_key ?? "";
	if (!key) {
		await publish({ status: "failed", error: NEEDS_KEY, needsKey: true });
		// The credential's own Error says what to paste.
		await republishCredential(cred.id);
		return;
	}
	try {
		// The person's words are painted as written; "Choose for me" has the art director write the idea, painted in the house style.
		let prompt = asked;
		let painted = asked;
		if (!prompt) {
			await publish({ status: "writing" });
			prompt = await writeCoverPrompt(key, await pageBrief(page));
			painted = `${prompt}\n\n${COVER_STYLE}`;
		}
		await publish({ status: "painting", prompt });
		const bytes = await paintCover(key, painted);
		// Dismissed while it painted: nothing to keep.
		if (!(await stillAsked(page.id, at))) return;
		const title = str(page.fields, "name") || "Untitled";
		const file = await storeUpload(bytes, `Cover - ${title}.jpg`, "image/jpeg", space);
		if (!(await stillAsked(page.id, at))) {
			await mutate("vanish", { object_ids: [file.id] });
			return;
		}
		// The new image is the cover, focused in the middle; the run is over.
		await setField(page.id, COVER_KEY, { linkValue: { relationKey: COVER_KEY, targetId: file.id } });
		await setField(page.id, COVER_Y_KEY, { floatValue: 0.5 });
		await deleteField(page.id, COVER_GENERATION_KEY);
	} catch (err) {
		const refused = err instanceof OpenAIError && err.keyRefused;
		if (refused) noteKeyRefused(cred.id, key, err.message);
		if (await stillAsked(page.id, at)) await publish({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 500), needsKey: refused });
		// The refused key shows on the credential's Error too.
		if (refused) await republishCredential(cred.id);
	}
}

/** Requests written while this computer was off: taken at start. */
export async function takePendingCoverRequests(): Promise<number> {
	const rows = await queryAll({ filters: [{ key: COVER_REQUEST_KEY, condition: "exists" }] });
	let taken = 0;
	for (const row of rows) {
		const page = await fetchObject(row.id).catch(() => null);
		if (!page) continue;
		await takeCoverRequest(page);
		taken += 1;
	}
	return taken;
}
