/**
 * Tiny localhost HTTP surface for the Settings/agent UI. The Odin server
 * can't speak TLS, so the OAuth exchange lives here in the harness — the
 * sole consumer of the credentials anyway. Also exposes the local agent
 * roster ("run on this machine" toggle). Loopback-only.
 */

import { SimplePool, finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

import { authStatus, finishAnthropicLogin, setApiKey, startAnthropicLogin } from "./auth";
import { agentTurnStatus } from "./index";
import { readRoster } from "./roster";
import { setSkillPrompt, resetSkillPrompt } from "./skillmgr";
import { approveCapabilityRequest, listCapabilityRequests, rejectCapabilityRequest } from "./capability-messages";
import { CredentialError, checkCredential, connectCredential, disconnectCredential, type CredentialRow } from "./credential-objects";
import { scoreAgain } from "./jev";
import { ensureBlob, blobDir, mimeOf, storeUpload } from "./files";
import { apiFetch, authorizeLocalRequest, localCors, localPreflight, sessionOrigin, validLocalHost } from "./local-api-auth";
import { loadIdentity, type SpaceJoinLink } from "./nostrsync";
import { OwnerPairing } from "./owner-pairing";

/** Public identity (npub + hex pubkey) derived from the local nostr key. */
async function identity(): Promise<{ npub: string; pubkeyHex: string } | { error: string }> {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	try {
		const parsed = (await Bun.file(`${root}/nostr.json`).json()) as { privkey?: string };
		if (!parsed.privkey || parsed.privkey.length !== 64) return { error: "no key" };
		const pk = getPublicKey(Uint8Array.from(Buffer.from(parsed.privkey, "hex")));
		return { npub: nip19.npubEncode(pk), pubkeyHex: pk };
	} catch {
		return { error: "no key" };
	}
}


// ── Identity profile (nostr kind 0) ──────────────────────────────
//
// The desktop app reads/sets the vault key's profile through here (the
// harness owns the key and the relay pool). The picture is a small
// data-URI; kind 0 is replaceable, so relays keep only the newest.

interface NostrProfile {
	picture?: string;
	name?: string;
	[key: string]: unknown;
}

async function identityKey(): Promise<{ sk: Uint8Array; pk: string; relays: string[] } | null> {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	try {
		const parsed = (await Bun.file(`${root}/nostr.json`).json()) as { privkey?: string; relays?: string[] };
		if (!parsed.privkey || parsed.privkey.length !== 64) return null;
		const sk = Uint8Array.from(Buffer.from(parsed.privkey, "hex"));
		return { sk, pk: getPublicKey(sk), relays: parsed.relays ?? [] };
	} catch {
		return null;
	}
}

async function readProfile(): Promise<NostrProfile> {
	const key = await identityKey();
	if (!key || key.relays.length === 0) return {};
	const pool = new SimplePool();
	try {
		const events = await pool.querySync(key.relays, { kinds: [0], authors: [key.pk] });
		events.sort((a, b) => b.created_at - a.created_at);
		return events[0] ? ((JSON.parse(events[0].content) as NostrProfile) ?? {}) : {};
	} catch {
		return {};
	} finally {
		try {
			pool.close(key.relays);
		} catch {
			/* closed */
		}
	}
}

async function writeProfile(patch: NostrProfile): Promise<NostrProfile> {
	const key = await identityKey();
	if (!key || key.relays.length === 0) throw new Error("no key or relays");
	const next: NostrProfile = { ...(await readProfile()), ...patch };
	for (const [k, v] of Object.entries(next)) if (v === undefined || v === "") delete next[k];
	const pool = new SimplePool();
	try {
		const event = finalizeEvent(
			{ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify(next) },
			key.sk,
		);
		await Promise.any(pool.publish(key.relays, event));
		return next;
	} finally {
		try {
			pool.close(key.relays);
		} catch {
			/* closed */
		}
	}
}

export const AUTH_PORT = Number(process.env.GLON_AUTH_PORT ?? 7334);

const ownerPairing = new OwnerPairing();

/**
 * Owner-proof pairing for hosted tabs (owner-pairing.ts). The tab has no
 * token yet, so this runs before authorization; it answers session origins
 * only, and a session is minted only for a valid owner signature.
 */
async function pairRoute(req: Request, url: URL): Promise<Response> {
	const origin = req.headers.get("Origin") ?? "";
	if (!validLocalHost(req.headers.get("Host"), AUTH_PORT) || !sessionOrigin(origin)) return new Response("origin not allowed", { status: 403 });
	const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
		status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...localCors(origin) },
	});
	if (req.method === "GET" && url.pathname === "/pair/challenge") {
		const issued = ownerPairing.issue(origin, Date.now());
		return issued ? json(issued) : json({ error: "Too many pairing requests; try again in a minute." }, 429);
	}
	if (req.method !== "POST" || url.pathname !== "/pair/owner") return json({ error: "not found" }, 404);
	const text = await req.text();
	if (text.length > 16_384) return json({ error: "Pairing request too large." }, 413);
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return json({ error: "invalid JSON" }, 400);
	}
	const event = typeof body === "object" && body !== null && "event" in body ? body.event : undefined;
	const owner = await loadIdentity();
	const refused = ownerPairing.verify(event, origin, `${url.origin}${url.pathname}`, owner?.pk ?? "", Date.now());
	if (refused) return json({ error: refused }, 403);
	const minted = await apiFetch("/api/local-auth/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin }) });
	if (!minted.ok) return json({ error: `The Roostr daemon refused the session (${minted.status}).` }, 503);
	return json(await minted.json());
}

