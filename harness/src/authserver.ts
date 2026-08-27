/**
 * Tiny localhost HTTP surface for the Settings UI. The Odin server can't
 * speak TLS, so the OAuth exchange lives here in the harness — the sole
 * consumer of the credentials anyway. Loopback-only.
 */

import { authStatus, finishAnthropicLogin, setApiKey, startAnthropicLogin } from "./auth";

export const AUTH_PORT = Number(process.env.GLON_AUTH_PORT ?? 7334);

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export function startAuthServer(): void {
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
				return json({ error: "not found" }, 404);
			} catch (err) {
				return json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		},
	});
	console.log(`[harness] auth endpoint on http://127.0.0.1:${AUTH_PORT}`);
}
