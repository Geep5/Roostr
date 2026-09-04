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
	/**
	 * Stable id for THIS machine. The claim published to the DAG is keyed on
	 * it rather than on the hostname, so renaming the Mac edits one name
	 * instead of orphaning the claim and minting a second machine object.
	 */
	machineId?: string;
}

function rosterPath(): string {
	const root = process.env.GLON_DATA ?? `${process.env.HOME}/.glon`;
	return `${root}/harness.json`;
}

async function readFile(): Promise<RosterFile> {
	try {
		const parsed = (await Bun.file(rosterPath()).json()) as RosterFile;
		if (parsed?.version === 1 && Array.isArray(parsed.agents)) return parsed;
	} catch {
		/* missing/corrupt → empty */
	}
	return { version: 1, agents: [] };
}

/** Whole-file write: every caller passes the file it read, so adding a key
 *  cannot drop a sibling one. */
function writeFile(next: RosterFile): void {
	const path = rosterPath();
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2));
	renameSync(tmp, path);
}

export async function readRoster(): Promise<string[]> {
	return (await readFile()).agents;
}

export async function setEnabled(agentId: string, enabled: boolean): Promise<string[]> {
	const file = await readFile();
	const next = enabled ? [...new Set([...file.agents, agentId])] : file.agents.filter((id) => id !== agentId);
	writeFile({ ...file, agents: next });
	return next;
}

/** This machine's stable id, minted on first use. */
export async function machineId(): Promise<string> {
	const file = await readFile();
	if (file.machineId) return file.machineId;
	const id = crypto.randomUUID();
	writeFile({ ...file, machineId: id });
	return id;
}

