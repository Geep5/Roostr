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
import * as find from "./tool-code/find";
import * as neighborhood from "./tool-code/neighborhood";
import * as object_get from "./tool-code/object_get";
import * as object_list from "./tool-code/object_list";
import * as object_search from "./tool-code/object_search";
import * as query_run from "./tool-code/query_run";
import * as space_map from "./tool-code/space_map";

/** One shipped tool as its Tool object starts out. */
export interface ShippedCode {
	name: string;
	description: string;
	inputs: string;
	code: string;
}

/** A shipped file's function body: the lines inside its default export (opened by TOOL_HEADER, closed by its last line), one tab less indented. */
export function shippedBody(source: string): string {
	const lines = source.trimEnd().split("\n");
	const start = lines.indexOf(TOOL_HEADER);
	if (start < 0 || lines.at(-1) !== "}") throw new Error("a shipped tool file ends with its default export, opened by TOOL_HEADER");
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
];

export const SHIPPED_CODE: readonly ShippedCode[] = FILES.map(([name, file]) => ({
	name,
	description: file.description,
	inputs: file.inputs,
	code: shippedBody(readFileSync(join(import.meta.dir, "tool-code", `${name}.ts`), "utf8")),
}));
