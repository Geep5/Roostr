/**
 * Commands the harness ships in harness/bin and puts on this computer's
 * PATH (~/.local/bin), as links so a pull updates them: `gws-as` (Google
 * Workspace, google-credentials.ts) and `roostr-design` (Claude Design).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Text in a copy an older harness wrote: such a file is ours to replace with the link. */
const LEGACY_MARKS: Readonly<Record<string, string>> = { "gws-as": "Run gws against one explicitly selected Google account." };

/**
 * Link harness/bin/<name> into `binDir`. Replaced there: our own link (to
 * another checkout, or dangling), a copy identical to what we ship, a copy
 * an older harness wrote. Anything else is someone's own and is left alone.
 * Returns whether the link is in place.
 */
export function installShippedCommand(name: string, binDir = join(homedir(), ".local", "bin"), shipped = join(import.meta.dir, "..", "bin", name)): boolean {
	const target = join(binDir, name);
	try {
		const entry = lstatSync(target, { throwIfNoEntry: false });
		if (entry?.isSymbolicLink()) {
			if (readlinkSync(target) === shipped) return true;
			const dangling = !existsSync(target);
			const ours = dangling || readFileSync(target, "utf8") === readFileSync(shipped, "utf8");
			if (!ours) return false;
			rmSync(target);
		} else if (entry) {
			const current = readFileSync(target, "utf8");
			const legacy = LEGACY_MARKS[name];
			if (current !== readFileSync(shipped, "utf8") && !(legacy !== undefined && current.includes(legacy))) return false;
			rmSync(target);
		}
		mkdirSync(binDir, { recursive: true });
		symlinkSync(shipped, target);
		console.log(`[harness] ${name} → ${shipped}`);
		return true;
	} catch (error) {
		console.error(`[harness] could not install ${name}:`, error instanceof Error ? error.message : error);
		return false;
	}
}
