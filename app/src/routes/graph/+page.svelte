<script lang="ts">
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { buildGraph, simStep, type ObjectGraph } from "$lib/graph";
	import { activeSpace } from "$lib/space.svelte";
	import { store, refreshAll } from "$lib/data.svelte";
	import { createRenderer, createProgram } from "brometal";
	import nodeShader from "$lib/shaders/graph-node.shader.gen";
	import edgeShader from "$lib/shaders/graph-edge.shader.gen";

	let canvasEl = $state<HTMLCanvasElement>();
	let labelHost = $state<HTMLDivElement>();
	let status = $state("Loading graph…");

	const MAX_LABELS = 100; // Anytype's visible-label cull

	// Each channel gets its own graph (Anytype: one graph per space).
	const defaultChannelId = $derived(store.channels[0]?.id ?? "");
	const channelId = $derived(activeSpace.id || defaultChannelId);
	const spaceName = $derived(store.channels.find((c) => c.id === channelId)?.name ?? "");
	// ?focus=<objectId>: highlight + center that object (Anytype's
	// "show in graph" from an open object).
	const focusId = $derived(page.url.searchParams.get("focus") ?? "");

	$effect(() => {
		const id = channelId;
		const el = canvasEl; // dep: re-run when the keyed canvas remounts
		const isDefault = id === defaultChannelId && id !== "";
		if (!id) {
			void refreshAll(); // channels not loaded yet; effect re-runs when they land
			return;
		}
		if (!el || !labelHost) return;
		let cleanup: (() => void) | null = null;
		let cancelled = false;
		status = "Loading graph…";

		void (async () => {
			const graph: ObjectGraph = await buildGraph(id, isDefault);
			status = graph.nodes.length === 0 ? "Nothing in this space yet." : "";
			if (!canvasEl || cancelled || graph.nodes.length === 0) return;

			// iOS Safari sizes the WebGPU swapchain when the context is
			// configured and does NOT track later canvas resizes (Chrome
			// does, per spec) - so the one configure() call must see the
			// real dimensions, not the default 300x150 attribute size.
			// Symptom without this: the graph paints a letterboxed sub-rect.
			const dpr = window.devicePixelRatio || 1;
			canvasEl.width = Math.max(1, Math.floor(canvasEl.clientWidth * dpr));
			canvasEl.height = Math.max(1, Math.floor(canvasEl.clientHeight * dpr));
			const renderer = await createRenderer(canvasEl, { clearColor: [0.047, 0.055, 0.066, 1] });
			if (cancelled) {
				renderer.destroy();
				return;
			}

			const nodes = createProgram(renderer, nodeShader, { blend: "alpha" });
			const edges = createProgram(renderer, edgeShader, { blend: "alpha" });

			// Unit quad, two triangles.
			nodes.attributes.aCorner.set(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
			edges.attributes.aQuad.set(new Float32Array([-1, 0, 1, 0, -1, 1, -1, 1, 1, 0, 1, 1]));

			const n = graph.nodes.length;
			const centers = new Float32Array(n * 2);
			const radii = new Float32Array(n);
			const tints = new Float32Array(n * 3);
			const flags = new Float32Array(n);
			for (const [i, node] of graph.nodes.entries()) {
				radii[i] = node.radius;
				tints.set(node.color, i * 3);
			}
			const m = graph.edges.length;
			const starts = new Float32Array(m * 2);
			const ends = new Float32Array(m * 2);
			const ecolors = new Float32Array(m * 4);
			for (const [i, e] of graph.edges.entries()) ecolors.set(e.color, i * 4);

			// View state (world → screen: (p - offset) * scale + viewport/2).
			let scale = 1;
			let offsetX = 0;
			let offsetY = 0;
			let alpha = 1;
			let hovered = -1;
			const focused = focusId ? graph.nodes.findIndex((node) => node.id === focusId) : -1;
			let dragNode = -1;
			let panning = false;
			let moved = 0;
			let lastX = 0;
			let lastY = 0;
			let autoFit = true;

			// Label pool.
			const labels: HTMLDivElement[] = [];
			for (let i = 0; i < Math.min(MAX_LABELS, n); i++) {
				const div = document.createElement("div");
				div.className = "graph-label";
				labelHost!.appendChild(div);
				labels.push(div);
			}

			const cssSize = () => ({ w: canvasEl!.clientWidth, h: canvasEl!.clientHeight });

			const toWorld = (sx: number, sy: number) => {
				const { w, h } = cssSize();
				return { x: (sx - w / 2) / scale + offsetX, y: (sy - h / 2) / scale + offsetY };
			};

			const pick = (sx: number, sy: number): number => {
				const p = toWorld(sx, sy);
				let best = -1;
				let bestD = Infinity;
				for (const [i, node] of graph.nodes.entries()) {
					const d = Math.hypot(node.x - p.x, node.y - p.y);
					if (d <= node.radius + 4 / scale && d < bestD) {
						bestD = d;
						best = i;
					}
				}
				return best;
			};

			const fit = () => {
				const { w, h } = cssSize();
				if (focused >= 0) {
					// Center the focused object; comfortable fixed zoom.
					scale = 1.2;
					offsetX = graph.nodes[focused].x;
					offsetY = graph.nodes[focused].y;
					return;
				}
				let r = 1;
				for (const node of graph.nodes) r = Math.max(r, Math.hypot(node.x, node.y) + node.radius + 40);
				scale = Math.min(1.6, Math.min(w, h) / (2 * r));
				offsetX = 0;
				offsetY = 0;
			};

			// ── Interaction ─────────────────────────────────────────
			const el = canvasEl!;
			el.addEventListener("pointerdown", (e) => {
				el.setPointerCapture(e.pointerId);
				moved = 0;
				lastX = e.offsetX;
				lastY = e.offsetY;
				const hit = pick(e.offsetX, e.offsetY);
				if (hit >= 0) {
					dragNode = hit;
					alpha = Math.max(alpha, 0.3); // reheat, d3-drag style
				} else {
					panning = true;
				}
				autoFit = false;
			});
			el.addEventListener("pointermove", (e) => {
				const dx = e.offsetX - lastX;
				const dy = e.offsetY - lastY;
				if (dragNode >= 0) {
					moved += Math.abs(dx) + Math.abs(dy);
					const p = toWorld(e.offsetX, e.offsetY);
					graph.nodes[dragNode].x = p.x;
					graph.nodes[dragNode].y = p.y;
					alpha = Math.max(alpha, 0.3);
					lastX = e.offsetX;
					lastY = e.offsetY;
				} else if (panning) {
					moved += Math.abs(dx) + Math.abs(dy);
					offsetX -= dx / scale;
					offsetY -= dy / scale;
					lastX = e.offsetX;
					lastY = e.offsetY;
				} else {
					hovered = pick(e.offsetX, e.offsetY);
					el.style.cursor = hovered >= 0 ? "pointer" : "grab";
				}
			});
			el.addEventListener("pointerup", (e) => {
				if (dragNode >= 0 && moved < 4) {
					void goto(`/object/${graph.nodes[dragNode].id}`);
				}
				dragNode = -1;
				panning = false;
			});
			el.addEventListener("wheel", (e) => {
				e.preventDefault();
				autoFit = false;
				const { w, h } = cssSize();
				const before = toWorld(e.offsetX, e.offsetY);
				scale = Math.min(8, Math.max(0.05, scale * Math.exp(-e.deltaY * 0.0015)));
				// Keep the point under the cursor fixed.
				offsetX = before.x - (e.offsetX - w / 2) / scale;
				offsetY = before.y - (e.offsetY - h / 2) / scale;
			}, { passive: false });

			// ── Frame loop ──────────────────────────────────────────
			const stop = renderer.loop(() => {
				if (alpha > 0.003) {
					simStep(graph, alpha, dragNode);
					simStep(graph, alpha, dragNode);
					alpha *= 0.98;
					if (autoFit) fit();
				}

				const { w, h } = cssSize();
				for (const [i, node] of graph.nodes.entries()) {
					centers[i * 2] = node.x;
					centers[i * 2 + 1] = node.y;
					flags[i] = i === hovered || i === focused ? 1 : 0;
				}
				for (const [i, e] of graph.edges.entries()) {
					starts[i * 2] = graph.nodes[e.a].x;
					starts[i * 2 + 1] = graph.nodes[e.a].y;
					ends[i * 2] = graph.nodes[e.b].x;
					ends[i * 2 + 1] = graph.nodes[e.b].y;
				}

				if (m > 0) {
					edges.instanceAttributes.iStart.set(starts);
					edges.instanceAttributes.iEnd.set(ends);
					edges.instanceAttributes.iColor.set(ecolors);
					edges.uniforms.uScale.set(scale);
					edges.uniforms.uOffset.set([offsetX, offsetY]);
					edges.uniforms.uViewport.set([w, h]);
					edges.uniforms.uWidth.set(1.5);
					edges.draw();
				}

				nodes.instanceAttributes.iCenter.set(centers);
				nodes.instanceAttributes.iRadius.set(radii);
				nodes.instanceAttributes.iTint.set(tints);
				nodes.instanceAttributes.iFlags.set(flags);
				nodes.uniforms.uScale.set(scale);
				nodes.uniforms.uOffset.set([offsetX, offsetY]);
				nodes.uniforms.uViewport.set([w, h]);
				nodes.draw();

				// Labels: biggest nodes first, culled to the pool (Anytype: ≤100).
				const order = graph.nodes
					.map((node, i) => ({ i, r: node.radius + (i === hovered ? 100 : 0) + (i === focused ? 200 : 0) }))
					.sort((a, b) => b.r - a.r);
				for (const [li, div] of labels.entries()) {
					const entry = order[li];
					if (!entry) {
						div.style.display = "none";
						continue;
					}
					const node = graph.nodes[entry.i];
					const sx = (node.x - offsetX) * scale + w / 2;
					const sy = (node.y - offsetY) * scale + h / 2 + node.radius * scale + 4;
					if (sx < -80 || sx > w + 80 || sy < -20 || sy > h + 20 || scale < 0.35) {
						div.style.display = "none";
						continue;
					}
					div.style.display = "block";
					div.style.transform = `translate(${sx}px, ${sy}px) translateX(-50%)`;
					div.textContent = node.name;
					div.classList.toggle("hot", entry.i === hovered);
				}
			});

			cleanup = () => {
				stop();
				nodes.dispose();
				edges.dispose();
				renderer.destroy();
			};
		})().catch((e) => (status = `Graph failed: ${e}`));

		return () => {
			cancelled = true;
			cleanup?.();
		};
	});
</script>

<svelte:head><title>Graph — glon</title></svelte:head>

<div class="stage">
	{#key channelId}
		<canvas bind:this={canvasEl}></canvas>
		<div class="labels" bind:this={labelHost}></div>
	{/key}
	{#if status}<p class="status">{status}</p>{/if}
</div>

<style>
	.stage {
		position: relative;
		width: 100%;
		height: calc(100vh - 120px);
		min-height: 400px;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
		border-radius: 12px;
		cursor: grab;
	}
	.labels {
		position: absolute;
		inset: 0;
		pointer-events: none;
		overflow: hidden;
	}
	:global(.graph-label) {
		position: absolute;
		top: 0;
		left: 0;
		font-size: 11px;
		color: var(--muted);
		white-space: nowrap;
		text-shadow: 0 1px 3px rgb(0 0 0 / 0.8);
	}
	:global(.graph-label.hot) {
		color: var(--fg);
		font-weight: 600;
	}
	.status {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
	}
</style>
