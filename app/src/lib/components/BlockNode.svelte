<script lang="ts">
	import type { BlockJSON, ObjectJSON } from "$lib/types";
	import { Pos, Style, Layout } from "$lib/types";
	import { toHtml } from "$lib/marks";
	import BlockNode from "./BlockNode.svelte";
	import TableBlock from "./TableBlock.svelte";
	import RelationBlock from "./RelationBlock.svelte";
	import { isToggleOpen, setToggleOpen } from "$lib/toggles";
	import { store } from "$lib/data.svelte";
	import { objectIcon } from "$lib/icons";

	let {
		id,
		byId,
		object,
		draggingId,
		selectedIds,
		onkeydown,
		oninput,
		onblur,
		onselect,
		ondragbegin,
		ondrop,
		ontogglecheck,
		onmenu,
		onrefresh,
		onpaste,
		onemptytoggle,
	}: {
		id: string;
		byId: Map<string, BlockJSON>;
		object: ObjectJSON;
		draggingId: string;
		selectedIds: Set<string>;
		onkeydown: (e: KeyboardEvent, id: string) => void;
		oninput: (id: string) => void;
		onblur: (id: string) => void;
		onselect: (id: string) => void;
		ondragbegin: (id: string) => void;
		ondrop: (targetId: string, position: number) => void;
		ontogglecheck: (id: string, checked: boolean) => void;
		/** Open the block action menu at viewport coordinates. */
		onmenu: (id: string, x: number, y: number) => void;
		/** Re-pull object state after a structural table mutation. */
		onrefresh: () => void | Promise<void>;
		/** URL-paste interception (Anytype "Paste as" menu). */
		onpaste: (e: ClipboardEvent, id: string) => void;
		/** Click on an open empty toggle's placeholder: create the first child. */
		onemptytoggle: (id: string) => void;
	} = $props();

	const block = $derived(byId.get(id));
	let zone = $state(0); // 0 none, else Pos value
	let textEl: HTMLElement | undefined = $state();

	// Anytype toggle: open state is per-device (localStorage), arrow rotates,
	// children hidden while closed.
	const isToggle = $derived(block?.content.text?.style === Style.TOGGLE);
	let toggleOpen = $state(false);
	$effect(() => {
		if (isToggle) toggleOpen = isToggleOpen(object.id, id);
	});
	function flipToggle() {
		toggleOpen = !toggleOpen;
		setToggleOpen(object.id, id, toggleOpen);
	}

	// iOS: autocorrect/autocapitalize paint red squiggles inside contenteditables.
	const IOS_KEYBOARD_OFF: Record<string, string> = { autocapitalize: "off", autocorrect: "off" };
	const STYLE_CLASS: Record<number, string> = {
		[Style.PARAGRAPH]: "p",
		[Style.HEADER1]: "h1",
		[Style.HEADER2]: "h2",
		[Style.HEADER3]: "h3",
		[Style.QUOTE]: "quote",
		[Style.CODE]: "codeblock",
		[Style.BULLET]: "bullet",
		[Style.NUMBERED]: "numbered",
		[Style.CHECKBOX]: "checkbox",
		[Style.TITLE]: "title",
		[Style.TOGGLE]: "toggle",
		[Style.CALLOUT]: "callout",
		[Style.DESCRIPTION]: "description",
	};

	// Render marks → HTML only when the element isn't being edited.
	// `data-ready` gates saves: an element that hasn't been populated yet
	// must never be read back as block content (poison-save race).
	$effect(() => {
		const t = block?.content.text;
		if (!textEl || !t) return;
		if (document.activeElement !== textEl) {
			const html = toHtml(t.text, t.marks ?? []);
			if (textEl.innerHTML !== html) textEl.innerHTML = html;
		}
		textEl.dataset.ready = "1";
	});

	function widthOf(colId: string): string {
		const col = byId.get(colId);
		const w = col?.fields?.entries?.["width"];
		const n = w?.floatValue ?? w?.intValue ?? 0;
		return n > 0 ? `${n * 100}%` : "1fr";
	}

	/**
	 * Anytype drag/provider.tsx zone math (initVars/col1/col2): Left only
	 * when the pointer is LEFT of the content rect (`ex <= x - blockMenu/4`
	 * — i.e. out in the rail/margin), Right only PAST the right edge. Inside
	 * the block body position is purely vertical: top 30% → Top, bottom 30%
	 * → Bottom, middle 40% → INSIDE (InnerFirst) on blocks that
	 * canHaveChildren (paragraph, lists, toggle, callout, quote — not
	 * headers/code/title); others split 50/50. Our rows don't receive
	 * dragover in the page margin, so the rail itself plays Left and a slim
	 * right-edge strip plays Right.
	 */
	const CAN_HAVE_CHILDREN: Record<number, true> = {
		[Style.PARAGRAPH]: true,
		[Style.BULLET]: true,
		[Style.NUMBERED]: true,
		[Style.CHECKBOX]: true,
		[Style.TOGGLE]: true,
		[Style.CALLOUT]: true,
		[Style.QUOTE]: true,
	};

	function computeZone(e: DragEvent): number {
		// Anytype's content DropTarget wraps only the block's own row - and
		// since children now render OUTSIDE this element, the rect IS the row.
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		const gutter = el.querySelector(":scope > .gutter");
		const contentLeft = gutter ? gutter.getBoundingClientRect().right : r.left;
		if (e.clientX < contentLeft) return Pos.LEFT;
		if (e.clientX > r.right - 24) return Pos.RIGHT;
		const h = r.height;
		const y = h > 0 ? (e.clientY - r.top) / h : 0;
		const style = block?.content.text?.style;
		if (style !== undefined && CAN_HAVE_CHILDREN[style]) {
			if (y <= 0.3) return Pos.TOP;
			if (y >= 0.7) return Pos.BOTTOM;
			return Pos.INNER_FIRST;
		}
		return y < 0.5 ? Pos.TOP : Pos.BOTTOM;
	}
