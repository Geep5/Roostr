/**
 * Shortcut (app.shortcut.com), the project tracker: a Shortcut credential
 * holds an API token (Settings → Your Account → API Tokens), and the
 * harness signs each request to Shortcut's REST API (v3) with it for the
 * agent that lists the credential (the `shortcut` tool, tool-harness.ts
 * `credentialApi`). The token never reaches the model: it rides in the
 * Shortcut-Token header, and anything echoing it is blanked by the harness.
 */
import { credentialKeys } from "./credentials";
import type { CredentialApi } from "./extensions";

export const SHORTCUT_SERVICE = "shortcut";
export const SHORTCUT_API = "https://api.app.shortcut.com/api/v3";
const TIMEOUT_MS = 30_000;

export const shortcutApi: CredentialApi = {
	token: async (fields) => {
		const token = credentialKeys(fields)?.api_token ?? "";
		if (!token) throw new Error("the Shortcut credential has no API token yet - a person pastes one on it");
		return token;
	},
	call: async (token, path, method, body) => {
		if (!path.startsWith("/")) throw new Error(`path must start with / (a path on ${SHORTCUT_API}), not "${path}"`);
		const res = await fetch(`${SHORTCUT_API}${path}`, {
			method,
			headers: { "Shortcut-Token": token, "Content-Type": "application/json", Accept: "application/json" },
			body: body === undefined || method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		const text = await res.text();
		if (res.status === 401 || res.status === 403) throw new Error(`Shortcut refused the API token (${res.status}) - a person replaces it on the credential`);
		if (!res.ok) throw new Error(`Shortcut answered ${res.status} for ${method} ${path}: ${text.slice(0, 500)}`);
		if (!text) return { ok: true };
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	},
};
