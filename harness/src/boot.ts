/**
 * The harness's startup housekeeping - migrations of this computer's own
 * files and the seeding of catalogs, credentials, spaces' defaults - as
 * named steps. None of them is needed to answer agents, so none may stop
 * the harness: each runs on its own, a failure is logged and goes on this
 * computer's Error ("startup step <name> failed: …"), and the rest still run.
 * The harness serves first and runs these in the background.
 *
 * Only what the harness cannot run without is outside this: holding the
 * single-instance lock, knowing its machine id, registering its Computer
 * object, reaching the store and its live updates.
 */

import { deleteField, setField, str, sv } from "./api";
import { ownMachine } from "./machine";

export interface BootStep {
	name: string;
	run: () => Promise<unknown>;
}

/** Error-badge prefix this module owns on the Computer object ("startup step failed - …", "startup steps failed - …"). */
export const STARTUP_BADGE = "startup step";

/** Run every step in order; one that throws is reported, never fatal. Returns the failures ("name: message"). */
export async function runBootSteps(steps: BootStep[], report: (failures: string[]) => Promise<void> = reportOnComputer): Promise<string[]> {
	const failures: string[] = [];
	for (const step of steps) {
		try {
			const result = await step.run();
			if (result !== undefined) console.log(`[harness] ${step.name}:`, typeof result === "string" ? result : JSON.stringify(result));
		} catch (err) {
			const message = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 200);
			console.error(`[harness] startup step ${step.name} failed:`, err);
			failures.push(`${step.name}: ${message}`);
		}
	}
	await report(failures).catch((err) => console.error("[harness] startup report failed:", err instanceof Error ? err.message : err));
	return failures;
}

/** This computer's Error says which startup steps failed; a clean startup clears what an earlier one wrote. */
async function reportOnComputer(failures: string[]): Promise<void> {
	const mine = await ownMachine();
	if (!mine) return;
	const current = str(mine.fields, "error");
	const ours = current.startsWith(STARTUP_BADGE);
	if (failures.length > 0) {
		const next = `${failures.length === 1 ? "startup step" : "startup steps"} failed - ${failures.join("; ")}`.slice(0, 600);
		// Never over a crash report or a person's note.
		if ((!current || ours) && current !== next) await setField(mine.id, "error", sv(next));
	} else if (ours) await deleteField(mine.id, "error");
}