</script>

{#if block}
	{#if block.content.layout?.style === Layout.ROW}
		<div class="row" style="grid-template-columns: {block.childrenIds.map(widthOf).join(' ')}">
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {object} {draggingId} {selectedIds} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} {onemptytoggle} />
			{/each}
		</div>
	{:else if block.content.layout?.style === Layout.COLUMN}
		<div class="col">
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {object} {draggingId} {selectedIds} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} {onemptytoggle} />
			{/each}
		</div>
	{:else if block.content.table}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}" class:selected={selectedIds.has(block.id)}
			data-block={block.id}
			role="presentation"
			ondragover={(e) => {
				if (!draggingId || draggingId === block.id) return;
				e.preventDefault();
				zone = computeZone(e);
			}}
			ondragleave={() => (zone = 0)}
			ondrop={(e) => {
				e.preventDefault();
				const z = zone;
				zone = 0;
				ondrop(block.id, z || Pos.BOTTOM);
			}}
			oncontextmenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onmenu(block.id, e.clientX, e.clientY);
			}}
		>
			<div class="gutter">
				<button
					class="handle"
					title="Click for actions; drag to move"
					draggable="true"
					ondragstart={(e) => {
						e.dataTransfer?.setData("text/plain", block.id);
						ondragbegin(block.id);
					}}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onmenu(block.id, r.right + 8, r.top);
					}}
				>
					<svg viewBox="0 0 2 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 1C0 0.447716 0.447715 0 1 0C1.55228 0 2 0.447716 2 1C2 1.55228 1.55228 2 1 2C0.447715 2 0 1.55228 0 1ZM0 6C0 5.44772 0.447715 5 1 5C1.55228 5 2 5.44772 2 6C2 6.55228 1.55228 7 1 7C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12C1.55228 12 2 11.5523 2 11C2 10.4477 1.55228 10 1 10Z" fill="currentColor" /></svg>
				</button>
			</div>
			<TableBlock {block} {byId} objectId={object.id} {onrefresh} {oninput} {onblur} />
		</div>
	{:else if block.content.text}
		{@const t = block.content.text}
		<!-- Anytype block/index.tsx: the selectionTarget wraps ONLY the row;
		     children render as a SIBLING inside a plain wrapper, so pointer
		     events near nested rows can never land on this ancestor. -->
		<div class="block-tree" class:dragging={draggingId === block.id} style={block.backgroundColor ? `background:${block.backgroundColor}` : ""}>
		<div
			class="block zone-{zone}" class:selected={selectedIds.has(block.id)}
			data-block={block.id}
			role="presentation"
			ondragover={(e) => {
				if (!draggingId || draggingId === block.id) return;
				e.preventDefault();
				zone = computeZone(e);
			}}
			ondragleave={() => (zone = 0)}
			ondrop={(e) => {
				e.preventDefault();
				const z = zone;
				zone = 0;
				ondrop(block.id, z || Pos.BOTTOM);
			}}
			oncontextmenu={(e) => {
				// Anytype rule: the focused text block keeps the native menu
				// (spellcheck); everything else opens the block action menu.
				if (document.activeElement === textEl) return;
				e.preventDefault();
				e.stopPropagation();
				onmenu(block.id, e.clientX, e.clientY);
			}}
		>
			<div class="gutter">
				<button
					class="handle"
					title="Click for actions; drag to move"
					draggable="true"
					ondragstart={(e) => {
						e.dataTransfer?.setData("text/plain", block.id);
						ondragbegin(block.id);
					}}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onmenu(block.id, r.right + 8, r.top);
					}}
				>
					<svg viewBox="0 0 2 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 1C0 0.447716 0.447715 0 1 0C1.55228 0 2 0.447716 2 1C2 1.55228 1.55228 2 1 2C0.447715 2 0 1.55228 0 1ZM0 6C0 5.44772 0.447715 5 1 5C1.55228 5 2 5.44772 2 6C2 6.55228 1.55228 7 1 7C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12C1.55228 12 2 11.5523 2 11C2 10.4477 1.55228 10 1 10Z" fill="currentColor" /></svg>
				</button>
			</div>
			{#if t.style === Style.CHECKBOX}
				<!-- Anytype's circular checkbox: outlined circle → accent-filled circle + white check. -->
				<button
					class="check-circle"
					class:on={t.checked ?? false}
					aria-label={t.checked ? "Mark undone" : "Mark done"}
					onclick={() => ontogglecheck(block.id, !(t.checked ?? false))}
				>
					{#if t.checked}
						<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M2 10C2 5.58172 5.58172 2 10 2C14.4183 2 18 5.58172 18 10C18 14.4183 14.4183 18 10 18C5.58172 18 2 14.4183 2 10Z" fill="currentColor" />
							<path d="M13.0975 6.16216C13.2842 5.87198 13.6705 5.78818 13.9608 5.97466C14.251 6.16128 14.3348 6.54761 14.1483 6.83794L9.65222 13.8379C9.54506 14.0046 9.36554 14.1111 9.16785 14.1241C8.97004 14.1371 8.77734 14.0547 8.64929 13.9034L5.89929 10.6534C5.67673 10.3899 5.71015 9.99535 5.97351 9.77251C6.23702 9.54995 6.63153 9.58337 6.85437 9.84673L9.0575 12.4502L13.0975 6.16216Z" fill="white" />
						</svg>
					{:else}
						<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M10 2.5C14.1421 2.5 17.5 5.85786 17.5 10C17.5 14.1421 14.1421 17.5 10 17.5C5.85786 17.5 2.5 14.1421 2.5 10C2.5 5.85786 5.85786 2.5 10 2.5Z" stroke="currentColor" class="ring" />
						</svg>
					{/if}
				</button>
			{/if}
			{#if t.style === Style.BULLET}<span class="marker">•</span>{/if}
			{#if t.style === Style.NUMBERED}<span class="marker">1.</span>{/if}
			{#if t.style === Style.TOGGLE}
				<!-- Anytype markerToggle: 24x24 rounded chevron, rotates 90 when open. -->
				<button class="toggle-arrow" class:open={toggleOpen} aria-label={toggleOpen ? "Collapse" : "Expand"} onclick={flipToggle}>
					<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path
							fill-rule="evenodd"
							clip-rule="evenodd"
							d="M10.2158 7.2226C10.5087 6.92971 10.9835 6.92971 11.2764 7.2226L15.9507 11.8969C16.0093 11.9554 16.0093 12.0504 15.9507 12.109L11.2764 16.7833C10.9835 17.0762 10.5087 17.0762 10.2158 16.7833C9.92287 16.4904 9.92287 16.0155 10.2158 15.7226L13.9354 12.0029L10.2158 8.28326C9.92287 7.99037 9.92287 7.51549 10.2158 7.2226Z"
							fill="currentColor"
						/>
					</svg>
				</button>
			{/if}
			<div
				role="textbox"
				tabindex="0"
				aria-multiline="false"
				class="text {STYLE_CLASS[t.style] ?? 'p'} {t.checked && t.style === Style.CHECKBOX ? 'done' : ''}"
				style="{t.color ? `color:${t.color};` : ''}{block.align ? `text-align:${['left', 'center', 'right', 'justify'][block.align]};` : ''}"
				contenteditable="true"
				bind:this={textEl}
				onkeydown={(e) => onkeydown(e, block.id)}
				onpaste={(e) => onpaste(e, block.id)}
				oninput={() => oninput(block.id)}
				onblur={() => onblur(block.id)}
				onmouseup={() => onselect(block.id)}
				onkeyup={(e) => {
					if (e.shiftKey || e.key.startsWith("Arrow")) onselect(block.id);
				}}
				spellcheck="false"
				{...IOS_KEYBOARD_OFF}
				data-placeholder={t.style === Style.TITLE ? "Untitled" : "Type / for commands"}
			></div>
		</div>
			{#if block.childrenIds.length > 0 && (!isToggle || toggleOpen)}
				<div class="nested">
					{#each block.childrenIds as cid (cid)}
						<BlockNode id={cid} {byId} {object} {draggingId} {selectedIds} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} {onemptytoggle} />
					{/each}
				</div>
				<!-- Anytype targetBot (block/index.tsx:1219): a thin strip below
				     the children; dropping here lands AFTER this whole subtree. -->
				<div
					class="bot-strip"
					class:over={zone === 12}
					role="presentation"
					style="pointer-events:{draggingId && draggingId !== block.id ? 'auto' : 'none'}"
					ondragover={(e) => {
						e.preventDefault();
						e.stopPropagation();
						zone = 12; // AFTER sentinel: strip line only, no block shadow
					}}
					ondragleave={() => (zone = 0)}
					ondrop={(e) => {
						e.preventDefault();
						e.stopPropagation();
						zone = 0;
						ondrop(block.id, Pos.BOTTOM);
					}}
				></div>
			{:else if isToggle && toggleOpen && block.childrenIds.length === 0}
				<!-- Anytype .emptyToggle: muted hint, click creates the first child. -->
				<button class="empty-toggle" onclick={() => onemptytoggle(block.id)}>Empty toggle. Click or drop Block inside</button>
			{/if}
		</div>
	{:else if block.content.custom?.contentType === "relation"}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}" class:selected={selectedIds.has(block.id)}
			data-block={block.id}
			role="presentation"
			ondragover={(e) => {
				if (!draggingId || draggingId === block.id) return;
				e.preventDefault();
				zone = computeZone(e);
			}}
			ondragleave={() => (zone = 0)}
			ondrop={(e) => {
				e.preventDefault();
				const z = zone;
				zone = 0;
				ondrop(block.id, z || Pos.BOTTOM);
			}}
			oncontextmenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onmenu(block.id, e.clientX, e.clientY);
			}}
		>
			<div class="gutter">
				<button
					class="handle"
					title="Click for actions; drag to move"
					draggable="true"
					ondragstart={(e) => {
						e.dataTransfer?.setData("text/plain", block.id);
						ondragbegin(block.id);
					}}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onmenu(block.id, r.right + 8, r.top);
					}}
				>
					<svg viewBox="0 0 2 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 1C0 0.447716 0.447715 0 1 0C1.55228 0 2 0.447716 2 1C2 1.55228 1.55228 2 1 2C0.447715 2 0 1.55228 0 1ZM0 6C0 5.44772 0.447715 5 1 5C1.55228 5 2 5.44772 2 6C2 6.55228 1.55228 7 1 7C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12C1.55228 12 2 11.5523 2 11C2 10.4477 1.55228 10 1 10Z" fill="currentColor" /></svg>
				</button>
			</div>
			<RelationBlock {block} {object} {onrefresh} />
		</div>
	{:else if block.content.custom?.contentType === "embed" || block.content.custom?.contentType === "bookmark"}
		{@const meta = block.content.custom.meta ?? {}}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}" class:selected={selectedIds.has(block.id)}
			data-block={block.id}
			role="presentation"
			ondragover={(e) => {
				if (!draggingId || draggingId === block.id) return;
				e.preventDefault();
				zone = computeZone(e);
			}}
			ondragleave={() => (zone = 0)}
			ondrop={(e) => {
				e.preventDefault();
				const z = zone;
				zone = 0;
				ondrop(block.id, z || Pos.BOTTOM);
			}}
			oncontextmenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onmenu(block.id, e.clientX, e.clientY);
			}}
		>
			<div class="gutter">
				<button
					class="handle"
					title="Click for actions; drag to move"
					draggable="true"
					ondragstart={(e) => {
						e.dataTransfer?.setData("text/plain", block.id);
						ondragbegin(block.id);
					}}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onmenu(block.id, r.right + 8, r.top);
					}}
				>
					<svg viewBox="0 0 2 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 1C0 0.447716 0.447715 0 1 0C1.55228 0 2 0.447716 2 1C2 1.55228 1.55228 2 1 2C0.447715 2 0 1.55228 0 1ZM0 6C0 5.44772 0.447715 5 1 5C1.55228 5 2 5.44772 2 6C2 6.55228 1.55228 7 1 7C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12C1.55228 12 2 11.5523 2 11C2 10.4477 1.55228 10 1 10Z" fill="currentColor" /></svg>
				</button>
			</div>
			{#if block.content.custom.contentType === "embed"}
				<iframe
					class="embed"
					class:audio={meta["processor"] === "spotify"}
					src={meta["src"]}
					title={meta["url"] ?? "Embedded content"}
					frameborder="0"
					allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
					allowfullscreen
				></iframe>
			{:else}
				{@const host = (() => { try { return new URL(meta["url"] ?? "").hostname; } catch { return meta["url"] ?? ""; } })()}
				<a class="bookmark" href={meta["url"]} target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()}>
					<img class="favicon" src="https://www.google.com/s2/favicons?domain={host}&sz=32" alt="" />
					<span class="bm-meta">
						<span class="bm-title">{meta["title"] || host}</span>
						<span class="bm-url">{meta["url"]}</span>
					</span>
				</a>
			{/if}
		</div>
	{:else if block.content.custom?.contentType === "link"}
		<!-- Anytype BlockType.Link, text card style (block/link.tsx): 20px
		     object icon + 500-weight name; ghost row when target deleted. -->
		{@const target = store.summaries.find((s) => s.id === block.content.custom?.meta?.target)}
		{@const linkStyle = block.content.custom?.meta?.style ?? "text"}
		{@const typeName = target ? (store.types.find((t) => t.key === target.typeKey)?.name ?? target.typeKey) : ""}
		<div
			class="block link-block zone-{zone} {draggingId === block.id ? 'dragging' : ''}"
			class:selected={selectedIds.has(block.id)}
			data-block={block.id}
			role="presentation"
			ondragover={(e) => {
				if (!draggingId || draggingId === block.id) return;
				e.preventDefault();
				zone = computeZone(e);
			}}
			ondragleave={() => (zone = 0)}
			ondrop={(e) => {
				e.preventDefault();
				const z = zone;
				zone = 0;
				ondrop(block.id, z || Pos.BOTTOM);
			}}
			oncontextmenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onmenu(block.id, e.clientX, e.clientY);
			}}
		>
			<div class="gutter">
				<button
					class="handle"
					title="Click for actions; drag to move"
					draggable="true"
					ondragstart={(e) => {
						e.dataTransfer?.setData("text/plain", block.id);
						ondragbegin(block.id);
					}}
					onclick={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						onmenu(block.id, r.right + 8, r.top);
					}}
				>
					<svg viewBox="0 0 2 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M0 1C0 0.447716 0.447715 0 1 0C1.55228 0 2 0.447716 2 1C2 1.55228 1.55228 2 1 2C0.447715 2 0 1.55228 0 1ZM0 6C0 5.44772 0.447715 5 1 5C1.55228 5 2 5.44772 2 6C2 6.55228 1.55228 7 1 7C0.447715 7 0 6.55228 0 6ZM1 10C0.447715 10 0 10.4477 0 11C0 11.5523 0.447715 12 1 12C1.55228 12 2 11.5523 2 11C2 10.4477 1.55228 10 1 10Z" fill="currentColor" /></svg>
				</button>
			</div>
			<div class="link-wrap" style={block.align === 1 ? "justify-content:center" : block.align === 2 ? "justify-content:flex-end" : ""}>
				{#if !target}
					<span class="link-body deleted">
						<span class="link-icon">⌀</span>
						<span class="link-name">Deleted object</span>
					</span>
				{:else if linkStyle === "card"}
					<!-- Anytype linkCard (link.scss:170): bordered 8px card,
					     16px padding, name row + small secondary type row. -->
					<a class="link-card" href="/object/{target.id}">
						<span class="card-name">
							<span class="link-icon">{objectIcon(target.icon, target.typeKey)}</span>
							<span class="link-name">{target.name || "Untitled"}</span>
						</span>
						<span class="card-type">{typeName}</span>
					</a>
				{:else}
					<a class="link-body" href="/object/{target.id}">
						<span class="link-icon">{objectIcon(target.icon, target.typeKey)}</span>
						<span class="link-name">{target.name || "Untitled"}</span>
					</a>
				{/if}
			</div>
		</div>
	{:else if block.content.custom}
		<div class="block-tree">
			<div class="block custom" class:selected={selectedIds.has(block.id)} data-block={block.id}>
				<span class="chip">{block.content.custom.contentType}</span>
			</div>
			{#if block.childrenIds.length > 0}
				<div class="nested">
					{#each block.childrenIds as cid (cid)}
						<BlockNode id={cid} {byId} {object} {draggingId} {selectedIds} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} {onemptytoggle} />
					{/each}
				</div>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.row {
		display: grid;
		gap: 24px;
		margin: 2px 0;
	}
	.col {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.block-tree {
		position: relative;
		border-radius: 4px;
	}
	.block-tree.dragging {
		opacity: 0.4;
	}
	.block {
		position: relative;
		display: flex;
		align-items: flex-start;
		padding: 1px 0;
		border-radius: 4px;
	}
	.block.zone-1 { box-shadow: 0 -2px 0 var(--accent); }
	.block.zone-2 { box-shadow: 0 2px 0 var(--accent); }
	.block.zone-3 { box-shadow: -3px 0 0 var(--accent); }
	.block.zone-4 { box-shadow: 3px 0 0 var(--accent); }
	/* InnerFirst: drop INSIDE — Anytype outlines the whole target. */
	/* Anytype .dropTarget.isOver.middle: translucent drop-zone fill. */
	.block.zone-7 {
		background: rgba(55, 122, 255, 0.25);
		border-radius: 4px;
	}
	/* Anytype wrapMenu: a 48px left rail every block shares — content
	   always starts at the same x; the handle hangs in the margin. */
	.gutter {
		width: 48px;
		flex: 0 0 48px;
		position: relative;
	}
	/* Anytype .icon.commonDnd: 12px-wide full-height pill, 3-dot column,
	   invisible until block hover, grab cursor. */
	.handle {
		position: absolute;
		right: 6px;
		top: 0;
		height: 100%;
		min-height: 24px;
		width: 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: none;
		color: var(--muted);
		cursor: grab;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.1s;
		padding: 0;
	}
	.handle :global(svg) {
		width: 2px;
		height: 12px;
	}
	/* Hover-only: on touch, a :hover rule that reveals content makes iOS
	   spend the FIRST tap emulating hover (handle appears) and only the
	   second tap clicks - toggles felt like they needed two taps. */
	@media (hover: hover) {
		.block:hover > .gutter .handle {
			opacity: 1;
		}
	}
	/* Touch can't hover: show the handle only on the ACTIVE block (the
	   one whose text is focused). Static pseudo-classes trigger no iOS
	   first-tap hover emulation. :has(> .text:focus) keeps ancestor
	   toggles from also sprouting handles for a focused child. */
	@media (hover: none) {
		.block:has(> .text:focus) > .gutter .handle {
			opacity: 0.7;
		}
	}
	.handle:hover {
		background: var(--hover);
		border-color: var(--hover);
		color: var(--fg);
	}
	/* Anytype marker: 24×24 box, 20×20 circle icon, muted → accent when checked. */
	.check-circle {
		width: 24px;
		height: 24px;
		flex: none;
		margin-top: 3px;
		padding: 0;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.check-circle svg {
		width: 20px;
		height: 20px;
	}
	.check-circle:hover .ring {
		fill: rgb(79 79 79 / 0.08);
	}
	.check-circle.on {
		color: var(--accent);
	}
	/* Anytype markers: 24x24 box, 6px right margin, aligned to the line. */
	.toggle-arrow {
		background: none;
		border: none;
		color: var(--fg);
		width: 24px;
		height: 24px;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		margin-right: 6px;
		cursor: pointer;
		transition: transform 0.2s ease;
		padding: 0;
	}
	.toggle-arrow.open {
		transform: rotate(90deg);
	}
	.empty-toggle {
		flex-basis: 100%;
		display: block;
		background: none;
		border: none;
		margin-left: 30px;
		padding: 2px 0;
		font-size: inherit;
		color: var(--muted);
		cursor: pointer;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.empty-toggle:hover {
		color: var(--fg);
	}
	.marker {
		padding-top: 4px;
		color: var(--muted);
		flex: none;
	}
	.text {
		flex: 1;
		min-width: 60px;
		outline: none;
		padding: 3px 2px;
		line-height: 1.55;
		font-size: 15px;
		word-break: break-word;
		white-space: pre-wrap;
	}
	.text:empty::before {
		content: attr(data-placeholder);
		color: var(--muted);
		opacity: 0;
	}
	.text:focus:empty::before {
		opacity: 0.6;
	}
	.nested {
		padding-left: 26px;
	}
	.h1 { font-size: 28px; font-weight: 700; line-height: 1.3; }
	.h2 { font-size: 22px; font-weight: 650; line-height: 1.3; }
	.h3 { font-size: 18px; font-weight: 600; line-height: 1.3; }
	.title { font-size: 34px; font-weight: 750; }
	.quote { border-left: 3px solid var(--accent); padding-left: 12px; font-style: italic; }
	.codeblock { font-family: ui-monospace, monospace; background: var(--panel); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
	.callout { background: var(--panel); border-radius: 8px; padding: 10px 12px; }
	.description { color: var(--muted); }
	/* Checked text dims (Anytype), no strikethrough. */
	.done { color: var(--muted); }
	.custom .chip {
		font-size: 11px;
		color: var(--muted);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 2px 8px;
	}
	:global(.m-bold) { font-weight: 700; }
	:global(.m-italic) { font-style: italic; }
	:global(.m-strike) { text-decoration: line-through; }
	:global(.m-underline) { text-decoration: underline; }
	:global(.m-code) {
		font-family: ui-monospace, monospace;
		background: var(--panel);
		border-radius: 4px;
		padding: 0 4px;
		font-size: 0.9em;
	}
	.embed {
		flex: 1;
		min-width: 0;
		width: 100%;
		aspect-ratio: 16 / 9;
		border: none;
		border-radius: 10px;
		background: #000;
		margin: 4px 0;
	}
	.embed.audio {
		aspect-ratio: auto;
		height: 152px;
		background: none;
	}
	.bookmark {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 10px;
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px 12px;
		margin: 4px 0;
		text-decoration: none;
		color: inherit;
	}
	.bookmark:hover {
		background: var(--hover);
	}
	.favicon {
		width: 20px;
		height: 20px;
		border-radius: 4px;
		flex: none;
	}
	.bm-meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.bm-title {
		font-size: 13px;
		font-weight: 550;
	}
	.bm-url {
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	:global(.m-link) { color: var(--accent); text-decoration: underline; cursor: pointer; }
	.block.selected::after {
		content: "";
		position: absolute;
		inset: 0;
		background: rgba(55, 122, 255, 0.25);
		border-radius: 2px;
		pointer-events: none;
		z-index: 10;
	}
	/* Anytype block/link.tsx text style: icon + medium name, underline
	   from a light border, brightening on hover. NOTE: the row must keep
	   default (stretch) alignment - the gutter/handle pill spans the block
	   height like every other block. */
	.link-wrap {
		flex: 1;
		display: flex;
		min-width: 0;
		padding: 3px 2px;
	}
	.link-body {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--fg);
		text-decoration: none;
		min-width: 0;
	}
	.link-icon {
		font-size: 18px;
		line-height: 20px;
		flex: none;
	}
	.link-name {
		font-weight: 500;
		border-bottom: 1px solid var(--border);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.link-body:hover .link-name {
		border-bottom-color: var(--fg);
	}
	.link-body.deleted {
		color: var(--muted);
	}
	.link-body.deleted .link-name {
		border-bottom: none;
	}
	.link-card {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 2px;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		min-width: 240px;
		max-width: 100%;
		color: var(--fg);
		text-decoration: none;
		box-shadow: 0 0 4px rgba(0, 0, 0, 0.05);
		transition: border-color 0.15s;
	}
	.link-card:hover {
		border-color: var(--muted);
	}
	.link-card .card-name {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.link-card .link-name {
		border-bottom: none;
	}
	.link-card .card-type {
		font-size: 12px;
		line-height: 16px;
		color: var(--muted);
	}
	.bot-strip {
		position: absolute;
		left: 0;
		right: 0;
		bottom: -4px;
		height: 10px;
		z-index: 5;
	}
	/* Anytype .dropTarget.targetBot.isOver.bottom: 2px accent line inset. */
	.bot-strip.over {
		box-shadow: 0 2px 0 var(--accent) inset;
	}
	/* Mobile: the 48px drag rail collapses to the shared 16px gutter -
	   handles are hover-only and meaningless on touch. */
	@media (max-width: 720px) {
		.gutter {
			width: 16px;
			flex: 0 0 16px;
		}
		.block {
			padding-right: 16px;
		}
		.handle {
			/* right: 6px in a 16px gutter pushed the 12px handle to
			   x = -2 - clipped at the screen edge. */
			right: 2px;
		}
	}
</style>
