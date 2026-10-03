/**
 * Models sometimes send typed tool inputs as text - "true" for a boolean,
 * "5" for a number, "[\"09:30\"]" for a list - especially under prompts
 * that insist on plain text. Tools then saw a string, refused, or silently
 * did nothing (object_check never ticked). Each input whose schema says
 * boolean/number/integer/array/object and that arrived as a string is
 * converted when the text unambiguously means that type; anything else is
 * left as sent, so the tool's own checks still speak.
 */
import type { ToolDef } from "./types";

type Schema = { type?: unknown; items?: unknown };

function asSchema(v: unknown): Schema {
	return v && typeof v === "object" ? v : {};
}

function coerce(value: unknown, schema: Schema): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	switch (schema.type) {
		case "boolean":
			if (text === "true") return true;
			if (text === "false") return false;
			return value;
		case "number":
		case "integer": {
			if (text === "") return value;
			const n = Number(text);
			if (!Number.isFinite(n) || (schema.type === "integer" && !Number.isInteger(n))) return value;
			return n;
		}
		case "array": {
			if (!text.startsWith("[")) return value;
			try {
				const parsed: unknown = JSON.parse(text);
				if (!Array.isArray(parsed)) return value;
				const items = asSchema(schema.items);
				return parsed.map((item) => coerce(item, items));
			} catch {
				return value;
			}
		}
		case "object": {
			if (!text.startsWith("{")) return value;
			try {
				const parsed: unknown = JSON.parse(text);
				return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
			} catch {
				return value;
			}
		}
		default:
			return value;
	}
}

/** `input` with every stringly-typed value converted to what `def`'s schema declares. */
export function coerceToolInput(def: ToolDef, input: Record<string, unknown>): Record<string, unknown> {
	const props = asSchema(def.input_schema);
	const properties = "properties" in props && props.properties && typeof props.properties === "object" ? props.properties : {};
	const out: Record<string, unknown> = { ...input };
	for (const [key, schema] of Object.entries(properties)) {
		if (key in out) out[key] = coerce(out[key], asSchema(schema));
	}
	return out;
}
