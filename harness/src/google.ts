/** A Google account's local gws sign-in: its config dir under the accounts
 * root (~/.config/gws/accounts/<email>), as `gws-as <email> auth login`
 * leaves it. The sign-in a credential carries lives on the credential
 * (google-credentials.ts); this only removes the local copy.
 */
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function rootDir(): string {
	return process.env.GOOGLE_WORKSPACE_ACCOUNTS_DIR ?? join(homedir(), ".config", "gws", "accounts");
}

/** Delete an account's local sign-in (its config dir under the accounts root). Nothing is revoked: a copy on a credential keeps working. */
export function removeGoogleAccount(account: string): void {
	if (!/^[^\s/@]+@[^\s/@]+$/.test(account)) throw new Error("Invalid Google account.");
	rmSync(join(rootDir(), account), { recursive: true, force: true });
}
