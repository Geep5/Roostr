/**
 * The agent's Project folder: its `repo_path` property, an absolute path on
 * the computer that serves it (machine-local by nature - the serving gate
 * guarantees the computer running the turn is the one the agent is pinned
 * to). Optional: no folder is a normal agent. A folder that is set is
 * either fully in use - checked, described in the prompt, shell_exec's
 * starting directory, its AGENTS.md read - or its absence is on the agent's
 * Error. A folder need not be a git repo; when it is, the prompt says so.
 */

import { homedir } from "node:os";
import { deleteField, setField, str, sv, type ObjectJSON } from "./api";

const AGENTS_MD_CAP = 8000;
const GIT_TIMEOUT_MS = 10_000;
/** Error-badge prefix for a Project folder problem (cleared once the folder is fine or unset). */
export const FOLDER_BADGE = "Project folder ";

async function git(path: string, ...args: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
	const out = await new Response(proc.stdout).text();
	const code = await proc.exited;
	clearTimeout(timer);
	return { code, out: out.trim() };
}

export interface Workspace {
	path: string;
	/** A git work tree (anything below is only set when it is). */
	git: boolean;
	remote: string;
	branch: string;
	dirty: number;
	/** The checkout's AGENTS.md (else CLAUDE.md): its file name and text, capped. */
	agentsFile: string;
	agentsMd: string;
	agentsTruncated: boolean;
}

/** `~` and `~/…` as the person typed them, on this computer. */
export function expandHome(path: string): string {
	const p = path.trim();
	return p === "~" ? homedir() : p.startsWith("~/") ? `${homedir()}${p.slice(1)}` : p;
}

/** A folder by path, or null when it is not a directory on this computer. */
export async function workspaceAt(rawPath: string): Promise<Workspace | null> {
	const path = expandHome(rawPath);
	const exists = await Bun.file(`${path}/.`)
		.stat()
		.then((s) => s.isDirectory())
		.catch(() => false);
	if (!exists) return null;
	const inside = await git(path, "rev-parse", "--is-inside-work-tree");
	const isGit = inside.code === 0 && inside.out === "true";
	const [remote, branch, status] = isGit
		? await Promise.all([git(path, "remote", "get-url", "origin"), git(path, "rev-parse", "--abbrev-ref", "HEAD"), git(path, "status", "--porcelain")])
		: [null, null, null];
	let agentsFile = "";
	let agentsMd = "";
	let agentsTruncated = false;
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const text = await Bun.file(`${path}/${name}`)
			.text()
			.catch(() => "");
		if (!text.trim()) continue;
		agentsFile = name;
		agentsTruncated = text.length > AGENTS_MD_CAP;
		agentsMd = agentsTruncated ? text.slice(0, AGENTS_MD_CAP) : text;
		break;
	}
	return {
		path,
		git: isGit,
		remote: remote?.code === 0 ? remote.out : "",
		branch: branch?.code === 0 ? branch.out : "",
		dirty: status?.code === 0 && status.out ? status.out.split("\n").length : 0,
		agentsFile,
		agentsMd,
		agentsTruncated,
	};
}

/** One line saying what the folder is, for people (the check endpoint) and the prompt. */
export function workspaceSummary(ws: Workspace): string {
	if (!ws.git) return `${ws.path} (a folder, not a git repo)`;
	const where = [ws.remote, ws.branch].filter(Boolean).join(" · ");
	const state = ws.dirty ? `${ws.dirty} uncommitted change${ws.dirty === 1 ? "" : "s"}` : "clean";
	return `${ws.path} - git repo${where ? ` ${where}` : ""} (${state})`;
}

/** The Workspace system-prompt section: everything from the folder itself, never from the System prompt. */
export function workspacePromptSection(ws: Workspace): string {
	const lines = [`This is your project: ${ws.path} - set as your Project folder. Read and change the project here; shell_exec starts in this folder.`];
	if (ws.git) {
		lines.push(
			`It is a git repo${ws.remote ? ` (remote ${ws.remote})` : ""}${ws.branch ? `, on branch ${ws.branch}` : ""}: ${ws.dirty ? `${ws.dirty} uncommitted change${ws.dirty === 1 ? "" : "s"}` : "no uncommitted changes"}. Use git for its history and changes.`,
		);
	} else lines.push("It is a plain folder, not a git repo.");
	if (ws.agentsMd) {
		lines.push("", `Project instructions (${ws.agentsFile}, from the project - follow them):`, ws.agentsMd);
		if (ws.agentsTruncated) lines.push(`… (continues - read the rest from ${ws.path}/${ws.agentsFile} before relying on it)`);
	}
	return lines.join("\n");
}

/**
 * Keep the agent's Error true about its Project folder, on the computer that
 * serves it: a set folder missing here is an Error; fine or unset clears one
 * this wrote. Returns the folder when it is in use.
 */
export async function checkProjectFolder(agent: ObjectJSON): Promise<Workspace | null> {
	const repo = str(agent.fields, "repo_path").trim();
	const ws = repo ? await workspaceAt(repo).catch(() => null) : null;
	const current = str(agent.fields, "error");
	const want = repo && !ws ? `${FOLDER_BADGE}${repo} isn't on ${await thisComputerName()} - set it to a folder on the computer this agent runs on, or clear it.` : "";
	if (want && current !== want && (!current || current.startsWith(FOLDER_BADGE))) await setField(agent.id, "error", sv(want));
	if (!want && current.startsWith(FOLDER_BADGE)) await deleteField(agent.id, "error");
	return ws;
}

/** This computer as people know it: its Computer object's name. */
export async function thisComputerName(): Promise<string> {
	const { machines } = await import("./machine");
	const { machineId } = await import("./roster");
	const me = await machineId();
	return (await machines()).find((m) => m.machineId === me)?.name ?? (await import("node:os")).hostname();
}
