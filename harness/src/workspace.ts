/**
 * Project folders: the `repo_path` property, an absolute path on the
 * computer that runs the turn. A folder belongs to the work - set on the
 * object a chat is on (a task, a meeting...), or on the Project it is linked
 * to - so one agent works in each task's own folder; the agent's own folder
 * is only the fallback (its own page, objects without one). Optional: no
 * folder anywhere is normal. A folder in use is checked, described in the
 * prompt (where it is set), shell_exec's starting directory, its AGENTS.md
 * read; one missing here is said in the prompt, and on the agent's Error
 * when it is the agent's own. A folder need not be a git repo.
 */

import { homedir } from "node:os";
import { deleteField, fetchObject, setField, str, sv, type ObjectJSON } from "./api";

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

/**
 * Where a turn's Project folder is set: on the object the chat is on, else
 * on the first Project it is linked to (Linked projects), else on the agent
 * itself - a fallback for its own page and objects without one.
 */
export interface FolderSource {
	/** As set (`~` not yet expanded). */
	path: string;
	from: ObjectJSON;
}

const folderOf = (o: ObjectJSON): string => str(o.fields, "repo_path").trim();

export async function projectFolderSource(agent: ObjectJSON, on: ObjectJSON | null): Promise<FolderSource | null> {
	if (on && on.id !== agent.id) {
		if (folderOf(on)) return { path: folderOf(on), from: on };
		const v = on.fields["linked_projects"];
		const first = (v?.valuesValue?.items ?? (v ? [v] : [])).map((i) => i.linkValue?.targetId ?? "").find(Boolean);
		const project = first ? await fetchObject(first).catch(() => null) : null;
		if (project && folderOf(project)) return { path: folderOf(project), from: project };
	}
	return folderOf(agent) ? { path: folderOf(agent), from: agent } : null;
}

/** Whose Project folder it is, in the prompt's words. */
function whose(source: FolderSource, agentId: string): string {
	if (source.from.id === agentId) return "your own Project folder (no folder is set where this chat is)";
	const name = str(source.from.fields, "name") || source.from.id.slice(0, 8);
	return `the Project folder of ${source.from.typeKey} "${name}" (${source.from.id})`;
}

/**
 * A turn's Project folder: where it is set and, when this computer has it,
 * the folder. The agent's own folder keeps its Error true as before; a
 * folder set elsewhere that is missing here is said in the prompt instead
 * (missingFolderSection) - never silently swapped for another folder.
 */
export async function turnFolder(agent: ObjectJSON, on: ObjectJSON | null): Promise<{ source: FolderSource | null; ws: Workspace | null }> {
	const own = await checkProjectFolder(agent).catch(() => null);
	const source = await projectFolderSource(agent, on);
	if (!source) return { source: null, ws: null };
	if (source.from.id === agent.id) return { source, ws: own };
	return { source, ws: await workspaceAt(source.path).catch(() => null) };
}

/** The Workspace system-prompt section: everything from the folder itself, never from the System prompt. */
export function workspacePromptSection(ws: Workspace, source: FolderSource, agentId: string): string {
	const lines = [`This is your project: ${ws.path} - ${whose(source, agentId)}. Read and change the project here; shell_exec starts in this folder.`];
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
 * The Workspace section for a folder set where this chat is (or on its
 * Project) that this computer doesn't have: work nowhere else.
 */
export async function missingFolderSection(source: FolderSource, agentId: string): Promise<string> {
	return `${whose(source, agentId)[0].toUpperCase()}${whose(source, agentId).slice(1)} is ${source.path}, but that folder isn't on ${await thisComputerName()}, the computer you run on. Don't work on the project anywhere else: tell the person, so they set it to a folder on this computer or clear it.`;
}

/**
 * Keep the agent's Error true about its own Project folder, on the computer
 * that serves it: a set folder missing here is an Error; fine or unset
 * clears one this wrote. Returns the folder when it is in use.
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
