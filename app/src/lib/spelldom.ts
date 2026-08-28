/**
 * DOM side of spellcheck: walk every text-block editable, map misspelling
 * offsets back onto text nodes, and register the Ranges as the `spell`
 * CSS custom highlight (styled with a red wavy underline; zero DOM
 * mutation).
 */

import { checkText, loadDictionary } from "$lib/spell";

const HIGHLIGHT = "spell";

interface NodeSpan {
	node: Text;
	start: number; // global offset of this node's first char
}

function textNodes(root: HTMLElement): NodeSpan[] {
	const out: NodeSpan[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let offset = 0;
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		out.push({ node: n as Text, start: offset });
		offset += (n as Text).length;
	}
	return out;
}

function rangeFor(spans: NodeSpan[], from: number, to: number): Range | null {
	let a: { node: Text; off: number } | null = null;
	let b: { node: Text; off: number } | null = null;
	for (const s of spans) {
		const end = s.start + s.node.length;
		if (!a && from >= s.start && from <= end) a = { node: s.node, off: from - s.start };
		if (to >= s.start && to <= end) b = { node: s.node, off: to - s.start };
	}
	if (!a || !b) return null;
	const r = document.createRange();
	r.setStart(a.node, a.off);
	r.setEnd(b.node, b.off);
	return r;
}

/** Recompute the spell highlight for every editable under `root`. */
export async function refreshSpell(root: HTMLElement): Promise<void> {
	if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
	await loadDictionary();
	const ranges: Range[] = [];
	for (const el of root.querySelectorAll<HTMLElement>("[contenteditable]")) {
		const spans = textNodes(el);
		const text = spans.map((s) => s.node.data).join("");
		for (const miss of checkText(text)) {
			const r = rangeFor(spans, miss.from, miss.to);
			if (r) ranges.push(r);
		}
	}
	CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
}

/** The misspelled word at a screen point, or null. */
export function misspelledAt(x: number, y: number): { word: string; el: HTMLElement } | null {
	const caret = document.caretRangeFromPoint?.(x, y);
	if (!caret) return null;
	const node = caret.startContainer;
	if (node.nodeType !== Node.TEXT_NODE) return null;
	const el = (node.parentElement as HTMLElement)?.closest<HTMLElement>("[contenteditable]");
	if (!el) return null;
	const spans = textNodes(el);
	const span = spans.find((s) => s.node === node);
	if (!span) return null;
	const global = span.start + caret.startOffset;
	const text = spans.map((s) => s.node.data).join("");
	for (const miss of checkText(text)) {
		if (global >= miss.from && global <= miss.to) return { word: miss.word, el };
	}
	return null;
}
