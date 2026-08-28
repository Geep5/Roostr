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
	import { fetchQuery, note } from "$lib/api";
	import { refreshAll } from "$lib/data.svelte";

	let { object, onchanged }: { object: ObjectJSON; onchanged: () => Promise<void> } = $props();

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
	<div class="sec">
		<div class="sec-name">Layout</div>
		<div class="layouts">
			{#each LAYOUTS as l (l.id)}
				<button class="layout" class:active={layout === l.id} onclick={() => void setLayout(l.id)}>
					<span class="l-name">{l.id === "task" ? "☑" : "▤"} {l.name}</span>
					<span class="l-hint">{l.hint}</span>
				</button>
			{/each}
		</div>
	</div>

	<div class="sec">
		<div class="sec-head">
			<div class="sec-name">Templates</div>
			<button class="add" onclick={() => void addTemplate()}>＋ New template</button>
		</div>
		{#each templates as t (t.id)}
			<div class="tpl">
				<a class="tpl-name" href="/object/{t.id}">{t.name || "Untitled"}</a>
				{#if defaultTemplateId === t.id}
					<button class="badge default" title="Unset default" onclick={() => void setDefault(t.id)}>Default</button>
				{:else}
					<button class="badge" onclick={() => void setDefault(t.id)}>Set default</button>
				{/if}
				<button class="rm" title="Delete template" onclick={() => void removeTemplate(t.id)}>×</button>
			</div>
		{/each}
		{#if templates.length === 0}
			<p class="muted">No templates yet — a default template pre-fills every new {fieldStr(object.fields, "name") || "object"}.</p>
		{/if}
	</div>
</div>

<style>
	.type-panel {
		display: flex;
		flex-direction: column;
		gap: 24px;
		margin-top: 16px;
	}
	.sec-name {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--muted);
		margin-bottom: 8px;
	}
	.sec-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
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
	.add {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
	}
	.add:hover {
		color: var(--fg);
	}
	.tpl {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}
	.tpl-name {
		flex: 1;
		color: var(--fg);
		text-decoration: none;
		font-size: 14px;
	}
	.tpl-name:hover {
		color: var(--accent);
	}
	.badge {
		font-size: 11px;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		padding: 2px 8px;
		cursor: pointer;
	}
	.badge.default {
		border-color: var(--accent);
		color: var(--accent);
	}
	.rm {
		background: none;
		border: none;
		color: var(--muted);
		cursor: pointer;
		font-size: 14px;
	}
	.rm:hover {
		color: #e05555;
	}
	.muted {
		color: var(--muted);
		font-size: 13px;
	}
</style>
