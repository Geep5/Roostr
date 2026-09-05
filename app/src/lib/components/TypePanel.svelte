<script lang="ts">
	/**
	 * Type object page body — Anytype's sidebar type sections (layout +
	 * templates) rendered inline. Layout: Page | Task (task swaps the object
	 * icon for a checkbox bound to the bundled `done` relation). Templates:
	 * objects of type `template` with target_type = this type; one can be
	 * the default (default_template_id) applied on every create.
	 */
	import { goto } from "$app/navigation";
	import type { ObjectJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchObject, fetchQuery, note } from "$lib/api";
	import { applyTemplate } from "$lib/create";
	import { Style } from "$lib/types";
	import { refreshAll } from "$lib/data.svelte";

	let { object, onchanged }: { object: ObjectJSON; onchanged: () => Promise<void> } = $props();

	// ── Definition: what this type MEANS - agents read it. ──────────
	let defDraft = $state("");
	$effect(() => {
		defDraft = fieldStr(object.fields, "description");
	});
	async function saveDef() {
		if (defDraft.trim() === fieldStr(object.fields, "description")) return;
		await note.setField(object.id, "description", { stringValue: defDraft.trim() });
		await onchanged();
	}

	const layout = $derived(fieldStr(object.fields, "layout") || "page");
	const defaultTemplateId = $derived(fieldStr(object.fields, "default_template_id"));

	const LAYOUTS = [
		{ id: "page", name: "Page", hint: "Title, icon, and blocks" },
		{ id: "task", name: "Task", hint: "Checkbox bound to Done" },
	];

	async function setLayout(id: string) {
		if (id === layout) return;
		await note.setField(object.id, "layout", { stringValue: id });
		await onchanged();
		await refreshAll();
	}

	// ── Templates ─────────────────────────────────────────────────
	let templates = $state<Array<{ id: string; name: string }>>([]);

	async function loadTemplates() {
		const res = await fetchQuery({
			type: "template",
			filters: [{ key: "target_type", condition: "equal", value: object.id }],
			limit: 50,
		});
		templates = res.records.map((r) => ({ id: r.id, name: r.fields["name"]?.stringValue ?? "" }));
	}

	$effect(() => {
		void object.id;
		void loadTemplates();
	});

	async function addTemplate() {
		const { id } = await note.create("New template", "template", {
			target_type: { stringValue: object.id },
		});
		await goto(`/object/${id}`);
	}

	// ── Gallery overlay: cards with mini block previews ─────────────
	let galleryOpen = $state(false);
	let previews = $state<Record<string, Array<{ kind: string; text: string }>>>({});

	/** First content blocks of a template, flattened for the mini preview. */
	async function loadPreview(id: string) {
		try {
			const tpl = await fetchObject(id);
			const byId = new Map(tpl.blocks.map((b) => [b.id, b]));
			const skip = new Set<string>();
			const markSkip = (bid: string) => {
				if (skip.has(bid)) return;
				skip.add(bid);
				for (const c of byId.get(bid)?.childrenIds ?? []) markSkip(c);
			};
			markSkip("__discussion__");
			const lines: Array<{ kind: string; text: string }> = [];
			for (const b of tpl.blocks) {
				if (skip.has(b.id) || lines.length >= 7) continue;
				if (b.content.custom?.contentType === "divider") {
					lines.push({ kind: "divider", text: "" });
				} else if (b.content.custom) {
					lines.push({ kind: "custom", text: b.content.custom.contentType ?? "block" });
				} else if (b.content.text) {
					const st = b.content.text.style ?? 0;
					const kind = st === Style.HEADER1 || st === Style.HEADER2 || st === Style.HEADER3 ? "head" : st === Style.CHECKBOX ? "check" : st === Style.BULLET || st === Style.NUMBERED ? "list" : "p";
					lines.push({ kind, text: b.content.text.text ?? "" });
				}
			}
			previews[id] = lines;
		} catch {
			previews[id] = [];
		}
	}

	async function openGallery() {
		galleryOpen = true;
		await loadTemplates();
		for (const t of templates) if (!previews[t.id]) void loadPreview(t.id);
	}

	/** Copy: fresh template object, same target, blocks cloned. */
	async function duplicateTemplate(t: { id: string; name: string }) {
		const { id } = await note.create(`${t.name || "Untitled"} copy`, "template", {
			target_type: { stringValue: object.id },
		});
		await applyTemplate(id, t.id);
		await loadTemplates();
		void loadPreview(id);
	}

	async function setDefault(id: string) {
		if (defaultTemplateId === id) {
			await note.deleteField(object.id, "default_template_id");
		} else {
			await note.setField(object.id, "default_template_id", { stringValue: id });
		}
		await onchanged();
		await refreshAll();
	}

	async function removeTemplate(id: string) {
		if (!confirm("Delete this template?")) return;
		if (defaultTemplateId === id) await note.deleteField(object.id, "default_template_id");
		await note.del(id);
		await loadTemplates();
		await refreshAll();
	}