/** @param served live set of currently-served agent ids (reported by /agents) */
export function startAuthServer(served: Set<string>): void {
	Bun.serve({
		port: AUTH_PORT,
		hostname: "127.0.0.1",
		// Files arrive as one raw body (any type); keep headroom above Bun's 128 MB default.
		maxRequestBodySize: 1024 * 1024 * 1024,
		// A download may wait on a peer-to-peer fetch; Bun's 10 s default would drop it mid-transfer.
		idleTimeout: 255,
		fetch: async (req) => {
			const url = new URL(req.url);
			let authorization;
			try {
				if (req.method === "OPTIONS") return localPreflight(req, AUTH_PORT);
				if (url.pathname.startsWith("/pair/")) return await pairRoute(req, url);
				authorization = await authorizeLocalRequest(req, AUTH_PORT);
			} catch {
				return new Response("authentication unavailable", { status: 503 });
			}
			// Readable to session origins: a tab whose pairing lapsed sees 401 and pairs again.
			if (!authorization) {
				const origin = req.headers.get("Origin") ?? "";
				return new Response("authentication required", { status: 401, headers: sessionOrigin(origin) ? localCors(origin) : {} });
			}
			const cors = localCors(authorization.origin);
			const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
				status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
			});
			try {
				if (url.pathname === "/capability-requests" && req.method === "GET") {
					return json({ requests: await listCapabilityRequests() });
				}
				if (url.pathname.startsWith("/capability-requests/") && req.method === "POST") {
					if (authorization.role !== "ui") return json({ error: "A paired human approval is required." }, 403);
					let body: { objectId?: unknown; messageId?: unknown };
					try {
						body = await req.json() as { objectId?: unknown; messageId?: unknown };
						if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["objectId", "messageId"].includes(key))) throw new Error();
					} catch {
						return json({ error: "Invalid capability approval body." }, 400);
					}
					if (typeof body.objectId !== "string" || typeof body.messageId !== "string" || !body.objectId || !body.messageId) return json({ error: "objectId and messageId are required." }, 400);
					try {
						if (url.pathname === "/capability-requests/approve") return json(await approveCapabilityRequest(body.objectId, body.messageId));
						if (url.pathname === "/capability-requests/reject") {
							await rejectCapabilityRequest(body.objectId, body.messageId);
							return json({ ok: true });
						}
						return json({ error: "not found" }, 404);
					} catch (error) {
						return json({ error: error instanceof Error ? error.message : "Capability approval failed." }, 400);
					}
				}
				// Only the computer a credential's Served by names opens its sign-in
				// window and writes its status; anyone else gets a 409 naming that computer.
				const credentialOps: Record<string, (id: string) => Promise<CredentialRow>> = { "/credentials/connect": connectCredential, "/credentials/check": checkCredential, "/credentials/disconnect": disconnectCredential };
				const credentialOp = req.method === "POST" ? credentialOps[url.pathname] : undefined;
				if (credentialOp) {
					if (authorization.role !== "ui") return json({ error: "A paired app is required." }, 403);
					const body = (await req.json().catch(() => null)) as { id?: unknown } | null;
					if (typeof body?.id !== "string" || !body.id) return json({ error: "id is required." }, 400);
					try {
						const row = await credentialOp(body.id);
						return json({ status: row.status, ...(row.error ? { error: row.error } : {}) });
					} catch (error) {
						if (error instanceof CredentialError) return json({ error: error.message }, error.status);
						throw error;
					}
				}
				// "Ask again": the Jev Skill and agent that set a value run it on the object once
				// more. Any computer can answer: the agent's TypeSafe key rides on its synced credential.
				if (req.method === "POST" && url.pathname === "/jev/again") {
					if (authorization.role !== "ui") return json({ error: "A paired app is required." }, 403);
					const body = (await req.json().catch(() => null)) as { object?: unknown; key?: unknown } | null;
					if (typeof body?.object !== "string" || !body.object || typeof body.key !== "string" || !body.key) return json({ error: "object and key are required." }, 400);
					try {
						return json(await scoreAgain(body.object, body.key));
					} catch (error) {
						return json({ error: error instanceof Error ? error.message : String(error) }, 400);
					}
				}
				if (req.method === "GET" && url.pathname === "/auth/status") {
					return json(await authStatus());
				}
				if (req.method === "GET" && url.pathname === "/profile") {
					return json(await readProfile());
				}
				if (req.method === "POST" && url.pathname === "/profile") {
					const body = (await req.json()) as NostrProfile;
					return json(await writeProfile(body));
				}
				if (req.method === "GET" && url.pathname === "/identity") {
					return json(await identity());
				}
				if (req.method === "POST" && url.pathname === "/auth/anthropic/start") {
					return json({ authUrl: await startAnthropicLogin() });
				}
				if (req.method === "POST" && url.pathname === "/auth/anthropic/finish") {
					const body = (await req.json()) as { code?: string };
					if (!body.code?.trim()) return json({ error: "code required" }, 400);
					await finishAnthropicLogin(body.code);
					return json({ ok: true });
				}
				if (req.method === "POST" && url.pathname === "/auth/key") {
					const body = (await req.json()) as { provider?: string; key?: string };
					if (body.provider !== "anthropic" && body.provider !== "kimi") return json({ error: "provider must be anthropic or kimi" }, 400);
					await setApiKey(body.provider, (body.key ?? "").trim());
					return json({ ok: true });
				}
				if (req.method === "GET" && url.pathname === "/agent/status") {
					return json({ agents: [...agentTurnStatus.values()] });
				}
				if (req.method === "GET" && url.pathname === "/agents") {
					return json({ roster: await readRoster(), serving: [...served] });
				}
				// Upload: the raw bytes become a File object in `space`, held here.
				if (req.method === "POST" && url.pathname === "/files") {
					const bytes = new Uint8Array(await req.arrayBuffer());
					if (bytes.byteLength === 0) return json({ error: "The file is empty." }, 400);
					return json(await storeUpload(bytes, url.searchParams.get("name") ?? "", url.searchParams.get("mime") ?? "", url.searchParams.get("space") ?? ""));
				}
				// Download: fetched peer-to-peer first when this computer lacks the bytes.
				if (req.method === "GET" && url.pathname.startsWith("/files/")) {
					const hash = url.pathname.slice("/files/".length);
					try {
						await ensureBlob(hash);
					} catch (err) {
						return json({ error: err instanceof Error ? err.message : String(err) }, 503);
					}
					return new Response(Bun.file(`${blobDir()}/${hash}`), {
						headers: { "Content-Type": await mimeOf(hash), "Cache-Control": "private, max-age=31536000, immutable", ...cors },
					});
				}
				if (req.method === "GET" && url.pathname === "/machine") {
					const { machineId } = await import("./roster");
					const { hostname } = await import("node:os");
					return json({ id: await machineId(), host: hostname() });
				}
				if (req.method === "GET" && url.pathname === "/join-requests") {
					const { listJoinRequests } = await import("./nostrsync");
					return json({ requests: await listJoinRequests() });
				}
				if (req.method === "POST" && url.pathname === "/join-requests/send") {
					const { sendJoinRequest } = await import("./nostrsync");
					await sendJoinRequest(await req.json() as SpaceJoinLink);
					return json({ ok: true });
				}
				if (req.method === "POST" && url.pathname === "/join-requests/clear") {
					const body = (await req.json()) as { key?: string };
					const { clearJoinRequest } = await import("./nostrsync");
					await clearJoinRequest(body.key ?? "");
					return json({ ok: true });
				}
				if (req.method === "POST" && url.pathname.startsWith("/skills/")) {
					const body = (await req.json()) as { key?: string; text?: string };
					if (!body.key) return json({ error: "key required" }, 400);
					const op = url.pathname.slice("/skills/".length);
					if (op === "prompt") {
						await setSkillPrompt(body.key, body.text ?? "");
						return json({ ok: true });
					}
					if (op === "prompt-reset") {
						return json({ ok: true, prompt: await resetSkillPrompt(body.key) });
					}
					return json({ error: "not found" }, 404);
				}
				return json({ error: "not found" }, 404);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		},
	});
	console.log(`[harness] auth endpoint on http://127.0.0.1:${AUTH_PORT}`);
}
