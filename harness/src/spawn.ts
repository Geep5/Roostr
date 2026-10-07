/**
 * Subagents — port of glon agent-spawn.ts. A subagent is an ordinary agent
 * object linked by spawn_parent; templates set the system suffix and tool
 * set. Depth capped, concurrency semaphored, result returned via the
 * submit_result tool and persisted on the subagent object.
 */

import { choice, createObject, deleteField, fetchObject, iv, setField, str, sv } from "./api";
import { promptFor } from "./prompts";
import { runTurn } from "./runner";
import { MAX_SPAWN_DEPTH, SPAWN_CONCURRENCY } from "./types";
import type { ToolContext } from "./tools";
import { agentThread, postTo } from "./conv";

interface Template {
	name: string;
	systemSuffix: string;
}

/** BUILTIN_TEMPLATES (agent-spawn.ts:77-102), trimmed to the Roostr tool set. */
const TEMPLATES: Record<string, Template> = {
	task: {
		name: "task",
		systemSuffix:
			"You are a subagent handling a delegated task. Work autonomously with your tools, then call submit_result exactly once with your complete findings/outcome. Do not ask questions — make reasonable decisions.",
	},
	explore: {
		name: "explore",
		systemSuffix:
			"You are a read-only research subagent. Investigate with search/read tools only, then call submit_result exactly once with a compressed, factual report.",
	},
	quick_task: {
		name: "quick_task",
		systemSuffix: "You are a fast subagent for a small task. Do the minimum correct work, then call submit_result exactly once.",
	},
	installer: {
		name: "installer",
		systemSuffix:
			"You install developer tooling on this Mac for the agent fleet. Use shell_exec for everything; verify with the check command named in the task. Do not attempt interactive sign-ins — if authentication is required, note exactly what the human must run. Call submit_result exactly once with what you installed and the check output.",
	},
};

class Semaphore {
	#queue: Array<() => void> = [];
	#available: number;
	constructor(n: number) {
		this.#available = n;
	}
	async acquire(): Promise<void> {
		if (this.#available > 0) {
			this.#available--;
			return;
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#queue.push(resolve);
		await promise;
	}
	release(): void {
		const next = this.#queue.shift();
		if (next) next();
		else this.#available++;
	}
}

const semaphore = new Semaphore(SPAWN_CONCURRENCY);

export async function spawnSubagent(task: string, templateName: string, parentCtx: ToolContext): Promise<string> {
	if (parentCtx.depth >= MAX_SPAWN_DEPTH) return "error: max spawn depth reached";
	const template = TEMPLATES[templateName] ?? TEMPLATES.task;
	const parent = await fetchObject(parentCtx.agentId);

	await semaphore.acquire();
	try {
		// The parent's effective model (its pick, else its prompt's) and its
		// prompt object: a subagent runs on the same visible configuration.
		const model = choice(parent.fields, "model") || (await promptFor(parent)).model;
		const { id } = await createObject(`sub: ${task.slice(0, 48)}`, "agent", {
			spawn_parent: sv(parentCtx.agentId),
			spawn_depth: iv(parentCtx.depth + 1),
			spawn_template: sv(template.name),
			model: sv(model),
			...(parent.fields["prompt"] ? { prompt: parent.fields["prompt"] } : {}),
			// Its parent's logins: the model key first of all. Without them a
			// helper fell back to the computer's own Claude login - an expired
			// one failed every spawn while its parent's key worked.
			...(parent.fields["credentials"] ? { credentials: parent.fields["credentials"] } : {}),
			...(str(parent.fields, "channel") ? { channel: sv(str(parent.fields, "channel")) } : {}),
		});

		let submitted = "";
		// A subagent's transcript is a thread on its own agent object: no
		// object names it, so conv.ts resolves the subject to the agent
		// itself - where the old code posted when chat and agent were the
		// same id.
		const conv = await agentThread(await fetchObject(id));
		await postTo(conv, task); // the task is the first user message
		let finalText: string;
		try {
			finalText = await runTurn(id, conv, {
				template: template.name,
				depth: parentCtx.depth + 1,
				spawn: template.name === "task" ? spawnSubagent : undefined,
				submitResult: (content) => {
					submitted = content;
				},
				systemSuffix: template.systemSuffix,
			});
		} catch (err) {
			// The parent may work around it; the person still sees why, on the object.
			const why = err instanceof Error ? err.message : String(err);
			if (parentCtx.boundObject) await badgeHelperFailure(parentCtx.boundObject, why).catch(() => {});
			throw err;
		}

		const result = submitted || finalText || "(subagent produced no result)";
		await setField(id, "submitted_result", sv(result.slice(0, 8192)));
		await setField(id, "submitted_at", iv(Date.now()));
		if (parentCtx.boundObject) await clearHelperFailure(parentCtx.boundObject).catch(() => {});
		return result;
	} finally {
		semaphore.release();
	}
}

/** Error-badge prefix for a helper agent (spawn) that failed on an object. */
const HELPER_BADGE = "helper agent failed: ";

/** Put the helper's failure on the object the turn was about - unless it carries another Error. */
async function badgeHelperFailure(objectId: string, why: string): Promise<void> {
	const current = str((await fetchObject(objectId)).fields, "error");
	const next = `${HELPER_BADGE}${why}`.slice(0, 300);
	if ((!current || current.startsWith(HELPER_BADGE)) && current !== next) await setField(objectId, "error", sv(next));
}

/** A helper that worked clears what a failed one wrote. */
async function clearHelperFailure(objectId: string): Promise<void> {
	if (str((await fetchObject(objectId)).fields, "error").startsWith(HELPER_BADGE)) await deleteField(objectId, "error");
}