</script>

<div class="type-panel">
	<textarea class="definition" placeholder="What is this type for? Agents read this." bind:value={defDraft} onblur={() => void saveDef()} rows="2"></textarea>
	<div class="sec">
		<div class="sec-name">Layout</div>
		<div class="layouts">
			{#each LAYOUTS as l (l.id)}
				<button class="layout" class:active={layout === l.id} onclick={() => void setLayout(l.id)}>
					<span class="l-name">{l.id === "task" ? "✅" : "📄"} {l.name}</span>
					<span class="l-hint">{l.hint}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="tpl-chip-row">
		<button class="tpl-chip" onclick={() => void openGallery()}>
			⊞ Templates{templates.length ? ` · ${templates.length}` : ""}
		</button>
	</div>

</div>

{#if galleryOpen}
	<!-- Anytype's template gallery: cards with live mini previews; the
	     default wears a badge; a dashed card creates. Editing stays on the
	     template's own page - the overlay is for choosing and managing. -->
	<div class="tg-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) galleryOpen = false; }}>
		<div class="tg-modal" role="dialog" aria-label="Templates">
			<header>
				<h2>⊞ Templates</h2>
				<button class="tg-x" onclick={() => (galleryOpen = false)}>×</button>
			</header>
			<p class="tg-hint">A default template pre-fills every new {fieldStr(object.fields, "name") || "object"}; the New button's ▾ picks one per object.</p>
			<div class="tg-grid">
				{#each templates as t (t.id)}
					<div class="tg-card" class:default={defaultTemplateId === t.id}>
						<button class="tg-preview" title="Edit template" onclick={() => { galleryOpen = false; void goto(`/object/${t.id}`); }}>
							{#each previews[t.id] ?? [] as line, i (i)}
								{#if line.kind === "divider"}
									<span class="pv-div"></span>
								{:else if line.kind === "head"}
									<span class="pv-line pv-head">{line.text || "Heading"}</span>
								{:else if line.kind === "check"}
									<span class="pv-line">☐ {line.text}</span>
								{:else if line.kind === "list"}
									<span class="pv-line">• {line.text}</span>
								{:else if line.kind === "custom"}
									<span class="pv-line pv-dim">▨ {line.text}</span>
								{:else}
									<span class="pv-line">{line.text}</span>
								{/if}
							{/each}
							{#if (previews[t.id] ?? []).length === 0}
								<span class="pv-line pv-dim">Empty template</span>
							{/if}
						</button>
						<div class="tg-foot">
							<span class="tg-name">{t.name || "Untitled"}</span>
							{#if defaultTemplateId === t.id}<span class="tg-badge">Default</span>{/if}
						</div>
						<div class="tg-actions">
							<button title={defaultTemplateId === t.id ? "Unset default" : "Set as default"} class:on={defaultTemplateId === t.id} onclick={() => void setDefault(t.id)}>★</button>
							<button title="Duplicate" onclick={() => void duplicateTemplate(t)}>⧉</button>
							<button title="Delete" class="tg-danger" onclick={() => void removeTemplate(t.id)}>🗑</button>
						</div>
					</div>
				{/each}
				<button class="tg-card tg-new" onclick={() => { galleryOpen = false; void addTemplate(); }}>
					<span class="tg-plus">＋</span>
					<span>New template</span>
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.type-panel {
		display: flex;
		flex-direction: column;
		gap: 24px;
		margin: 16px 0 0 48px;
	}
	@media (max-width: 720px) {
		.type-panel {
			margin: 16px 16px 0;
		}
	}
	.sec-name {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin-bottom: 8px;
	}
	.layouts {
		display: flex;
		gap: 8px;
	}
	.layout {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		background: none;
		border: 1px solid var(--border);
		border-radius: 10px;
		color: var(--fg);
		padding: 10px 14px;
		cursor: pointer;
		min-width: 160px;
	}
	.layout.active {
		border-color: var(--accent);
	}
	.l-name {
		font-size: 14px;
	}
	.l-hint {
		font-size: 11px;
		color: var(--muted);
	}
	.definition {
		width: 100%;
		box-sizing: border-box;
		background: var(--hover, rgba(255, 255, 255, 0.04));
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font: inherit;
		font-size: 13.5px;
		padding: 8px 10px;
		margin: 0 0 10px;
		resize: vertical;
	}
	.definition::placeholder {
		color: var(--muted);
	}
	.definition:hover {
		border-color: var(--muted);
	}
	.definition:focus {
		border-color: var(--accent);
		outline: none;
	}
	.tpl-chip-row {
		margin-top: -8px;
	}
	.tpl-chip {
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--muted);
		font-size: 12px;
		padding: 4px 12px;
		cursor: pointer;
	}
	.tpl-chip:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.tg-overlay {
		position: fixed;
		inset: 0;
		background: rgb(0 0 0 / 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 200;
	}
	.tg-modal {
		box-sizing: border-box;
		width: 640px;
		max-width: calc(100vw - 48px);
		max-height: 78vh;
		overflow-y: auto;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 14px;
		padding: 18px 22px 22px;
		box-shadow: 0 24px 80px rgb(0 0 0 / 0.6);
	}
	.tg-modal header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.tg-modal h2 {
		margin: 0;
		font-size: 16px;
	}
	.tg-x {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 20px;
		cursor: pointer;
	}
	.tg-hint {
		color: var(--muted);
		font-size: 12px;
		margin: 4px 0 14px;
	}
	.tg-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: 12px;
	}
	.tg-card {
		position: relative;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg);
		overflow: hidden;
	}
	.tg-card.default {
		border-color: var(--accent);
	}
	.tg-preview {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
		height: 108px;
		padding: 10px 12px;
		background: none;
		border: none;
		cursor: pointer;
		overflow: hidden;
		text-align: left;
	}
	.pv-line {
		font-size: 9px;
		line-height: 1.35;
		color: var(--fg);
		max-width: 100%;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.pv-head {
		font-size: 11px;
		font-weight: 700;
	}
	.pv-dim {
		color: var(--muted);
	}
	.pv-div {
		width: 100%;
		height: 1px;
		background: var(--border);
		margin: 2px 0;
	}
	.tg-foot {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 7px 10px;
		border-top: 1px solid var(--border);
	}
	.tg-name {
		flex: 1;
		min-width: 0;
		font-size: 12px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.tg-badge {
		font-size: 10px;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 5px;
		padding: 1px 5px;
		flex: none;
	}
	.tg-actions {
		position: absolute;
		top: 6px;
		right: 6px;
		display: none;
		gap: 2px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 7px;
		padding: 2px;
	}
	.tg-card:hover .tg-actions {
		display: flex;
	}
	.tg-actions button {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
		padding: 2px 5px;
		border-radius: 5px;
	}
	.tg-actions button:hover {
		background: var(--hover);
		color: var(--fg);
	}
	.tg-actions button.on {
		color: var(--accent);
	}
	.tg-actions .tg-danger:hover {
		color: #e05555;
	}
	.tg-new {
		align-items: center;
		justify-content: center;
		gap: 6px;
		border-style: dashed;
		color: var(--muted);
		cursor: pointer;
		min-height: 140px;
		font-size: 13px;
	}
	.tg-new:hover {
		color: var(--fg);
		border-color: var(--muted);
	}
	.tg-plus {
		font-size: 22px;
	}
</style>
