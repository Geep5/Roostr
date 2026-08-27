<script lang="ts">
	import type { ObjectJSON, BlockJSON } from "$lib/types";
	import { Pos, Style, MarkT } from "$lib/types";
	import { note } from "$lib/api";
	import { fromDom, selectionOffsets, setCaret, toggleMark } from "$lib/marks";
	import BlockNode from "./BlockNode.svelte";
	import BlockMenu from "./BlockMenu.svelte";
	import type { MenuAction } from "./BlockMenu.svelte";

	let { object, onchanged }: { object: ObjectJSON; onchanged: () => Promise<void> } = $props();

	const byId = $derived(new Map(object.blocks.map((b) => [b.id, b])));
	const rootIds = $derived.by(() => {
		const referenced = new Set<string>();
		for (const b of object.blocks) for (const c of b.childrenIds) referenced.add(c);
		return object.blocks.filter((b) => !referenced.has(b.id) && b.id !== "__content__").map((b) => b.id);
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
	let toolbar = $state<{ blockId: string; from: number; to: number; x: number; y: number } | null>(null);
	let slashFor = $state<string | null>(null);
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
		if (focusRequest) {
			const req = focusRequest;
			focusRequest = null;
			requestAnimationFrame(() => {
				const el = blockEl(req.blockId);
				if (el) {
					el.focus();
					setCaret(el, req.offset);
				}
			});
		}
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

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const sel = selectionOffsets(el);
			const { text, marks } = fromDom(el);
			const at = sel?.from ?? text.length;
			const newId = crypto.randomUUID();
			cancelPending(id);
			lastLocalEdit = Date.now();
			await note.blockUpdate(object.id, id, contentFor(id, text.slice(0, at), marks.filter((m) => m.from < at).map((m) => ({ ...m, to: Math.min(m.to, at) }))));
			await note.blockAdd(
				object.id,
				{ id: newId, childrenIds: [], content: { text: { text: text.slice(at), style: Style.PARAGRAPH, marks: marks.filter((m) => m.to > at).map((m) => ({ ...m, from: Math.max(0, m.from - at), to: m.to - at })) } } },
				id,
				Pos.BOTTOM,
			);
			focusRequest = { blockId: newId, offset: 0 };
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

		if (e.key === "/" ) {
			const { text } = fromDom(el);
			if (text.length === 0) {
				e.preventDefault();
				slashFor = id;
				return;
			}
		}
		if (e.key === "Escape") {
			slashFor = null;
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
	const SLASH_ITEMS: Array<{ label: string; style: number }> = [
		{ label: "Text", style: Style.PARAGRAPH },
		{ label: "Heading 1", style: Style.HEADER1 },
		{ label: "Heading 2", style: Style.HEADER2 },
		{ label: "Heading 3", style: Style.HEADER3 },
		{ label: "Bulleted list", style: Style.BULLET },
		{ label: "Numbered list", style: Style.NUMBERED },
		{ label: "Checkbox", style: Style.CHECKBOX },
		{ label: "Quote", style: Style.QUOTE },
		{ label: "Code", style: Style.CODE },
		{ label: "Callout", style: Style.CALLOUT },
	];

	async function applyStyle(id: string, style: number) {
		slashFor = null;
		const cur = byId.get(id)?.content.text;
		const el = blockEl(id);
		const { text, marks } = el ? fromDom(el) : { text: cur?.text ?? "", marks: cur?.marks ?? [] };
		cancelPending(id);
		lastLocalEdit = Date.now();
		await note.blockUpdate(object.id, id, { text: { text, marks, style, checked: cur?.checked ?? false, color: cur?.color ?? "" } });
		focusRequest = { blockId: id, offset: text.length };
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
		lastLocalEdit = Date.now();
		await note.blockMove(object.id, dragged, targetId, position);
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
	let blockMenu = $state<{ blockId: string; x: number; y: number } | null>(null);

	function openBlockMenu(id: string, x: number, y: number) {
		toolbar = null;
		slashFor = null;
		blockMenu = { blockId: id, x, y };
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

	/** Duplicate a block's subtree below it (fresh ids, preserved order). */
	async function duplicateBlock(id: string) {
		const src = byId.get(id);
		if (!src) return;
		cancelPending(id);
		lastLocalEdit = Date.now();
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
		lastLocalEdit = Date.now();
		switch (a.kind) {
			case "style":
				await applyStyle(id, a.value as number);
				break;
			case "align":
				await note.blockSetAttrs(object.id, id, { align: a.value as number });
				await refresh();
				break;
			case "color":
				await setTextColor(id, a.value as string);
				break;
			case "background":
				await note.blockSetAttrs(object.id, id, { background_color: a.value as string });
				await refresh();
				break;
			case "duplicate":
				await duplicateBlock(id);
				break;
			case "delete":
				await removeBlockById(id);
				break;
		}
	}
</script>

<div class="editor" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) void appendBlock(); }}>
	{#each rootIds as id (id)}
		<BlockNode
			{id}
			{byId}
			{draggingId}
			onkeydown={onKeydown}
			oninput={scheduleSave}
			onblur={flushSave}
			onselect={onSelect}
			ondragbegin={(bid) => (draggingId = bid)}
			ondrop={onDrop}
			ontogglecheck={toggleChecked}
			onmenu={openBlockMenu}
		/>
	{/each}
	{#if rootIds.length === 0}
		<button class="empty-hint" onclick={() => void appendBlock()}>Click to start writing…</button>
	{/if}
</div>

{#if blockMenu && byId.has(blockMenu.blockId)}
	<BlockMenu
		block={byId.get(blockMenu.blockId)!}
		x={blockMenu.x}
		y={blockMenu.y}
		onaction={(a) => void onMenuAction(a)}
		onclose={() => (blockMenu = null)}
	/>
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

{#if slashFor}
	<div class="slash-menu">
		{#each SLASH_ITEMS as item (item.style)}
			<button onclick={() => void applyStyle(slashFor!, item.style)}>{item.label}</button>
		{/each}
	</div>
{/if}

<style>
	.editor {
		min-height: 240px;
		padding-bottom: 120px;
		cursor: text;
	}
	.empty-hint {
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
	.slash-menu {
		position: fixed;
		left: 50%;
		top: 30%;
		transform: translateX(-50%);
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		min-width: 220px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.45);
		z-index: 60;
	}
	.slash-menu button {
		text-align: left;
		border: none;
		background: none;
		color: var(--fg);
		padding: 8px 10px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}
	.slash-menu button:hover {
		background: var(--hover);
	}
</style>
