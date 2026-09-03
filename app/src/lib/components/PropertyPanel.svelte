<script lang="ts">
	/**
	 * Property (relation) object page body — Anytype's property view:
	 * every object currently holding a value for this property, with
	 * the value rendered in the relation's own format.
	 */
	import type { ObjectJSON, ValueJSON } from "$lib/types";
	import { fieldStr } from "$lib/types";
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import { objectIcon } from "$lib/icons";
	import { store } from "$lib/data.svelte";
	import { currentSpaceId } from "$lib/relations";

	let { object }: { object: ObjectJSON } = $props();

	const key = $derived(fieldStr(object.fields, "key"));
	const format = $derived(fieldStr(object.fields, "format") || "shorttext");

	let rows = $state<QueryResultRow[]>([]);
	let loaded = $state(false);

	async function load() {
		if (!key) return;
		// Spaces are self-contained: a stamped property lists its own
		// space's holders; a bundled (global) one lists the space you are
		// browsing from. The default space also owns unstamped objects.
		const own = fieldStr(object.fields, "channel") || currentSpaceId();
		const spaceFilter =
			own === (store.channels[0]?.id ?? "")
				? { key: "channel", condition: "in", value: [own, ""] }
				: { key: "channel", condition: "equal", value: own };
		const res = await fetchQuery({ filters: [{ key, condition: "notEmpty" }, spaceFilter], limit: 500 });
		// Definition objects (relations/types) carry system fields like
		// `key`/`format` themselves — keep the listing to real records.
		rows = res.records
			.filter((r) => r.id !== object.id && r.typeKey !== "relation" && r.typeKey !== "type")
			.toSorted((a, b) => b.updatedAt - a.updatedAt);
		loaded = true;
	}
	$effect(() => {
		void key;
		void load();
	});

	function fmt(v: ValueJSON | undefined): string {
		if (!v) return "";
		if (v.boolValue !== undefined) return v.boolValue ? "☑" : "☐";
		if (v.stringValue !== undefined) return v.stringValue;
		if (v.intValue !== undefined) return format === "date" ? new Date(v.intValue).toLocaleDateString() : String(v.intValue);
		if (v.floatValue !== undefined) return String(v.floatValue);
		if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? i.linkValue?.targetId.slice(0, 8) ?? "").filter(Boolean).join(", ");
		if (v.linkValue) return v.linkValue.targetId.slice(0, 8);
		if (v.listValue) return v.listValue.values.join(", ");
		return "";
	}
</script>

<div class="prop-panel">
	<p class="meta">
		<span class="chip">{format}</span>
		{loaded ? `${rows.length} object${rows.length === 1 ? "" : "s"} with a value` : "Loading…"}
	</p>
	{#if loaded && rows.length === 0}
		<p class="muted">No objects have a value for this property yet.</p>
	{:else if rows.length > 0}
		<table>
			<thead><tr><th>Name</th><th>Value</th><th>Type</th></tr></thead>
			<tbody>
				{#each rows as r (r.id)}
					<tr>
						<td><a href="/object/{r.id}"><span class="obj-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span> {r.name || fieldStr(r.fields, "name") || "Untitled"}</a></td>
						<td class="val">{fmt(r.fields[key])}</td>
						<td class="muted">{r.typeKey}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.prop-panel {
		padding: 0 48px;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--muted);
		font-size: 13px;
	}
	.chip {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 2px 8px;
		font-size: 12px;
		color: var(--fg);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 8px;
	}
	th {
		text-align: left;
		font-size: 12px;
		font-weight: 500;
		color: var(--muted);
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
	}
	td {
		padding: 8px;
		border-bottom: 1px solid var(--border);
		font-size: 14px;
	}
	td a {
		color: var(--fg);
		text-decoration: none;
		font-weight: 500;
	}
	td a:hover {
		text-decoration: underline;
	}
	.val {
		color: var(--fg);
		max-width: 340px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.muted {
		color: var(--muted);
	}
</style>
