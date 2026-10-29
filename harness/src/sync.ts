/**
 * Standalone note synchronization. Run alongside the Odin daemon, independently
 * of the optional agent harness: `bun run sync`.
 * Agent startup/crashes must not control whether notes reach other devices.
 * A daemon in record mode (GLON_RECORDS=1) syncs records (recordsync.ts);
 * otherwise the legacy change/base protocol (nostrsync.ts).
 */
// First: private extensions (harness/private/) register their seeds before anything reads them.
import "./extensions";
import { startNostrSync } from "./nostrsync";
import { daemonSyncMode, startRecordSync } from "./recordsync";
import { holdSingleInstance } from "./single-instance";

await holdSingleInstance("sync");

try {
	if ((await daemonSyncMode()) === "records") await startRecordSync();
	else await startNostrSync();
} catch (error) {
	console.error("[sync] startup failed:", error);
	process.exitCode = 1;
	process.exit(1);
}
