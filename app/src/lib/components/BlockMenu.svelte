<script lang="ts">
	import type { BlockJSON } from "$lib/types";
	import { Style } from "$lib/types";
	import { creatableTypes } from "$lib/create";

	export interface MenuAction {
		kind: "style" | "align" | "color" | "background" | "duplicate" | "delete" | "link_style" | "clear_style" | "turn_into_object";
		value?: number | string;
	}

	let {
		block,
		x,
		y,
		groupCount = 1,
		onaction,
		onclose,
	}: {
		block: BlockJSON;
		x: number;
		y: number;
		/** >1 when the menu acts on a multi-block selection. */
		groupCount?: number;
		onaction: (a: MenuAction) => void;
		onclose: () => void;
	} = $props();

	let filter = $state("");
	let filterEl = $state<HTMLInputElement>();
	let menuEl = $state<HTMLElement>();
	let flyoutEl = $state<HTMLElement>();

	$effect(() => {
		filterEl?.focus();
	});

	// Keep the menu on-screen.
	const MENU_W = 260;
	const pos = $derived.by(() => {
		const h = Math.min(440, window.innerHeight - 40);
		return {
			left: Math.max(8, Math.min(x, window.innerWidth - MENU_W - 12)),
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

	const t = $derived(block.content.text);
	const isLink = $derived(block.content.custom?.contentType === "link");

	// ── Current-value trailers for the root rows ─────────────────────
	const curStyle = $derived(STYLES.find((s) => s.value === t?.style)?.label ?? "Text");
	const curAlign = $derived(ALIGNS.find((a) => a.value === (block.align ?? 0))?.label ?? "Left");
	const curColor = $derived(COLORS.find((c) => c.text === (t?.color ?? "")) ?? COLORS[0]);
	const curBg = $derived(COLORS.find((c) => c.bg === (block.backgroundColor ?? "")) ?? COLORS[0]);

	// ── Submenu flyout (Anytype-style) ───────────────────────────────
	type SubKind = "style" | "align" | "color" | "background" | "turn";

	/** The space's creatable types (same list as the sidebar + button). */
	const TURN_TYPES = creatableTypes();
	let sub = $state<{ kind: SubKind; top: number } | null>(null);

	function toggleSub(kind: SubKind, e: MouseEvent) {
		if (sub?.kind === kind) {
			sub = null;
			return;
		}
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		sub = { kind, top: r.top };
	}

	/** Hover-open (mouse only - a tap synthesizes pointerenter AND click,
	 *  which would open-then-toggle-shut on touch). */
	function hoverSub(kind: SubKind, e: PointerEvent) {
		if (e.pointerType !== "mouse" || sub?.kind === kind) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		sub = { kind, top: r.top };
	}

	function hoverPlain(e: PointerEvent) {
		if (e.pointerType === "mouse") sub = null;
	}

	const SUB_W = 220;
	const subPos = $derived.by(() => {
		if (!sub) return null;
		const h = Math.min(420, window.innerHeight - 24);
		const rightX = pos.left + MENU_W - 6;
		const left = rightX + SUB_W + 12 <= window.innerWidth ? rightX : Math.max(8, pos.left - SUB_W + 6);
		return { left, top: Math.max(8, Math.min(sub.top, window.innerHeight - h - 12)) };
	});

	function fire(a: MenuAction) {
		onaction(a);
		onclose();
	}

	// ── Filter mode: flat leaf-action list (unchanged behavior) ──────
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
		const out: Item[] = [];
		if (isLink) {
			const cur = block.content.custom?.meta?.style ?? "text";
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
		for (const ty of TURN_TYPES) out.push({ section: "Turn into object", label: ty.name, action: { kind: "turn_into_object", value: ty.key } });
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

	const filtering = $derived(filter.trim().length > 0);

	function onWindowMousedown(e: MouseEvent) {
		const n = e.target as Node;
		if (menuEl && !menuEl.contains(n) && !(flyoutEl && flyoutEl.contains(n))) onclose();
	}
</script>

<svelte:window
	onmousedown={onWindowMousedown}
	onkeydown={(e) => {
		if (e.key === "Escape") {
			if (sub) sub = null;
			else onclose();
		}
	}}
/>

<div class="block-menu" bind:this={menuEl} style="left:{pos.left}px; top:{pos.top}px" role="menu" tabindex="-1">
	<input bind:this={filterEl} bind:value={filter} placeholder="Filter actions…" oninput={() => (sub = null)} />
	{#if groupCount > 1}
		<div class="group-note">Applies to {groupCount} selected blocks</div>
	{/if}
	{#if filtering}
		<div class="scroll">
			{#each sections as section (section.name)}
				<div class="section">
					<div class="section-name">{section.name}</div>
					{#each section.items as item (section.name + item.label)}
						<button class:active={item.active} class:danger={item.label === "Delete"} onclick={() => fire(item.action)}>
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
	{:else}
		<div class="scroll">
			{#if isLink}
				<div class="section-name">Appearance</div>
				{#each [{ label: "Text", value: "text" }, { label: "Card", value: "card" }] as o (o.value)}
					<button class:active={(block.content.custom?.meta?.style ?? "text") === o.value} onclick={() => fire({ kind: "link_style", value: o.value })}>
						{o.label}
						{#if (block.content.custom?.meta?.style ?? "text") === o.value}<span class="check">✓</span>{/if}
					</button>
				{/each}
			{/if}
			<div class="section-name">{t ? "Text" : "Block"}</div>
			{#if t}
				<button class="sub-row" class:open={sub?.kind === "style"} onclick={(e) => toggleSub("style", e)} onpointerenter={(e) => hoverSub("style", e)}>
					Style
					<span class="trail">{curStyle}<span class="chev">›</span></span>
				</button>
			{/if}
			<button class="sub-row" class:open={sub?.kind === "align"} onclick={(e) => toggleSub("align", e)} onpointerenter={(e) => hoverSub("align", e)}>
				Align
				<span class="trail">{curAlign}<span class="chev">›</span></span>
			</button>
			{#if t}
				<button class="sub-row" class:open={sub?.kind === "color"} onclick={(e) => toggleSub("color", e)} onpointerenter={(e) => hoverSub("color", e)}>
					Color
					<span class="trail"><span class="dot" style="background:{curColor.text || 'var(--fg)'}"></span><span class="chev">›</span></span>
				</button>
			{/if}
			<button class="sub-row" class:open={sub?.kind === "background"} onclick={(e) => toggleSub("background", e)} onpointerenter={(e) => hoverSub("background", e)}>
				Background
				<span class="trail"><span class="dot" style="background:{curBg.bg || 'transparent'}"></span><span class="chev">›</span></span>
			</button>
			{#if t}
				<button onpointerenter={hoverPlain} onclick={() => fire({ kind: "clear_style" })}>Clear style</button>
			{/if}
			<div class="sep"></div>
			<button class="sub-row" class:open={sub?.kind === "turn"} onclick={(e) => toggleSub("turn", e)} onpointerenter={(e) => hoverSub("turn", e)}>
				Turn into object
				<span class="trail"><span class="chev">›</span></span>
			</button>
			<button onpointerenter={hoverPlain} onclick={() => fire({ kind: "duplicate" })}>Duplicate</button>
			<button class="danger" onpointerenter={hoverPlain} onclick={() => fire({ kind: "delete" })}>Delete block</button>
		</div>
	{/if}
</div>

{#if sub && subPos}
	<div class="flyout" bind:this={flyoutEl} style="left:{subPos.left}px; top:{subPos.top}px" role="menu" tabindex="-1">
		{#if sub.kind === "style" && t}
			{#each STYLES as s (s.value)}
				<button class:active={t.style === s.value} onclick={() => fire({ kind: "style", value: s.value })}>
					<span class="preview {s.cls}">{s.preview}</span>
					<span class="texts">
						<span class="label-line">{s.label}</span>
						<span class="desc">{s.desc}</span>
					</span>
					{#if t.style === s.value}<span class="check">✓</span>{/if}
				</button>
			{/each}
		{:else if sub.kind === "align"}
			{#each ALIGNS as a (a.value)}
				<button class:active={(block.align ?? 0) === a.value} onclick={() => fire({ kind: "align", value: a.value })}>
					{a.label}
					{#if (block.align ?? 0) === a.value}<span class="check">✓</span>{/if}
				</button>
			{/each}
		{:else if sub.kind === "color" && t}
			{#each COLORS as c (c.name)}
				<button class="cap" class:active={(t.color ?? "") === c.text} onclick={() => fire({ kind: "color", value: c.text })}>
					<span class="dot" style="background:{c.text || 'var(--fg)'}"></span>
					{c.name}
					{#if (t.color ?? "") === c.text}<span class="check">✓</span>{/if}
				</button>
			{/each}
		{:else if sub.kind === "turn"}
			{#each TURN_TYPES as ty (ty.key)}
				<button onclick={() => fire({ kind: "turn_into_object", value: ty.key })}>
					<span class="glyph">{ty.icon}</span>
					{ty.name}
				</button>
			{/each}
		{:else if sub.kind === "background"}
			{#each COLORS as c (c.name)}
				<button class="cap" class:active={(block.backgroundColor ?? "") === c.bg} onclick={() => fire({ kind: "background", value: c.bg })}>
					<span class="dot ring" style="background:{c.bg || 'transparent'}"></span>
					{c.name}
					{#if (block.backgroundColor ?? "") === c.bg}<span class="check">✓</span>{/if}
				</button>
			{/each}
		{/if}
	</div>
{/if}

<style>
	.block-menu {
		position: fixed;
		width: 260px;
		max-height: 440px;
		display: flex;
		flex-direction: column;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		z-index: 100;
		overflow: hidden;
	}
	.flyout {
		position: fixed;
		width: 220px;
		max-height: 420px;
		overflow-y: auto;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 10px;
		box-shadow: 0 16px 48px rgb(0 0 0 / 0.5);
		z-index: 101;
		padding: 4px;
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
	.sep {
		height: 1px;
		background: var(--border);
		margin: 4px 6px;
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
		padding: 7px 10px;
		border-radius: 6px;
		font-size: 13px;
		cursor: pointer;
	}
	button:hover,
	button.open {
		background: var(--hover);
	}
	button.active {
		color: var(--accent);
	}
	button.danger {
		color: #f55522;
	}
	button.cap {
		text-transform: capitalize;
	}
	.trail {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--muted);
		font-size: 12px;
	}
	.chev {
		font-size: 15px;
		line-height: 1;
	}
	.dot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		flex: none;
	}
	.dot.ring,
	.trail .dot {
		border: 1px solid var(--border);
	}
	.glyph {
		width: 18px;
		text-align: center;
		flex: none;
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
	.group-note {
		font-size: 11px;
		color: var(--accent);
		padding: 6px 12px 0;
	}
</style>
