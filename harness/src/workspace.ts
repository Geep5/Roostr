/**
 * Space ↔ local checkout binding.
 *
 * A space that manages a project has two facts with different scopes:
 *
 *   - Project identity (`repo_url` on the channel object) - synced truth,
 *     meaningful on every device; a new machine uses it to clone.
 *   - The local checkout path - a machine-local fact, stored on THIS
 *     machine's object as a JSON map (`paths`: spaceId -> absolute path)
 *     with a sibling status map (`paths_status`). It syncs like everything
 *     else so any device can SEE where checkouts live, but only the machine
 *     that serves the space ever writes its own entry (enforced by the
 *     harness endpoint being the sole writer - the UI has no direct path).
 *
 * The binding is what makes serving sticky in practice: the machine with
 * the working copy is the only one that can execute in it.
 */

import { fetchObject, queryAll, setField, str, sv, type QueryRow } from "./api";
import { machineId } from "./roster";
import { MACHINE_TYPE } from "./machine";

const AGENTS_MD_CAP = 4000;
const GIT_TIMEOUT_MS = 10_000;

// ── My machine row ────────────────────────────────────────────────

const ROW_TTL_MS = 20_000;
let rowCache: { at: number; row: QueryRow | null } | null = null;

export function invalidateWorkspaces(): void {
	rowCache = null;
}

async function myMachineRow(): Promise<QueryRow | null> {
	if (rowCache && Date.now() - rowCache.at < ROW_TTL_MS) return rowCache.row;
	const id = await machineId();
	const row = (await queryAll({ type: MACHINE_TYPE })).find((m) => str(m.fields, "machine_id") === id) ?? null;
	rowCache = { at: Date.now(), row };
	return row;
}

function parseMap(row: QueryRow | null, key: string): Record<string, string> {
	try {
		const raw = row ? str(row.fields, key) : "";
		return raw ? (JSON.parse(raw) as Record<string, string>) : {};
	} catch {
		return {};
	}
}

/** This machine's spaceId -> path map. */
export async function readBindings(): Promise<Record<string, string>> {
	return parseMap(await myMachineRow(), "paths");
}

// ── Validation ────────────────────────────────────────────────────

async function git(path: string, ...args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	clearTimeout(timer);
	return { code, out: out.trim() };
}

/** Normalize a git remote for comparison: strip protocol/user/.git suffix. */
function remoteKey(url: string): string {
	return url
		.trim()
		.replace(/^git@([^:]+):/, "$1/")
		.replace(/^[a-z+]+:\/\//, "")
		.replace(/^[^@]+@/, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "")
		.toLowerCase();
}

/**
 * Status of one binding: "ok" | "missing" | "not-git" |
 * "remote-mismatch:<actual>". `repoUrl` empty = any remote is fine.
 */
export async function bindingStatus(path: string, repoUrl: string): Promise<string> {
	const exists = await Bun.file(`${path}/.`)
		.stat()
		.then((s) => s.isDirectory())
		.catch(() => false);
	if (!exists) return "missing";
	const remote = await git(path, "remote", "get-url", "origin");
	if (remote.code !== 0) return "not-git";
	if (repoUrl && remoteKey(remote.out) !== remoteKey(repoUrl)) return `remote-mismatch:${remote.out}`;
	return "ok";
}

async function writeStatusMap(row: QueryRow, statuses: Record<string, string>): Promise<void> {
	const prev = parseMap(row, "paths_status");
	if (JSON.stringify(prev) === JSON.stringify(statuses)) return;
	await setField(row.id, "paths_status", sv(JSON.stringify(statuses)));
}

/** Re-validate every binding this machine holds; write statuses if changed. */
export async function validateBindings(): Promise<void> {
	const row = await myMachineRow();
	if (!row) return;
	const paths = parseMap(row, "paths");
	const statuses: Record<string, string> = {};
	for (const [spaceId, path] of Object.entries(paths)) {
		const repoUrl = await fetchObject(spaceId)
			.then((o) => str(o.fields, "repo_url"))
			.catch(() => "");
		statuses[spaceId] = await bindingStatus(path, repoUrl);
	}
	await writeStatusMap(row, statuses);
	invalidateWorkspaces();
}

// ── Binding writes (authserver is the only caller - UI never writes) ──

/** Bind (or with empty path, unbind) this machine's checkout for a space. */
export async function setBinding(spaceId: string, path: string): Promise<{ status: string }> {
	const row = await myMachineRow();
	if (!row) throw new Error("this machine has no machine object yet - serve something first");
	const paths = parseMap(row, "paths");
	const statuses = parseMap(row, "paths_status");
	if (!path) {
		delete paths[spaceId];
		delete statuses[spaceId];
		await setField(row.id, "paths", sv(JSON.stringify(paths)));
		await writeStatusMap(row, statuses);
		invalidateWorkspaces();
		return { status: "unbound" };
	}
	const repoUrl = await fetchObject(spaceId)
		.then((o) => str(o.fields, "repo_url"))
		.catch(() => "");
	const status = await bindingStatus(path, repoUrl);
	paths[spaceId] = path;
	statuses[spaceId] = status;
	await setField(row.id, "paths", sv(JSON.stringify(paths)));
	await writeStatusMap(row, statuses);
	invalidateWorkspaces();
	return { status };
}

// ── Agent-facing context ──────────────────────────────────────────

export interface Workspace {
	path: string;
	remote: string;
	branch: string;
	dirty: number;
	agentsMd: string;
}

/**
 * The workspace an agent in `channelId` works in on THIS machine, or null
 * when the space has no binding here. Reads AGENTS.md/CLAUDE.md from the
 * checkout so repo knowledge rides with the repo, not the DAG.
 */
export async function workspaceContext(channelId: string): Promise<Workspace | null> {
	if (!channelId) return null;
	const path = (await readBindings())[channelId];
	if (!path) return null;
	const exists = await Bun.file(`${path}/.`)
		.stat()
		.then((s) => s.isDirectory())
		.catch(() => false);
	if (!exists) return null;
	const [remote, branch, status] = await Promise.all([
		git(path, "remote", "get-url", "origin"),
		git(path, "rev-parse", "--abbrev-ref", "HEAD"),
		git(path, "status", "--porcelain"),
	]);
	let agentsMd = "";
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const text = await Bun.file(`${path}/${name}`)
			.text()
			.catch(() => "");
		if (text.trim()) {
			agentsMd = text.length > AGENTS_MD_CAP ? `${text.slice(0, AGENTS_MD_CAP)}\n… (truncated)` : text;
			break;
		}
	}
	return {
		path,
		remote: remote.code === 0 ? remote.out : "",
		branch: branch.code === 0 ? branch.out : "",
		dirty: status.code === 0 && status.out ? status.out.split("\n").length : 0,
		agentsMd,
	};
}

/** The Workspace system-prompt section. */
export function workspacePromptSection(ws: Workspace): string {
	const lines = [
		`This space manages a local project checked out on this machine.`,
		`Path: ${ws.path}`,
		ws.remote ? `Remote: ${ws.remote}` : "",
		ws.branch ? `Branch: ${ws.branch}${ws.dirty ? ` (${ws.dirty} uncommitted change${ws.dirty === 1 ? "" : "s"})` : " (clean)"}` : "",
		`shell_exec starts in this directory.`,
	].filter(Boolean);
	if (ws.agentsMd) lines.push("", "Project instructions (AGENTS.md, from the checkout):", ws.agentsMd);
	return lines.join("\n");
}
