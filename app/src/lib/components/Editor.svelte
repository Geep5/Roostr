<script lang="ts">
	import type { ObjectJSON, BlockJSON, MarkJSON } from "$lib/types";
	import { Pos, Style, MarkT, Layout } from "$lib/types";
	import { note, table, fetchObject } from "$lib/api";
	import { fromDom, selectionOffsets, setCaret, toggleMark, toHtml } from "$lib/marks";
	import { isToggleOpen, setToggleOpen } from "$lib/toggles";
	import { refreshSpell, misspelledAt } from "$lib/spelldom";
	import { addToDictionary } from "$lib/spell";
	import BlockNode from "./BlockNode.svelte";
	import BlockMenu from "./BlockMenu.svelte";
	import type { MenuAction } from "./BlockMenu.svelte";
	import SlashMenu, { type SlashPick } from "./SlashMenu.svelte";
	import PropertySuggest from "./PropertySuggest.svelte";
	import LinkPicker from "./LinkPicker.svelte";
	import { store } from "$lib/data.svelte";
	import { RESERVED_KEYS, emptyValueFor } from "$lib/relations";
	import type { RelationDefJSON } from "$lib/types";
	import { getProcessorByUrl, getEmbedUrl, isSingleUrl, type EmbedProcessor } from "$lib/embed";

	let { object, onchanged }: { object: ObjectJSON; onchanged: () => Promise<void> } = $props();

	const byId = $derived(new Map(object.blocks.map((b) => [b.id, b])));
	const rootIds = $derived.by(() => {
		const referenced = new Set<string>();
		for (const b of object.blocks) for (const c of b.childrenIds) referenced.add(c);
		return object.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__content__" && b.id !== "__discussion__").map((b) => b.id);
	});

	/** Text blocks in document order, for prev/next navigation and merge. */
	const flatText = $derived.by(() => {
		const out: string[] = [];
		const visit = (id: string) => {
			const b = byId.get(id);
			if (!b) return;
			if (b.content.text) out.push(id);
			for (const c of b.childrenIds) visit(c);
		};
		for (const id of rootIds) visit(id);
		return out;
	});

	// ── Editing state ─────────────────────────────────────────────
	let draggingId = $state("");
	let focusRequest = $state<{ blockId: string; offset: number } | null>(null);

	/** Move the caret as soon as the element exists. A single rAF loses the
	 *  race when render straddles frames - the caret then silently stays in
	 *  the OLD block and keystrokes land one line above where the user is
	 *  looking. Retries across frames until focus verifiably lands. */
	function focusNow(blockId: string, offset: number) {
		let tries = 0;
		const attempt = () => {
			const el = blockEl(blockId);
			if (el && el.isConnected && el.dataset.ready === "1") {
				el.focus();
				setCaret(el, offset);
				if (document.activeElement === el) return;
			}
			if (++tries < 24) requestAnimationFrame(attempt);
		};
		requestAnimationFrame(attempt);
	}

	// ── Spellcheck (basic English dictionary + ignore list) ─────────
	let spellTimer: ReturnType<typeof setTimeout> | undefined;
	let spellMenu = $state<{ word: string; x: number; y: number } | null>(null);

	function scheduleSpell() {
		clearTimeout(spellTimer);
		spellTimer = setTimeout(() => {
			if (editorEl) void refreshSpell(editorEl);
		}, 350);
	}

	$effect(() => {
		void object.blocks;
		scheduleSpell();
	});

	function onEditorContextMenu(e: MouseEvent) {
		const hit = misspelledAt(e.clientX, e.clientY);
		if (hit) {
			e.preventDefault();
			e.stopPropagation();
			spellMenu = { word: hit.word, x: e.clientX, y: e.clientY };
			return;
		}
		// A live multi-selection owns the right-click (Anytype's provider
		// intercepts contextmenu with selected ids). Without this, the
		// indent area around nested rows belongs to an ANCESTOR's DOM, so
		// right-clicking beside a selected child anchored the menu on the
		// unselected parent toggle.
		if (selectedIds.length > 1) {
			const blockDiv = (e.target as HTMLElement).closest("[data-block]");
			const hitId = blockDiv?.getAttribute("data-block") ?? "";
			e.preventDefault();
			e.stopPropagation();
			openBlockMenu(selectedSet.has(hitId) ? hitId : selectedIds[0], e.clientX, e.clientY);
		}
	}

	// ── Multi-block selection (Anytype selection/provider.tsx) ──────
	// Rect-drag from whitespace selects colliding blocks (cmd toggles vs
	// the drag-start snapshot, alt removes); shift-click selects the
	// contiguous tree-order range from the anchor; selected blocks get the
	// translucent system-selection overlay. Backspace deletes the
	// selection, Escape/plain click clears, dragging one moves all.
	let selectedIds = $state<string[]>([]);
	const selectedSet = $derived(new Set(selectedIds));
	let selRect = $state<{ x: number; y: number; w: number; h: number } | null>(null);
	let editorEl: HTMLElement | undefined = $state();
	let lastFocused = "";
	// Anchor in scroll-container coords so the rect survives scrolling;
	// textOrigin drags defer to the native text selection until they cross
	// into a second block (Anytype selection/provider.tsx).
	let dragSel: {
		ax: number;
		ay: number;
		base: string[];
		mode: "replace" | "toggle" | "remove";
		moved: boolean;
		textOrigin: boolean;
		lastX: number;
		lastY: number;
		scroller: Element;
	} | null = null;
	let autoScrollTimer: ReturnType<typeof setInterval> | undefined;

	/** Blocks in document order (tree DFS), Anytype's getTreeList. */
	const flatIds = $derived.by(() => {
		const out: string[] = [];
		const walk = (id: string) => {
			const b = byId.get(id);
			if (!b) return;
			out.push(id);
			for (const c of b.childrenIds) walk(c);
		};
		for (const id of rootIds) walk(id);
		return out;
	});

	/** Ids from `set` whose ancestors are NOT in it (subtrees act whole). */
	function topmostOf(set: Set<string>): string[] {
		const parentOf = new Map<string, string>();
		for (const b of object.blocks) for (const c of b.childrenIds) parentOf.set(c, b.id);
		return flatIds.filter((id) => {
			if (!set.has(id)) return false;
			let p = parentOf.get(id);
			while (p) {
				if (set.has(p)) return false;
				p = parentOf.get(p);
			}
			return true;
		});
	}

	/** Selected ids whose ancestors are NOT selected (subtrees move whole). */
	function topmostSelected(): string[] {
		return topmostOf(selectedSet);
	}

	function toggleSelect(id: string) {
		selectedIds = selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
	}

	/** Anytype onMouseUp shift branch: range between anchor and clicked. */
	function rangeSelect(id: string) {
		const anchor = selectedIds[0] ?? lastFocused;
		const a = anchor ? flatIds.indexOf(anchor) : -1;
		const b = flatIds.indexOf(id);
		if (a === -1 || b === -1 || a === b) {
			selectedIds = [id];
			return;
		}
		selectedIds = flatIds.slice(Math.min(a, b), Math.max(a, b) + 1);
	}

	/** The element whose scrolling moves the blocks under this editor. */
	function scrollerOf(): Element {
		let el: Element | null = editorEl ?? null;
		while (el && el !== document.body) {
			const o = getComputedStyle(el).overflowY;
			if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) return el;
			el = el.parentElement;
		}
		return document.scrollingElement ?? document.documentElement;
	}

	function armDrag(e: MouseEvent, textOrigin: boolean) {
		const scroller = scrollerOf();
		dragSel = {
			ax: e.clientX + scroller.scrollLeft,
			ay: e.clientY + scroller.scrollTop,
			base: [...selectedIds],
			mode: e.metaKey || e.ctrlKey ? "toggle" : e.altKey ? "remove" : "replace",
			moved: false,
			textOrigin,
			lastX: e.clientX,
			lastY: e.clientY,
			scroller,
		};
		window.addEventListener("mousemove", selMouseMove);
		window.addEventListener("mouseup", selMouseUp);
		window.addEventListener("scroll", selOnScroll, true);
	}

	function selMouseDown(e: MouseEvent) {
		if (e.button !== 0) return;
		const t = e.target as HTMLElement;
		const blockDiv = t.closest("[data-block]");
		if (blockDiv && (e.shiftKey || e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			const id = blockDiv.getAttribute("data-block")!;
			if (e.shiftKey) rangeSelect(id);
			else toggleSelect(id);
			return;
		}
		// The drag handle is interactive but must NOT clear the selection:
		// dragging a selected block drags the whole selection, and the
		// clearing here used to collapse the group before dragstart fired.
		if (t.closest(".handle")) return;
		if (t.closest("input, textarea, select, button, a")) {
			if (blockDiv) lastFocused = blockDiv.getAttribute("data-block")!;
			selectedIds = [];
			return;
		}
		if (t.closest("[contenteditable]")) {
			if (blockDiv) lastFocused = blockDiv.getAttribute("data-block")!;
			selectedIds = [];
			// The native text drag proceeds - but if it escapes this block,
			// it converts into a block selection (Anytype cross-select).
			if (blockDiv) armDrag(e, true);
			return;
		}
		armDrag(e, false);
	}

	function selUpdate(cx: number, cy: number) {
		if (!dragSel) return;
		const ax = dragSel.ax - dragSel.scroller.scrollLeft;
		const ay = dragSel.ay - dragSel.scroller.scrollTop;
		const w = Math.abs(cx - ax);
		const h = Math.abs(cy - ay);
		// Anytype THRESHOLD: ignore only when BOTH axes are tiny, so a long
		// thin drag across one line still selects.
		if (!dragSel.moved && w < 20 && h < 20) return;
		const x = Math.min(ax, cx);
		const y = Math.min(ay, cy);
		const hits: string[] = [];
		if (editorEl) {
			for (const el of editorEl.querySelectorAll("[data-block]")) {
				// Each [data-block] is the block's OWN row - children live in a
				// sibling .nested wrapper (Anytype's selectionTarget shape).
				const r = el.getBoundingClientRect();
				if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) {
					hits.push(el.getAttribute("data-block")!);
				}
			}
		}
		if (dragSel.textOrigin && !dragSel.moved) {
			// Native selection owns the drag until a second block is hit.
			if (hits.length < 2) return;
			window.getSelection()?.removeAllRanges();
			(document.activeElement as HTMLElement | null)?.blur?.();
		}
		dragSel.moved = true;
		if (!dragSel.textOrigin) window.getSelection()?.removeAllRanges();
		selRect = { x, y, w, h };
		if (dragSel.mode === "toggle") {
			const base = new Set(dragSel.base);
			selectedIds = [...dragSel.base.filter((i) => !hits.includes(i)), ...hits.filter((i) => !base.has(i))];
		} else if (dragSel.mode === "remove") {
			selectedIds = dragSel.base.filter((i) => !hits.includes(i));
		} else {
			selectedIds = hits;
		}
	}

	function selMouseMove(e: MouseEvent) {
		if (!dragSel) return;
		dragSel.lastX = e.clientX;
		dragSel.lastY = e.clientY;
		selUpdate(e.clientX, e.clientY);
		if (dragSel.moved && autoScrollTimer === undefined) {
			// Edge autoscroll: pointer parked near an edge keeps scrolling,
			// and the scroll event re-runs the hit test (Anytype scrollOnMove).
			autoScrollTimer = setInterval(() => {
				if (!dragSel?.moved) return;
				const B = 48;
				const y = dragSel.lastY;
				const el = dragSel.scroller;
				if (y < B) el.scrollTop -= Math.min(12, Math.ceil((B - y) / 6));
				else if (y > window.innerHeight - B) el.scrollTop += Math.min(12, Math.ceil((y - (window.innerHeight - B)) / 6));
			}, 50);
		}
	}

	function selOnScroll() {
		if (dragSel) selUpdate(dragSel.lastX, dragSel.lastY);
	}

	function selMouseUp() {
		if (dragSel && !dragSel.moved && dragSel.mode === "replace" && !dragSel.textOrigin) selectedIds = [];
		dragSel = null;
		selRect = null;
		if (autoScrollTimer !== undefined) {
			clearInterval(autoScrollTimer);
			autoScrollTimer = undefined;
		}
		window.removeEventListener("mousemove", selMouseMove);
		window.removeEventListener("mouseup", selMouseUp);
		window.removeEventListener("scroll", selOnScroll, true);
	}

	/** Arm from the page margins around the editor (Anytype's provider wraps
	 *  the whole window, so margin drags select too). */
	function marginMouseDown(e: MouseEvent) {
		if (e.button !== 0 || !editorEl || dragSel) return;
		const t = e.target as HTMLElement;
		if (editorEl.contains(t)) return; // the editor's own handler owns this
		// The page margins live in the content column around the article
		// (.main-col desktop / .m-main mobile), not in the article itself -
		// Anytype's provider wraps the whole window, this is our analog.
		const scopes = [editorEl.closest(".main-col"), editorEl.closest(".m-main"), editorEl.closest("article")];
		if (!scopes.some((sc) => sc?.contains(t))) return;
		if (t.closest("input, textarea, select, button, a, [contenteditable], [role='dialog'], .block-menu, .flyout, .toolbar, .spell-menu")) return;
		armDrag(e, false);
	}

	async function onWindowKeydown(e: KeyboardEvent) {
		if (!selectedIds.length) return;
		if (e.key === "Escape") {
			selectedIds = [];
			return;
		}
		// Anytype: an active block selection owns Backspace/Delete outright —
		// selection and text focus are mutually exclusive (selecting blurs).
		if (e.key === "Backspace" || e.key === "Delete") {
			e.preventDefault();
			const tops = topmostSelected();
			selectedIds = [];
			lastLocalEdit = Date.now();
			for (const id of tops) {
				cancelPending(id);
				await note.blockRemove(object.id, id);
			}
			await refresh();
		}
	}

	// Selecting clears text focus (Anytype's selection provider clears the
	// focus state on select) — otherwise the focused block eats keystrokes.
	$effect(() => {
		if (selectedIds.length === 0) return;
		const ae = document.activeElement as HTMLElement | null;
		if (ae && (ae.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName))) ae.blur();
	});
	let toolbar = $state<{ blockId: string; from: number; to: number; x: number; y: number } | null>(null);
	/** Slash menu: block, offset of the "/", live filter, caret anchor. */
	let slash = $state<{ blockId: string; start: number; filter: string; x: number; y: number } | null>(null);
	let slashMenu: { move: (d: number) => void; confirm: () => void } | undefined = $state();
	/** Object's present, non-hidden properties for the slash section. */
	const presentRelations = $derived(store.relations.filter((r) => !r.hidden && !RESERVED_KEYS[r.key] && r.key in object.fields));

	/** Property-suggest popover opened from slash "Add property". */
	let propertySuggest = $state<{ blockId: string; x: number; y: number } | null>(null);

	/** "Paste as" menu (Anytype editor/page.tsx onPasteUrl). */
	let pasteMenu = $state<{ blockId: string; url: string; processor: EmbedProcessor | null; x: number; y: number; at: number } | null>(null);
	const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
	let lastLocalEdit = $state(0);

	export function lastEditAt(): number {
		return lastLocalEdit;
	}

	const blockEl = (id: string): HTMLElement | null => document.querySelector(`[data-block="${id}"] .text`);

	async function refresh() {
		// Persist every pending edit BEFORE re-rendering from server state —
		// otherwise a refresh triggered by one block's mutation clobbers
		// another block's unflushed typing.
		for (const id of [...dirty]) await flushSave(id);
		await onchanged();
		void syncLinksField();
		if (focusRequest) {
			const req = focusRequest;
			focusRequest = null;
			focusNow(req.blockId, req.offset);
		}
	}

	// ── Object link blocks (Anytype BlockType.Link) ─────────────────
	let linkPicker = $state<{ blockId: string; x: number; y: number } | null>(null);

	/** Create the link block: replace the empty slash block, else below. */
	async function insertLinkBlock(blockId: string, targetId: string) {
		linkPicker = null;
		const cur = byId.get(blockId)?.content.text;
		const empty = (cur?.text ?? "") === "";
		lastLocalEdit = Date.now();
		const block = { id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: "link", meta: { target: targetId } } } };
		await note.blockAdd(object.id, block, blockId, empty ? Pos.REPLACE : Pos.BOTTOM);
		await refresh();
	}

	/**
	 * Anytype derives the `links` relation from link blocks (anytype-heart),
	 * which feeds backlinks and the graph. Our analog: mirror the object's
	 * link blocks into a hidden `links` field of linkValue items. Runs on
	 * every refresh; writes only when the target set actually changed.
	 */
	async function syncLinksField() {
		const targets = [...new Set(object.blocks.filter((b) => b.content.custom?.contentType === "link").map((b) => b.content.custom!.meta?.target ?? "").filter(Boolean))];
		const current = (object.fields["links"]?.valuesValue?.items ?? []).map((i) => i.linkValue?.targetId ?? "").filter(Boolean);
		if (targets.length === current.length && targets.every((t, i) => t === current[i])) return;
		await note.setField(object.id, "links", { valuesValue: { items: targets.map((t) => ({ linkValue: { targetId: t, relationKey: "links" } })) } });
	}

	function readBlock(id: string): { text: string; marks: ReturnType<typeof fromDom>["marks"] } {
		const el = blockEl(id);
		if (!el) return { text: "", marks: [] };
		return fromDom(el);
	}

	function contentFor(id: string, text: string, marks: ReturnType<typeof fromDom>["marks"]): BlockJSON["content"] {
		const cur = byId.get(id)?.content.text;
		return { text: { text, style: cur?.style ?? Style.PARAGRAPH, marks, checked: cur?.checked ?? false, color: cur?.color ?? "" } };
	}

	/** Blocks with unsaved user input. Saves ONLY fire for dirty blocks —
	 * blur/re-render races must never persist a DOM read the user didn't type. */
	const dirty = new Set<string>();

	/** Supersede any pending debounced save (structural mutations write their own truth). */
	function cancelPending(id: string) {
		clearTimeout(saveTimers.get(id));
		saveTimers.delete(id);
		dirty.delete(id);
	}

	function scheduleSave(id: string) {
		lastLocalEdit = Date.now();
		dirty.add(id);
		clearTimeout(saveTimers.get(id));
		saveTimers.set(
			id,
			setTimeout(() => void flushSave(id), 600),
		);
	}

	async function flushSave(id: string) {
		if (!dirty.has(id)) return;
		clearTimeout(saveTimers.get(id));
		saveTimers.delete(id);
		const el = blockEl(id);
		if (!el || !byId.has(id)) return;
		dirty.delete(id);
		// Element recreated but not yet populated → its content is not the
		// user's; reading it back would persist "" (poison save).
		if (el.dataset.ready !== "1") return;
		const { text, marks } = fromDom(el);
		const cur = byId.get(id)!.content.text;
		if (cur && cur.text === text && JSON.stringify(cur.marks ?? []) === JSON.stringify(marks)) return;
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, contentFor(id, text, marks));
	}

	// ── Keyboard ──────────────────────────────────────────────────
	async function onKeydown(e: KeyboardEvent, id: string) {
		const el = blockEl(id);
		if (!el) return;

		// While the slash menu is open it owns navigation keys; everything
		// else keeps typing into the block (Anytype behavior).
		if (slash && slash.blockId === id) {
			if (e.key === "ArrowDown") { e.preventDefault(); slashMenu?.move(1); return; }
			if (e.key === "ArrowUp") { e.preventDefault(); slashMenu?.move(-1); return; }
			if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); slashMenu?.confirm(); return; }
			if (e.key === "Escape") { e.preventDefault(); slash = null; return; }
		}

		if (e.key === "Enter" && !e.shiftKey) {
			// Anytype: Enter inside a code block inserts a newline, never splits
			// (Shift+Enter splits nothing anywhere - both fall through to the
			// browser's native newline insertion).
			if (byId.get(id)?.content.text?.style === Style.CODE) return;
			e.preventDefault();
			const sel = selectionOffsets(el);
			const { text, marks } = fromDom(el);
			const at = sel?.from ?? text.length;
			const curStyle = byId.get(id)?.content.text?.style ?? Style.PARAGRAPH;
			const isList = curStyle === Style.BULLET || curStyle === Style.NUMBERED || curStyle === Style.CHECKBOX;
			const isQuoteish = curStyle === Style.QUOTE || curStyle === Style.CALLOUT;

			// Anytype editor/page.tsx onEnterBlock: Enter on an EMPTY list/quote/
			// callout block exits the list — the block turns into a paragraph.
			if (text.length === 0 && (isList || isQuoteish)) {
				const curText = byId.get(id)!.content.text!;
				cancelPending(id);
				lastLocalEdit = Date.now();
				await note.blockUpdate(object.id, id, { text: { ...curText, text: "", marks: [], style: Style.PARAGRAPH, checked: false } });
				focusRequest = { blockId: id, offset: 0 };
				await refresh();
				return;
			}

			// Anytype onEnterBlock canToggle rules: Enter at the end of an OPEN
			// toggle creates the first INNER child; a closed toggle gets a
			// plain sibling below (the default split handles that).
			if (curStyle === Style.TOGGLE && isToggleOpen(object.id, id) && at === text.length) {
				const innerId = crypto.randomUUID();
				cancelPending(id);
				lastLocalEdit = Date.now();
				// Optimistic: state + caret move NOW, the write catches up -
				// otherwise everything typed during the round trip lands in
				// the old block (Anytype applies model-side first too).
				const inner: BlockJSON = { id: innerId, childrenIds: [], content: { text: { text: "", style: Style.PARAGRAPH } } };
				object.blocks.push(inner);
				byId.get(id)!.childrenIds.unshift(innerId);
				focusNow(innerId, 0);
				await note.blockAdd(object.id, { id: innerId, childrenIds: [], content: { text: { text: "", style: Style.PARAGRAPH } } }, id, Pos.INNER_FIRST);
				await refresh();
				return;
			}

			// Anytype blockSplit style rules: lists continue their style in the
			// new block; quote/callout continue only when splitting mid-text;
			// headers and everything else yield a paragraph.
			let newStyle: number = Style.PARAGRAPH;
			if (isList) newStyle = curStyle;
			else if (isQuoteish && at < text.length) newStyle = curStyle;

			const newId = crypto.randomUUID();
			cancelPending(id);
			lastLocalEdit = Date.now();

			// Cursor at start of a non-empty block: Anytype splits mode=Top — an
			// empty block appears above, the current block keeps its text/style
			// (checkboxes spawn a fresh unchecked checkbox, others a paragraph).
			if (at === 0 && text.length > 0) {
				const aboveStyle = curStyle === Style.CHECKBOX ? Style.CHECKBOX : Style.PARAGRAPH;
				await note.blockAdd(object.id, { id: newId, childrenIds: [], content: { text: { text: "", style: aboveStyle } } }, id, Pos.TOP);
				focusRequest = { blockId: id, offset: 0 };
				await refresh();
				return;
			}

			const headMarks = marks.filter((m) => m.from < at).map((m) => ({ ...m, to: Math.min(m.to, at) }));
			const tailMarks = marks.filter((m) => m.to > at).map((m) => ({ ...m, from: Math.max(0, m.from - at), to: m.to - at }));
			const tail: BlockJSON = { id: newId, childrenIds: [], content: { text: { text: text.slice(at), style: newStyle, marks: tailMarks } } };
			// Optimistic: split the state and move the caret SYNCHRONOUSLY -
			// the daemon round trip used to own the caret, so keystrokes
			// typed right after Enter landed in the old line ("first items" /
			// "econd"). Writes follow; refresh reconciles the same ids.
			const cur = byId.get(id)!;
			if (cur.content.text) {
				cur.content.text.text = text.slice(0, at);
				cur.content.text.marks = headMarks;
			}
			if (el) el.innerHTML = toHtml(text.slice(0, at), headMarks);
			const idx = object.blocks.findIndex((b) => b.id === id);
			object.blocks.splice(idx + 1, 0, tail);
			const par = object.blocks.find((b) => b.id !== newId && b.childrenIds.includes(id));
			if (par) par.childrenIds.splice(par.childrenIds.indexOf(id) + 1, 0, newId);
			focusNow(newId, 0);
			await note.blockUpdate(object.id, id, contentFor(id, text.slice(0, at), headMarks));
			await note.blockAdd(
				object.id,
				{ id: newId, childrenIds: [], content: { text: { text: text.slice(at), style: newStyle, marks: tailMarks } } },
				id,
				Pos.BOTTOM,
			);
			await refresh();
			return;
		}

		if (e.key === "Backspace") {
			const sel = selectionOffsets(el);
			if (sel && sel.from === 0 && sel.to === 0) {
				e.preventDefault();
				const cur = byId.get(id)!;
				const curText = cur.content.text!;
				if (curText.style !== Style.PARAGRAPH) {
					// First backspace demotes style.
					const { text, marks } = fromDom(el);
					cancelPending(id);
					lastLocalEdit = Date.now();
					await note.blockUpdate(object.id, id, { text: { ...curText, text, marks, style: Style.PARAGRAPH } });
					focusRequest = { blockId: id, offset: 0 };
					await refresh();
					return;
				}
				const idx = flatText.indexOf(id);
				if (idx <= 0) return;
				const prevId = flatText[idx - 1];
				const prev = readBlock(prevId);
				const cur2 = fromDom(el);
				const shift = prev.text.length;
				cancelPending(id);
				cancelPending(prevId);
				lastLocalEdit = Date.now();
				await note.blockUpdate(object.id, prevId, contentFor(prevId, prev.text + cur2.text, [
					...prev.marks,
					...cur2.marks.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift })),
				]));
				await note.blockRemove(object.id, id);
				focusRequest = { blockId: prevId, offset: shift };
				await refresh();
				return;
			}
		}

		// Anytype Tab/Shift-Tab: indent under the previous sibling / outdent
		// to a sibling of the parent. Works at any depth.
		if (e.key === "Tab") {
			e.preventDefault();
			const sel = selectionOffsets(el);
			const at = sel?.from ?? 0;
			const parentOf = new Map<string, string>();
			for (const b of object.blocks) for (const c of b.childrenIds) parentOf.set(c, b.id);
			const parentId = parentOf.get(id);
			if (e.shiftKey) {
				// Outdent: become the sibling right below the parent.
				if (!parentId || parentId === "__content__") return;
				cancelPending(id);
				lastLocalEdit = Date.now();
				await note.blockMove(object.id, id, parentId, Pos.BOTTOM);
			} else {
				// Indent: append under the sibling directly above.
				const siblings = parentId ? (byId.get(parentId)?.childrenIds ?? []) : rootIds;
				const idx = siblings.indexOf(id);
				if (idx <= 0) return;
				const prevId = siblings[idx - 1];
				cancelPending(id);
				lastLocalEdit = Date.now();
				await note.blockMove(object.id, id, prevId, Pos.INNER);
				// Tucking under a closed toggle would make the block vanish.
				if (byId.get(prevId)?.content.text?.style === Style.TOGGLE) setToggleOpen(object.id, prevId, true);
			}
			focusRequest = { blockId: id, offset: at };
			await refresh();
			return;
		}

		if (e.key === "/") {
			// Open at the caret; the "/" lands in the block and is stripped on
			// apply. Position is read after the character is inserted.
			const sel = selectionOffsets(el);
			const start = sel?.from ?? 0;
			requestAnimationFrame(() => {
				const winSel = window.getSelection();
				const r = winSel && winSel.rangeCount > 0 ? winSel.getRangeAt(0).getBoundingClientRect() : null;
				const er = el.getBoundingClientRect();
				const anchored = r && (r.left !== 0 || r.bottom !== 0);
				slash = {
					blockId: id,
					start,
					filter: "",
					x: anchored ? r.left : er.left,
					y: (anchored ? r.bottom : er.bottom) + 6,
				};
			});
		}
		if (e.key === "Escape") {
			toolbar = null;
		}

		if (e.key === "ArrowUp" || e.key === "ArrowDown") {
			const sel = selectionOffsets(el);
			const { text } = fromDom(el);
			const atEdge = e.key === "ArrowUp" ? sel?.from === 0 : sel?.to === text.length;
			if (atEdge) {
				const idx = flatText.indexOf(id);
				const nextId = e.key === "ArrowUp" ? flatText[idx - 1] : flatText[idx + 1];
				if (nextId) {
					e.preventDefault();
					const target = blockEl(nextId);
					target?.focus();
					if (target) setCaret(target, e.key === "ArrowUp" ? (target.textContent?.length ?? 0) : 0);
				}
			}
		}

		// Formatting shortcuts
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
			const map: Record<string, number> = { b: MarkT.BOLD, i: MarkT.ITALIC, u: MarkT.UNDERLINE, e: MarkT.INLINE_CODE };
			const t = map[e.key.toLowerCase()];
			if (t !== undefined) {
				e.preventDefault();
				await applyMark(id, t);
			}
		}
	}

	// ── Slash menu ────────────────────────────────────────────────

	/** Track the filter typed after "/"; close if the slash was deleted. */
	function updateSlash(id: string) {
		if (!slash || slash.blockId !== id) return;
		const el = blockEl(id);
		if (!el) {
			slash = null;
			return;
		}
		const { text } = fromDom(el);
		if (text[slash.start] !== "/") {
			slash = null;
			return;
		}
		const sel = selectionOffsets(el);
		const end = sel?.to ?? text.length;
		if (end <= slash.start) {
			slash = null;
			return;
		}
		slash = { ...slash, filter: text.slice(slash.start + 1, end) };
	}

	function onInput(id: string) {
		updateSlash(id);
		scheduleSave(id);
		scheduleSpell();
	}

	/** Apply a slash pick: strip "/filter" from the block, then act. */
	async function applySlash(pick: SlashPick) {
		if (!slash) return;
		const { blockId: id, start, filter } = slash;
		const slashPos = { x: slash.x, y: slash.y };
		slash = null;
		const cur = byId.get(id)?.content.text;
		const el = blockEl(id);
		const { text, marks } = el ? fromDom(el) : { text: cur?.text ?? "", marks: cur?.marks ?? [] };
		const clean = text.slice(0, start) + text.slice(start + 1 + filter.length);
		// The block keeps focus while the menu is open, and a focused element
		// is never repopulated from state - rewrite the DOM directly so the
		// "/filter" text visibly disappears.
		if (el) {
			el.innerHTML = toHtml(clean, marks);
			setCaret(el, start);
		}
		cancelPending(id);
		lastLocalEdit = Date.now();
		if (pick.kind === "table") {
			// Anytype default 3x3: replace the block when it's empty,
			// otherwise keep the text and insert the table below it.
			if (clean === "") {
				await table.create(object.id, id, Pos.REPLACE);
			} else {
				await note.blockUpdate(object.id, id, contentFor(id, clean, marks));
				await table.create(object.id, id, Pos.BOTTOM);
			}
		} else if (pick.kind === "relation") {
			await insertRelationBlock(id, clean, marks, pick.key);
		} else if (pick.kind === "link_object") {
			// Anytype: "Link to existing page" opens the searchObject menu.
			linkPicker = { blockId: id, x: slashPos.x, y: slashPos.y };
		} else if (pick.kind === "property_add") {
			// Anytype: "New relation" opens the relationSuggest menu.
			propertySuggest = { blockId: id, x: slashPos.x, y: slashPos.y };
		} else {
			await note.blockUpdate(object.id, id, { text: { text: clean, marks, style: pick.value, checked: cur?.checked ?? false, color: cur?.color ?? "" } });
			focusRequest = { blockId: id, offset: start };
		}
		await refresh();
	}
	// ── URL paste (Anytype editor/page.tsx onPasteUrl) ───────────

	function onPasteText(e: ClipboardEvent, id: string) {
		const text = e.clipboardData?.getData("text/plain") ?? "";
		if (!isSingleUrl(text)) return; // ordinary paste
		e.preventDefault();
		const url = text.trim();
		const el = blockEl(id);
		const sel = el ? selectionOffsets(el) : null;
		const from = sel?.from ?? 0;
		const to = sel?.to ?? from;
		// Pasting over a selection link-marks it directly, no menu.
		if (to > from && el) {
			void linkRange(id, url, from, to);
			return;
		}
		const winSel = window.getSelection();
		const r = winSel && winSel.rangeCount > 0 ? winSel.getRangeAt(0).getBoundingClientRect() : null;
		const er = el?.getBoundingClientRect();
		const anchored = r && (r.left !== 0 || r.bottom !== 0);
		pasteMenu = {
			blockId: id,
			url,
			processor: getProcessorByUrl(url),
			x: anchored ? r.left : (er?.left ?? 120),
			y: (anchored ? r.bottom : (er?.bottom ?? 120)) + 6,
			at: from,
		};
	}

	async function linkRange(id: string, url: string, from: number, to: number) {
		const el = blockEl(id);
		if (!el) return;
		const { text, marks } = fromDom(el);
		marks.push({ from, to, type: MarkT.LINK, param: url });
		el.innerHTML = toHtml(text, marks);
		setCaret(el, to);
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, contentFor(id, text, marks));
		await refresh();
	}

	/** Insert the URL as text at the caret; optionally link-marked. */
	async function pasteAsText(withMark: boolean) {
		if (!pasteMenu) return;
		const { blockId: id, url, at } = pasteMenu;
		pasteMenu = null;
		const el = blockEl(id);
		if (!el) return;
		const { text, marks } = fromDom(el);
		const value = text.slice(0, at) + url + " " + text.slice(at);
		const shifted = marks.map((m) => (m.from >= at ? { ...m, from: m.from + url.length + 1, to: m.to + url.length + 1 } : m));
		if (withMark) shifted.push({ from: at, to: at + url.length, type: MarkT.LINK, param: url });
		el.innerHTML = toHtml(value, shifted);
		setCaret(el, at + url.length + 1);
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, contentFor(id, value, shifted));
		await refresh();
	}

	/** Create an embed/bookmark block: replace an empty block, else below. */
	async function pasteAsBlock(kind: "embed" | "bookmark") {
		if (!pasteMenu) return;
		const { blockId: id, url, processor } = pasteMenu;
		pasteMenu = null;
		const cur = byId.get(id)?.content.text;
		const el = blockEl(id);
		const { text } = el ? fromDom(el) : { text: cur?.text ?? "" };
		const meta: Record<string, string> =
			kind === "embed" && processor
				? { processor, url, src: getEmbedUrl(processor, url) }
				: { url };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockAdd(
			object.id,
			{ id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: kind, meta } } },
			id,
			text === "" ? Pos.REPLACE : Pos.BOTTOM,
		);
		await refresh();
	}


	/** Insert an inline relation block (empty text block → replace, else below)
	 * and initialize the field so it shows everywhere. */
	async function insertRelationBlock(id: string, clean: string, marks: MarkJSON[], key: string) {
		const relBlock = { id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: "relation", meta: { key } } } };
		if (clean === "") {
			await note.blockAdd(object.id, relBlock, id, Pos.REPLACE);
		} else {
			await note.blockUpdate(object.id, id, contentFor(id, clean, marks));
			await note.blockAdd(object.id, relBlock, id, Pos.BOTTOM);
		}
		if (!(key in object.fields)) {
			const rel = store.relations.find((r) => r.key === key);
			await note.setField(object.id, key, emptyValueFor(rel?.format ?? "shorttext"));
		}
	}

	async function onSuggestPick(rel: RelationDefJSON) {
		if (!propertySuggest) return;
		const id = propertySuggest.blockId;
		propertySuggest = null;
		const el = blockEl(id);
		const cur = byId.get(id)?.content.text;
		const { text, marks } = el ? fromDom(el) : { text: cur?.text ?? "", marks: cur?.marks ?? [] };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await insertRelationBlock(id, text, marks, rel.key);
		await refresh();
	}

	/** Turn-into from the block action menu. */
	async function applyStyle(id: string, style: number, focus = true) {
		const cur = byId.get(id)?.content.text;
		const el = blockEl(id);
		const { text, marks } = el ? fromDom(el) : { text: cur?.text ?? "", marks: cur?.marks ?? [] };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, { text: { text, marks, style, checked: cur?.checked ?? false, color: cur?.color ?? "" } });
		if (focus) focusRequest = { blockId: id, offset: text.length };
		await refresh();
	}

	// ── Marks toolbar ─────────────────────────────────────────────
	function onSelect(id: string) {
		const el = blockEl(id);
		if (!el) return;
		const sel = selectionOffsets(el);
		const winSel = window.getSelection();
		if (!sel || sel.from === sel.to || !winSel || winSel.rangeCount === 0) {
			toolbar = null;
			return;
		}
		const rect = winSel.getRangeAt(0).getBoundingClientRect();
		toolbar = { blockId: id, from: sel.from, to: sel.to, x: rect.left + rect.width / 2, y: rect.top };
	}

	async function applyMark(id: string, type: number, param?: string) {
		const el = blockEl(id);
		if (!el) return;
		const range = toolbar && toolbar.blockId === id ? toolbar : (() => {
			const s = selectionOffsets(el);
			return s ? { blockId: id, from: s.from, to: s.to, x: 0, y: 0 } : null;
		})();
		if (!range || range.from === range.to) return;
		const { text, marks } = fromDom(el);
		const next = toggleMark(marks, range.from, range.to, type, param);
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, contentFor(id, text, next));
		toolbar = null;
		focusRequest = { blockId: id, offset: range.to };
		await refresh();
	}

	async function addLink(id: string) {
		const url = prompt("Link URL:");
		if (url) await applyMark(id, MarkT.LINK, url);
	}

	// ── Drag & drop ───────────────────────────────────────────────
	async function onDrop(targetId: string, position: number) {
		const dragged = draggingId;
		draggingId = "";
		if (!dragged || dragged === targetId) return;
		// Dragging a selected block moves the whole selection (Anytype
		// drags the selection when the source is part of it).
		const group = selectedSet.has(dragged) && selectedIds.length > 1 ? topmostSelected() : [dragged];
		// Never drop into a dragged block's own subtree (checkParentIds).
		const parentOf = new Map<string, string>();
		for (const b of object.blocks) for (const c of b.childrenIds) parentOf.set(c, b.id);
		let walk: string | undefined = targetId;
		while (walk) {
			if (group.includes(walk)) return;
			walk = parentOf.get(walk);
		}
		lastLocalEdit = Date.now();
		// First block takes the drop position; the rest chain below it,
		// preserving document order.
		let prev = "";
		for (const id of group) {
			await note.blockMove(object.id, id, prev || targetId, prev ? Pos.BOTTOM : position);
			prev = id;
		}
		selectedIds = [];
		// Dropping INSIDE a closed toggle opens it (drag/provider.tsx:295) —
		// otherwise the block vanishes into a collapsed section.
		if (position === Pos.INNER_FIRST && byId.get(targetId)?.content.text?.style === Style.TOGGLE) {
			setToggleOpen(object.id, targetId, true);
		}
		await refresh();
	}

	/** Empty-toggle placeholder click: create + focus the first child. */
	async function onEmptyToggle(id: string) {
		const innerId = crypto.randomUUID();
		lastLocalEdit = Date.now();
		await note.blockAdd(object.id, { id: innerId, childrenIds: [], content: { text: { text: "", style: Style.PARAGRAPH } } }, id, Pos.INNER_FIRST);
		focusRequest = { blockId: innerId, offset: 0 };
		await refresh();
	}

	async function toggleChecked(id: string, checked: boolean) {
		const cur = byId.get(id)!.content.text!;
		const el = blockEl(id);
		const { text, marks } = el ? fromDom(el) : { text: cur.text, marks: cur.marks ?? [] };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, { text: { ...cur, text, marks, checked } });
		await refresh();
	}

	async function appendBlock() {
		const newId = crypto.randomUUID();
		lastLocalEdit = Date.now();
		await note.blockAdd(object.id, { id: newId, childrenIds: [], content: { text: { text: "", style: Style.PARAGRAPH } } });
		focusRequest = { blockId: newId, offset: 0 };
		await refresh();
	}

	async function removeBlockById(id: string) {
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockRemove(object.id, id);
		await refresh();
	}

	// ── Block action menu (Anytype's blockAction) ─────────────────
	let blockMenu = $state<{ blockId: string; x: number; y: number; group: string[] | null } | null>(null);

	function openBlockMenu(id: string, x: number, y: number) {
		toolbar = null;
		slash = null;
		// Opened on a block inside a multi-selection: styling ops apply to
		// the whole selection (Anytype's selection-wide block actions).
		const group = selectedIds.length > 1 && selectedSet.has(id) ? [...selectedIds] : null;
		// Opened OUTSIDE the selection: retarget it to the clicked block
		// (Anytype getForClick) - the old selection stayed highlighted while
		// the menu silently acted on the anchor, which read as "a block I
		// didn't select got changed".
		if (!group && selectedIds.length > 0 && !selectedSet.has(id)) selectedIds = [id];
		blockMenu = { blockId: id, x, y, group };
	}

	async function setTextColor(id: string, color: string) {
		const cur = byId.get(id)?.content.text;
		if (!cur) return;
		const el = blockEl(id);
		const { text, marks } = el ? fromDom(el) : { text: cur.text, marks: cur.marks ?? [] };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, { text: { ...cur, text, marks, color } });
		await refresh();
	}

	/** Column/row id lists of a table block, from the two marker layouts. */
	function tableShape(t: BlockJSON) {
		const kids = t.childrenIds.map((i) => byId.get(i));
		return {
			cols: kids.find((b) => b?.content.layout?.style === Layout.TABLE_COLUMNS)?.childrenIds ?? [],
			rows: kids.find((b) => b?.content.layout?.style === Layout.TABLE_ROWS)?.childrenIds ?? [],
		};
	}

	/** Duplicate a block's subtree below it (fresh ids, preserved order). */
	async function duplicateBlock(id: string) {
		const src = byId.get(id);
		if (!src) return;
		cancelPending(id);
		lastLocalEdit = Date.now();
		if (src.content.table) {
			// Cells are addressed "<rowId>-<colId>", so a generic clone would
			// break the grid. Create a fresh same-size table, then copy cells.
			const { cols, rows } = tableShape(src);
			const { id: newId } = await table.create(object.id, id, Pos.BOTTOM, rows.length, cols.length);
			const fresh = await fetchObject(object.id);
			const freshBy = new Map(fresh.blocks.map((b) => [b.id, b]));
			const nshape = tableShape(freshBy.get(newId)!);
			for (let r = 0; r < rows.length; r++) {
				for (let c = 0; c < cols.length; c++) {
					const cell = byId.get(`${rows[r]}-${cols[c]}`)?.content.text;
					if (!cell || (!cell.text && !(cell.marks ?? []).length)) continue;
					await note.blockUpdate(object.id, `${nshape.rows[r]}-${nshape.cols[c]}`, { text: cell });
				}
			}
			await refresh();
			return;
		}
		const cloneInto = async (srcId: string, targetId: string, position: number) => {
			const s = byId.get(srcId);
			if (!s) return;
			const newId = crypto.randomUUID();
			await note.blockAdd(object.id, { ...s, id: newId, childrenIds: [] }, targetId, position);
			for (const cid of s.childrenIds) await cloneInto(cid, newId, Pos.INNER);
		};
		await cloneInto(id, id, Pos.BOTTOM);
		await refresh();
	}

	async function onMenuAction(a: MenuAction) {
		const id = blockMenu?.blockId;
		if (!id) return;
		// Styling from a multi-selection hits every selected block.
		const ids = blockMenu?.group ?? [id];
		const textIds = ids.filter((b) => byId.get(b)?.content.text);
		lastLocalEdit = Date.now();
		// Group styling snapshots its reads BEFORE any write and refreshes
		// ONCE at the end: per-block write+refetch cycles let a mid-loop
		// re-render (or an SSE echo) clobber later blocks' reads - the
		// "last block randomly kept its style" bug.
		const groupText = async (make: (cur: NonNullable<BlockJSON["content"]["text"]>, text: string, marks: ReturnType<typeof fromDom>["marks"]) => BlockJSON["content"]["text"]) => {
			const payloads = textIds.map((b) => {
				const cur = byId.get(b)!.content.text!;
				const el = blockEl(b);
				const dom = el && el.dataset.ready === "1" ? fromDom(el) : { text: cur.text ?? "", marks: cur.marks ?? [] };
				return { b, content: { text: make(cur, dom.text, dom.marks) } };
			});
			for (const pIt of payloads) {
				cancelPending(pIt.b);
				await note.blockUpdate(object.id, pIt.b, pIt.content);
			}
		};
		switch (a.kind) {
			case "style":
				if (ids.length === 1) {
					await applyStyle(id, a.value as number);
					break;
				}
				await groupText((cur, text, marks) => ({ text, marks, style: a.value as number, checked: cur.checked ?? false, color: cur.color ?? "" }));
				await refresh();
				break;
			case "align":
				for (const b of ids) await note.blockSetAttrs(object.id, b, { align: a.value as number });
				await refresh();
				break;
			case "color":
				if (ids.length === 1) {
					await setTextColor(id, a.value as string);
					break;
				}
				await groupText((cur, text, marks) => ({ ...cur, text, marks, color: a.value as string }));
				await refresh();
				break;
			case "background":
				for (const b of ids) await note.blockSetAttrs(object.id, b, { background_color: a.value as string });
				await refresh();
				break;
			case "duplicate":
				await duplicateBlock(id);
				break;
			case "link_style": {
				// Anytype menuBlockLinkSettings: cardStyle Text | Card.
				const cur = byId.get(id)?.content.custom;
				if (cur?.contentType === "link") {
					await note.blockUpdate(object.id, id, { custom: { contentType: "link", meta: { ...cur.meta, style: a.value as string } } });
					await refresh();
				}
				break;
			}
			case "turn_into_object": {
				// Anytype's Turn into object: the block's text becomes a new
				// object's name, its children become that object's content,
				// and a link block takes its place.
				const src = byId.get(id);
				if (!src) break;
				const name = (src.content.text?.text ?? "").trim().slice(0, 120) || "Untitled";
				const ch = object.fields["channel"]?.stringValue ?? "";
				const { id: newId } = await note.create(name, a.value as string, ch ? { channel: { stringValue: ch } } : {});
				const moveInto = async (srcId: string, targetId: string, position: number) => {
					const s = byId.get(srcId);
					if (!s) return;
					const nid = crypto.randomUUID();
					await note.blockAdd(newId, { ...s, id: nid, childrenIds: [] }, targetId, position);
					for (const cid of s.childrenIds) await moveInto(cid, nid, Pos.INNER);
				};
				for (const cid of src.childrenIds) await moveInto(cid, "", 0);
				await note.blockAdd(object.id, { id: crypto.randomUUID(), childrenIds: [], content: { custom: { contentType: "link", meta: { target: newId } } } }, id, Pos.BOTTOM);
				await removeBlockById(id);
				break;
			}
			case "clear_style": {
				// Anytype's Clear style: back to default color, background, align.
				await groupText((cur, text, marks) => ({ ...cur, text, marks, color: "" }));
				for (const b of ids) await note.blockSetAttrs(object.id, b, { background_color: "", align: 0 });
				await refresh();
				break;
			}
			case "delete": {
				if (ids.length > 1) {
					const tops = topmostOf(new Set(ids));
					selectedIds = [];
					for (const b of tops) {
						cancelPending(b);
						await note.blockRemove(object.id, b);
					}
					await refresh();
				} else {
					await removeBlockById(id);
				}
				break;
			}
		}
	}
