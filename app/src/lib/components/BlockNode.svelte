<script lang="ts">
	import type { BlockJSON } from "$lib/types";
	import { Pos, Style, Layout } from "$lib/types";
	import { toHtml } from "$lib/marks";
	import BlockNode from "./BlockNode.svelte";

	let {
		id,
		byId,
		draggingId,
		onkeydown,
		oninput,
		onblur,
		onselect,
		ondragbegin,
		ondrop,
		ontogglecheck,
		onmenu,
	}: {
		id: string;
		byId: Map<string, BlockJSON>;
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
	} = $props();

	const block = $derived(byId.get(id));
	let zone = $state(0); // 0 none, else Pos value
	let textEl: HTMLElement | undefined = $state();

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
				<BlockNode id={cid} {byId} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} />
			{/each}
		</div>
	{:else if block.content.layout?.style === Layout.COLUMN}
		<div class="col" data-block={block.id}>
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} />
			{/each}
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
				<input class="check" type="checkbox" checked={t.checked ?? false} onchange={(e) => ontogglecheck(block.id, e.currentTarget.checked)} />
			{/if}
			{#if t.style === Style.BULLET}<span class="marker">•</span>{/if}
			{#if t.style === Style.NUMBERED}<span class="marker">1.</span>{/if}
			<div
				role="textbox"
				tabindex="0"
				aria-multiline="false"
				class="text {STYLE_CLASS[t.style] ?? 'p'} {t.checked && t.style === Style.CHECKBOX ? 'done' : ''}"
				style="{t.color ? `color:${t.color};` : ''}{block.align ? `text-align:${['left', 'center', 'right', 'justify'][block.align]};` : ''}"
				contenteditable="true"
				bind:this={textEl}
				onkeydown={(e) => onkeydown(e, block.id)}
				oninput={() => oninput(block.id)}
				onblur={() => onblur(block.id)}
				onmouseup={() => onselect(block.id)}
				onkeyup={(e) => {
					if (e.shiftKey || e.key.startsWith("Arrow")) onselect(block.id);
				}}
				data-placeholder={t.style === Style.TITLE ? "Untitled" : "Type / for commands"}
			></div>
			{#if block.childrenIds.length > 0}
				<div class="nested">
					{#each block.childrenIds as cid (cid)}
						<BlockNode id={cid} {byId} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} />
					{/each}
				</div>
			{/if}
		</div>
	{:else if block.content.custom}
		<div class="block custom" data-block={block.id}>
			<span class="chip">{block.content.custom.contentType}</span>
			{#each block.childrenIds as cid (cid)}
				<BlockNode id={cid} {byId} {draggingId} {onkeydown} {oninput} {onblur} {onselect} {ondragbegin} {ondrop} {ontogglecheck} {onmenu} />
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
	.check {
		margin-top: 8px;
		accent-color: var(--accent);
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
	.done { text-decoration: line-through; color: var(--muted); }
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
	:global(.m-link) { color: var(--accent); text-decoration: underline; cursor: pointer; }
</style>
