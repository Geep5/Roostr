<script lang="ts">
	import type { BlockJSON, ObjectJSON } from "$lib/types";
	import { Pos, Style, Layout } from "$lib/types";
	import { toHtml } from "$lib/marks";
	import BlockNode from "./BlockNode.svelte";
	import TableBlock from "./TableBlock.svelte";
	import RelationBlock from "./RelationBlock.svelte";
	import { isToggleOpen, setToggleOpen } from "$lib/toggles";

	let {
		id,
		byId,
		object,
		draggingId,
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
	}: {
		id: string;
		byId: Map<string, BlockJSON>;
		object: ObjectJSON;
		draggingId: string;
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

	function computeZone(e: DragEvent): number {
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width;
		const y = (e.clientY - r.top) / r.height;
		if (x < 0.15) return Pos.LEFT;
		if (x > 0.85) return Pos.RIGHT;
		return y < 0.5 ? Pos.TOP : Pos.BOTTOM;
	}
</script>

{#if block}
	{#if block.content.layout?.style === Layout.ROW}
		<div class="row" data-block={block.id} style="grid-template-columns: {block.childrenIds.map(widthOf).join(' ')}">
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {object} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} />
			{/each}
		</div>
	{:else if block.content.layout?.style === Layout.COLUMN}
		<div class="col" data-block={block.id}>
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {object} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} />
			{/each}
		</div>
	{:else if block.content.table}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}"
			data-table={block.id}
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
					}}>⠿</button
				>
			</div>
			<TableBlock {block} {byId} objectId={object.id} {onrefresh} {oninput} {onblur} />
		</div>
	{:else if block.content.text}
		{@const t = block.content.text}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}"
			data-block={block.id}
			role="presentation"
			style={block.backgroundColor ? `background:${block.backgroundColor}` : ""}
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
					}}>⠿</button
				>
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
				<button class="toggle-arrow" class:open={toggleOpen} aria-label={toggleOpen ? "Collapse" : "Expand"} onclick={flipToggle}>▶</button>
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
				data-placeholder={t.style === Style.TITLE ? "Untitled" : "Type / for commands"}
			></div>
			{#if block.childrenIds.length > 0 && (!isToggle || toggleOpen)}
				<div class="nested">
					{#each block.childrenIds as cid (cid)}
						<BlockNode id={cid} {byId} {object} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} />
					{/each}
				</div>
			{/if}
		</div>
	{:else if block.content.custom?.contentType === "relation"}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}"
			data-table={block.id}
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
					}}>⠿</button
				>
			</div>
			<RelationBlock {block} {object} {onrefresh} />
		</div>
	{:else if block.content.custom?.contentType === "embed" || block.content.custom?.contentType === "bookmark"}
		{@const meta = block.content.custom.meta ?? {}}
		<div
			class="block zone-{zone} {draggingId === block.id ? 'dragging' : ''}"
			data-table={block.id}
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
					}}>⠿</button
				>
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
	{:else if block.content.custom}
		<div class="block custom" data-block={block.id}>
			<span class="chip">{block.content.custom.contentType}</span>
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {object} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} {onrefresh} {onpaste} />
			{/each}
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
	.block {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 4px;
		padding: 1px 0;
		border-radius: 4px;
		flex-wrap: wrap;
	}
	.block.dragging {
		opacity: 0.4;
	}
	.block.zone-1 { box-shadow: 0 -2px 0 var(--accent); }
	.block.zone-2 { box-shadow: 0 2px 0 var(--accent); }
	.block.zone-3 { box-shadow: -3px 0 0 var(--accent); }
	.block.zone-4 { box-shadow: 3px 0 0 var(--accent); }
	.gutter {
		width: 22px;
		flex: none;
		display: flex;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.1s;
		padding-top: 4px;
	}
	.block:hover > .gutter {
		opacity: 1;
	}
	.handle {
		border: none;
		background: none;
		color: var(--muted);
		cursor: grab;
		font-size: 13px;
		padding: 2px;
		border-radius: 4px;
	}
	.handle:hover {
		background: var(--hover);
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
	.toggle-arrow {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 9px;
		width: 20px;
		height: 24px;
		flex: none;
		cursor: pointer;
		transition: transform 0.15s;
		padding: 0;
	}
	.toggle-arrow.open {
		transform: rotate(90deg);
	}
	.toggle-arrow:hover {
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
		flex-basis: 100%;
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
</style>
