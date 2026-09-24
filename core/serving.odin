package core

// Per-object serving: which machine does the agent work for an object -
// answers its discussion, mints its agent, fires its occurrences.
//
// Responsibility is a pure function of DAG state that every machine
// evaluates identically, so there is no lease, heartbeat, or coordinator.
// It never writes: work moves by editing its inputs, each an ordinary commit.
//
//   object.served_by      pin: this machine, whatever it can do
//   object.requires       capability keys the work needs (catalog keys)
//   space.served_by       default server for the space (first-seen machine)
//   machine.capabilities  catalog keys installed AND enabled on that machine
//
// Resolution, in order:
//   pinned              served_by set and capable (or nothing required)
//   pinned-uncapable    served_by set but lacks a requirement - the host files a holdup
//   space               nothing required → the space default
//   space-capable       the default has every requirement (stickiness: no churn)
//   capability          smallest machine_id among capable machines
//   unsatisfied         nothing capable → the space default, and a holdup
//
// An agent has no server of its own: the object that names it (`object.agent`)
// resolves through this same function, and the agent object itself for its
// own transcript.

import "core:encoding/json"

SERVED_BY_KEY :: "served_by"
REQUIRES_KEY :: "requires"
CAPABILITIES_KEY :: "capabilities"
MACHINE_ID_KEY :: "machine_id"
MACHINE_TYPE_KEY :: "machine"

Serving :: struct {
	machine_id: string,
	reason:     string,
	requires:   [dynamic]string,
	candidates: [dynamic]string, // machine ids able to serve, sorted
}

// Strings of a list-valued field: String_List (`listValue`) or a List of
// strings (`valuesValue`) - hosts write both shapes. Empty for anything else.
field_strings :: proc(fields: [dynamic]Value_Entry, key: string, allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	v, ok := fields_get(fields, key)
	if !ok do return out
	#partial switch v.kind {
	case .String_List:
		for s in v.strings do if s != "" do append(&out, s)
	case .List:
		for item in v.items do if item.kind == .String && item.str != "" do append(&out, item.str)
	case .String:
		if v.str != "" do append(&out, v.str)
	}
	return out
}

@(private = "file")
has_all :: proc(have, need: [dynamic]string) -> bool {
	outer: for n in need {
		for h in have do if h == n do continue outer
		return false
	}
	return true
}

@(private = "file")
insert_sorted :: proc(ids: ^[dynamic]string, id: string) {
	for existing, i in ids {
		if existing == id do return
		if id < existing {
			inject_at(ids, i, id)
			return
		}
	}
	append(ids, id)
}

resolve_server :: proc(object: ^Object_State, space: ^Object_State, machines: []Object_State, allocator := context.temp_allocator) -> Serving {
	out: Serving
	out.candidates = make([dynamic]string, allocator)
	if object != nil do out.requires = field_strings(object.fields, REQUIRES_KEY, allocator)
	else do out.requires = make([dynamic]string, allocator)
	// Installations are machine-owned services. Neither a space default nor
	// an object pin may approve credentials or install software elsewhere.
	// An installation missing its owner stays unserved, rather than falling
	// back to whichever machine happens to serve the space.
	if object != nil && object.type_key == "install" {
		out.machine_id = field_string(object.fields, MACHINE_ID_KEY)
		out.reason = "self"
		return out
	}

	for &m in machines {
		id := field_string(m.fields, MACHINE_ID_KEY)
		if id == "" do continue
		if has_all(field_strings(m.fields, CAPABILITIES_KEY), out.requires) do insert_sorted(&out.candidates, id)
	}
	capable :: proc(s: ^Serving, id: string) -> bool {
		for c in s.candidates do if c == id do return true
		return false
	}

	pin := ""
	if object != nil {
		pin = field_string(object.fields, SERVED_BY_KEY)
		if pin == "" {
			// served_by became an object relation: the machine object id rides as a link.
			if v, ok := fields_get(object.fields, SERVED_BY_KEY); ok && v.kind == .Link do pin = v.link_target
		}
	}
	dflt := pin
	if dflt == "" && space != nil do dflt = field_string(space.fields, SERVED_BY_KEY)

	// A machine object answers for itself, ahead of any pin. Nobody else can
	// install software on that box, read its holdups, or report its
	// capabilities - so "who serves this machine?" has exactly one honest
	// answer, and a pin to another machine would be a promise it cannot keep.
	self := ""
	if object != nil && object.type_key == MACHINE_TYPE_KEY do self = field_string(object.fields, MACHINE_ID_KEY)

	switch {
	case self != "":
		out.machine_id, out.reason = self, "self"
	case pin != "" && (len(out.requires) == 0 || capable(&out, pin)):
		out.machine_id, out.reason = pin, "pinned"
	case pin != "":
		out.machine_id, out.reason = pin, "pinned-uncapable"
	case len(out.requires) == 0:
		out.machine_id, out.reason = dflt, "space"
	case dflt != "" && capable(&out, dflt):
		out.machine_id, out.reason = dflt, "space-capable"
	case len(out.candidates) > 0:
		out.machine_id, out.reason = out.candidates[0], "capability"
	case:
		out.machine_id, out.reason = dflt, "unsatisfied"
	}
	return out
}

// {action: "resolve", object?: ObjectJSON, space?: ObjectJSON, machines: [ObjectJSON]}
// → {machineId, reason, requires: [key], candidates: [machineId]}
serving_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	switch json_str(payload, "action") {
	case "resolve":
		object, ook := optional_state(payload, "object")
		if !ook do return nil, "invalid object state"
		space, sok := optional_state(payload, "space")
		if !sok do return nil, "invalid space state"
		machines := make([dynamic]Object_State, context.temp_allocator)
		if list, present := json_field(payload, "machines"); present {
			arr, aok := list.(json.Array)
			if !aok do return nil, "machines must be an array"
			for item in arr {
				state, mok := object_from_json(item, context.temp_allocator, clone_json = false)
				if !mok do return nil, "invalid machine state"
				append(&machines, state)
			}
		}
		return serving_to_json(resolve_server(object, space, machines[:])), ""
	}
	return nil, "unknown serving action"
}

// Resolve by id over a full state map: the object's `channel` (else the
// oldest live channel) is its space; every live `machine` object is a
// candidate. `object_id` may name an object that does not exist yet (a
// brand-new space's first message) - it then resolves as the space default.
resolve_server_in :: proc(states: map[string]^Object_State, object_id: string, allocator := context.temp_allocator) -> Serving {
	object := states[object_id]
	space_id := ""
	if object != nil do space_id = field_string(object.fields, "channel")
	if space_id == "" do space_id = oldest_channel_id(states)
	space := states[space_id]
	machines := make([dynamic]Object_State, allocator)
	for _, s in states {
		if s.type_key == "machine" && !s.deleted do append(&machines, s^)
	}
	return resolve_server(object, space, machines[:], allocator)
}

serving_to_json :: proc(s: Serving, allocator := context.temp_allocator) -> json.Value {
	out := jobj(allocator)
	out["machineId"] = json.String(s.machine_id)
	out["reason"] = json.String(s.reason)
	requires := make([dynamic]json.Value, allocator)
	for r in s.requires do append(&requires, json.String(r))
	out["requires"] = json.Array(requires)
	candidates := make([dynamic]json.Value, allocator)
	for c in s.candidates do append(&candidates, json.String(c))
	out["candidates"] = json.Array(candidates)
	return json.Object(out)
}
