/**
 * Standalone note synchronization. Run alongside the Odin daemon, independently
 * of the optional agent harness: `bun run sync`.
 * Agent startup/crashes must not control whether notes reach other devices.
 */
// First: private extensions (harness/private/) register their seeds before anything reads them.
import "./extensions";
import { startNostrSync } from "./nostrsync";

try {
	await startNostrSync();
} catch (error) {
	console.error("[sync] startup failed:", error);
	process.exitCode = 1;
	process.exit(1);
}
