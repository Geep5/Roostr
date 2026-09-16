/** Google account selectors for the local gws CLI. Secrets stay in each
 * account's config dir; this only reports which selectors exist and whether
 * their own auth state verifies.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
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

function defaultClientSecret(): string | undefined {
	for (const path of [join(rootDir(), "client_secret.json"), join(homedir(), ".config", "gws", "client_secret.json")]) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

/** Create an account selector directory, sharing only the OAuth client config. */
export function addGoogleAccount(account: string): GoogleAccountStatus {
	if (!/^[^\s/]+@[^\s/]+$/.test(account)) throw new Error("Enter the Google account email address.");
	const dir = accountDir(account);
	mkdirSync(dir, { recursive: true });
	const client = defaultClientSecret();
	if (client && !existsSync(join(dir, "client_secret.json"))) copyFileSync(client, join(dir, "client_secret.json"));
	return googleAccountStatus(account);
}

export function removeGoogleAccount(account: string): void {
	const dir = accountDir(account);
	if (!dir.startsWith(rootDir())) throw new Error("Invalid Google account.");
	rmSync(dir, { recursive: true, force: true });
}

async function gws(account: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
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
	const res = await gws(account, "auth", "status");
	if (res.code !== 0) return { ...base, error: (res.err || res.out || "gws auth status failed").trim() };
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

/** Every configured account selector, in stable order. */
export async function listGoogleAccounts(): Promise<GoogleAccountStatus[]> {
	mkdirSync(rootDir(), { recursive: true });
	const accounts = readdirSync(rootDir(), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.includes("@"))
		.map((entry) => entry.name)
		.sort();
	return Promise.all(accounts.map(googleAccountStatus));
}
