<script lang="ts">
	/**
	 * Anytype's add-menu (menu/block/add.tsx): opens at the caret when "/"
	 * is typed, sectioned items with a rendered style preview + description,
	 * filtered live by the text typed after the slash (name + aliases),
	 * arrow-key navigation. The editor owns the keyboard focus (typing keeps
	 * going into the block) and forwards nav keys via move()/confirm().
	 */
	import { Style, type RelationDefJSON } from "$lib/types";

	export type SlashPick =
		| { kind: "style"; value: number }
		| { kind: "table" }
		| { kind: "divider"; style: "line" | "dots" }
		| { kind: "relation"; key: string }
		| { kind: "property_add" }
		| { kind: "link_object" };
	let {
		filter,
		x,
		y,
		presentRelations = [],
		onpick,
		onclose,
	}: {
		filter: string;
		x: number;
		y: number;
		/** The object's already-present properties (Anytype inlines these). */
		presentRelations?: RelationDefJSON[];
		onpick: (item: SlashPick) => void;
		onclose: () => void;
	} = $props();

	interface Entry {
		section: string;
		label: string;
		desc: string;
		preview: string;
		cls: string;
		aliases: string[];
		pick: SlashPick;
	}

	/** Sections mirror Anytype's menuBlockAdd: Text / Lists / Other. */
	const ENTRIES: Entry[] = [
		{ section: "Text", label: "Text", desc: "Plain paragraph", preview: "Ag", cls: "pv-p", aliases: ["paragraph", "plain"], pick: { kind: "style", value: Style.PARAGRAPH } },
		{ section: "Text", label: "Heading 1", desc: "Big section heading", preview: "Ag", cls: "pv-h1", aliases: ["h1", "head1", "header1"], pick: { kind: "style", value: Style.HEADER1 } },
		{ section: "Text", label: "Heading 2", desc: "Medium section heading", preview: "Ag", cls: "pv-h2", aliases: ["h2", "head2", "header2"], pick: { kind: "style", value: Style.HEADER2 } },
		{ section: "Text", label: "Heading 3", desc: "Small section heading", preview: "Ag", cls: "pv-h3", aliases: ["h3", "head3", "header3"], pick: { kind: "style", value: Style.HEADER3 } },
		{ section: "Text", label: "Quote", desc: "Highlight a passage", preview: "Ag", cls: "pv-quote", aliases: ["quote", "blockquote"], pick: { kind: "style", value: Style.QUOTE } },
		{ section: "Text", label: "Callout", desc: "Bordered emphasis box", preview: "Ag", cls: "pv-callout", aliases: ["callout"], pick: { kind: "style", value: Style.CALLOUT } },
		{ section: "Lists", label: "Checkbox", desc: "Task with a to-do state", preview: "☑", cls: "pv-check", aliases: ["todo", "checkbox", "task"], pick: { kind: "style", value: Style.CHECKBOX } },
		{ section: "Lists", label: "Bulleted list", desc: "Simple list of items", preview: "•—", cls: "pv-list", aliases: ["bullet", "bulleted list", "ul"], pick: { kind: "style", value: Style.BULLET } },
		{ section: "Lists", label: "Numbered list", desc: "Ordered list of items", preview: "1—", cls: "pv-list", aliases: ["number", "numbered list", "ol"], pick: { kind: "style", value: Style.NUMBERED } },
		{ section: "Lists", label: "Toggle", desc: "Collapsible content", preview: "▸", cls: "pv-list", aliases: ["toggle", "collapse"], pick: { kind: "style", value: Style.TOGGLE } },
		{ section: "Other", label: "Code", desc: "Monospaced snippet", preview: "</>", cls: "pv-code", aliases: ["code", "snippet"], pick: { kind: "style", value: Style.CODE } },
		{ section: "Other", label: "Table", desc: "3×3 simple table", preview: "⊞", cls: "pv-table", aliases: ["table", "grid"], pick: { kind: "table" } },
		{ section: "Other", label: "Line divider", desc: "Horizontal line separator", preview: "—", cls: "pv-div", aliases: ["line", "divider", "hr", "---"], pick: { kind: "divider", style: "line" } },
		{ section: "Other", label: "Dots divider", desc: "Three dots separator", preview: "···", cls: "pv-div", aliases: ["dots", "dot divider", "***"], pick: { kind: "divider", style: "dots" } },
		// Anytype menuBlockAdd getBlockLink: "Link to existing page" (alias "link").
		{ section: "Other", label: "Link to object", desc: "Embed a link to an existing object", preview: "🔗", cls: "pv-link", aliases: ["link", "object", "existing", "page"], pick: { kind: "link_object" } },
	];

	/** Anytype's slash "Relations" section (menu/block/add.tsx:111-131):
	 * "New relation" first, then only the OBJECT's present properties. */
	const relationEntries = $derived.by((): Entry[] => [
		{
			section: "Properties",
			label: "Add property",
			desc: "pick existing or create new",
			preview: "＋",
			cls: "pv-rel",
			aliases: ["property", "relation", "field", "add property", "new property"],
			pick: { kind: "property_add" } as SlashPick,
		},
		...presentRelations.map((r) => ({
			section: "Properties",
			label: r.name || r.key,
			desc: r.format,
			preview: "≔",
			cls: "pv-rel",
			aliases: [r.key, "property", "relation"],
			pick: { kind: "relation", key: r.key } as SlashPick,
		})),
	]);

	const all = $derived([...ENTRIES, ...relationEntries]);

	const filtered = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		if (!q) return all;
		return all.filter(
			(e) => e.label.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q) || e.aliases.some((a) => a.includes(q)),
		);
	});

	let sel = $state(0);

	// Clamp/reset selection when the filter changes the list.
	$effect(() => {
		if (sel >= filtered.length) sel = Math.max(0, filtered.length - 1);
	});

	// Anytype auto-closes once the filter clearly matches nothing.
	$effect(() => {
		if (filtered.length === 0 && filter.length > 3) onclose();
	});

	export function move(delta: number) {
		if (!filtered.length) return;
		sel = (sel + delta + filtered.length) % filtered.length;
		menuEl?.querySelectorAll(".item")[sel]?.scrollIntoView({ block: "nearest" });
	}

	export function confirm() {
		const item = filtered[sel];
		if (item) onpick(item.pick);
		else onclose();
	}

	let menuEl = $state<HTMLElement>();

	// Keep on-screen; flip above the caret when there's no room below.
	const pos = $derived.by(() => {
		const w = 300;
		const h = Math.min(360, 12 + filtered.length * 46);
		const left = Math.min(x, window.innerWidth - w - 12);
		const top = y + h > window.innerHeight - 12 ? Math.max(12, y - h - 28) : y;
		return { left, top };
	});

	function onWindowPointerDown(e: PointerEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="slash-menu" bind:this={menuEl} style="left: {pos.left}px; top: {pos.top}px">
	{#if filtered.length === 0}
		<div class="none">No matches</div>
	{/if}
	{#each filtered as item, i (item.section + item.label)}
		{#if i === 0 || filtered[i - 1].section !== item.section}
			<div class="section">{item.section}</div>
		{/if}
		<button
			class="item"
			class:sel={i === sel}
			onpointerenter={() => (sel = i)}
			onclick={() => onpick(item.pick)}
		>
			<span class="preview {item.cls}">{item.preview}</span>
			<span class="meta">
				<span class="label">{item.label}</span>
				<span class="desc">{item.desc}</span>
			</span>
		</button>
	{/each}
</div>

<style>
	.slash-menu {
		position: fixed;
		z-index: 120;
		width: 300px;
		max-height: 360px;
		overflow-y: auto;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
	}
	.section {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		padding: 8px 8px 4px;
	}
	.item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		border: none;
		background: none;
		color: var(--fg, inherit);
		padding: 5px 8px;
		border-radius: 8px;
		cursor: pointer;
		text-align: left;
	}
	.item.sel {
		background: var(--hover);
	}
	.preview {
		flex: 0 0 36px;
		height: 36px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg, transparent);
	}
	.meta {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.label {
		font-size: 13px;
		font-weight: 550;
	}
	.desc {
		font-size: 11px;
		color: var(--muted);
	}
	.none {
		padding: 12px;
		font-size: 12px;
		color: var(--muted);
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
	.pv-table { font-size: 16px; color: var(--muted); }
	.pv-rel { font-size: 14px; color: var(--accent); }
</style>
