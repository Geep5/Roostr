/**
 * Roostr harness daemon — the /holdfast analog. Idempotent setup creates
 * the agent object; `serve` watches SSE for user chat messages on agent
 * objects and runs a turn; `ask` is a one-shot CLI turn for smoke tests.
 *
 *   bun run src/index.ts setup --name Gracie [--model claude-…] [--channel id]
 *   bun run src/index.ts serve
 *   bun run src/index.ts ask <agentId> "message"
 */

import { chatPost, fetchObject, query, setField, str, subscribe, sv, createObject } from "./api";
import { runTurn } from "./runner";
import { spawnSubagent } from "./spawn";
import { startAuthServer } from "./authserver";

function argValue(flagName: string): string {
	const idx = process.argv.indexOf(flagName);
	return idx >= 0 ? (process.argv[idx + 1] ?? "") : "";
}

/** Principal agents = agent objects without a spawn_parent. */
async function principalAgents(): Promise<string[]> {
	const rows = await query({ type: "agent", limit: 100 });
	return rows.filter((r) => !str(r.fields, "spawn_parent")).map((r) => r.id);
}

async function setup(): Promise<void> {
	const name = argValue("--name") || "Agent";
	const existing = await query({ type: "agent", filters: [{ key: "name", condition: "equal", value: name }] });
	if (existing.length > 0) {
		console.log(`agent "${name}" already exists: ${existing[0].id}`);
		return;
	}
	const fields: Record<string, ReturnType<typeof sv>> = {
		model: sv(argValue("--model") || "claude-sonnet-4-5"),
	};
	if (argValue("--channel")) fields.channel = sv(argValue("--channel"));
	const { id } = await createObject(name, "agent", fields);
	console.log(`created agent "${name}": ${id}`);
}

/** Newest unanswered user chat block id, or "" when up to date. */
async function pendingUserMessage(agentId: string): Promise<string> {
	const obj = await fetchObject(agentId);
	const byId = new Map(obj.blocks.map((b) => [b.id, b]));
	const root = byId.get("__discussion__");
	if (!root) return "";
	const lastProcessed = str(obj.fields, "last_ingested_block");
	let newestUser = "";
	let sawProcessed = lastProcessed === "";
	for (const cid of root.childrenIds) {
		if (cid === lastProcessed) {
			sawProcessed = true;
			newestUser = "";
			continue;
		}
		const meta = byId.get(cid)?.content.custom;
		if (meta?.contentType === "chat" && meta.meta?.["author"] !== agentId) newestUser = cid;
	}
	return sawProcessed ? newestUser : newestUser; // unknown lastProcessed ⇒ treat all as new
}

async function handleAgentEvent(agentId: string, busy: Set<string>): Promise<void> {
	if (busy.has(agentId)) return; // steering: runTurn re-fetches every iteration
	const pending = await pendingUserMessage(agentId);
	if (!pending) return;
	busy.add(agentId);
	try {
		await setField(agentId, "last_ingested_block", sv(pending));
		const reply = await runTurn(agentId, { spawn: spawnSubagent });
		console.log(`[${new Date().toISOString()}] ${agentId.slice(0, 8)} replied: ${reply.slice(0, 120)}`);
	} catch (err) {
		console.error(`[harness] turn failed for ${agentId}:`, err);
	} finally {
		busy.delete(agentId);
		// A message may have landed while we were busy — check once more.
		const again = await pendingUserMessage(agentId);
		if (again) void handleAgentEvent(agentId, busy);
	}
}

async function serve(): Promise<void> {
	startAuthServer();
	const agents = new Set(await principalAgents());
	console.log(`[harness] watching ${agents.size} agent(s): ${[...agents].map((a) => a.slice(0, 8)).join(", ")}`);
	const busy = new Set<string>();
	// Catch up on anything that arrived while the harness was down.
	for (const id of agents) void handleAgentEvent(id, busy);
	subscribe((objectId) => {
		if (agents.has(objectId)) void handleAgentEvent(objectId, busy);
		else {
			// A new agent object may have been created.
			void (async () => {
				const fresh = await principalAgents();
				for (const id of fresh) agents.add(id);
			})();
		}
	});
	console.log("[harness] SSE connected; serving.");
}

async function ask(): Promise<void> {
	const agentId = process.argv[3];
	const text = process.argv[4];
	if (!agentId || !text) {
		console.error("usage: ask <agentId> <message>");
		process.exit(1);
	}
	await chatPost(agentId, text);
	const reply = await runTurn(agentId, { spawn: spawnSubagent });
	console.log(reply);
}

const cmd = process.argv[2];
if (cmd === "setup") await setup();
else if (cmd === "serve") await serve();
else if (cmd === "ask") await ask();
else {
	console.log("commands: setup --name X [--model m] [--channel id] | serve | ask <agentId> <msg>");
}
