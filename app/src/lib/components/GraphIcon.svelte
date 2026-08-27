<script lang="ts">
	/** Force-graph glyph: three linked nodes. Unicode has nothing that
	 * reads as "graph" at 14px, so this is a real icon (currentColor). */
	let { size = 15 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
	<path d="M4.5 11.5 8 5.5l3.5 6z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" fill="none" />
	<circle cx="8" cy="4" r="2.1" fill="var(--bg, #101216)" stroke="currentColor" stroke-width="1.3" />
	<circle cx="3.5" cy="12.5" r="2.1" fill="var(--bg, #101216)" stroke="currentColor" stroke-width="1.3" />
	<circle cx="12.5" cy="12.5" r="2.1" fill="var(--bg, #101216)" stroke="currentColor" stroke-width="1.3" />
</svg>

<style>
	svg {
		display: inline-block;
		vertical-align: -2px;
		flex: none;
	}
</style>
