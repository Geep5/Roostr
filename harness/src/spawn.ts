/**
 * Subagents — port of glon agent-spawn.ts. A subagent is an ordinary agent
 * object linked by spawn_parent; templates set the system suffix and tool
 * set. Depth capped, concurrency semaphored, result returned via the
 * submit_result tool and persisted on the subagent object.
 */

import { chatPost, createObject, fetchObject, iv, setField, str, sv } from "./api";
import { runTurn } from "./runner";
import { MAX_SPAWN_DEPTH, SPAWN_CONCURRENCY } from "./types";
import type { ToolContext } from "./tools";

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
		const { id } = await createObject(`sub: ${task.slice(0, 48)}`, "agent", {
			spawn_parent: sv(parentCtx.agentId),
			spawn_depth: iv(parentCtx.depth + 1),
			spawn_template: sv(template.name),
			model: sv(str(parent.fields, "model") || "mock"),
			...(str(parent.fields, "channel") ? { channel: sv(str(parent.fields, "channel")) } : {}),
		});

		let submitted = "";
		await chatPost(id, task); // the task is the first user message
		const finalText = await runTurn(id, {
			template: template.name,
			depth: parentCtx.depth + 1,
			spawn: template.name === "task" ? spawnSubagent : undefined,
			submitResult: (content) => {
				submitted = content;
			},
			systemSuffix: template.systemSuffix,
		});

		const result = submitted || finalText || "(subagent produced no result)";
		await setField(id, "submitted_result", sv(result.slice(0, 8192)));
		await setField(id, "submitted_at", iv(Date.now()));
		return result;
	} finally {
		semaphore.release();
	}
}
