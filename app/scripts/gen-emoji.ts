/**
 * Regenerate src/lib/emoji-data.ts from Unicode's emoji-test.txt.
 * Run to adopt a new Unicode release: bun run scripts/gen-emoji.ts
 *
 * emoji-test.txt is the canonical machine-readable list: every emoji in
 * standard order, tagged with a qualification status and carrying its CLDR
 * name, split into the nine standard groups. Taking it verbatim means the
 * picker matches every other emoji keyboard instead of one person's taste.
 *
 * Kept: fully-qualified sequences only (the forms a font is required to
 * render). Dropped: skin-tone and hair variants — 2,030 of the 3,944 rows
 * are one of five tones applied to the same gesture, which triples the
 * grid without adding a concept. The base sequence is what a picker shows.
 *
 * The fetch happens here, once, and the result is committed: the build must
 * never depend on unicode.org being reachable.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = "https://unicode.org/Public/emoji/latest/emoji-test.txt";
const outPath = resolve(import.meta.dir, "..", "src/lib/emoji-data.ts");

const txt = await (await fetch(SOURCE)).text();
const version = txt.match(/#\s*Version:\s*(\S+)/)?.[1] ?? "unknown";

const groups: string[] = [];
const rows: Array<{ emoji: string; name: string; group: number }> = [];
let group = -1;

for (const line of txt.split("\n")) {
	if (line.startsWith("# group:")) {
		const label = line.slice(8).trim();
		// "Component" holds the skin-tone and hair modifiers (🏻, 🦰). They are
		// combining pieces, not emoji anyone picks.
		group = label === "Component" ? -1 : groups.push(label) - 1;
		continue;
	}
	if (!line || line.startsWith("#") || group === -1) continue;
	const m = line.match(/^([0-9A-F ]+);\s*([a-z-]+)\s*#\s*(\S+)\s+E\d+\.\d+\s+(.+)$/);
	if (!m) continue;
	const [, , status, emoji, name] = m;
	if (status !== "fully-qualified") continue;
	// "…: light skin tone", "…: curly hair" — variants of a base sequence.
	if (/ skin tone|: .*hair\b/.test(name)) continue;
	rows.push({ emoji, name, group });
}

if (rows.length < 1000) throw new Error(`only parsed ${rows.length} emoji — source format changed?`);

const out = `/**
 * GENERATED FILE — do not edit. Source: ${SOURCE}
 * Unicode emoji ${version} · ${rows.length} base emoji in ${groups.length} groups.
 * Regenerate with: bun run scripts/gen-emoji.ts
 *
 * Tuple form keeps the payload small: [emoji, CLDR name, group index].
 */
export const EMOJI_GROUPS: readonly string[] = ${JSON.stringify(groups)};

export const EMOJI: ReadonlyArray<readonly [string, string, number]> = ${JSON.stringify(
	rows.map((r) => [r.emoji, r.name, r.group]),
)};
`;

writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${rows.length} emoji, ${groups.length} groups, Unicode ${version}, ${(out.length / 1024).toFixed(1)} KB`);
