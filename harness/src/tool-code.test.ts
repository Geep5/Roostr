import { expect, test } from "bun:test";
import { shippedBody } from "./tool-code";
import { TOOL_HEADER } from "./tool-host";

// A shipped tool runs as its default export's body alone in its Tool object:
// property_edit once kept a helper above the function and failed every call
// with "ReferenceError: strings is not defined".
test("a shipped tool file with code outside its default export is refused", () => {
	const file = (above: string) => `import type { Roostr } from "../tool-sdk";\n\nexport const description = "d";\nexport const inputs = "i";\n${above}\n${TOOL_HEADER}\n\treturn "ok";\n}\n`;
	expect(() => shippedBody(file("const strings = (v: unknown) => v;"))).toThrow('move "const strings');
	expect(() => shippedBody(file("function helper() {}"))).toThrow("inside its default export");
	expect(shippedBody(file(""))).toBe('return "ok";');
});
