/**
 * Local roster: which agents THIS machine serves. Assignment is a local
 * fact, never synced — an agent is "not ours" unless it was set up or
 * enabled here. Lives in GLON_DATA/harness.json next to auth.json.
 *
 * There is no presence signal at all, by choice. It used to be two setField
 * calls per agent every 120s, each one a content-addressed change on disk,
 * an SSE broadcast to every client, a relay publish, and a state
 * invalidation that replayed the agent's whole history. An idle machine
 * spent 100% of its commits saying "still alive" - 47% of this vault's 22k
 * changes sat on five agent objects. Liveness cannot live in the DAG
 * cheaply, and the DAG is the only source of truth this app reads, so the
 * answer is not to report it. What this roster still says is narrower and
 * durable: which agents this machine will serve.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";

interface RosterFile {
	version: 1;
	agents: string[];
}

function rosterPath(): string {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	return `${root}/harness.json`;
}

export async function readRoster(): Promise<string[]> {
	try {
		const parsed = (await Bun.file(rosterPath()).json()) as RosterFile;
		if (parsed?.version === 1 && Array.isArray(parsed.agents)) return parsed.agents;
	} catch {
		/* missing/corrupt → empty */
	}
	return [];
}

function writeRoster(agents: string[]): void {
	const path = rosterPath();
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify({ version: 1, agents } satisfies RosterFile, null, 2));
	renameSync(tmp, path);
}

export async function setEnabled(agentId: string, enabled: boolean): Promise<string[]> {
	const current = await readRoster();
	const next = enabled ? [...new Set([...current, agentId])] : current.filter((id) => id !== agentId);
	writeRoster(next);
	return next;
}

