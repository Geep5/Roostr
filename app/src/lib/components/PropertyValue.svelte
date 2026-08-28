<script lang="ts">
	/**
	 * The one per-format value editor, covering Anytype's relation formats
	 * (interface/object.ts RelationType): shorttext, longtext, number,
	 * status (Select), tag (MultiSelect), date (calendar picker), checkbox,
	 * url/email/phone (typed input + open link), object (link picker).
	 * File is deferred (no blob storage yet); Icon is covered by the icon
	 * button; Relations is internal.
	 *
	 * Emits complete ValueJSON via onsave; the caller owns persistence.
	 */
	import type { RelationDefJSON, ValueJSON } from "$lib/types";
	import { store } from "$lib/data.svelte";
	import { objectIcon } from "$lib/icons";
	import CalendarPicker from "./CalendarPicker.svelte";
	import OptionPicker from "./OptionPicker.svelte";

	let {
		rel,
		value,
		onsave,
	}: {
		rel: RelationDefJSON;
		value: ValueJSON | undefined;
		onsave: (v: ValueJSON) => void | Promise<void>;
	} = $props();

	const text = $derived(value?.stringValue ?? "");
	const num = $derived(value?.intValue ?? value?.floatValue);
	const checked = $derived(value?.boolValue === true);
	const items = $derived((value?.valuesValue?.items ?? []).map((i) => i.stringValue ?? "").filter(Boolean));

	const sv = (s: string): ValueJSON => ({ stringValue: s });
	const list = (xs: string[]): ValueJSON => ({ valuesValue: { items: xs.map(sv) } });

	function saveNumber(raw: string) {
		const n = Number(raw);
		if (!Number.isFinite(n)) return;
		void onsave(Number.isInteger(n) ? { intValue: n } : { floatValue: n });
	}

	// ── Date ──────────────────────────────────────────────────────
	let dateOpen = $state(false);
	const dateLabel = $derived(num ? new Date(num).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "");

	// Status values: list with maxCount 1 (legacy objects used stringValue).
	const statusSelected = $derived(items.length ? items : text ? [text] : []);

	// ── Tags ──────────────────────────────────────────────────────
	async function toggleTag(tag: string) {
		const next = items.includes(tag) ? items.filter((t) => t !== tag) : [...items, tag];
		await onsave(list(next));
	}

	// ── Links (url / email / phone) ───────────────────────────────
	function linkHref(): string {
		if (rel.format === "email") return `mailto:${text}`;
		if (rel.format === "phone") return `tel:${text}`;
		return /^https?:\/\//.test(text) ? text : `https://${text}`;
	}

	// ── Object links ──────────────────────────────────────────────
	let objectQuery = $state("");
	let objectOpen = $state(false);
	const HIDDEN_TYPES: Record<string, true> = { program: true, relation: true, channel: true, pinned_fact: true, milestone: true, type: true, template: true, agent: true };
	const candidates = $derived.by(() => {
		const q = objectQuery.trim().toLowerCase();
		return store.summaries
			.filter((s) => !items.includes(s.id) && !HIDDEN_TYPES[s.typeKey])
			.filter((s) => !q || (s.name ?? "").toLowerCase().includes(q))
			.slice(0, 8);
	});
	function nameOf(id: string): string {
		return store.summaries.find((s) => s.id === id)?.name || id.slice(0, 8);
	}
	async function toggleObject(id: string) {
		const next = items.includes(id) ? items.filter((x) => x !== id) : [...items, id];
		objectQuery = "";
		await onsave(list(next));
	}
</script>

