<script lang="ts">
	/**
	 * Gallery view — port of Anytype's dataview gallery (view/gallery.tsx +
	 * gallery/card.tsx): a responsive grid of cards, each with icon + name
	 * and the view's visible relation values as compact cells. (No covers —
	 * we have no file storage yet, Anytype's ObjectCover needs one.)
	 */
	import { goto } from "$app/navigation";
	import { tagStyle } from "$lib/options";
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import type { ObjectJSON, RelationDefJSON } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	let {
		body,
		object,
		relations,
	}: {
		body: Record<string, unknown>;
		object: ObjectJSON;
		relations: RelationDefJSON[];
	} = $props();

	let rows = $state<QueryResultRow[]>([]);

	async function load() {
		const res = await fetchQuery(body);
		rows = res.records;
	}

	$effect(() => {
		void JSON.stringify(body);
		void object.updatedAt;
		void load();
	});

	/** The view's visible relations (same list the table shows), name first excluded. */
	const visible = $derived.by(() => {
		const items = object.fields["viewRelations"]?.valuesValue?.items ?? [];
		const keys = items
			.map((i) => i.mapValue?.entries?.["key"]?.stringValue)
			.filter((k): k is string => !!k && k !== "name");
		return keys.map((k) => relations.find((r) => r.key === k)).filter((r): r is RelationDefJSON => !!r);
	});

	function cellText(r: QueryResultRow, rel: RelationDefJSON): string {
		const v = r.fields[rel.key];
		if (!v) return "";
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.boolValue !== undefined) return v.boolValue ? "✓" : "";
		if (v.intValue !== undefined) {
			return rel.format === "date" && v.intValue > 0 ? new Date(v.intValue).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : String(v.intValue);
		}
		if (v.floatValue !== undefined) return String(v.floatValue);
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").filter(Boolean).join(", ");
		return "";
	}
</script>

<div class="gallery">
	{#each rows as r (r.id)}
		<button class="card" onclick={() => void goto(`/object/${r.id}`)}>
			<div class="card-head">
				<span class="g-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
				<span class="g-name">{r.fields["name"]?.stringValue || "Untitled"}</span>
			</div>
			{#each visible as rel (rel.key)}
				{@const t = cellText(r, rel)}
				{#if t}
					<div class="g-cell" title={rel.name || rel.key}>
						{#if rel.format === "tag" || rel.format === "status"}
							{#each t.split(", ") as tg (tg)}
								{@const opt = rel.options.find((o) => o.text === tg)}
								<span class="g-tag" style={tagStyle(opt?.color ?? "")}>{tg}</span>
							{/each}
						{:else}
							{t}
						{/if}
					</div>
				{/if}
			{/each}
		</button>
	{/each}
	{#if rows.length === 0}
		<p class="muted">No objects match.</p>
	{/if}
</div>

<style>
	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 10px;
		padding: 4px 0 24px;
	}
	.card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		background: var(--hl-light);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 12px;
		cursor: pointer;
		text-align: left;
		color: var(--fg);
		min-height: 74px;
	}
	.card:hover {
		border-color: var(--accent);
	}
	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
	}
	.g-icon {
		flex: none;
	}
	.g-name {
		font-size: 14px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.g-cell {
		font-size: 12px;
		color: var(--muted);
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		max-width: 100%;
		overflow: hidden;
	}
	/* Anytype tagItem.isSmall: filled pill. */
	.g-tag {
		display: inline-block;
		border-radius: 10px;
		padding: 0 6px;
		font-size: 11px;
		line-height: 18px;
		height: 18px;
	}
	.muted {
		color: var(--muted);
		font-size: 13px;
	}
</style>
