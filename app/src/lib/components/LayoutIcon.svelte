<script lang="ts">
	/**
	 * Anytype's dataview layout icons (util/icons/dataview/view/*.tsx,
	 * used by menu/dataview/view/layout.tsx): 56x56 currentColor outlines
	 * over a subtle plate. Their plate is a light-grey gradient; ours uses
	 * the theme highlight so it reads on dark backgrounds.
	 */
	let { kind, size = 20 }: { kind: string; size?: number } = $props();
</script>

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56" fill="none" width={size} height={size} aria-hidden="true">
	{#if kind === "table"}
		<rect x="11" y="13" width="34" height="30" rx="3" fill="var(--hl-med)" />
		<rect x="11.5" y="13.5" width="33" height="29" rx="2.5" stroke="currentColor" />
		<path d="M23.5 13.5V42.5" stroke="currentColor" />
		<path d="M11 23H45" stroke="currentColor" />
		<path d="M11 33.5H45" stroke="currentColor" />
	{:else if kind === "gallery"}
		<rect x="11.5" y="13.5" width="15" height="13" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
		<rect x="29.5" y="13.5" width="15" height="13" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
		<rect x="11.5" y="29.5" width="15" height="13" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
		<rect x="29.5" y="29.5" width="15" height="13" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
	{:else if kind === "kanban"}
		<rect x="11.5" y="13.5" width="14" height="29" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
		<rect x="30.5" y="13.5" width="14" height="19" rx="2.5" fill="var(--hl-med)" stroke="currentColor" />
	{:else if kind === "calendar"}
		<rect x="10.5625" y="13" width="34" height="30" rx="3" fill="var(--hl-med)" />
		<rect x="11.0625" y="13.5" width="33" height="29" rx="2.5" stroke="currentColor" />
		<rect x="10.5625" y="21" width="34" height="1" fill="currentColor" />
		<rect x="25" y="25.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="33" y="25.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="17" y="30.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="25" y="30.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="33" y="30.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="17" y="35.5" width="5" height="3" rx="0.5" stroke="currentColor" />
		<rect x="25" y="35.5" width="5" height="3" rx="0.5" stroke="currentColor" />
	{/if}
</svg>
