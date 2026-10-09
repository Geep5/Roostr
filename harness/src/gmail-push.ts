/**
 * Gmail push: new mail reaches Roostr the moment it lands, no polling.
 *
 * An inbox object (Mailbox `email_mailbox`, a Check first that imports it,
 * and `gmail_push_topic` naming a Cloud Pub/Sub topic) is watched: Gmail
 * posts "this mailbox changed" to the topic, and the harness serving the
 * object pulls those notes from `gmail_push_subscription` and runs the
 * object now (schedule.ts runNow - its Check first imports, its agent gets
 * a turn only when something came in). The note carries no mail; the
 * check reads Gmail itself, from where it last left off, so a note lost or
 * missed while this computer was off is made up by the next one.
 *
 * Gmail stops a watch after 7 days: each one is renewed here once it has
 * less than 2 days left (checked every 6 hours and at start), and its end
 * is written to `gmail_watch_expires`.
 *
 * Failures - no sign-in for the mailbox on this computer, a refused watch,
 * a subscription that cannot be read - go on the object's Error badge
 * (`error`, prefixed "push failed:") and clear when the next attempt works,
 * so a broken push shows on the inbox itself rather than in a log.
 *
 * Tokens come from the Google sign-ins this computer holds
 * (<GLON_DATA>/google/<email>.json, written for the credentials its agents
 * list); the Matcherino sign-ins carry the pubsub scope.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteField, fetchObject, iv, queryAll, setField, str, sv, type QueryRow } from "./api";
import { googleFilesDir } from "./google-credentials";
import { primeServing, servesHere } from "./machine";
import { runNow } from "./schedule";

const BADGE = "push failed:";
const RENEW_BEFORE_MS = 2 * 86_400_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const RETRY_MS = 30_000;

interface Inbox {
	id: string;
	mailbox: string;
	topic: string;
	subscription: string;
	watchExpires: number;
}

interface SignIn {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}

interface PulledMessage {
	ackId: string;
	message: { data?: string };
}

/** The inbox objects this computer serves that ask for push. */
async function inboxesHere(): Promise<Inbox[]> {
	const rows: QueryRow[] = await queryAll({ filters: [{ key: "gmail_push_topic", condition: "exists" }] });
	await primeServing(rows.map((r) => r.id));
	const out: Inbox[] = [];
	for (const r of rows) {
		const mailbox = str(r.fields, "email_mailbox").trim().toLowerCase();
		const topic = str(r.fields, "gmail_push_topic").trim();
		const subscription = str(r.fields, "gmail_push_subscription").trim();
		if (!(await servesHere(r.id))) continue;
		if (!mailbox || !topic || !subscription) {
			await badge(r.id, `needs Mailbox, gmail_push_topic and gmail_push_subscription`);
			continue;
		}
		out.push({ id: r.id, mailbox, topic, subscription, watchExpires: r.fields["gmail_watch_expires"]?.intValue ?? 0 });
	}
	return out;
}

// ── Error badge: set on failure, cleared by the next success ─────

/** Objects whose badge this process set, or may have inherited from a previous run (checked once each). */
const maybeBadged = new Set<string>();
const checkedOnce = new Set<string>();

async function badge(objectId: string, problem: string): Promise<void> {
	const text = `${BADGE} ${problem}`.slice(0, 300);
	console.error(`[gmail-push] ${objectId.slice(0, 8)} ${text}`);
	maybeBadged.add(objectId);
	const current = str((await fetchObject(objectId)).fields, "error");
	if (current !== text) await setField(objectId, "error", sv(text));
}

async function clearBadge(objectId: string): Promise<void> {
	if (!maybeBadged.has(objectId) && checkedOnce.has(objectId)) return;
	checkedOnce.add(objectId);
	maybeBadged.delete(objectId);
	const current = str((await fetchObject(objectId)).fields, "error");
	if (current.startsWith(BADGE)) await deleteField(objectId, "error");
}

// ── Tokens ────────────────────────────────────────────────────────

const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(mailbox: string): Promise<string> {
	const cached = tokens.get(mailbox);
	if (cached && cached.until > Date.now() + 60_000) return cached.token;
	const path = join(googleFilesDir(), `${mailbox}.json`);
	if (!existsSync(path)) throw new Error(`no Google sign-in for ${mailbox} on this computer - list its Google credential on an agent served here`);
	const signIn = JSON.parse(readFileSync(path, "utf8")) as SignIn;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		body: new URLSearchParams({ client_id: signIn.client_id, client_secret: signIn.client_secret, refresh_token: signIn.refresh_token, grant_type: "refresh_token" }),
	});
	const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
	if (!res.ok || !body.access_token) throw new Error(`Google sign-in for ${mailbox} refused: ${body.error_description ?? body.error ?? res.status}`);
	tokens.set(mailbox, { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 });
	return body.access_token;
}

