import type { ValueJSON } from "../api";
import type { Roostr } from "../tool-sdk";

export const description =
	"Change an existing property of this space, as the app's property Edit screen does - visible to everyone: rename it, change its emoji, limit an object property to some types (type keys; [] lifts the limit), or add select/status/tag options. Built-in properties are not editable. To change a value on an object use object_set_field; to make a new property use object_add_property.";
export const inputs =
	"key: string - the property's key or name, e.g. 'main_games' or 'Main games'\nname?: string - new name\nemoji?: string - new emoji ('' removes it)\nobject_types?: string[] - object format only: type keys the value may link to; [] = any type\nadd_options?: string[] - status/tag/select formats: option texts to add";

const OPTION_FORMATS = ["status", "tag", "select", "multi_select"];
const PALETTE = ["grey", "red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "purple", "pink"];

const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()) : undefined);

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asked = typeof input.key === "string" ? input.key.trim() : "";
	if (!asked) return "error: nothing changed. Say which property: key or name.";
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const rows = await roostr.query({ type: "relation", filters: [await roostr.spaceFilter()] });
	const rel = rows.find((r) => {
		const key = r.fields["key"]?.stringValue ?? "";
		const name = r.fields["name"]?.stringValue ?? "";
		return norm(key) === norm(asked) || norm(name) === norm(asked);
	});
	if (!rel) {
		const known = rows.map((r) => r.fields["name"]?.stringValue || r.fields["key"]?.stringValue).filter(Boolean).join(", ");
		return `error: nothing changed. This space has no "${asked}" property. Properties here: ${known}.`;
	}
	const relName = rel.fields["name"]?.stringValue || rel.fields["key"]?.stringValue || asked;
	const format = rel.fields["format"]?.stringValue ?? "";
	if (rel.fields["bundled"]?.boolValue === true || rel.fields["readOnly"]?.boolValue === true || rel.fields["system"]?.boolValue === true) {
		return `error: nothing changed. ${relName} is built into Roostr; its definition is not editable.`;
	}
	const changes: Array<[string, ValueJSON]> = [];
	const said: string[] = [];
	if (typeof input.name === "string") {
		const name = input.name.trim();
		if (!name) return "error: nothing changed. A property needs a name.";
		const clash = rows.find((r) => r.id !== rel.id && norm(r.fields["name"]?.stringValue ?? "") === norm(name));
		if (clash) return `error: nothing changed. This space already has a property named ${clash.fields["name"]?.stringValue}.`;
		changes.push(["name", { stringValue: name }]);
		said.push(`renamed to ${name}`);
	}
	if (typeof input.emoji === "string") {
		changes.push(["iconEmoji", { stringValue: input.emoji.trim() }]);
		said.push(input.emoji.trim() ? `emoji ${input.emoji.trim()}` : "emoji removed");
	}
	const wantedTypes = strings(input.object_types);
	if (wantedTypes) {
		if (format !== "object") return `error: nothing changed. ${relName} is a ${format} property; only object properties link to types.`;
		const types = await roostr.types();
		const ids: string[] = [];
		const names: string[] = [];
		for (const k of wantedTypes) {
			const t = types.get(k) ?? [...types.values()].find((x) => norm(x.name) === norm(k));
			if (!t) return `error: nothing changed. No type "${k}" in this space; types here: ${[...types.keys()].join(", ")}.`;
			ids.push(t.id);
			names.push(t.name);
		}
		changes.push(["object_types", { valuesValue: { items: ids.map((id) => ({ stringValue: id })) } }]);
		said.push(names.length ? `links only to ${names.join(", ")}` : "links to any type");
	}
	const newOptions = strings(input.add_options)?.filter(Boolean);
	if (newOptions?.length) {
		if (!OPTION_FORMATS.includes(format)) return `error: nothing changed. ${relName} is a ${format} property; only status, tag and select properties have options.`;
		const items = rel.fields["options"]?.valuesValue?.items ?? [];
		const have = new Set(items.map((i) => norm(i.mapValue?.entries["text"]?.stringValue ?? "")));
		const added: ValueJSON[] = [];
		for (const text of newOptions) {
			if (have.has(norm(text))) continue;
			have.add(norm(text));
			const n = items.length + added.length;
			added.push({
				mapValue: {
					entries: {
						id: { stringValue: crypto.randomUUID() },
						text: { stringValue: text },
						color: { stringValue: PALETTE[n % PALETTE.length] },
						orderId: { stringValue: String(n).padStart(6, "0") },
					},
				},
			});
		}
		if (added.length) {
			changes.push(["options", { valuesValue: { items: [...items, ...added] } }]);
			said.push(`options added: ${added.map((a) => a.mapValue?.entries["text"]?.stringValue).join(", ")}`);
		} else said.push("those options already exist");
	}
	if (!changes.length) return `error: nothing changed. Say what to change on ${relName}: name, emoji, object_types or add_options.`;
	for (const [key, value] of changes) await roostr.setField(rel.id, key, value);
	roostr.touch(rel.id);
	return `${relName}: ${said.join("; ")}. Everyone in this space sees the change.`;
}
