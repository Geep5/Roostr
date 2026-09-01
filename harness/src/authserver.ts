/**
 * Tiny localhost HTTP surface for the Settings/agent UI. The Odin server
 * can't speak TLS, so the OAuth exchange lives here in the harness — the
 * sole consumer of the credentials anyway. Also exposes the local agent
 * roster ("run on this machine" toggle). Loopback-only.
 */

import { SimplePool, finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

import { authStatus, finishAnthropicLogin, setApiKey, startAnthropicLogin } from "./auth";
import { agentTurnStatus } from "./index";
import { readRoster, setEnabled } from "./roster";
import { disableSkill, enableSkill, getCoordinator, recheckSkill, setCoordinator, skillStatus, uninstallSkill, setSkillPrompt, resetSkillPrompt } from "./skillmgr";
import { fetchObject, str } from "./api";

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

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

/**
 * @param served live set of currently-served agent ids (reported by /agents)
 * @param onRosterChange invoked with the new roster after a toggle
 */
export function startAuthServer(served: Set<string>, onRosterChange: (next: string[]) => void): void {
	Bun.serve({
		port: AUTH_PORT,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			try {
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
				if (req.method === "POST" && url.pathname === "/agents/toggle") {
					const body = (await req.json()) as { id?: string; enabled?: boolean };
					if (!body.id) return json({ error: "id required" }, 400);
					const next = await setEnabled(body.id, body.enabled === true);
					onRosterChange(next);
					return json({ ok: true, roster: next });
				}
				if (req.method === "GET" && url.pathname === "/skills") {
					const [skills, coordinator, roster] = await Promise.all([skillStatus(), getCoordinator(), readRoster()]);
					const agents: { id: string; name: string }[] = [];
					for (const id of roster) {
						try {
							const obj = await fetchObject(id);
							agents.push({ id, name: str(obj.fields, "name") || id.slice(0, 8) });
						} catch {
							agents.push({ id, name: id.slice(0, 8) });
						}
					}
					return json({ skills, coordinator, agents });
				}
				if (req.method === "POST" && url.pathname === "/skills/coordinator") {
					const body = (await req.json()) as { id?: string };
					await setCoordinator(body.id ?? "");
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
					if (op === "enable") return json({ phase: await enableSkill(body.key) });
					if (op === "disable") {
						await disableSkill(body.key);
						return json({ phase: "off" });
					}
					if (op === "recheck") return json({ phase: await recheckSkill(body.key) });
					if (op === "uninstall") return json({ phase: await uninstallSkill(body.key) });
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