async function google<T>(mailbox: string, url: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${await accessToken(mailbox)}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text();
	if (!res.ok) {
		const message = (() => {
			try {
				return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
			} catch {
				return text;
			}
		})();
		throw new Error(`${res.status} ${message}`.slice(0, 240));
	}
	return (text ? JSON.parse(text) : {}) as T;
}

// ── Watches ───────────────────────────────────────────────────────

/** Start or renew a mailbox's watch when it is missing or ends within 2 days. */
async function renewWatch(inbox: Inbox): Promise<void> {
	if (inbox.watchExpires - Date.now() > RENEW_BEFORE_MS) return;
	try {
		const res = await google<{ historyId?: string; expiration?: string }>(inbox.mailbox, "https://gmail.googleapis.com/gmail/v1/users/me/watch", {
			topicName: inbox.topic,
			labelIds: ["INBOX"],
			labelFilterBehavior: "include",
		});
		const expires = Number(res.expiration ?? 0);
		await setField(inbox.id, "gmail_watch_expires", iv(expires));
		inbox.watchExpires = expires;
		await clearBadge(inbox.id);
		console.log(`[gmail-push] watching ${inbox.mailbox} until ${new Date(expires).toISOString()}`);
	} catch (err) {
		await badge(inbox.id, `could not watch ${inbox.mailbox}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ── Listening ─────────────────────────────────────────────────────

/** One open pull per subscription, shared by the inboxes it carries. */
const listeners = new Map<string, { inboxes: Inbox[]; stop: AbortController }>();

async function listen(subscription: string, state: { inboxes: Inbox[]; stop: AbortController }): Promise<void> {
	const signal = state.stop.signal;
	while (!signal.aborted) {
		// Any inbox on this subscription can read it: all share the project.
		const reader = state.inboxes[0];
		const asked = Date.now();
		try {
			const res = await google<{ receivedMessages?: PulledMessage[] }>(
				reader.mailbox,
				`https://pubsub.googleapis.com/v1/${subscription}:pull`,
				{ maxMessages: 50 },
				signal,
			);
			for (const inbox of state.inboxes) await clearBadge(inbox.id);
			const received = res.receivedMessages ?? [];
			if (received.length === 0) {
				// The pull usually waits for a note; one that answers empty at once must not spin.
				if (Date.now() - asked < 1000) await new Promise((resolve) => setTimeout(resolve, 2000));
				continue;
			}
			const changed = new Set<string>();
			for (const m of received) {
				try {
					const note = JSON.parse(Buffer.from(m.message.data ?? "", "base64").toString("utf8")) as { emailAddress?: string };
					if (note.emailAddress) changed.add(note.emailAddress.toLowerCase());
				} catch {
					/* not a Gmail note: acknowledged and dropped */
				}
			}
			// Acknowledged before the run: the run reads Gmail from where it
			// last left off, so a run that fails is made up by the next note.
			await google(reader.mailbox, `https://pubsub.googleapis.com/v1/${subscription}:acknowledge`, { ackIds: received.map((m) => m.ackId) }, signal);
			for (const inbox of state.inboxes) {
				if (!changed.has(inbox.mailbox)) continue;
				runNow(inbox.id, `new mail in ${inbox.mailbox}`);
			}
		} catch (err) {
			if (signal.aborted) return;
			const problem = `cannot read ${subscription}: ${err instanceof Error ? err.message : String(err)}`;
			for (const inbox of state.inboxes) await badge(inbox.id, problem).catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
		}
	}
}

/** Match the running listeners to the inboxes served here now. */
async function reconcile(): Promise<void> {
	const inboxes = await inboxesHere();
	const bySubscription = new Map<string, Inbox[]>();
	for (const inbox of inboxes) bySubscription.set(inbox.subscription, [...(bySubscription.get(inbox.subscription) ?? []), inbox]);
	for (const [subscription, state] of listeners) {
		if (!bySubscription.has(subscription)) {
			state.stop.abort();
			listeners.delete(subscription);
		}
	}
	for (const [subscription, group] of bySubscription) {
		const running = listeners.get(subscription);
		if (running) {
			running.inboxes = group;
			continue;
		}
		const state = { inboxes: group, stop: new AbortController() };
		listeners.set(subscription, state);
		console.log(`[gmail-push] listening on ${subscription} for ${group.map((i) => i.mailbox).join(", ")}`);
		void listen(subscription, state);
	}
	for (const inbox of inboxes) await renewWatch(inbox);
}

/** Start listening; `serve` calls this once after boot. */
export function startGmailPush(): void {
	const tick = () => void reconcile().catch((err) => console.error("[gmail-push] reconcile:", err instanceof Error ? err.message : err));
	tick();
	// Also renews watches: each reconcile renews one that ends within 2 days.
	setInterval(tick, RECONCILE_EVERY_MS);
}
