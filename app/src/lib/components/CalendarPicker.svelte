<script lang="ts">
	/**
	 * Anytype's CalendarSelect, compact: month grid with adjacent-month
	 * fill, today ring, selected day, prev/next month, Today + Clear
	 * footer. Emits unix ms (local midnight) or null for clear.
	 */
	let {
		value = 0,
		onpick,
		onclose,
	}: {
		/** unix ms, 0 = unset */
		value?: number;
		onpick: (ms: number | null) => void;
		onclose: () => void;
	} = $props();

	// Seed from the initial value only — the picker is remounted per open.
	let year = $state(0);
	let month = $state(0); // 0-11
	$effect.pre(() => {
		if (year === 0) {
			const seed = value ? new Date(value) : new Date();
			year = seed.getFullYear();
			month = seed.getMonth();
		}
	});

	const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
	const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

	interface Day {
		d: number;
		m: number;
		y: number;
		other: boolean;
	}

	const days = $derived.by((): Day[] => {
		const first = new Date(year, month, 1);
		// Monday-start offset.
		const lead = (first.getDay() + 6) % 7;
		const out: Day[] = [];
		for (let i = 0; i < 42; i++) {
			const d = new Date(year, month, 1 - lead + i);
			out.push({ d: d.getDate(), m: d.getMonth(), y: d.getFullYear(), other: d.getMonth() !== month });
		}
		return out;
	});

	const today = new Date();
	const selected = $derived(value ? new Date(value) : null);

	function isToday(day: Day): boolean {
		return day.d === today.getDate() && day.m === today.getMonth() && day.y === today.getFullYear();
	}
	function isSelected(day: Day): boolean {
		return !!selected && day.d === selected.getDate() && day.m === selected.getMonth() && day.y === selected.getFullYear();
	}

	function step(delta: number) {
		const d = new Date(year, month + delta, 1);
		year = d.getFullYear();
		month = d.getMonth();
	}

	let menuEl = $state<HTMLElement>();
	function onWindowPointerDown(e: PointerEvent) {
		if (menuEl && !menuEl.contains(e.target as Node)) onclose();
	}
</script>

<svelte:window
	onpointerdown={onWindowPointerDown}
	onkeydown={(e) => {
		if (e.key === "Escape") onclose();
	}}
/>

<div class="cal" bind:this={menuEl} role="dialog" aria-label="Pick a date">
	<div class="head">
		<button class="nav" onclick={() => step(-1)}>‹</button>
		<span class="title">{MONTHS[month]} {year}</span>
		<button class="nav" onclick={() => step(1)}>›</button>
	</div>
	<div class="grid">
		{#each WEEKDAYS as w (w)}
			<span class="wd">{w}</span>
		{/each}
		{#each days as day (day.y + "-" + day.m + "-" + day.d)}
			<button
				class="day"
				class:other={day.other}
				class:today={isToday(day)}
				class:sel={isSelected(day)}
				onclick={() => onpick(new Date(day.y, day.m, day.d).getTime())}
			>
				{day.d}
			</button>
		{/each}
	</div>
	<div class="foot">
		<button onclick={() => onpick(new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime())}>Today</button>
		<button onclick={() => onpick(null)}>Clear</button>
	</div>
</div>

<style>
	.cal {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 95;
		width: 252px;
		background: var(--panel, #1a1d23);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 10px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.title {
		font-size: 13px;
		font-weight: 600;
	}
	.nav {
		border: none;
		background: none;
		color: var(--muted);
		font-size: 16px;
		cursor: pointer;
		padding: 2px 8px;
		border-radius: 6px;
	}
	.nav:hover {
		background: var(--hover);
		color: inherit;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 1px;
	}
	.wd {
		text-align: center;
		font-size: 10px;
		color: var(--muted);
		padding: 3px 0;
	}
	.day {
		border: none;
		background: none;
		color: inherit;
		font-size: 12px;
		padding: 5px 0;
		border-radius: 6px;
		cursor: pointer;
	}
	.day:hover {
		background: var(--hover);
	}
	.day.other {
		color: var(--muted);
		opacity: 0.5;
	}
	.day.today {
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.day.sel {
		background: var(--accent);
		color: #14100a;
		font-weight: 600;
	}
	.foot {
		display: flex;
		justify-content: space-between;
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	.foot button {
		border: none;
		background: none;
		color: var(--muted);
		font-size: 12px;
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 6px;
	}
	.foot button:hover {
		background: var(--hover);
		color: inherit;
	}
</style>
