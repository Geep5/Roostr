import { expect, test } from "bun:test";

// Module mocks live in a separate process: replacing ./api here would leak
// into the other tests in the same Bun worker.
const fixture = String.raw`
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const objects = new Map();
const writes = [];
mock.module("./api", () => ({
	str: (fields, key) => fields[key]?.stringValue ?? "",
	sv: (value) => ({ stringValue: value }),
	fetchObject: async (id) => { const o = objects.get(id); if (!o) throw new Error("no " + id); return structuredClone(o); },
	setField: async (id, key) => void writes.push([id, key]),
	deleteField: async (id, key) => void writes.push([id, "-" + key]),
}));
mock.module("./machine", () => ({ machines: async () => [{ machineId: "this-mac", name: "This Mac" }] }));
mock.module("./roster", () => ({ machineId: async () => "this-mac" }));
const { missingFolderSection, turnFolder, workspacePromptSection } = await import("./workspace");
const dirs = [];
const folder = (instructions) => { const dir = mkdtempSync(join(tmpdir(), "roostr-folder-")); writeFileSync(join(dir, "AGENTS.md"), instructions); dirs.push(dir); return dir; };
const obj = (id, typeKey, fields = {}) => { const o = { id, typeKey, fields: { name: { stringValue: id }, ...fields }, blocks: [], deleted: false, createdAt: 0, updatedAt: 0 }; objects.set(id, o); return o; };
const path = (p) => ({ repo_path: { stringValue: p } });
try {
`;

async function scenario(body: string): Promise<void> {
	const child = Bun.spawn([process.execPath, "-e", `${fixture}${body}\n} finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }`], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
}

test("the folder where the chat is wins, then its Project's, then the agent's own", async () => {
	await scenario(String.raw`
const own = folder("agent's own");
const client = folder("acme project");
const task = folder("acme task");
const agent = obj("mockup-agent", "agent", path(own));
const project = obj("acme", "project", path(client));
const linked = { linked_projects: { valuesValue: { items: [{ linkValue: { targetId: project.id } }] } } };

const onTask = await turnFolder(agent, obj("task-1", "task", { ...path(task), ...linked }));
assert.equal(onTask.ws?.path, task);
const text = workspacePromptSection(onTask.ws, onTask.source, agent.id);
assert.ok(text.includes("This is your project: " + task + ' - the Project folder of task "task-1"'), text);
assert.ok(text.includes("acme task"), "its AGENTS.md");

const viaProject = await turnFolder(agent, obj("task-2", "task", linked));
assert.equal(viaProject.ws?.path, client);
assert.equal(viaProject.source?.from.id, "acme");

const plain = await turnFolder(agent, obj("note-1", "note"));
assert.equal(plain.ws?.path, own);
assert.ok(workspacePromptSection(plain.ws, plain.source, agent.id).includes("your own Project folder"));

assert.equal((await turnFolder(agent, agent)).ws?.path, own, "the agent's own page");
assert.deepEqual(await turnFolder(obj("plain-agent", "agent"), obj("note-2", "note")), { source: null, ws: null });
`);
});

test("a folder set where the chat is that this computer lacks is said, not swapped for the agent's", async () => {
	await scenario(String.raw`
const own = folder("agent's own");
const agent = obj("dev-agent", "agent", path(own));
const turn = await turnFolder(agent, obj("task-3", "task", path("/nowhere/acme")));
assert.equal(turn.ws, null);
const text = await missingFolderSection(turn.source, agent.id);
assert.ok(text.includes("/nowhere/acme") && text.includes("isn't on This Mac"), text);
assert.deepEqual(writes.filter(([id]) => id === agent.id), [], "the agent's own folder is fine: no Error");
`);
});
