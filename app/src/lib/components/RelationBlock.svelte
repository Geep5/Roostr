<script lang="ts">
	/**
	 * Anytype's relation block (BlockType.Relation): a property rendered
	 * inline in the document as "Name  value". The block only carries the
	 * relation key (meta.key); the value lives in the object's fields, so
	 * the block and the featured row always agree. Editing goes through
	 * the shared PropertyValue editor (all Anytype formats).
	 */
	import type { ObjectJSON } from "$lib/types";
	import { note } from "$lib/api";
	import { store } from "$lib/data.svelte";
	import PropertyValue from "./PropertyValue.svelte";

	let {
		block,
		object,
		onrefresh,
	}: {
		block: { content: { custom?: { meta?: Record<string, string> } } };
		object: ObjectJSON;
		onrefresh: () => void | Promise<void>;
	} = $props();

	const key = $derived(block.content.custom?.meta?.["key"] ?? "");
	const rel = $derived(store.relations.find((r) => r.key === key));
</script>

{#if rel}
	<div class="relation">
		<span class="rel-name" title={rel.format}>{rel.name || rel.key}</span>
		<div class="rel-value">
			<PropertyValue
				{rel}
				value={object.fields[key]}
				onsave={async (v) => {
					await note.setField(object.id, key, v);
					await onrefresh();
				}}
			/>
		</div>
	</div>
{:else}
	<div class="relation missing">Unknown property "{key}"</div>
{/if}

<style>
	.relation {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 3px 0;
		font-size: 14px;
	}
	.rel-name {
		flex: 0 0 140px;
		color: var(--muted);
		font-size: 13px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.rel-value {
		flex: 1;
		min-width: 0;
	}
	.missing {
		color: var(--muted);
		font-style: italic;
	}
</style>
