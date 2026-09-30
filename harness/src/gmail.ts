/**
 * Support email as objects: one Email object per Gmail thread, so every
 * conversation gets its own page (the messages) and its own chat (you and
 * the agents, about that email). Read through `gws-as <mailbox>`, which
 * uses the mailbox's Google Credential (google-credentials.ts).
 *
 * Dedup is by Gmail thread id (`gmail_thread_id`): a thread already
 * imported is never created twice - if it has new messages they are
 * appended to its page, after the last one it holds (`gmail_last_message_id`).
 * An Email is task-shaped: the system Done checkbox closes it, and a new
 * reply on a done thread opens it again.
 * Read-only: nothing here sends, labels or marks mail read.
 */
import { createObject, mutate, queryAll, setField, str, sv, type ValueJSON } from "./api";

export const EMAIL_TYPE = "email";

/** The Email type's properties: ordinary relations of the space (never bundled). */
const EMAIL_PROPERTIES: Array<{ key: string; name: string; format: string; emoji: string; options?: Array<[string, string]> }> = [
	{ key: "email_from", name: "From", format: "shorttext", emoji: "✉️" },
	{ key: "email_received", name: "Received", format: "date", emoji: "🕒" },
	{ key: "email_mailbox", name: "Mailbox", format: "email", emoji: "📮" },
	{ key: "gmail_thread_id", name: "Gmail thread", format: "shorttext", emoji: "🧵" },
	{ key: "gmail_last_message_id", name: "Gmail last message", format: "shorttext", emoji: "🧵" },
];

/** The Email type and its properties in `space`, created once. */
export async function ensureEmailType(space: string): Promise<void> {
	const types = await queryAll({ type: "type" });
	if (!types.some((t) => str(t.fields, "key") === EMAIL_TYPE && str(t.fields, "channel") === space)) {
		// Task layout: an email is work to finish - the system Done checkbox closes it.
		await createObject("Email", "type", { key: sv(EMAIL_TYPE), name: sv("Email"), iconEmoji: sv("📧"), layout: sv("task"), channel: sv(space) });
	}
	const have = new Set((await queryAll({ type: "relation" })).filter((r) => str(r.fields, "channel") === space).map((r) => str(r.fields, "key")));
	for (const p of EMAIL_PROPERTIES) {
		if (have.has(p.key)) continue;
		await createObject(p.name, "relation", {
			channel: sv(space),
			key: sv(p.key),
			name: sv(p.name),
			format: sv(p.format),
			iconEmoji: sv(p.emoji),
			hidden: { boolValue: false },
			readOnly: { boolValue: false },
			maxCount: { intValue: p.format === "status" ? 1 : 0 },
			options: {
				valuesValue: {
					items: (p.options ?? []).map(([text, color], i) => ({
						mapValue: { entries: { id: sv(`${p.key}-${text}`), text: sv(text), color: sv(color), orderId: sv(String(i).padStart(6, "0")) } },
					})),
				},
			},
			bundled: { boolValue: false },
		});
	}
}

interface GmailPart {
	mimeType?: string;
	headers?: Array<{ name: string; value: string }>;
	body?: { data?: string };
	parts?: GmailPart[];
}
interface GmailMessage {
	id: string;
	internalDate: string;
	payload: GmailPart;
}

