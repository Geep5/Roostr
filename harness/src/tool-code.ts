/**
 * The built-in tools whose code lives in their Tool objects, as this
 * harness ships them. Each `tool-code/<name>.ts` is one tool: its
 * description, its inputs (the `tool_inputs` line format) and its code - a
 * default-exported function whose body is exactly what the Tool object
 * holds (tool-objects.ts seeds it; tool-runtime.ts runs the object's code).
 * Being source files, they are type-checked like the rest of the harness.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_HEADER } from "./tool-host";
import * as chat_reply_on from "./tool-code/chat_reply_on";
import * as discussion_read from "./tool-code/discussion_read";
import * as find from "./tool-code/find";
import * as memory_amend_milestone from "./tool-code/memory_amend_milestone";
import * as memory_list_facts from "./tool-code/memory_list_facts";
import * as memory_list_milestones from "./tool-code/memory_list_milestones";
import * as memory_recall from "./tool-code/memory_recall";
import * as memory_upsert_fact from "./tool-code/memory_upsert_fact";
import * as memory_upsert_milestone from "./tool-code/memory_upsert_milestone";
import * as neighborhood from "./tool-code/neighborhood";
import * as object_add_link from "./tool-code/object_add_link";
import * as object_add_property from "./tool-code/object_add_property";
import * as object_add_text from "./tool-code/object_add_text";
import * as object_check from "./tool-code/object_check";
import * as object_clear_field from "./tool-code/object_clear_field";
import * as object_clear_repeat from "./tool-code/object_clear_repeat";
import * as object_create from "./tool-code/object_create";
import * as object_delete from "./tool-code/object_delete";
import * as object_edit_block from "./tool-code/object_edit_block";
import * as object_flag_error from "./tool-code/object_flag_error";
import * as object_get from "./tool-code/object_get";
import * as object_list from "./tool-code/object_list";
import * as object_move_block from "./tool-code/object_move_block";
import * as object_remove_blocks from "./tool-code/object_remove_blocks";
import * as object_restore from "./tool-code/object_restore";
import * as object_search from "./tool-code/object_search";
import * as object_set_block_style from "./tool-code/object_set_block_style";
import * as object_set_field from "./tool-code/object_set_field";
import * as object_set_repeat from "./tool-code/object_set_repeat";
import * as object_set_type from "./tool-code/object_set_type";
import * as occurrence_complete from "./tool-code/occurrence_complete";
import * as query_run from "./tool-code/query_run";
import * as space_map from "./tool-code/space_map";

/** One shipped tool as its Tool object starts out. */
export interface ShippedCode {
	name: string;
	description: string;
	inputs: string;
	code: string;
}

/**
 * A shipped file's function body: the lines inside its default export
 * (opened by TOOL_HEADER, closed by its last line), one tab less indented.
 * The body runs alone in its Tool object, so the file imports nothing but
 * types: a helper imported here would type-check and then be missing there.
 */
export function shippedBody(source: string): string {
	const lines = source.trimEnd().split("\n");
	const start = lines.indexOf(TOOL_HEADER);
	if (start < 0 || lines.at(-1) !== "}") throw new Error("a shipped tool file ends with its default export, opened by TOOL_HEADER");
	if (lines.slice(0, start).some((line) => line.startsWith("import ") && !line.startsWith("import type "))) throw new Error("a shipped tool file imports only types: its body runs alone in its Tool object");
	return lines
		.slice(start + 1, -1)
		.map((line) => line.replace(/^\t/, ""))
		.join("\n");
}

/** In the order agents are offered them. */
const FILES: ReadonlyArray<[string, { description: string; inputs: string }]> = [
	["object_search", object_search],
	["object_list", object_list],
	["object_get", object_get],
	["space_map", space_map],
	["neighborhood", neighborhood],
	["find", find],
	["query_run", query_run],
	["discussion_read", discussion_read],
	["object_create", object_create],
	["object_set_field", object_set_field],
	["object_set_repeat", object_set_repeat],
	["object_clear_repeat", object_clear_repeat],
	["object_add_property", object_add_property],
	["object_clear_field", object_clear_field],
	["object_set_type", object_set_type],
	["occurrence_complete", occurrence_complete],
	["object_add_text", object_add_text],
	["object_edit_block", object_edit_block],
	["object_set_block_style", object_set_block_style],
	["object_check", object_check],
	["object_remove_blocks", object_remove_blocks],
	["object_move_block", object_move_block],
	["object_add_link", object_add_link],
	["object_delete", object_delete],
	["object_restore", object_restore],
	["chat_reply_on", chat_reply_on],
	["memory_upsert_fact", memory_upsert_fact],
	["memory_upsert_milestone", memory_upsert_milestone],
	["memory_amend_milestone", memory_amend_milestone],
	["memory_list_facts", memory_list_facts],
	["memory_list_milestones", memory_list_milestones],
	["memory_recall", memory_recall],
	["object_flag_error", object_flag_error],
];

export const SHIPPED_CODE: readonly ShippedCode[] = FILES.map(([name, file]) => ({
	name,
	description: file.description,
	inputs: file.inputs,
	code: shippedBody(readFileSync(join(import.meta.dir, "tool-code", `${name}.ts`), "utf8")),
}));
