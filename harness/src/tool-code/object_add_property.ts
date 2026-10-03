import type { Roostr } from "../tool-sdk";

export const description = "Create a new property in this space - on purpose, visible to everyone in the Properties list - when none of the existing ones fits (object_set_field lists them). Then set values with object_set_field. `object` properties may be limited to some types (type keys). Creating a key that already exists changes nothing and says so.";
export const inputs = "name: string - human name, e.g. 'Mockup status'\nformat: shorttext|longtext|number|status|tag|date|checkbox|url|email|phone|object\nobject_types?: string[] - object format only: type keys the value may link to";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	// Formats a person can create in the app (the website's CREATABLE_FORMATS).
	const formats = ["shorttext", "longtext", "number", "status", "tag", "date", "checkbox", "url", "email", "phone", "object"];
	const name = (typeof input.name === "string" ? input.name : "").trim();
	if (!name) return "error: nothing created. A property needs a name.";
	const format = typeof input.format === "string" ? input.format : "";
	if (!formats.includes(format)) return `error: nothing created. format must be one of ${formats.join(", ")}.`;
	// The key from the name, as the app derives it (relations.ts slugKey).
	const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `prop_${Date.now()}`;
	// Keys agents reach for when they mean a schedule: only object_set_repeat makes an object recur.
	const scheduleKeys: Record<string, true> = { repeat: true, repeats: true, recurrence: true, recurring: true, recurs: true, schedule: true, frequency: true, cadence: true };
	if (scheduleKeys[key] === true) return `error: nothing created. A "${name}" property would not make anything repeat - use object_set_repeat.`;
	const space = await roostr.space();
	// Same property whatever the spelling: "Due date", "due_date" and the bundled "dueDate" are one.
	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const existing = [...(await roostr.properties()).values()].find((d) => norm(d.key) === norm(name) || norm(d.name) === norm(name));
	if (existing) return `Nothing created: this space already has ${existing.name} (key ${existing.key}, ${existing.format}). Set it with object_set_field key=${existing.key}.`;
	const types = await roostr.types();
	const limits: string[] = [];
	const wanted = format === "object" && Array.isArray(input.object_types) ? input.object_types.filter((x): x is string => typeof x === "string") : [];
	for (const k of wanted) {
		const t = types.get(k);
		if (!t) return `error: nothing created. No type "${k}" in this space; types here: ${[...types.keys()].join(", ")}.`;
		limits.push(t.id);
	}
	await roostr.create(name, "relation", {
		channel: { stringValue: space },
		key: { stringValue: key },
		name: { stringValue: name },
		format: { stringValue: format },
		hidden: { boolValue: false },
		readOnly: { boolValue: false },
		maxCount: { intValue: format === "status" ? 1 : 0 },
		options: { valuesValue: { items: [] } },
		bundled: { boolValue: false },
		...(limits.length ? { object_types: { valuesValue: { items: limits.map((t) => ({ stringValue: t })) } } } : {}),
	});
	return `Created the property ${name} (key ${key}, ${format}) in this space; it now shows in the Properties list. Set it with object_set_field key=${key}.`;
}