{#if rel.format === "checkbox"}
	<input type="checkbox" {checked} onchange={(e) => void onsave({ boolValue: e.currentTarget.checked })} />
{:else if rel.format === "number"}
	<input type="number" value={num ?? ""} placeholder="Empty" onchange={(e) => saveNumber(e.currentTarget.value)} />
{:else if rel.format === "date"}
	<span class="anchor">
		<button class="date-btn" class:empty={!num} onclick={() => (dateOpen = !dateOpen)}>
			{dateLabel || "Pick a date"}
		</button>
		{#if dateOpen}
			<CalendarPicker
				value={num ?? 0}
				onpick={(ms) => {
					dateOpen = false;
					void onsave(ms === null ? { intValue: 0 } : { intValue: ms });
				}}
				onclose={() => (dateOpen = false)}
			/>
		{/if}
	</span>
{:else if rel.format === "status"}
	<!-- Anytype option list: filter/create/edit options, pick one. -->
	<OptionPicker
		{rel}
		selected={statusSelected}
		multi={false}
		onpick={(t) => void onsave(list(statusSelected.includes(t) ? [] : [t]))}
	/>
{:else if rel.format === "tag"}
	<OptionPicker {rel} selected={items} multi={true} onpick={(t) => void toggleTag(t)} />
{:else if rel.format === "url" || rel.format === "email" || rel.format === "phone"}
	<span class="link-row">
		<input
			type={rel.format === "email" ? "email" : rel.format === "phone" ? "tel" : "url"}
			value={text}
			placeholder={rel.format === "email" ? "name@example.com" : rel.format === "phone" ? "+1 555 0100" : "example.com"}
			onchange={(e) => void onsave(sv(e.currentTarget.value.trim()))}
		/>
		{#if text}
			<a class="open" href={linkHref()} target="_blank" rel="noopener noreferrer" title="Open">↗</a>
		{/if}
	</span>
{:else if rel.format === "object"}
	<div class="objects">
		{#each items as id (id)}
			{@const s = store.summaries.find((x) => x.id === id)}
			<span class="obj-chip">
				<a href="/object/{id}">{objectIcon(undefined, s?.typeKey ?? "note")} {nameOf(id)}</a>
				<button title="Remove" onclick={() => void toggleObject(id)}>×</button>
			</span>
		{/each}
		<span class="anchor">
			<button class="pill" onclick={() => (objectOpen = !objectOpen)}>+ link object</button>
			{#if objectOpen}
				<div class="obj-menu">
					<input bind:value={objectQuery} placeholder="Search objects…" />
					{#each candidates as c (c.id)}
						<button
							class="obj-item"
							onclick={() => {
								objectOpen = false;
								void toggleObject(c.id);
							}}>{objectIcon(undefined, c.typeKey)} {c.name || "Untitled"} <span class="tk">{c.typeKey}</span></button
						>
					{/each}
					{#if candidates.length === 0}<span class="tk pad">No matches</span>{/if}
				</div>
			{/if}
		</span>
	</div>
{:else if rel.format === "longtext"}
	<textarea rows="3" placeholder="Empty" onchange={(e) => void onsave(sv(e.currentTarget.value))}>{text}</textarea>
{:else}
	<input type="text" value={text} placeholder="Empty" onchange={(e) => void onsave(sv(e.currentTarget.value))} />
{/if}

<style>
	input[type="text"],
	input[type="number"],
	input[type="url"],
	input[type="email"],
	input[type="tel"],
	textarea {
		background: var(--bg, #101216);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: inherit;
		padding: 5px 8px;
		font-size: 13px;
		font-family: inherit;
		min-width: 0;
		width: 100%;
	}
	textarea {
		resize: vertical;
	}
	.anchor {
		position: relative;
		display: inline-block;
	}
	.date-btn {
		border: 1px solid var(--border);
		background: var(--bg, #101216);
		color: inherit;
		border-radius: 6px;
		padding: 5px 10px;
		font-size: 13px;
		cursor: pointer;
	}
	.date-btn.empty {
		color: var(--muted);
	}
	.date-btn:hover {
		border-color: var(--accent);
	}
	.objects {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		align-items: center;
	}
	.pill {
		border: 1px solid var(--border);
		background: none;
		color: inherit;
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 11px;
		cursor: pointer;
	}
	.link-row {
		display: flex;
		gap: 6px;
		align-items: center;
		width: 100%;
	}
	.open {
		color: var(--accent);
		text-decoration: none;
		font-size: 14px;
		flex: none;
	}
	.obj-chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 1px 4px 1px 8px;
		font-size: 12px;
	}
	.obj-chip a {
		color: inherit;
		text-decoration: none;
	}
	.obj-chip a:hover {
		color: var(--accent);
	}
	.obj-chip button {
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		font-size: 11px;
	}
	.obj-menu {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 95;
		min-width: 240px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.obj-item {
		border: none;
		background: none;
		color: inherit;
		text-align: left;
		padding: 5px 6px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 13px;
		display: flex;
		gap: 6px;
		align-items: baseline;
	}
	.obj-item:hover {
		background: var(--hover);
	}
	.tk {
		color: var(--muted);
		font-size: 11px;
		margin-left: auto;
	}
	.pad {
		padding: 4px 6px;
	}
</style>
