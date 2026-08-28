<script lang="ts">
	/**
	 * Calendar view — port of Anytype's dataview calendar (view/calendar.tsx).
	 * Groups by a DATE relation: createdDate / modifiedDate (system
	 * timestamps) or any date property like dueDate. Month grid with
	 * prev/next/Today, objects rendered as chips on their day.
	 */
	import { goto } from "$app/navigation";
	import { fetchQuery, type QueryResultRow } from "$lib/api";
	import type { ObjectJSON } from "$lib/types";
	import { objectIcon } from "$lib/icons";

	let {
		body,
		object,
		dateKey,
	}: {
		body: Record<string, unknown>;
		object: ObjectJSON;
		dateKey: string;
	} = $props();

	let rows = $state<QueryResultRow[]>([]);
	const today = new Date();
	let year = $state(new Date().getFullYear());
	let month = $state(new Date().getMonth()); // 0-based

	async function load() {
		const res = await fetchQuery(body);
		rows = res.records;
	}

	$effect(() => {
		void JSON.stringify(body);
		void object.updatedAt;
		void load();
	});

	function tsOf(r: QueryResultRow): number {
		if (dateKey === "createdDate") return r.createdAt;
		if (dateKey === "modifiedDate") return r.updatedAt;
		const v = r.fields[dateKey];
		return v?.intValue ?? v?.floatValue ?? 0;
	}

	/** 42 cells starting the Monday-week of the 1st (Anytype fills 6 weeks). */
	const cells = $derived.by(() => {
		const first = new Date(year, month, 1);
		const startOffset = (first.getDay() + 6) % 7; // Monday-first
		const start = new Date(year, month, 1 - startOffset);
		const byDay = new Map<string, QueryResultRow[]>();
		for (const r of rows) {
			const ts = tsOf(r);
			if (!ts) continue;
			const d = new Date(ts);
			const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
			let arr = byDay.get(k);
			if (!arr) byDay.set(k, (arr = []));
			arr.push(r);
		}
		const out: Array<{ date: Date; inMonth: boolean; isToday: boolean; items: QueryResultRow[] }> = [];
		for (let i = 0; i < 42; i++) {
			const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
			out.push({
				date: d,
				inMonth: d.getMonth() === month,
				isToday: d.toDateString() === today.toDateString(),
				items: byDay.get(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) ?? [],
			});
		}
		return out;
	});

	function step(dir: number) {
		const d = new Date(year, month + dir, 1);
		year = d.getFullYear();
		month = d.getMonth();
	}

	const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
</script>

<div class="cal">
	<div class="cal-head">
		<span class="cal-title">{MONTHS[month]} {year}</span>
		<span class="nav">
			<button onclick={() => step(-1)}>‹</button>
			<button
				onclick={() => {
					year = today.getFullYear();
					month = today.getMonth();
				}}>Today</button
			>
			<button onclick={() => step(1)}>›</button>
		</span>
	</div>
	<div class="grid days">
		{#each DAYS as d (d)}<span class="dow">{d}</span>{/each}
	</div>
	<div class="grid">
		{#each cells as c (c.date.getTime())}
			<div class="day" class:dim={!c.inMonth} class:today={c.isToday}>
				<span class="num">{c.date.getDate()}</span>
				{#each c.items.slice(0, 4) as r (r.id)}
					<button class="chip" title={r.fields["name"]?.stringValue} onclick={() => void goto(`/object/${r.id}`)}>
						<span class="ch-icon">{objectIcon(r.fields["iconEmoji"]?.stringValue, r.typeKey)}</span>
						{r.fields["name"]?.stringValue || "Untitled"}
					</button>
				{/each}
				{#if c.items.length > 4}
					<span class="more">+{c.items.length - 4}</span>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.cal {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-bottom: 24px;
	}
	.cal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.cal-title {
		font-size: 15px;
		font-weight: 600;
	}
	.nav {
		display: flex;
		gap: 4px;
	}
	.nav button {
		background: none;
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--fg);
		font-size: 12px;
		padding: 3px 10px;
		cursor: pointer;
	}
	.nav button:hover {
		border-color: var(--accent);
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 4px;
	}
	.grid.days {
		gap: 4px;
	}
	.dow {
		font-size: 11px;
		color: var(--muted);
		padding: 0 6px;
	}
	.day {
		min-height: 92px;
		background: var(--hl-light);
		border-radius: 8px;
		padding: 6px;
		display: flex;
		flex-direction: column;
		gap: 3px;
		overflow: hidden;
	}
	.day.dim {
		opacity: 0.45;
	}
	.day.today {
		outline: 1px solid var(--accent);
	}
	.num {
		font-size: 11px;
		color: var(--muted);
	}
	.day.today .num {
		color: var(--accent);
		font-weight: 700;
	}
	.chip {
		display: flex;
		align-items: center;
		gap: 4px;
		background: var(--panel);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-size: 11px;
		padding: 2px 6px;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-align: left;
	}
	.chip:hover {
		border-color: var(--accent);
	}
	.ch-icon {
		flex: none;
	}
	.more {
		font-size: 10px;
		color: var(--muted);
		padding-left: 4px;
	}
</style>
