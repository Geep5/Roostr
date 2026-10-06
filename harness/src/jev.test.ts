import { expect, test } from "bun:test";
import { parseQuestion, verdictOf } from "./jev";

test("a Score's numbered list becomes its levels, lowest first, and the paragraphs its instructions", () => {
	const q = parseQuestion("How hostile is this email?\nCount slurs as the worst.\n1. None\n2. Rude\n3. Hateful", "score");
	expect(q).toEqual({ type: "score", instructions: "How hostile is this email?\nCount slurs as the worst.", criteria: ["None", "Rude", "Hateful"] });
});

test("a Choice's bullets are options; 'Name: meaning' splits, a bare name has no meaning, checkboxes are not options", () => {
	const q = parseQuestion("What is it about?\n- Payout: money not arriving\n- Login - can't sign in\n- Other\n- [ ] not an option", "choice");
	expect(q).toEqual({
		type: "choice",
		instructions: "What is it about?\n- [ ] not an option",
		criteria: { Payout: "money not arriving", Login: "can't sign in", Other: null },
	});
});

test("Yes/No reads Yes:/No: lines as criteria and asks without them when absent", () => {
	expect(parseQuestion("Does it contain a slur?\nYes: any slur, even quoted\nno - none at all", "yes_no")).toEqual({
		type: "noul",
		instructions: "Does it contain a slur?",
		criteria: { true: "any slur, even quoted", false: "none at all" },
	});
	expect(parseQuestion("Does it contain a slur?", "yes_no")).toEqual({ type: "noul", instructions: "Does it contain a slur?" });
});

test("a page that can't be a question says what's missing", () => {
	expect(() => parseQuestion("1. None\n2. Rude", "score")).toThrow("no question");
	expect(() => parseQuestion("How bad?\n1. Only one", "score")).toThrow("2 to 10 levels");
	expect(() => parseQuestion(`How bad?\n${Array.from({ length: 11 }, (_, i) => `${i + 1}. L${i}`).join("\n")}`, "score")).toThrow("at most 10");
	expect(() => parseQuestion("Which?\n- A", "choice")).toThrow("at least 2 options");
	expect(() => parseQuestion("Which?\n- A\n- A: again", "choice")).toThrow('"A" is listed twice');
});

test("a Score answer lands on the page's numbering (Jev counts from 0, the list from 1)", () => {
	const v = verdictOf({ type: "score", score: 1.04, confidence: 0.9, legend: { "0": "None", "1": "Rude: impatient", "2": "Hateful" } });
	expect(v.value).toEqual({ floatValue: 2 });
	expect(v.text).toBe("2 of 3 (Rude)");
	expect(v.confidence).toBe(0.9);
});

test("Yes/No is ticked from 50% up and keeps the probability, not a confidence", () => {
	expect(verdictOf({ type: "noul", noul: 0.5 })).toEqual({ value: { boolValue: true }, text: "yes", probability: 0.5 });
	expect(verdictOf({ type: "noul", noul: 0.49 }).value).toEqual({ boolValue: false });
});
