/**
 * Basic English spellcheck over the editor's text blocks.
 *
 * Dictionary: the BSD `web2` word list (235k headwords) served as a static
 * asset and loaded lazily into a Set, plus light suffix stripping so
 * ordinary inflections (notes, edited, running, quickly) of known
 * headwords pass. A user ignore list ("Add to dictionary") persists in
 * localStorage and syncs into the same lookup.
 *
 * Rendering uses the CSS Custom Highlight API: misspelled words become
 * Ranges registered under the `spell` highlight - no DOM mutation, so the
 * marks engine and caret handling stay untouched.
 */

let dict: Set<string> | null = null;

/**
 * web2 is a headword list - common inflections and contractions are
 * missing (it has "have" but not "has", "say" but not "says").
 */
const SUPPLEMENT = [
	"has", "says", "did", "done", "gone", "went", "been", "am", "are", "were",
	"cannot", "ok", "okay", "email", "emails", "todo", "todos", "app", "apps",
	"don't", "doesn't", "isn't", "aren't", "wasn't", "weren't", "can't", "won't",
	"wouldn't", "couldn't", "shouldn't", "didn't", "hasn't", "haven't", "hadn't",
	"it's", "that's", "there's", "here's", "what's", "who's", "let's", "i'm",
	"i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd", "we're",
	"we've", "we'll", "we'd", "they're", "they've", "they'll", "they'd",
	"he's", "she's", "ain't", "y'all", "o'clock",
];
let loading: Promise<void> | null = null;

const IGNORE_KEY = "spell-ignore";

function ignoreSet(): Set<string> {
	try {
		return new Set(JSON.parse(localStorage.getItem(IGNORE_KEY) ?? "[]") as string[]);
	} catch {
		return new Set();
	}
}

export function ignoredWords(): string[] {
	return [...ignoreSet()].sort();
}

export function addToDictionary(word: string): void {
	const s = ignoreSet();
	s.add(word.toLowerCase());
	localStorage.setItem(IGNORE_KEY, JSON.stringify([...s]));
}

export function removeFromDictionary(word: string): void {
	const s = ignoreSet();
	s.delete(word.toLowerCase());
	localStorage.setItem(IGNORE_KEY, JSON.stringify([...s]));
}

export function loadDictionary(): Promise<void> {
	if (dict) return Promise.resolve();
	loading ??= fetch("/dict-en.txt")
		.then((r) => r.text())
		.then((text) => {
			const s = new Set<string>();
			for (const line of text.split("\n")) {
				const w = line.trim();
				if (w) s.add(w.toLowerCase());
			}
			for (const w of SUPPLEMENT) s.add(w);
			dict = s;
		})
		.catch(() => {
			dict = new Set(); // asset missing: never flag anything
		});
	return loading;
}

function inDict(w: string): boolean {
	return dict?.has(w) ?? true;
}

/** Known word? Checks the base plus common inflection strips. */
export function isKnown(word: string): boolean {
	if (!dict) return true; // not loaded yet - stay quiet
	const w = word.toLowerCase();
	if (w.length <= 1) return true;
	if (ignoreSet().has(w)) return true;
	if (inDict(w)) return true;
	// possessives and contractions
	if (w.endsWith("'s") && inDict(w.slice(0, -2))) return true;
	const strips: Array<[string, string]> = [
		["ies", "y"],
		["es", ""],
		["s", ""],
		["ed", ""],
		["ed", "e"],
		["d", ""],
		["ing", ""],
		["ing", "e"],
		["ly", ""],
		["er", ""],
		["er", "e"],
		["est", ""],
		["est", "e"],
	];
	for (const [suf, add] of strips) {
		if (w.length > suf.length + 1 && w.endsWith(suf) && inDict(w.slice(0, -suf.length) + add)) return true;
	}
	return false;
}

export interface Misspelling {
	from: number;
	to: number;
	word: string;
}

const TOKEN = /[A-Za-z][A-Za-z']*/g;

/** Misspelled tokens in a text. Skips ALLCAPS, digits-adjacent, URLs. */
export function checkText(text: string): Misspelling[] {
	if (!dict) return [];
	const out: Misspelling[] = [];
	for (const m of text.matchAll(TOKEN)) {
		const word = m[0].replace(/'+$/, "");
		if (word.length <= 1) continue;
		if (word === word.toUpperCase() && word.length > 1) continue; // acronyms
		const at = m.index;
		// inside a URL/path/email? look back for schemes or separators
		const before = text.slice(Math.max(0, at - 8), at);
		if (/[/@.\\-]$/.test(before) || /https?:$/.test(before)) continue;
		if (!isKnown(word)) out.push({ from: at, to: at + word.length, word });
	}
	return out;
}