</script>

<svelte:window
	onkeydown={(e) => void onWindowKeydown(e)}
	onmousedown={(e) => {
		if (spellMenu && !(e.target as HTMLElement).closest(".spell-menu")) spellMenu = null;
		marginMouseDown(e);
	}}
/>

<div
	class="editor"
	role="presentation"
	bind:this={editorEl}
	oncontextmenucapture={onEditorContextMenu}
	onmousedown={selMouseDown}
	onclick={(e) => {
		if (e.target === e.currentTarget && !selectedIds.length) void appendBlock();
	}}
>
	{#each rootIds as id (id)}
		<BlockNode
			{id}
			{byId}
			{object}
			{draggingId}
			selectedIds={selectedSet}
			onkeydown={onKeydown}
			oninput={onInput}
			onblur={flushSave}
			onselect={onSelect}
			ondragbegin={(bid) => (draggingId = bid)}
			ondrop={onDrop}
			ontogglecheck={toggleChecked}
			onemptytoggle={onEmptyToggle}
			onmenu={openBlockMenu}
			onrefresh={refresh}
			onpaste={onPasteText}
		/>
	{/each}
	{#if rootIds.length === 0}
		<button class="empty-hint" onclick={() => void appendBlock()}>Click to start writing…</button>
	{/if}
</div>

{#if spellMenu}
	<div class="spell-menu" style="left:{spellMenu.x}px; top:{spellMenu.y + 6}px" role="menu">
		<span class="sm-word">"{spellMenu.word}"</span>
		<button
			onclick={() => {
				addToDictionary(spellMenu!.word);
				spellMenu = null;
				scheduleSpell();
			}}>Add to dictionary</button
		>
		<button class="sm-close" onclick={() => (spellMenu = null)}>✕</button>
	</div>
{/if}

{#if selRect}
	<!-- Anytype #selection-rect: system-selection fill, hairline border. -->
	<div class="sel-rect" style="left:{selRect.x}px; top:{selRect.y}px; width:{selRect.w}px; height:{selRect.h}px"></div>
{/if}

{#if blockMenu && byId.has(blockMenu.blockId)}
	<BlockMenu
		block={byId.get(blockMenu.blockId)!}
		x={blockMenu.x}
		y={blockMenu.y}
		groupCount={blockMenu.group?.length ?? 1}
		onaction={(a) => void onMenuAction(a)}
		onclose={() => (blockMenu = null)}
	/>
{/if}

{#if linkPicker}
	<LinkPicker x={linkPicker.x} y={linkPicker.y} excludeId={object.id} onpick={(t) => void insertLinkBlock(linkPicker!.blockId, t)} onclose={() => (linkPicker = null)} />
{/if}

{#if propertySuggest}
	<PropertySuggest x={propertySuggest.x} y={propertySuggest.y} onpick={(r) => void onSuggestPick(r)} onclose={() => (propertySuggest = null)} />
{/if}

{#if pasteMenu}
	<div class="paste-menu" style="left: {pasteMenu.x}px; top: {pasteMenu.y}px">
		<div class="paste-head">Paste as</div>
		{#if pasteMenu.processor}
			<button onclick={() => void pasteAsBlock("embed")}>Embed</button>
		{/if}
		<button onclick={() => void pasteAsBlock("bookmark")}>Bookmark</button>
		<button onclick={() => void pasteAsText(true)}>Link</button>
		<button onclick={() => void pasteAsText(false)}>Text</button>
	</div>
	<button class="paste-backdrop" aria-label="Close" onclick={() => (pasteMenu = null)}></button>
{/if}

{#if toolbar}
	<div class="toolbar" style="left: {toolbar.x}px; top: {toolbar.y - 44}px">
		<button title="Bold (⌘B)" onclick={() => void applyMark(toolbar!.blockId, MarkT.BOLD)}><b>B</b></button>
		<button title="Italic (⌘I)" onclick={() => void applyMark(toolbar!.blockId, MarkT.ITALIC)}><i>I</i></button>
		<button title="Underline (⌘U)" onclick={() => void applyMark(toolbar!.blockId, MarkT.UNDERLINE)}><u>U</u></button>
		<button title="Strikethrough" onclick={() => void applyMark(toolbar!.blockId, MarkT.STRIKETHROUGH)}><s>S</s></button>
		<button title="Code (⌘E)" onclick={() => void applyMark(toolbar!.blockId, MarkT.INLINE_CODE)}>{"<>"}</button>
		<button title="Link" onclick={() => void addLink(toolbar!.blockId)}>🔗</button>
	</div>
{/if}

{#if slash}
	<SlashMenu bind:this={slashMenu} filter={slash.filter} x={slash.x} y={slash.y} {presentRelations} onpick={(p) => void applySlash(p)} onclose={() => (slash = null)} />
{/if}

<style>
	.editor {
		min-height: 240px;
		padding-bottom: 120px;
		cursor: text;
	}
	.empty-hint {
		margin-left: 48px;
		border: none;
		background: none;
		color: var(--muted);
		font-size: 15px;
		padding: 8px 0;
		cursor: text;
	}
	.toolbar {
		position: fixed;
		transform: translateX(-50%);
		display: flex;
		gap: 2px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 4px;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
		z-index: 50;
	}
	.toolbar button {
		border: none;
		background: none;
		color: var(--fg);
		width: 30px;
		height: 30px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}
	.toolbar button:hover {
		background: var(--hover);
	}
	.paste-menu {
		position: fixed;
		z-index: 120;
		min-width: 160px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		display: flex;
		flex-direction: column;
	}
	.paste-head {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 6px 8px 4px;
	}
	.paste-menu button {
		border: none;
		background: none;
		color: inherit;
		text-align: left;
		padding: 6px 8px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
	}
	.paste-menu button:hover {
		background: var(--hover);
	}
	.paste-backdrop {
		position: fixed;
		inset: 0;
		z-index: 110;
		background: none;
		border: none;
		cursor: default;
	}
	.sel-rect {
		position: fixed;
		z-index: 50;
		background: rgba(55, 122, 255, 0.25);
		border: 1px solid #2aa7ee;
		border-radius: 2px;
		pointer-events: none;
	}
	:global(::highlight(spell)) {
		text-decoration: underline wavy #e2400c 1px;
		text-decoration-skip-ink: none;
	}
	.spell-menu {
		position: fixed;
		z-index: 140;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 5px 8px;
		font-size: 13px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
	}
	.sm-word {
		color: var(--muted);
		max-width: 160px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.spell-menu button {
		background: none;
		border: none;
		color: var(--fg);
		cursor: pointer;
		font-size: 13px;
		padding: 2px 6px;
		border-radius: 5px;
	}
	.spell-menu button:hover {
		background: var(--hl-med);
	}
	.sm-close {
		color: var(--muted);
	}
	@media (max-width: 720px) {
		.empty-hint {
			margin-left: 16px;
		}
	}
</style>
