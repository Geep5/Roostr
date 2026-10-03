import type { Roostr } from "../tool-sdk";

export const description = "Run a shell command on this machine (sh -lc, 5min timeout). cwd is your Project folder when one is set, else home. Use for repo work, installs, and verification commands.";
export const inputs = "command: string - the shell command to run";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const command = typeof input.command === "string" ? input.command : "";
	if (!command) return "error: command required";
	const run = await roostr.shell(command);
	const body = (run.stdout + (run.stderr ? `\n[stderr]\n${run.stderr}` : "")).trim();
	return `exit ${run.exitCode}\n${body.slice(-16_000) || "(no output)"}`;
}
