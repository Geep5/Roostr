/**
 * People and agents change objects through the same engine actions. Every
 * action the engine offers must either have an agent tool, or a stated
 * reason agents don't get one. A new engine action (or a renamed tool)
 * fails here until someone decides which it is - so the two sides can't
 * silently drift apart again, the way agents once had no repeat tool and
 * faked it with a text field.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolDefs } from "./tools";

type Coverage = { tools: string[] } | { reason: string };

const TABLES = "gap: tables - agents cannot build or edit table blocks yet";
const MAILBOX = "mailbox delivery bookkeeping: the harness moves a sent message along, not an edit";
const MEMBERSHIP = "space membership and keys stay with people";

const COVERAGE: Record<string, Coverage> = {
	// ── Objects ──
	create: { tools: ["object_create"] },
	set_field: { tools: ["object_set_field"] },
	delete_field: { tools: ["object_clear_field"] },
	set_type: { tools: ["object_set_type"] },
	delete: { tools: ["object_delete"] },
	restore: { tools: ["object_restore"] },
	// ── Body ──
	block_add: { tools: ["object_add_text", "object_add_link"] },
	block_update: { tools: ["object_edit_block", "object_check", "object_set_block_style"] },
	block_move: { tools: ["object_move_block"] },
	block_remove: { tools: ["object_remove_blocks"] },
	block_set_attrs: { reason: "gap: line alignment and background colour - cosmetic, not yet an agent tool" },
	table_create: { reason: TABLES },
	table_row_add: { reason: TABLES },
	table_col_add: { reason: TABLES },
	table_col_remove: { reason: TABLES },
	// ── Recurrence ──
	repeat_set: { tools: ["object_set_repeat"] },
	repeat_clear: { tools: ["object_clear_repeat"] },
	occurrence_complete: { tools: ["occurrence_complete"] },
	occurrence_fire: { reason: "the scheduler's own bookkeeping when an occurrence starts, not an edit" },
	run_record: { reason: "the scheduler's record of an agent run, written by the harness around the turn" },
	// ── Conversation ──
	chat_post: { tools: ["chat_reply_on"] },
	message_send: { tools: ["agent_ask"] },
	message_deliver: { reason: MAILBOX },
	message_delivery_error: { reason: MAILBOX },
	message_processing: { reason: MAILBOX },
	message_retry: { reason: MAILBOX },
	conversation_open: { reason: "thread plumbing: opened by the harness for agent_ask and agent transcripts" },
	conversation_update: { reason: "thread plumbing: kept current by the harness, not edited by hand" },
	chat_react: { reason: "an emoji reaction is a person's gesture on a message; agents answer in words" },
	// ── People-only ──
	vanish: { reason: "irreversible erasure stays with people; agents use the recoverable bin (object_delete)" },
	purge_deleted: { reason: "emptying the bin is irreversible; it stays with people" },
	channel_create: { reason: "creating spaces is a person's decision" },
	channel_member_add: { reason: MEMBERSHIP },
	channel_member_remove: { reason: MEMBERSHIP },
	channel_key_rotate: { reason: MEMBERSHIP },
	space_leave: { reason: MEMBERSHIP },
	// ── Engine upkeep ──
	bootstrap_space_defaults: { reason: "engine start-up convergence of built-in types and properties" },
	seed_space_defaults: { reason: "engine seeding of a new space's built-in types and properties" },
};

/** Every action name in the engine's mutation dispatch; a case line may name several. */
const engineActions = (): string[] => {
	const source = readFileSync(`${import.meta.dir}/../../core/mutate.odin`, "utf8");
	const caseLines = [...source.matchAll(/^\s+case ("[a-z_]+"(?:, "[a-z_]+")*):/gm)].map((m) => m[1]);
	return [...new Set(caseLines.flatMap((l) => [...l.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])))].sort();
};

test("every engine action has an agent tool or a stated reason agents don't get one", () => {
	const actions = engineActions();
	expect(actions.length).toBeGreaterThan(20); // the parse found the dispatch, not an empty file
	const unaccounted = actions.filter((a) => !(a in COVERAGE));
	expect(unaccounted, `decide agent coverage for: ${unaccounted.join(", ")}`).toEqual([]);
	const stale = Object.keys(COVERAGE).filter((a) => !actions.includes(a));
	expect(stale, `no longer engine actions: ${stale.join(", ")}`).toEqual([]);
});

test("every tool named for an action is one an agent actually gets", () => {
	const offered = new Set(toolDefs("", 0, true).map((d) => d.name));
	const missing = Object.entries(COVERAGE).flatMap(([action, c]) => ("tools" in c ? c.tools.filter((t) => !offered.has(t)).map((t) => `${action} -> ${t}`) : []));
	expect(missing).toEqual([]);
});
