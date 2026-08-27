/**
 * Local roster: which agents THIS machine serves. Assignment is a local
 * fact, never synced — an agent is "not ours" unless it was set up or
 * enabled here. Lives in GLON_DATA/harness.json next to auth.json.
 * Heartbeat fields on the agent object (harness_seen_at / harness_host)
 * are written only for presence display on other devices.
 */

import { hostname } from "node:os";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { iv, setField, sv } from "./api";

const HEARTBEAT_MS = 120_000;

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

// ── Presence heartbeat ───────────────────────────────────────────

const beating = new Map<string, ReturnType<typeof setInterval>>();

async function beat(agentId: string): Promise<void> {
	try {
		await setField(agentId, "harness_seen_at", iv(Date.now()));
		await setField(agentId, "harness_host", sv(hostname()));
	} catch {
		/* server down — next tick retries */
	}
}

/** Start/refresh heartbeats for exactly the given agents. */
export function syncHeartbeats(agentIds: Set<string>): void {
	for (const [id, timer] of beating) {
		if (!agentIds.has(id)) {
			clearInterval(timer);
			beating.delete(id);
		}
	}
	for (const id of agentIds) {
		if (beating.has(id)) continue;
		void beat(id);
		beating.set(id, setInterval(() => void beat(id), HEARTBEAT_MS));
	}
}
