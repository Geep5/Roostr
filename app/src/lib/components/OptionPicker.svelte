<script lang="ts">
	/**
	 * Anytype's option list + edit (menu/dataview/option/{list,edit}.tsx):
	 * a filter box over the property's options; typing an unknown name
	 * offers `Create option "<name>"` (random palette color); every row has
	 * a ⋯ edit affordance opening name + the 10-swatch color palette +
	 * Delete option. Select (status) picks one; multi-select toggles.
	 */
	import type { RelationDefJSON } from "$lib/types";
	import { TAG_COLORS, addOption, deleteOption, renameOption, setOptionColor, tagStyle } from "$lib/options";

	let {
		rel,
		selected,
		multi,
		onpick,
	}: {
		rel: RelationDefJSON;
		/** Currently applied option texts. */
		selected: string[];
		multi: boolean;
		/** Toggle/select an option text. */
		onpick: (text: string) => void;
	} = $props();

	let query = $state("");
	let editing = $state(""); // option id with the edit panel open
	let nameDraft = $state("");

	const q = $derived(query.trim().toLowerCase());
	const matches = $derived(q ? rel.options.filter((o) => o.text.toLowerCase().includes(q)) : rel.options);
	const exact = $derived(rel.options.some((o) => o.text.toLowerCase() === q));
	const canCreate = $derived(q !== "" && !exact);

	async function create() {
		const opt = await addOption(rel, query.trim());
		query = "";
		onpick(opt.text);
	}

	function openEdit(id: string, text: string) {
		editing = editing === id ? "" : id;
		nameDraft = text;
	}

	async function commitRename(id: string) {
		await renameOption(rel, id, nameDraft);
		editing = "";
	}
</script>

<div class="opts">
	<input
		bind:value={query}
		placeholder={rel.options.length ? "Filter or create…" : "Type to create an option…"}
		onkeydown={(e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				if (matches[0]) onpick(matches[0].text);
				else if (canCreate) void create();
			}
		}}
	/>
	{#if canCreate}
		<button class="row create" onclick={() => void create()}>＋ Create option “{query.trim()}”</button>
	{/if}
	{#each matches as o (o.id)}
		<div class="row-wrap">
			<button class="row" class:on={selected.includes(o.text)} onclick={() => onpick(o.text)}>
				<span class="chip" style={tagStyle(o.color)}>{o.text}</span>
				{#if selected.includes(o.text)}<span class="check">✓</span>{/if}
			</button>
			<button class="more" title="Edit option" onclick={() => openEdit(o.id, o.text)}>⋯</button>
		</div>
		{#if editing === o.id}
			<div class="edit">
				<input
					bind:value={nameDraft}
					onkeydown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void commitRename(o.id);
						}
					}}
					onblur={() => void commitRename(o.id)}
				/>
				<div class="palette">
					{#each TAG_COLORS as c (c.name)}
						<button
							class="swatch"
							class:active={o.color === c.name}
							title={c.name}
							style="background:{c.hex}"
							onclick={() => {
								editing = "";
								void setOptionColor(rel, o.id, c.name);
							}}
						></button>
					{/each}
				</div>
				<button
					class="delete"
					onclick={() => {
						editing = "";
						void deleteOption(rel, o.id);
					}}>Delete option</button
				>
			</div>
		{/if}
	{/each}
	{#if matches.length === 0 && !canCreate}
		<span class="none">No options yet — type a name.</span>
	{/if}
	{#if !multi && selected.length > 0}
		<button class="row clear" onclick={() => onpick(selected[0])}>Clear</button>
	{/if}
</div>

<style>
	.opts {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 220px;
	}
	input {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 13px;
		padding: 5px 9px;
		outline: none;
		margin-bottom: 2px;
	}
	input:focus {
		border-color: var(--accent);
	}
	.row-wrap {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.row {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		background: none;
		border: none;
		padding: 4px 6px;
		border-radius: 6px;
		cursor: pointer;
		text-align: left;
		color: var(--fg);
		font-size: 13px;
	}
	.row:hover {
		background: var(--hl-med);
	}
	.row.create {
		color: var(--accent);
	}
	/* Anytype tagItem: filled pill, pale text. */
	.chip {
		border-radius: 10px;
		padding: 0 6px;
		font-size: 12px;
		line-height: 20px;
		height: 20px;
	}
	.check {
		margin-left: auto;
		color: var(--muted);
	}
	.more {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 4px;
		opacity: 0.5;
	}
	.row-wrap:hover .more {
		opacity: 1;
	}
	.more:hover {
		background: var(--hl-med);
		color: var(--fg);
	}
	.edit {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 8px 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		margin: 2px 0 4px;
	}
	.palette {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.swatch {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		border: 2px solid transparent;
		cursor: pointer;
		padding: 0;
	}
	.swatch.active {
		border-color: var(--fg);
	}
	.delete {
		background: none;
		border: none;
		color: #e05555;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
		padding: 2px 0 0;
	}
	.none {
		color: var(--muted);
		font-size: 12px;
		padding: 2px 6px;
	}
	.clear {
		color: var(--muted);
	}
</style>