async function gws(account: string, args: string[]): Promise<unknown> {
	const proc = Bun.spawn(["gws-as", account, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	if ((await proc.exited) !== 0) throw new Error(`gws-as ${account} ${args.slice(0, 3).join(" ")}: ${(err || out).trim().slice(0, 300)}`);
	return JSON.parse(out);
}

const header = (m: GmailMessage, name: string): string => m.payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const b64 = (data: string): string => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findPart(p: GmailPart, mime: string): string {
	if (p.mimeType === mime && p.body?.data) return b64(p.body.data);
	for (const c of p.parts ?? []) {
		const hit = findPart(c, mime);
		if (hit) return hit;
	}
	return "";
}

/** HTML as readable text: block tags break lines, the rest is dropped, entities decoded. */
function htmlText(html: string): string {
	return html
		.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/**
 * A message's own words: plain text (else HTML as text), cut where the
 * quoted history of earlier messages starts - each earlier message is on
 * the page already. Invisible filler characters go; at most 120 lines.
 */
export function messageLines(m: GmailMessage): string[] {
	const raw = findPart(m.payload, "text/plain") || htmlText(findPart(m.payload, "text/html"));
	const own: string[] = [];
	const quoted: string[] = [];
	let inQuote = false;
	const push = (to: string[], t: string) => {
		if (!t && (to.length === 0 || to[to.length - 1] === "")) return;
		to.push(t);
	};
	for (const line of raw.replace(/[\u034f\u200b-\u200d\u2060\ufeff\u00ad]/g, "").split(/\r?\n/)) {
		const t = line.trim();
		// Where quoted history starts: the reply attribution in any language
		// ("On … <a@b> wrote:", "… <a@b> şunu yazdı:") - a line naming an
		// address and ending in a colon - or an Outlook-style divider.
		if (!inQuote && (/<[^>\s]+@[^>\s]+>.{0,80}:$/.test(t) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(t) || /^_{10,}$/.test(t))) {
			inQuote = true;
			continue;
		}
		if (inQuote || t.startsWith(">")) push(quoted, t.replace(/^(>\s?)+/, "").trim());
		else push(own, t);
	}
	const trim = (xs: string[]) => {
		while (xs.length && xs[xs.length - 1] === "") xs.pop();
		return xs;
	};
	trim(own);
	// A reply with no words of its own still says something - "about this" -
	// so keep what it quoted, labelled, rather than an empty message.
	if (own.length === 0 && trim(quoted).length > 0) return ["(No text of their own - they replied to this earlier message:)", ...quoted.slice(0, 60)];
	return own.slice(0, 120);
}

/** Append messages to an Email page: a small heading per message (who, when), then its lines as paragraphs. */
async function appendMessages(objectId: string, messages: GmailMessage[]): Promise<void> {
	for (const m of messages) {
		const when = new Date(Number(m.internalDate)).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
		const add = (text: string, style: number) =>
			mutate("block_add", { object_id: objectId, block: { id: crypto.randomUUID(), childrenIds: [], content: { text: { text, style } } } });
		await add(`${header(m, "From")} · ${when}`, 3);
		for (const line of messageLines(m)) if (line) await add(line, 0);
	}
}

export interface ImportResult {
	created: string[];
	updated: string[];
	skipped: number;
}

/**
 * Import the `max` newest inbox threads of `mailbox` into `space` as Email
 * objects, each naming `agentIds` in its Agent property, in order (guests:
 * each answers that email's chat when tagged - the support agent, and the
 * agent it asks for account data).
 */
export async function importEmails(opts: { mailbox: string; space: string; agentIds: string[]; max: number; query?: string }): Promise<ImportResult> {
	await ensureEmailType(opts.space);
	const list = (await gws(opts.mailbox, ["gmail", "users", "threads", "list", "--params", JSON.stringify({ userId: "me", maxResults: opts.max, q: opts.query ?? "in:inbox" })])) as { threads?: Array<{ id: string }> };
	const existing = new Map(
		(await queryAll({ type: EMAIL_TYPE, filters: [{ key: "email_mailbox", condition: "equal", value: opts.mailbox }] })).map((r) => [str(r.fields, "gmail_thread_id"), r]),
	);
	const result: ImportResult = { created: [], updated: [], skipped: 0 };
	for (const { id: threadId } of list.threads ?? []) {
		const thread = (await gws(opts.mailbox, ["gmail", "users", "threads", "get", "--params", JSON.stringify({ userId: "me", id: threadId, format: "full" })])) as { messages: GmailMessage[] };
		const messages = thread.messages ?? [];
		if (messages.length === 0) continue;
		const last = messages[messages.length - 1];
		const have = existing.get(threadId);
		if (have) {
			const seen = str(have.fields, "gmail_last_message_id");
			const at = messages.findIndex((m) => m.id === seen);
			const fresh = at >= 0 ? messages.slice(at + 1) : [];
			if (fresh.length === 0) {
				result.skipped += 1;
				continue;
			}
			await appendMessages(have.id, fresh);
			await setField(have.id, "gmail_last_message_id", sv(last.id));
			await setField(have.id, "email_received", { intValue: Number(last.internalDate) });
			// A reply on a finished thread reopens it.
			await setField(have.id, "done", { boolValue: false });
			result.updated.push(have.id);
			continue;
		}
		const first = messages[0];
		const fields: Record<string, ValueJSON> = {
			channel: sv(opts.space),
			email_from: sv(header(first, "From")),
			email_received: { intValue: Number(last.internalDate) },
			email_mailbox: sv(opts.mailbox),
			done: { boolValue: false },
			gmail_thread_id: sv(threadId),
			gmail_last_message_id: sv(last.id),
			...(opts.agentIds.length ? { agent: { valuesValue: { items: opts.agentIds.map((targetId) => ({ linkValue: { relationKey: "agent", targetId } })) } } } : {}),
		};
		const { id } = await createObject(header(first, "Subject") || "(no subject)", EMAIL_TYPE, fields);
		await appendMessages(id, messages);
		result.created.push(id);
	}
	return result;
}

