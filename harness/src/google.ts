/** Google account selectors for the local gws CLI. Secrets stay in each
 * account's config dir; this checks one account's own auth state and
 * removes an account's local sign-in.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GoogleAccountStatus {
	account: string;
	configured: boolean;
	authMethod: string;
	clientConfigExists: boolean;
	credentialsExists: boolean;
	storage: string;
	error?: string;
}

function rootDir(): string {
	return process.env.GOOGLE_WORKSPACE_ACCOUNTS_DIR ?? join(homedir(), ".config", "gws", "accounts");
}

function accountDir(account: string): string {
	return join(rootDir(), account);
}

/** Delete an account's local sign-in (its config dir under the accounts root). */
export function removeGoogleAccount(account: string): void {
	if (!/^[^\s/@]+@[^\s/@]+$/.test(account)) throw new Error("Invalid Google account.");
	const dir = accountDir(account);
	rmSync(dir, { recursive: true, force: true });
}

interface GoogleCommandResult { code: number; out: string; err: string }

async function gws(account: string, ...args: string[]): Promise<GoogleCommandResult> {
	const proc = Bun.spawn(["gws-as", account, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, out, err };
}

/** Live auth state for one account selector. */
export async function googleAccountStatus(account: string): Promise<GoogleAccountStatus> {
	const dir = accountDir(account);
	const configured = existsSync(dir);
	const base: GoogleAccountStatus = {
		account,
		configured,
		authMethod: "none",
		clientConfigExists: existsSync(join(dir, "client_secret.json")),
		credentialsExists: false,
		storage: "none",
	};
	if (!configured) return { ...base, error: "not configured" };
	let res: GoogleCommandResult;
	try {
		res = await gws(account, "auth", "status");
	} catch {
		return { ...base, error: "Google CLI status is unavailable on this machine." };
	}
	// Status lands on a credential's error. CLI stderr is local-only and may
	// contain credentials or configuration material.
	if (res.code !== 0) return { ...base, error: "Google authentication status could not be verified on this machine." };
	try {
		const parsed = JSON.parse(res.out) as Record<string, unknown>;
		return {
			...base,
			authMethod: typeof parsed.auth_method === "string" ? parsed.auth_method : "none",
			clientConfigExists: parsed.client_config_exists === true,
			credentialsExists: parsed.plain_credentials_exists === true || parsed.encrypted_credentials_exists === true,
			storage: typeof parsed.storage === "string" ? parsed.storage : "none",
		};
	} catch {
		return { ...base, error: "gws auth status returned invalid JSON" };
	}
}
