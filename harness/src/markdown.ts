/**
 * Markdown an agent writes → body blocks the editor renders.
 *
 * Agents write markdown whatever the prompt says, so the tool reads it
 * instead of the prompt forbidding it: one block per line (checkboxes,
 * bullets, numbered items, headings, quotes, paragraphs), indentation
 * nests a line under the one above it, and inline `**bold**`, `*italic*`,
 * `~~strike~~`, `` `code` `` and `[text](url)` become real marks. Before
 * this, sub-bullets landed flat between numbered items (so every item read
 * "1.") and `**` showed as literal asterisks.
 */

import { mutate } from "./api";

/** proto TextStyle values the editor renders. */
export const STYLE = { paragraph: 0, h1: 1, h2: 2, h3: 3, quote: 4, bullet: 6, numbered: 7, checkbox: 8 } as const;
/** glon.MarkType values. */
export const MARK = { bold: 0, italic: 1, strike: 2, code: 4, link: 5 } as const;

export interface Mark {
	from: number;
	to: number;
	type: number;
	param?: string;
}

export interface MdBlock {
	text: string;
	style: number;
	checked?: boolean;
	marks: Mark[];
	children: MdBlock[];
}

/**
 * Inline markdown → plain text + marks. One pass, left to right; a span's
 * inside is parsed again, so `**[x](u)**` is a bold link. `_x_` counts only
 * between non-word characters, so snake_case and emails are left alone.
 */
export function inlineMarks(src: string): { text: string; marks: Mark[] } {
	const TOKEN = /\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/g;
	let text = "";
	const marks: Mark[] = [];
	let last = 0;
	for (const m of src.matchAll(TOKEN)) {
		text += src.slice(last, m.index);
		last = m.index! + m[0].length;
		const [, bold1, bold2, strike, code, linkText, url, ital1, ital2] = m;
		if (code !== undefined) {
			marks.push({ from: text.length, to: text.length + code.length, type: MARK.code });
			text += code;
			continue;
		}
		const inner = bold1 ?? bold2 ?? strike ?? linkText ?? ital1 ?? ital2 ?? "";
		const nested = inlineMarks(inner);
		const from = text.length;
		for (const n of nested.marks) marks.push({ ...n, from: n.from + from, to: n.to + from });
		text += nested.text;
		const type = bold1 !== undefined || bold2 !== undefined ? MARK.bold : strike !== undefined ? MARK.strike : linkText !== undefined ? MARK.link : MARK.italic;
		marks.push({ from, to: text.length, type, ...(type === MARK.link ? { param: url } : {}) });
	}
	text += src.slice(last);
	return { text, marks: marks.filter((k) => k.to > k.from).sort((a, b) => a.from - b.from || a.type - b.type) };
}

/** One line's block style and content, prefix removed. */
function lineBlock(body: string): Omit<MdBlock, "children" | "marks"> & { raw: string } {
	let m: RegExpMatchArray | null;
	if ((m = body.match(/^[-*+] \[([ xX])\] (.*)$/))) return { style: STYLE.checkbox, checked: m[1] !== " ", raw: m[2], text: "" };
	if ((m = body.match(/^[-*+] (.*)$/))) return { style: STYLE.bullet, raw: m[1], text: "" };
	if ((m = body.match(/^\d+[.)] (.*)$/))) return { style: STYLE.numbered, raw: m[1], text: "" };
	if ((m = body.match(/^(#{1,3}) (.*)$/))) return { style: m[1].length, raw: m[2], text: "" };
	if ((m = body.match(/^> ?(.*)$/))) return { style: STYLE.quote, raw: m[1], text: "" };
	return { style: STYLE.paragraph, raw: body, text: "" };
}

const isHeading = (style: number): boolean => style >= STYLE.h1 && style <= STYLE.h3;

/** Leading whitespace as columns (a tab is 4). */
const indentOf = (line: string): number => {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n += 1;
		else if (ch === "\t") n += 4;
		else break;
	}
	return n;
};

/**
 * Markdown lines → a block tree. A line indented deeper than the line
 * above nests under it (any depth); blank lines and `---` rules add
 * nothing. A heading never takes children - it's a section, not a parent.
 */
export function mdToTree(markdown: string): MdBlock[] {
	const roots: MdBlock[] = [];
	const stack: Array<{ indent: number; block: MdBlock }> = [];
	for (const raw of markdown.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
		const indent = indentOf(line);
		const parsed = lineBlock(line.trim());
		const { text, marks } = inlineMarks(parsed.raw);
		const block: MdBlock = { text, style: parsed.style, marks, children: [], ...(parsed.style === STYLE.checkbox ? { checked: parsed.checked } : {}) };
		if (isHeading(block.style)) {
			// A heading starts a new section: nothing nests under it or across it.
			stack.length = 0;
			roots.push(block);
			continue;
		}
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
		const parent = stack[stack.length - 1]?.block;
		if (parent) parent.children.push(block);
		else roots.push(block);
		stack.push({ indent, block });
	}
	return roots;
}

/** glon.Position.Inner: a block added as the target's last child. */
const POSITION_INNER = 5;

/**
 * Markdown appended to an object's body as the blocks the editor renders,
 * at the page root or inside `parentId` (as its last children). Parents are
 * written before their children. Returns how many blocks were added.
 */
export async function appendMarkdown(objectId: string, markdown: string, parentId = ""): Promise<number> {
	let added = 0;
	const add = async (blocks: MdBlock[], parent: string): Promise<void> => {
		for (const b of blocks) {
			const id = crypto.randomUUID();
			const content = { text: { text: b.text, style: b.style, ...(b.marks.length ? { marks: b.marks } : {}), ...(b.style === STYLE.checkbox ? { checked: b.checked === true } : {}) } };
			await mutate("block_add", { object_id: objectId, block: { id, childrenIds: [], content }, ...(parent ? { target_id: parent, position: POSITION_INNER } : {}) });
			added += 1;
			await add(b.children, id);
		}
	};
	await add(mdToTree(markdown), parentId);
	return added;
}
