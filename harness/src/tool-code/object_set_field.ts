import type { Roostr, ValueJSON } from "../tool-sdk";

export const description = "Set one of the object's properties - only a property that exists in this space (the reply lists them if the key is unknown); a value nothing can display is refused, never stored. The value is written in the property's own type: checkbox true/false, number a number, date epoch milliseconds or an ISO date, tag/object comma-separated; anything else is text. The reply is the value as the human now sees it. Setting done=true on a recurring object completes its current occurrence. key=agent ADDS the given agent id(s) to the guest list (who may be @-asked here); it never removes anyone. To make an object repeat, use object_set_repeat.";
export const inputs = "id: string\nkey: string\nvalue: string";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	const key = asText(input.key);
	const raw = asText(input.value);
	roostr.touch(asText(input.id));
	const obj = await roostr.writable(asText(input.id));
	// Field keys agents reach for when they mean a schedule: only object_set_repeat makes an object recur.
	const scheduleKeys: Record<string, true> = { repeat: true, repeats: true, recurrence: true, recurring: true, recurs: true, schedule: true, frequency: true, cadence: true };
	if (scheduleKeys[key.toLowerCase()] === true) {
		return `error: nothing written. "${key}" does not make an object repeat - call object_set_repeat (every N days/weeks/months/years, weekdays, time).`;
	}
	const defs = await roostr.properties();
	const def = defs.get(key);
	if (!def) {
		const known = [...defs.values()].filter((d) => !d.readOnly).map((d) => `${d.key} (${d.name}, ${d.format})`).join(", ");
		return `error: nothing written. This space has no "${key}" property, so a value there would be invisible to everyone. Properties here: ${known}. If none fits, create one with object_add_property (it shows in everyone's Properties list), then set it - never report it as done before that.`;
	}
	if (def.readOnly) return `error: nothing written. ${def.name} is computed by the store and cannot be set.`;
	const strings = (items: string[]): ValueJSON => ({ valuesValue: { items: items.map((s) => ({ stringValue: s })) } });
	/**
	 * The value in the property's own type, or why the input can't be one.
	 * Agents speak strings; the store does not - a checkbox written as "true"
	 * text is unchecked, a date as text never sorts. A value that would not
	 * read back as what was meant is refused, never stored as text.
	 */
	const typedValue = (format: string): ValueJSON | { error: string } => {
		const t = raw.trim();
		const n = t === "" ? NaN : Number(t);
		switch (format) {
			case "checkbox":
				if (t.toLowerCase() === "true") return { boolValue: true };
				if (t.toLowerCase() === "false") return { boolValue: false };
				return { error: `a checkbox takes true or false, not "${raw}"` };
			case "number":
				if (!Number.isFinite(n)) return { error: `a number property takes a number, not "${raw}"` };
				return Number.isInteger(n) ? { intValue: n } : { floatValue: n };
			case "date": {
				if (Number.isFinite(n)) return { intValue: Math.round(n) };
				const parsed = Date.parse(t);
				return Number.isNaN(parsed) ? { error: `a date property takes an ISO date or epoch milliseconds, not "${raw}"` } : { intValue: parsed };
			}
			case "status":
				return strings(t ? [t] : []);
			// Tag and object relations are lists in the store (and in the UI):
			// a bare string here would render as an empty cell.
			case "tag":
			case "object":
				return strings(t.split(",").map((s) => s.trim()).filter(Boolean));
			default:
				return { stringValue: raw };
		}
	};
	let value: ValueJSON;
	if (key === "agent") {
		// The guest list only grows here, and only by agents.
		const adding = raw.split(",").map((s) => s.trim()).filter(Boolean);
		for (const aid of adding) {
			const agent = await roostr.get(aid).catch(() => null);
			if (agent?.typeKey !== "agent") return `error: nothing written. "${aid}" is not an agent object.`;
		}
		value = strings([...new Set([...roostr.guests(obj.fields), ...adding])]);
	} else {
		const typed = typedValue(def.format);
		if ("error" in typed) return `error: nothing written. ${def.name}: ${typed.error}.`;
		value = typed;
	}
	// The clock rides along for the one case the engine needs it: done
	// on a recurring object advances the occurrence in local time.
	await roostr.mutate("set_field", { object_id: obj.id, key, value, ...roostr.clock() });
	const after = await roostr.get(obj.id);
	if (key === "done" && after.fields["repeat"]) return `This object repeats, so the current occurrence was completed instead: ${roostr.describeRepeat(after.fields["repeat"])}.`;
	/** A stored value as the Properties pane shows it - what the human now sees. */
	const shown = (v: ValueJSON | undefined): string => {
		if (!v) return "(empty)";
		if (v.boolValue !== undefined) return v.boolValue ? "checked" : "unchecked";
		const ms = v.intValue ?? v.floatValue;
		if (def.format === "date" && ms !== undefined) return new Date(ms).toLocaleString();
		if (ms !== undefined) return String(ms);
		const items = v.valuesValue?.items ?? [];
		if (v.valuesValue) return items.length ? items.map((i) => i.stringValue ?? i.linkValue?.targetId ?? "").join(", ") : "(empty)";
		return v.stringValue || "(empty)";
	};
	return `${def.name} is now: ${shown(after.fields[key])}`;
}
