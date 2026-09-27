/**
 * The agent's project checkout: its `repo_path` property ("Project folder"),
 * an absolute path on the machine that serves the agent. Machine-local by
 * nature - the serving gate guarantees the machine running the turn is the
 * one the agent is pinned to.
 */

const AGENTS_MD_CAP = 4000;
const GIT_TIMEOUT_MS = 10_000;

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
	remote: string;
	branch: string;
	dirty: number;
	agentsMd: string;
}

/**
 * A checkout by path, or null when the directory is missing. Reads
 * AGENTS.md/CLAUDE.md from it so repo knowledge rides with the repo, not
 * the DAG.
 */
export async function workspaceAt(path: string): Promise<Workspace | null> {
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
		`You work in a local project checked out on this machine.`,
		`Path: ${ws.path}`,
		ws.remote ? `Remote: ${ws.remote}` : "",
		ws.branch ? `Branch: ${ws.branch}${ws.dirty ? ` (${ws.dirty} uncommitted change${ws.dirty === 1 ? "" : "s"})` : " (clean)"}` : "",
		`shell_exec starts in this directory.`,
	].filter(Boolean);
	if (ws.agentsMd) lines.push("", "Project instructions (AGENTS.md, from the checkout):", ws.agentsMd);
	return lines.join("\n");
}
