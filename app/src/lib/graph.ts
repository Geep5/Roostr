/**
 * 2D object graph: build from the query API, simulate with d3-force
 * semantics (Anytype's constants: charge −250, link distance 100, weak
 * centering, cluster pull toward channel nodes).
 */

import { fetchQuery, type QueryResultRow } from "$lib/api";
import type { ValueJSON } from "$lib/types";

export interface GraphNode {
	id: string;
	name: string;
	kind: string;
	radius: number;
	color: [number, number, number];
	cluster: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export interface GraphEdge {
	a: number;
	b: number;
	color: [number, number, number, number];
}

export interface ObjectGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

const HIDDEN_KINDS: Record<string, true> = {
	program: true,
	typescript: true,
	json: true,
	proto: true,
	relation: true,
	type: true,
	template: true,
	agent: true,
	skill: true,
};

const TYPE_COLORS: Record<string, [number, number, number]> = {
	channel: [1.0, 0.63, 0.18],
	note: [0.42, 0.62, 0.95],
	task: [0.36, 0.78, 0.72],
	query: [0.8, 0.52, 0.95],
	set: [0.8, 0.52, 0.95],
	collection: [0.95, 0.75, 0.35],
	person: [0.9, 0.45, 0.55],
	peer: [0.9, 0.45, 0.55],
	agent: [0.55, 0.85, 0.4],
};

function typeColor(kind: string): [number, number, number] {
	const known = TYPE_COLORS[kind];
	if (known) return known;
	let h = 2166136261;
	for (const ch of kind) h = ((h ^ ch.charCodeAt(0)) * 16777619) >>> 0;
	return [0.35 + (h % 97) / 200, 0.35 + (Math.floor(h / 97) % 97) / 200, 0.45 + (Math.floor(h / 9409) % 97) / 250];
}

const LINK_COLOR: [number, number, number, number] = [0.55, 0.65, 0.85, 0.5];
const CLUSTER_COLOR: [number, number, number, number] = [1.0, 0.63, 0.18, 0.16];
const COLLECTION_COLOR: [number, number, number, number] = [0.95, 0.75, 0.35, 0.4];
const QUERY_COLOR: [number, number, number, number] = [0.8, 0.52, 0.95, 0.3];

function strItems(v: ValueJSON | undefined): string[] {
	return (v?.valuesValue?.items ?? []).map((i) => i.stringValue).filter((s): s is string => typeof s === "string");
}

/**
 * Build the graph for ONE channel (Anytype: each space has its own graph).
 * Unassigned objects belong to the default channel. The channel itself
 * is not a node — the graph shows its contents.
 */
export async function buildGraph(channelId: string, isDefaultChannel: boolean): Promise<ObjectGraph> {
	const res = await fetchQuery({ limit: 2000 });
	const rows = res.records.filter((r) => {
		if (HIDDEN_KINDS[r.typeKey] || r.typeKey === "channel") return false;
		const ch = r.fields["channel"]?.stringValue ?? "";
		return ch === channelId || (ch === "" && isDefaultChannel);
	});

	const nodes: GraphNode[] = [];
	const index = new Map<string, number>();
	for (const r of rows) {
		index.set(r.id, nodes.length);
		nodes.push({
			id: r.id,
			name: [r.fields["iconEmoji"]?.stringValue, r.fields["name"]?.stringValue || r.id.slice(0, 8)].filter(Boolean).join(" "),
			kind: r.typeKey,
			radius: 10,
			color: typeColor(r.typeKey),
			cluster: -1,
			x: (Math.random() - 0.5) * 600,
			y: (Math.random() - 0.5) * 600,
			vx: 0,
			vy: 0,
		});
	}

	const edges: GraphEdge[] = [];
	const degree = new Array<number>(nodes.length).fill(0);
	const push = (a: number, b: number, color: GraphEdge["color"]) => {
		if (a === b) return;
		edges.push({ a, b, color });
		degree[a] += 1;
		degree[b] += 1;
	};

	const queryRows: QueryResultRow[] = [];
	for (const r of rows) {
		const ni = index.get(r.id)!;
		for (const [key, v] of Object.entries(r.fields)) {
			if (key === "channel") continue; // scoping field, not a link
			if (key === "collectionIds") {
				for (const id of strItems(v)) {
					const mi = index.get(id);
					if (mi !== undefined) push(mi, ni, COLLECTION_COLOR);
				}
				continue;
			}
			if (v.linkValue) {
				const ti = index.get(v.linkValue.targetId);
				if (ti !== undefined) push(ti, ni, LINK_COLOR);
			} else if (v.valuesValue) {
				for (const item of v.valuesValue.items) {
					if (item.linkValue) {
						const ti = index.get(item.linkValue.targetId);
						if (ti !== undefined) push(ti, ni, LINK_COLOR);
					}
				}
			}
		}
		if (r.typeKey === "query" || r.typeKey === "set") queryRows.push(r);
	}

	// Query objects → edges to their current matches.
	for (const q of queryRows) {
		const qi = index.get(q.id)!;
		try {
			const matches = await fetchQuery({ setId: q.id, limit: 50 });
			for (const m of matches.records) {
				const mi = index.get(m.id);
				if (mi !== undefined && mi !== qi) push(qi, mi, QUERY_COLOR);
			}
		} catch {
			// query with no sources — skip
		}
	}

	for (const [i, n] of nodes.entries()) {
		// Small flat dots (Anytype scale): channels stand out, degree adds a little.
		n.radius = n.kind === "channel" ? 14 : 5 + 1.6 * Math.sqrt(degree[i]);
	}
	return { nodes, edges };
}

/** One d3-force step in 2D (velocity Verlet, decay 0.6). */
export function simStep(g: ObjectGraph, alpha: number, pinned = -1): void {
	const CHARGE = -600;
	const LINK_DIST = 130;
	const CENTER = 0.008;
	const CLUSTER = 0.04;

	const n = g.nodes.length;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const a = g.nodes[i];
			const b = g.nodes[j];
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const l2 = Math.max(dx * dx + dy * dy, 25);
			const l = Math.sqrt(l2);
			const f = (CHARGE * alpha) / l2;
			a.vx += (dx / l) * f;
			a.vy += (dy / l) * f;
			b.vx -= (dx / l) * f;
			b.vy -= (dy / l) * f;
		}
	}
	for (const e of g.edges) {
		const a = g.nodes[e.a];
		const b = g.nodes[e.b];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const l = Math.max(Math.hypot(dx, dy), 1);
		const f = ((l - LINK_DIST) / l) * alpha * 0.3;
		a.vx += dx * f * 0.5;
		a.vy += dy * f * 0.5;
		b.vx -= dx * f * 0.5;
		b.vy -= dy * f * 0.5;
	}
	for (const [i, node] of g.nodes.entries()) {
		node.vx -= node.x * CENTER * alpha;
		node.vy -= node.y * CENTER * alpha;
		if (node.cluster >= 0) {
			node.vx += (g.nodes[node.cluster].x - node.x) * CLUSTER * alpha;
			node.vy += (g.nodes[node.cluster].y - node.y) * CLUSTER * alpha;
		}
		node.vx *= 0.6;
		node.vy *= 0.6;
		if (i === pinned) {
			node.vx = 0;
			node.vy = 0;
			continue;
		}
		node.x += node.vx;
		node.y += node.vy;
	}

	// d3 forceCollide semantics: positional separation so nodes never
	// touch — padded by COLLIDE_PAD, displacement split by radius weight,
	// a pinned (dragged) node stays put and pushes the other fully.
	const COLLIDE_PAD = 14;
	for (let iter = 0; iter < 2; iter++) {
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				const a = g.nodes[i];
				const b = g.nodes[j];
				let dx = b.x - a.x;
				let dy = b.y - a.y;
				const minDist = a.radius + b.radius + COLLIDE_PAD;
				let l = Math.hypot(dx, dy);
				if (l >= minDist) continue;
				if (l === 0) {
					// Coincident: nudge apart deterministically by index.
					dx = Math.cos(i * 2.399963);
					dy = Math.sin(i * 2.399963);
					l = 1;
				}
				const overlap = (minDist - l) / l;
				const wa = i === pinned ? 0 : j === pinned ? 1 : b.radius / (a.radius + b.radius);
				const wb = 1 - wa;
				a.x -= dx * overlap * wa;
				a.y -= dy * overlap * wa;
				b.x += dx * overlap * wb;
				b.y += dy * overlap * wb;
			}
		}
	}
}
