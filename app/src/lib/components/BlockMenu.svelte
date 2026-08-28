<script lang="ts">
	import type { BlockJSON } from "$lib/types";
	import { Style } from "$lib/types";

	export interface MenuAction {
		kind: "style" | "align" | "color" | "background" | "duplicate" | "delete" | "link_style";
		value?: number | string;
	}

	let {
		block,
		x,
		y,
		onaction,
		onclose,
	}: {
		block: BlockJSON;
		x: number;
		y: number;
		onaction: (a: MenuAction) => void;
		onclose: () => void;
	} = $props();

	let filter = $state("");
	let filterEl = $state<HTMLInputElement>();
	let menuEl = $state<HTMLElement>();

	$effect(() => {
		filterEl?.focus();
	});

	// Keep the menu on-screen.
	const pos = $derived.by(() => {
		const w = 260;
		const h = Math.min(480, window.innerHeight - 40);
		return {
			left: Math.min(x, window.innerWidth - w - 12),
			top: Math.min(y, window.innerHeight - h - 12),
		};
	});

	/** Turn-into entries with a rendered preview + description, Anytype-style. */
	const STYLES: Array<{ label: string; value: number; desc: string; preview: string; cls: string }> = [
		{ label: "Text", value: Style.PARAGRAPH, desc: "Plain paragraph", preview: "Ag", cls: "pv-p" },
		{ label: "Heading 1", value: Style.HEADER1, desc: "Big section heading", preview: "Ag", cls: "pv-h1" },
		{ label: "Heading 2", value: Style.HEADER2, desc: "Medium section heading", preview: "Ag", cls: "pv-h2" },
		{ label: "Heading 3", value: Style.HEADER3, desc: "Small section heading", preview: "Ag", cls: "pv-h3" },
		{ label: "Bulleted list", value: Style.BULLET, desc: "Simple list of items", preview: "•—", cls: "pv-list" },
		{ label: "Numbered list", value: Style.NUMBERED, desc: "Ordered list of items", preview: "1—", cls: "pv-list" },
		{ label: "Toggle", value: Style.TOGGLE, desc: "Collapsible content", preview: "▸", cls: "pv-list" },
		{ label: "Checkbox", value: Style.CHECKBOX, desc: "Task with a to-do state", preview: "☑", cls: "pv-check" },
		{ label: "Quote", value: Style.QUOTE, desc: "Highlight a passage", preview: "Ag", cls: "pv-quote" },
		{ label: "Code", value: Style.CODE, desc: "Monospaced snippet", preview: "</>", cls: "pv-code" },
		{ label: "Callout", value: Style.CALLOUT, desc: "Bordered emphasis box", preview: "Ag", cls: "pv-callout" },
	];

	const ALIGNS: Array<{ label: string; value: number }> = [
		{ label: "Left", value: 0 },
		{ label: "Center", value: 1 },
		{ label: "Right", value: 2 },
	];

	/** Anytype's palette names, dark-theme values. */
	const COLORS: Array<{ name: string; text: string; bg: string }> = [
		{ name: "default", text: "", bg: "" },
		{ name: "grey", text: "#8b909b", bg: "#3d3f45" },
		{ name: "yellow", text: "#ecd91b", bg: "#4c4523" },
		{ name: "orange", text: "#ffb522", bg: "#4f3d20" },
		{ name: "red", text: "#f55522", bg: "#4e2c21" },
		{ name: "pink", text: "#e51ca0", bg: "#4a2242" },
		{ name: "purple", text: "#ab50cc", bg: "#3e2a4a" },
		{ name: "blue", text: "#628df2", bg: "#26304c" },
		{ name: "teal", text: "#0fc8ba", bg: "#1a4341" },
		{ name: "lime", text: "#5dd400", bg: "#2f4218" },
	];

	interface Item {
		section: string;
		label: string;
		action: MenuAction;
		active?: boolean;
		swatch?: string;
		desc?: string;
		preview?: string;
		previewClass?: string;
	}

	const items = $derived.by((): Item[] => {
		const t = block.content.text;
		const out: Item[] = [];
		if (block.content.custom?.contentType === "link") {
			const cur = block.content.custom.meta?.style ?? "text";
			out.push({ section: "Appearance", label: "Text", action: { kind: "link_style", value: "text" }, active: cur === "text", preview: "Ag", previewClass: "pv-p", desc: "Inline link" });
			out.push({ section: "Appearance", label: "Card", action: { kind: "link_style", value: "card" }, active: cur === "card", preview: "▭", previewClass: "pv-p", desc: "Bordered preview card" });
		}
		if (t) {
			for (const s of STYLES) {
				out.push({
					section: "Turn into",
					label: s.label,
					action: { kind: "style", value: s.value },
					active: t.style === s.value,
					desc: s.desc,
					preview: s.preview,
					previewClass: s.cls,
				});
			}
		}
		for (const a of ALIGNS) out.push({ section: "Align", label: a.label, action: { kind: "align", value: a.value }, active: (block.align ?? 0) === a.value });
		if (t) {
			for (const c of COLORS) out.push({ section: "Color", label: c.name, action: { kind: "color", value: c.text }, active: (t.color ?? "") === c.text, swatch: c.text || "var(--fg)" });
		}
		for (const c of COLORS) out.push({ section: "Background", label: c.name, action: { kind: "background", value: c.bg }, active: (block.backgroundColor ?? "") === c.bg, swatch: c.bg || "transparent" });
		out.push({ section: "Actions", label: "Duplicate", action: { kind: "duplicate" } });
		out.push({ section: "Actions", label: "Delete", action: { kind: "delete" } });
		const f = filter.trim().toLowerCase();
		return f ? out.filter((i) => i.label.toLowerCase().includes(f) || i.section.toLowerCase().includes(f)) : out;
	});

	const sections = $derived.by(() => {
		const order: string[] = [];
		const grouped = new Map<string, Item[]>();
		for (const i of items) {
			if (!grouped.has(i.section)) {
				grouped.set(i.section, []);
				order.push(i.section);
			}
			grouped.get(i.section)!.push(i);
		}
		return order.map((name) => ({ name, items: grouped.get(name)! }));
	});

	function onWindowMousedown(e: MouseEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window
	onmousedown={onWindowMousedown}
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
/>

<div class="block-menu" bind:this={menuEl} style="left:{pos.left}px; top:{pos.top}px" role="menu" tabindex="-1">
	<input bind:this={filterEl} bind:value={filter} placeholder="Filter actions…" />
	<div class="scroll">
		{#each sections as section (section.name)}
			<div class="section">
				<div class="section-name">{section.name}</div>
				{#each section.items as item (section.name + item.label)}
					<button
						class:active={item.active}
						class:danger={item.label === "Delete"}
						onclick={() => {
							onaction(item.action);
							onclose();
						}}
					>
						{#if item.swatch !== undefined}
							<span class="swatch" style="background:{item.swatch}"></span>
						{/if}
						{#if item.preview}
							<span class="preview {item.previewClass}">{item.preview}</span>
							<span class="texts">
								<span class="label-line">{item.label}</span>
								<span class="desc">{item.desc}</span>
							</span>
						{:else}
							{item.label}
						{/if}
						{#if item.active}<span class="check">✓</span>{/if}
					</button>
				{/each}
			</div>
		{/each}
		{#if items.length === 0}
			<div class="none">No matching actions</div>
		{/if}
	</div>
</div>

<style>
	.block-menu {
		position: fixed;
		width: 260px;
		max-height: 480px;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		z-index: 100;
		overflow: hidden;
	}
	input {
		background: none;
		border: none;
		border-bottom: 1px solid var(--border);
		color: var(--fg);
		padding: 10px 12px;
		font-size: 13px;
		outline: none;
	}
	.scroll {
		overflow-y: auto;
		padding: 4px;
	}
	.section-name {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 8px 10px 4px;
	}
	button {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		color: var(--fg);
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
	}
	button:hover {
		background: var(--hover);
	}
	button.active {
		color: var(--accent);
	}
	button.danger {
		color: #f55522;
	}
	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 4px;
		border: 1px solid var(--border);
		flex: none;
	}
	.check {
		margin-left: auto;
	}
	.none {
		color: var(--muted);
		font-size: 13px;
		padding: 12px;
	}
	.preview {
		width: 34px;
		height: 30px;
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--fg);
		overflow: hidden;
	}
	.pv-p { font-size: 12px; color: var(--muted); }
	.pv-h1 { font-size: 16px; font-weight: 750; }
	.pv-h2 { font-size: 14px; font-weight: 650; }
	.pv-h3 { font-size: 12px; font-weight: 600; }
	.pv-list { font-size: 11px; letter-spacing: 1px; color: var(--muted); }
	.pv-check { font-size: 14px; color: var(--accent); }
	.pv-quote { font-size: 12px; font-style: italic; border-left: 3px solid var(--accent); }
	.pv-code { font-family: ui-monospace, monospace; font-size: 10px; color: var(--muted); }
	.pv-callout { font-size: 12px; background: var(--hover); }
	.texts {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}
	.label-line {
		font-size: 13px;
	}
	.desc {
		font-size: 11px;
		color: var(--muted);
	}
</style>
