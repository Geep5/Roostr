import { expect, test } from "bun:test";
import { inlineMarks, MARK, mdToTree, STYLE } from "./markdown";

test("a numbered list with indented details nests them, so the numbers run 1, 2", () => {
	const tree = mdToTree(["# Top emails", "1. **Joshua** - Paypal refund", "   - deposited $500", "   - account restricted", "2. **Alberto** - payout error", "   - PayPal error"].join("\n"));
	expect(tree.map((b) => [b.style, b.text])).toEqual([
		[STYLE.h1, "Top emails"],
		[STYLE.numbered, "Joshua - Paypal refund"],
		[STYLE.numbered, "Alberto - payout error"],
	]);
	// Numbered items are siblings again - the details live under each one.
	expect(tree[1].children.map((c) => [c.style, c.text])).toEqual([
		[STYLE.bullet, "deposited $500"],
		[STYLE.bullet, "account restricted"],
	]);
	expect(tree[2].children).toHaveLength(1);
});

test("nesting follows indentation at any depth, and a heading ends it", () => {
	const tree = mdToTree(["- a", "  - b", "    - c", "  - d", "## Next", "  - e"].join("\n"));
	expect(tree.map((b) => b.text)).toEqual(["a", "Next", "e"]);
	expect(tree[0].children.map((b) => b.text)).toEqual(["b", "d"]);
	expect(tree[0].children[0].children.map((b) => b.text)).toEqual(["c"]);
});

test("inline markdown becomes marks on plain text", () => {
	const { text, marks } = inlineMarks("**Joshua Cortinas** (drako@yahoo.com) - see [ticket](https://x.co/1) and `id_42`");
	expect(text).toBe("Joshua Cortinas (drako@yahoo.com) - see ticket and id_42");
	expect(marks).toEqual([
		{ from: 0, to: 15, type: MARK.bold },
		{ from: 40, to: 46, type: MARK.link, param: "https://x.co/1" },
		{ from: 51, to: 56, type: MARK.code },
	]);
});

test("underscores inside words, emails and lone asterisks are left as text", () => {
	for (const s of ["snake_case_name", "first_last@mail.com", "5 * 3 = 15", "price*"]) {
		expect(inlineMarks(s)).toEqual({ text: s, marks: [] });
	}
	expect(inlineMarks("an _emphasised_ word").marks).toEqual([{ from: 3, to: 13, type: MARK.italic }]);
});

test("a bold link is both", () => {
	const { text, marks } = inlineMarks("**[Docs](https://d.io)**");
	expect(text).toBe("Docs");
	expect(marks.map((m) => m.type).sort()).toEqual([MARK.bold, MARK.link]);
});

test("checkboxes keep their tick; rules and blank lines add nothing", () => {
	const tree = mdToTree("- [x] done\n\n---\n- [ ] todo");
	expect(tree.map((b) => [b.style, b.text, b.checked])).toEqual([
		[STYLE.checkbox, "done", true],
		[STYLE.checkbox, "todo", false],
	]);
});
