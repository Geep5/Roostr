/**
 * Ranged-mark algebra for text blocks.
 *
 * Model: text + marks[{from, to, type, param}] over [from, to) ranges.
 * Rendering splits text into runs at mark boundaries; each run becomes
 * a <span data-marks="..."> so contenteditable edits preserve
 * formatting, and the DOM can be parsed back into text + marks.
 */

import type { MarkJSON } from "$lib/types";

export interface Run {
	text: string;
	/** mark type → param */
	marks: Map<number, string>;
}

/** Split text+marks into contiguous runs with uniform mark sets. */
export function toRuns(text: string, marks: MarkJSON[]): Run[] {
	if (text.length === 0) return [];
	const cuts = new Set<number>([0, text.length]);
	for (const m of marks) {
		cuts.add(Math.max(0, Math.min(m.from, text.length)));
		cuts.add(Math.max(0, Math.min(m.to, text.length)));
	}
	const points = [...cuts].sort((a, b) => a - b);
	const runs: Run[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const [a, b] = [points[i], points[i + 1]];
		if (a >= b) continue;
		const set = new Map<number, string>();
		for (const m of marks) {
			if (m.from <= a && m.to >= b) set.set(m.type, m.param ?? "");
		}
		runs.push({ text: text.slice(a, b), marks: set });
	}
	return runs;
}

const CLASS_BY_MARK: Record<number, string> = {
	0: "m-bold",
	1: "m-italic",
	2: "m-strike",
	3: "m-underline",
	4: "m-code",
	5: "m-link",
	6: "m-color",
	7: "m-bg",
};

function escapeHtml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Render text+marks to innerHTML for a contenteditable block. */
export function toHtml(text: string, marks: MarkJSON[]): string {
	if (text.length === 0) return "";
	const runs = toRuns(text, marks);
	return runs
		.map((r) => {
			const esc = escapeHtml(r.text);
			if (r.marks.size === 0) return esc;
			const classes: string[] = [];
			const attrs: string[] = [];
			const serialized: string[] = [];
			for (const [type, param] of r.marks) {
				classes.push(CLASS_BY_MARK[type] ?? `m-${type}`);
				serialized.push(param ? `${type}:${encodeURIComponent(param)}` : String(type));
				if (type === 6 && param) attrs.push(`style="color:${param}"`);
				if (type === 7 && param) attrs.push(`style="background:${param}"`);
				if (type === 5 && param) attrs.push(`title="${escapeHtml(param)}"`);
			}
			return `<span class="${classes.join(" ")}" data-marks="${serialized.join(",")}" ${attrs.join(" ")}>${esc}</span>`;
		})
		.join("");
}

/** Parse a contenteditable block's DOM back into text + marks. */
export function fromDom(el: HTMLElement): { text: string; marks: MarkJSON[] } {
	let text = "";
	const marks: MarkJSON[] = [];
	const open = new Map<string, { from: number; type: number; param?: string }>();

	const flushAt = (pos: number, active: Map<number, string | undefined>) => {
		// Close marks no longer active, open new ones.
		for (const [key, m] of open) {
			const [t] = key.split(":");
			if (!active.has(Number(t))) {
				if (pos > m.from) marks.push({ from: m.from, to: pos, type: m.type, param: m.param });
				open.delete(key);
			}
		}
		for (const [type, param] of active) {
			const key = `${type}:${param ?? ""}`;
			if (!open.has(key)) open.set(key, { from: pos, type, param });
		}
	};

	const walk = (node: Node, active: Map<number, string | undefined>) => {
		if (node.nodeType === Node.TEXT_NODE) {
			flushAt(text.length, active);
			text += node.textContent ?? "";
			return;
		}
		if (!(node instanceof HTMLElement)) return;
		if (node.tagName === "BR") return;
		const next = new Map(active);
		const dm = node.dataset?.marks;
		if (dm) {
			for (const part of dm.split(",")) {
				const [t, p] = part.split(":");
				if (t !== "") next.set(Number(t), p ? decodeURIComponent(p) : undefined);
			}
		}
		for (const child of node.childNodes) walk(child, next);
	};

	for (const child of el.childNodes) walk(child, new Map());
	flushAt(text.length, new Map());
	return { text, marks: mergeAdjacent(marks) };
}

function mergeAdjacent(marks: MarkJSON[]): MarkJSON[] {
	const sorted = [...marks].sort((a, b) => a.type - b.type || a.from - b.from);
	const out: MarkJSON[] = [];
	for (const m of sorted) {
		const last = out[out.length - 1];
		if (last && last.type === m.type && last.param === m.param && last.to >= m.from) {
			last.to = Math.max(last.to, m.to);
		} else {
			out.push({ ...m });
		}
	}
	return out;
}

/**
 * Toggle a mark over [from, to): if the whole range already carries it,
 * remove it there; otherwise apply it. Returns a new marks array.
 */
export function toggleMark(marks: MarkJSON[], from: number, to: number, type: number, param?: string): MarkJSON[] {
	if (from >= to) return marks;
	const others = marks.filter((m) => m.type !== type);
	const same = marks.filter((m) => m.type === type);

	const covered = (() => {
		let pos = from;
		for (const m of [...same].sort((a, b) => a.from - b.from)) {
			if (m.from > pos) return false;
			pos = Math.max(pos, m.to);
			if (pos >= to) return true;
		}
		return pos >= to;
	})();

	const result: MarkJSON[] = [];
	if (covered) {
		// Subtract [from, to) from every same-type mark.
		for (const m of same) {
			if (m.to <= from || m.from >= to) {
				result.push(m);
				continue;
			}
			if (m.from < from) result.push({ ...m, to: from });
			if (m.to > to) result.push({ ...m, from: to });
		}
	} else {
		result.push(...same, { from, to, type, param });
	}
	return mergeAdjacent([...others, ...result]);
}

/** Selection offsets of a (collapsed or ranged) selection within a block element. */
export function selectionOffsets(el: HTMLElement): { from: number; to: number } | null {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0) return null;
	const range = sel.getRangeAt(0);
	if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
	const offsetOf = (container: Node, offset: number): number => {
		let pos = 0;
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		let n: Node | null = walker.nextNode();
		while (n) {
			if (n === container) return pos + offset;
			pos += n.textContent?.length ?? 0;
			n = walker.nextNode();
		}
		// Element-container selection (e.g. empty block).
		return container === el ? pos : pos;
	};
	const from = offsetOf(range.startContainer, range.startOffset);
	const to = offsetOf(range.endContainer, range.endOffset);
	return from <= to ? { from, to } : { from: to, to: from };
}

/** Place the caret at a character offset inside a block element. */
export function setCaret(el: HTMLElement, offset: number): void {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let pos = 0;
	let n: Node | null = walker.nextNode();
	while (n) {
		const len = n.textContent?.length ?? 0;
		if (pos + len >= offset) {
			const range = document.createRange();
			range.setStart(n, offset - pos);
			range.collapse(true);
			const sel = window.getSelection();
			sel?.removeAllRanges();
			sel?.addRange(range);
			return;
		}
		pos += len;
		n = walker.nextNode();
	}
	// Empty or offset beyond end: caret at element end.
	const range = document.createRange();
	range.selectNodeContents(el);
	range.collapse(false);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);
}
