import { expect, test } from "bun:test";
import { coerceToolInput } from "./tool-input";

const def = {
	name: "t",
	description: "",
	input_schema: {
		type: "object",
		properties: {
			checked: { type: "boolean" },
			count: { type: "integer" },
			times: { type: "array", items: { type: "string" } },
			ids: { type: "array", items: { type: "number" } },
			filter: { type: "object" },
			text: { type: "string" },
		},
	},
};

test("stringly-typed inputs become what the schema declares", () => {
	expect(coerceToolInput(def, { checked: "true", count: "5", times: '["09:30"]', ids: '["1","2"]', filter: '{"a":1}', text: "true" })).toEqual({
		checked: true,
		count: 5,
		times: ["09:30"],
		ids: [1, 2],
		filter: { a: 1 },
		text: "true",
	});
});

test("ambiguous text is left for the tool to refuse", () => {
	expect(coerceToolInput(def, { checked: "yes", count: "1.5", times: "09:30", filter: "[1]" })).toEqual({ checked: "yes", count: "1.5", times: "09:30", filter: "[1]" });
});
