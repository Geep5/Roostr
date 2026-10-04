/**
 * Private extensions: what one deployment adds to the harness without it
 * being part of the public tree. Each `harness/private/<name>/index.ts`
 * (a gitignored, private checkout) default-exports an `Extension`; this
 * module imports every one at load and registers it. Every entrypoint
 * (index.ts, sync.ts) imports this module first, so the seeds and
 * registries below are complete before anything reads them. Without a
 * `harness/private/` folder nothing is added.
 *
 * An extension can add:
 * - `catalog`: machine skills (skillmgr.ts CATALOG);
 * - `kinds`: agent kinds (prompts.ts PROMPT_SEEDS);
 * - `credentialSeeds`: Credential presets (credentials.ts CREDENTIAL_SEEDS);
 * - `sessionRenewers`: per service, renewing a browser sign-in whose cookie's
 *   clock is not the truth (credential-objects.ts);
 * - `credentialApis`: per service, how the harness signs a request to the
 *   service's own API (`roostr.credentials.api`, tool-harness.ts);
 * - `credentialActions`: per service and action key, harness-side code
 *   `credential_action` runs (`roostr.credentials.act`), its `api` bound to
 *   the agent's credential with secrets blanked out of every answer.
 *
 * A computer without an extension never removes or rewrites what one seeded
 * elsewhere: seeding only ever iterates its own seeds, and the boot
 * migrations leave keys they don't know alone.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ValueJSON } from "./api";
import type { SessionCookie } from "./browser";
import { CREDENTIAL_SEEDS, type CredentialSeed } from "./credentials";
import { PROMPT_SEEDS, type AgentKindEntry } from "./prompts";
import { CATALOG, type CatalogEntry } from "./skillmgr";
import type { CredentialAnswer } from "./tool-sdk";

/** A service's own API as the harness signs it in: mint a token from the credential's fields, then send requests with it. */
export interface CredentialApi {
	token(fields: Record<string, ValueJSON>): Promise<string>;
	call(token: string, path: string, method: string, body: unknown): Promise<unknown>;
}

/** One credential action's harness-side code: the tool's input, and the service's API signed in with the agent's credential. */
export type CredentialActionRun = (input: Record<string, unknown>, api: (path: string, request?: { method?: string; body?: unknown }) => Promise<CredentialAnswer>) => Promise<unknown>;

export type SessionRenewer = (fields: Record<string, ValueJSON>) => Promise<SessionCookie[] | null>;

export interface Extension {
	catalog?: CatalogEntry[];
	kinds?: AgentKindEntry[];
	credentialSeeds?: CredentialSeed[];
	sessionRenewers?: Record<string, SessionRenewer>;
	credentialApis?: Record<string, CredentialApi>;
	credentialActions?: Record<string, Record<string, CredentialActionRun>>;
}

/** Service -> session renewer. */
export const sessionRenewers: Record<string, SessionRenewer> = {};
/** Service -> signed API. */
export const credentialApis: Record<string, CredentialApi> = {};
/** Service -> action key -> harness-side code. */
export const credentialActions: Record<string, Record<string, CredentialActionRun>> = {};

function removeFrom<T>(list: T[], items: T[]): void {
	for (const item of items) {
		const at = list.indexOf(item);
		if (at >= 0) list.splice(at, 1);
	}
}

/** Add `ext` to the seeds and registries; returns its removal (tests register a fake service and take it back). */
export function registerExtension(ext: Extension): () => void {
	const catalog = ext.catalog ?? [];
	const kinds = ext.kinds ?? [];
	const seeds = ext.credentialSeeds ?? [];
	CATALOG.push(...catalog);
	PROMPT_SEEDS.push(...kinds);
	CREDENTIAL_SEEDS.push(...seeds);
	Object.assign(sessionRenewers, ext.sessionRenewers);
	Object.assign(credentialApis, ext.credentialApis);
	for (const [service, actions] of Object.entries(ext.credentialActions ?? {})) credentialActions[service] = { ...credentialActions[service], ...actions };
	return () => {
		removeFrom(CATALOG, catalog);
		removeFrom(PROMPT_SEEDS, kinds);
		removeFrom(CREDENTIAL_SEEDS, seeds);
		for (const [service, renew] of Object.entries(ext.sessionRenewers ?? {})) if (sessionRenewers[service] === renew) delete sessionRenewers[service];
		for (const [service, api] of Object.entries(ext.credentialApis ?? {})) if (credentialApis[service] === api) delete credentialApis[service];
		for (const [service, actions] of Object.entries(ext.credentialActions ?? {})) {
			const mine = credentialActions[service];
			if (!mine) continue;
			for (const [key, run] of Object.entries(actions)) if (mine[key] === run) delete mine[key];
			if (Object.keys(mine).length === 0) delete credentialActions[service];
		}
	};
}

/** The private checkout's folder; absent in the public tree. */
export const PRIVATE_DIR = join(import.meta.dir, "..", "private");

/** Import and register every `private/<name>/index.ts`; returns the names loaded. */
export async function loadExtensions(dir = PRIVATE_DIR): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const loaded: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const index = join(dir, entry.name, "index.ts");
		if (!entry.isDirectory() || !existsSync(index)) continue;
		// Plugin loading: which extensions exist is only known at run time.
		const mod = (await import(index)) as { default?: Extension };
		if (!mod.default) throw new Error(`${index} has no default export (an Extension)`);
		registerExtension(mod.default);
		loaded.push(entry.name);
	}
	return loaded;
}

await loadExtensions();
