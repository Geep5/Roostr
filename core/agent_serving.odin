package core

// Every agent names its own computer. An agent with no `served_by` runs
// nowhere - no capability fallback, no pin borrowed from anywhere (see
// resolve_server) - and says so in its own `error` property. The engine
// writes that error and clears it together with the pin, so every host
// (daemon, web, iOS) shows the same thing without running anything.
//
// Subagents run under their parent and external responders answer from
// outside Roostr: neither needs a computer of its own.

AGENT_UNSERVED_ERROR :: "no machine serves this agent: pick a computer in its Served by property"

@(private = "file")
ERROR_KEY :: "error"

// Whether `fields` hold a served_by pin in any shape hosts write: a
// machine_id string, a link, or a one-item list of either.
agent_pin_present :: proc(fields: [dynamic]Value_Entry) -> bool {
	v, ok := fields_get(fields, SERVED_BY_KEY)
	if !ok do return false
	#partial switch v.kind {
	case .String:
		return v.str != ""
	case .Link:
		return v.link_target != ""
	case .String_List:
		for s in v.strings do if s != "" do return true
	case .List:
		for item in v.items {
			if item.kind == .String && item.str != "" do return true
			if item.kind == .Link && item.link_target != "" do return true
		}
	}
	return false
}

// An agent that must name a computer: not a subagent, not an external responder.
agent_needs_pin :: proc(fields: [dynamic]Value_Entry) -> bool {
	return !field_truthy(fields, "spawn_parent") && !field_truthy(fields, "external_responder")
}

@(private = "file")
field_truthy :: proc(fields: [dynamic]Value_Entry, key: string) -> bool {
	v, ok := fields_get(fields, key)
	if !ok do return false
	#partial switch v.kind {
	case .String:
		return v.str != ""
	case .Bool:
		return v.b
	case .Link:
		return v.link_target != ""
	case .None:
		return false
	}
	return true
}

// The error op that brings an agent with `fields` in line with the rule:
// set the unserved error when it has no pin, clear exactly that error when
// it has one. Any other error (a failed run) is the harness's and stays.
agent_error_op :: proc(fields: [dynamic]Value_Entry) -> (Operation, bool) {
	current := field_string(fields, ERROR_KEY)
	if agent_needs_pin(fields) && !agent_pin_present(fields) {
		if current == AGENT_UNSERVED_ERROR do return {}, false
		return Operation{kind = .Field_Set, key = ERROR_KEY, value = string_value(AGENT_UNSERVED_ERROR)}, true
	}
	if current == AGENT_UNSERVED_ERROR do return Operation{kind = .Field_Delete, key = ERROR_KEY}, true
	return {}, false
}

// `fields` after one field write, for evaluating the rule on the result.
agent_fields_after :: proc(fields: [dynamic]Value_Entry, key: string, value: Value, deleted: bool) -> [dynamic]Value_Entry {
	out := make([dynamic]Value_Entry, context.temp_allocator)
	for e in fields do if e.key != key do append(&out, e)
	if !deleted do append(&out, Value_Entry{key = key, value = value})
	return out
}

// Field writes that can change whether the rule holds.
agent_rule_key :: proc(key: string) -> bool {
	return key == SERVED_BY_KEY || key == "spawn_parent" || key == "external_responder"
}
