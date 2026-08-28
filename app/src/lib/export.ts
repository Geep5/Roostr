/**
 * Whole-space export, modeled on Anytype's export popup (popup/export.tsx):
 * their formats are Markdown and Any-Block (raw structures, JSON or
 * protobuf), zipped. Ours: Markdown (readable notes) and JSON (the full
 * computed objects — fields, blocks, provenance). Everything is fetched
 * through the local API and zipped in the browser; nothing leaves the
 * machine.
 */

import { fetchQuery } from "$lib/api";
import type { BlockJSON, ObjectJSON, ValueJSON } from "$lib/types";
import { Style } from "$lib/types";

const API = "http://127.0.0.1:7333";

async function fetchAllObjects(): Promise<ObjectJSON[]> {
	const res = await fetchQuery({ limit: 5000 });
	const out: ObjectJSON[] = [];
	for (const r of res.records) {
		const o = await fetch(`${API}/api/objects/${r.id}`);
		if (o.ok) out.push((await o.json()) as ObjectJSON);
	}
	return out;
}

// ── Markdown rendering ────────────────────────────────────────────

function fieldPlain(v: ValueJSON | undefined): string {
	if (!v) return "";
	if (typeof v.stringValue === "string") return v.stringValue;
	if (typeof v.intValue === "number") return String(v.intValue);
	if (typeof v.floatValue === "number") return String(v.floatValue);
	if (typeof v.boolValue === "boolean") return String(v.boolValue);
	if (v.valuesValue) return v.valuesValue.items.map((i) => i.stringValue ?? "").filter(Boolean).join(", ");
	return "";
}

function mdBlock(b: BlockJSON, byId: Map<string, BlockJSON>, names: Map<string, string>, depth: number): string[] {
	const pad = "  ".repeat(depth);
	const out: string[] = [];
	const t = b.content.text;
	if (t) {
		const s = t.style;
		const text = t.text;
		if (s === Style.HEADER1) out.push(`# ${text}`);
		else if (s === Style.HEADER2) out.push(`## ${text}`);
		else if (s === Style.HEADER3) out.push(`### ${text}`);
		else if (s === Style.BULLET) out.push(`${pad}- ${text}`);
		else if (s === Style.NUMBERED) out.push(`${pad}1. ${text}`);
		else if (s === Style.CHECKBOX) out.push(`${pad}- [${t.checked ? "x" : " "}] ${text}`);
		else if (s === Style.TOGGLE) out.push(`${pad}- ▸ ${text}`);
		else if (s === Style.QUOTE) out.push(`> ${text}`);
		else if (s === Style.CODE) out.push("```", text, "```");
		else if (s === Style.CALLOUT) out.push(`> **!** ${text}`);
		else if (text) out.push(`${pad}${text}`);
	} else if (b.content.custom?.contentType === "link") {
		const target = b.content.custom.meta?.target ?? "";
		out.push(`${pad}→ [[${names.get(target) ?? target}]]`);
	} else if (b.content.custom?.contentType === "bookmark") {
		const url = b.content.custom.meta?.["url"] ?? "";
		out.push(`${pad}<${url}>`);
	}
	for (const cid of b.childrenIds) {
		const c = byId.get(cid);
		if (c && !c.content.layout) out.push(...mdBlock(c, byId, names, t ? depth + 1 : depth));
		else if (c) for (const gc of c.childrenIds) {
			const g = byId.get(gc);
			if (g) out.push(...mdBlock(g, byId, names, depth));
		}
	}
	return out;
}

function mdFor(o: ObjectJSON, names: Map<string, string>): string {
	const name = fieldPlain(o.fields["name"]) || "Untitled";
	const lines: string[] = [];
	// Frontmatter: type + the object's plain property values.
	lines.push("---");
	lines.push(`type: ${o.typeKey}`);
	for (const [k, v] of Object.entries(o.fields)) {
		if (["name", "type_key"].includes(k)) continue;
		const plain = fieldPlain(v);
		if (plain) lines.push(`${k}: ${plain.replaceAll("\n", " ")}`);
	}
	lines.push("---", "", `# ${name}`, "");
	const byId = new Map(o.blocks.map((b) => [b.id, b]));
	const referenced = new Set<string>();
	for (const b of o.blocks) for (const c of b.childrenIds) referenced.add(c);
	for (const b of o.blocks) {
		if (referenced.has(b.id) || b.id === "__content__" || b.id === "__discussion__") continue;
		lines.push(...mdBlock(b, byId, names, 0));
	}
	return lines.join("\n") + "\n";
}

// ── Store-only zip writer (no deps) ───────────────────────────────

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; data: Uint8Array }>): Blob {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const e of entries) {
		const nameB = enc.encode(e.name);
		const crc = crc32(e.data);
		const local = new Uint8Array(30 + nameB.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(4, 20, true);
		lv.setUint32(14, crc, true);
		lv.setUint32(18, e.data.length, true);
		lv.setUint32(22, e.data.length, true);
		lv.setUint16(26, nameB.length, true);
		local.set(nameB, 30);
		chunks.push(local, e.data);
		const cd = new Uint8Array(46 + nameB.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(16, crc, true);
		cv.setUint32(20, e.data.length, true);
		cv.setUint32(24, e.data.length, true);
		cv.setUint16(28, nameB.length, true);
		cv.setUint32(42, offset, true);
		cd.set(nameB, 46);
		central.push(cd);
		offset += local.length + e.data.length;
	}
	const cdSize = central.reduce((a, c) => a + c.length, 0);
	const end = new Uint8Array(22);
	const ev = new DataView(end.buffer);
	ev.setUint32(0, 0x06054b50, true);
	ev.setUint16(8, entries.length, true);
	ev.setUint16(10, entries.length, true);
	ev.setUint32(12, cdSize, true);
	ev.setUint32(16, offset, true);
	return new Blob([...chunks, ...central, end] as BlobPart[], { type: "application/zip" });
}

function safeName(name: string, id: string): string {
	const base = name.replace(/[^\w\d \-_.]+/g, "").trim().slice(0, 60) || "Untitled";
	return `${base} ${id.slice(0, 8)}`;
}

/** Export every object as Markdown or JSON, downloaded as one zip. */
export async function exportAll(format: "markdown" | "json", onprogress?: (done: number, total: number) => void): Promise<number> {
	const objects = await fetchAllObjects();
	const names = new Map(objects.map((o) => [o.id, fieldPlain(o.fields["name"]) || "Untitled"]));
	const enc = new TextEncoder();
	const entries: Array<{ name: string; data: Uint8Array }> = [];
	objects.forEach((o, i) => {
		const fname = safeName(names.get(o.id) ?? "Untitled", o.id);
		if (format === "markdown") {
			entries.push({ name: `${o.typeKey || "other"}/${fname}.md`, data: enc.encode(mdFor(o, names)) });
		} else {
			entries.push({ name: `${o.typeKey || "other"}/${fname}.json`, data: enc.encode(JSON.stringify(o, null, "\t")) });
		}
		onprogress?.(i + 1, objects.length);
	});
	const blob = zip(entries);
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `roostr-export-${format}-${new Date().toISOString().slice(0, 10)}.zip`;
	a.click();
	URL.revokeObjectURL(a.href);
	return objects.length;
}
