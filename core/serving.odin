package core

// Per-object serving: which machine does the agent work for an object -
// answers its discussion, mints its agent, fires its occurrences.
//
// Responsibility is a pure function of DAG state that every machine
// evaluates identically, so there is no lease, heartbeat, or coordinator.
// It never writes: work moves by editing its inputs, each an ordinary commit.
//
//   object.served_by      pin: this machine, whatever it can do
//   object.agent          guest list: the first listed agent with a served_by
//                         lends its pin (the agent pin)
//   object.requires       capability keys the work needs (catalog keys)
//   machine.capabilities  catalog keys installed AND enabled on that machine
//
// Resolution, in order:
//   self                the object is a machine (or an install): its own machine_id
//   pinned              served_by set and capable (or nothing required)
//   pinned-uncapable    served_by set but lacks a requirement - the host files a holdup
//   agent               nothing required → the agent pin
//   agent-capable       the agent pin has every requirement
//   capability          smallest machine_id among capable machines
//   unsatisfied         nothing capable → the agent pin (else nobody), and a holdup
//   unserved            no pin, no agent pin, nothing required → nobody
//
// Machine choice lives on agents; the space plays no part. An agent object's
// own served_by is its pin, so its transcript resolves `pinned`, and every
// object naming it follows through the agent pin.

import "core:encoding/json"
import "core:fmt"
import "core:strings"

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
// strings or links (`valuesValue`) - hosts write any of these shapes.
// `requires` links capability objects; `served_by` links a machine. Empty
// for anything else.
field_strings :: proc(fields: [dynamic]Value_Entry, key: string, allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	v, ok := fields_get(fields, key)
	if !ok do return out
	#partial switch v.kind {
	case .String_List:
		for s in v.strings do if s != "" do append(&out, s)
	case .List:
		for item in v.items {
			if item.kind == .String && item.str != "" do append(&out, item.str)
			else if item.kind == .Link && item.link_target != "" do append(&out, item.link_target)
		}
	case .String:
		if v.str != "" do append(&out, v.str)
	case .Link:
		if v.link_target != "" do append(&out, v.link_target)
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

// A machine serves a requirement only when it hosts the required capability
// object AND that capability's install is active. An unset or inactive
// capability does not exist for the resolver - it is not offered to an agent
// and its machine does not count.
capability_servers :: proc(states: map[string]^Object_State, capability_id: string, allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	cap := states[capability_id]
	if cap == nil || cap.deleted || cap.type_key != "capability" do return out
	machine := field_string(cap.fields, "served_by")
	if machine == "" {
		if v, ok := fields_get(cap.fields, "served_by"); ok && v.kind == .Link do machine = v.link_target
	}
	if machine == "" do return out
	// The capability's install must be active. It links the install object,
	// else a same-key same-machine install is the fallback while links migrate.
	install_id := field_string(cap.fields, "install")
	if install_id == "" {
		if v, ok := fields_get(cap.fields, "install"); ok && v.kind == .Link do install_id = v.link_target
	}
	inst := states[install_id]
	if inst == nil {
		for _, s in states {
			if s.deleted || s.type_key != "install" do continue
			if field_string(s.fields, "key") == field_string(cap.fields, "key") && field_string(s.fields, "machine_id") == machine do inst = s
		}
	}
	if inst != nil && field_string(inst.fields, "status") == "active" do append(&out, machine)
	return out
}

// `served_by` as a string machine_id, or the machine it links since it became
// an object relation.
@(private = "file")
served_by :: proc(s: ^Object_State) -> string {
	pin := field_string(s.fields, SERVED_BY_KEY)
	if pin == "" {
		if v, ok := fields_get(s.fields, SERVED_BY_KEY); ok && v.kind == .Link do pin = v.link_target
	}
	return pin
}

// The first agent on the object's guest list, in list order, that has a
// served_by. Agents missing from `states`, binned, or unpinned are skipped.
@(private = "file")
agent_pin :: proc(object: ^Object_State, states: map[string]^Object_State) -> string {
	for id in object_agents(object.fields) {
		agent := states[id]
		if agent == nil || agent.deleted || agent.type_key != "agent" do continue
		if pin := served_by(agent); pin != "" do return pin
	}
	return ""
}

// `states` carries the candidate machines, the capability objects and their
// installs, and the agents the object's guest list names.
resolve_server :: proc(object: ^Object_State, states: map[string]^Object_State, allocator := context.temp_allocator) -> Serving {
	out: Serving
	out.candidates = make([dynamic]string, allocator)
	if object != nil do out.requires = field_strings(object.fields, REQUIRES_KEY, allocator)
	else do out.requires = make([dynamic]string, allocator)
	// Installations are machine-owned services. Neither an agent pin nor an
	// object pin may approve credentials or install software elsewhere. An
	// installation missing its owner stays unserved, rather than falling back
	// to whichever machine happens to serve its agent.
	if object != nil && object.type_key == "install" {
		out.machine_id = field_string(object.fields, MACHINE_ID_KEY)
		out.reason = "self"
		return out
	}

	// A machine is a candidate iff it serves every required capability. With
	// no requirements every live machine is a candidate (a pin decides
	// between them).
	if len(out.requires) == 0 {
		for _, m in states {
			if m.deleted || m.type_key != "machine" do continue
			if id := field_string(m.fields, MACHINE_ID_KEY); id != "" do insert_sorted(&out.candidates, id)
		}
	} else {
		server_sets := make([dynamic][dynamic]string, allocator)
		for req in out.requires {
			append(&server_sets, capability_servers(states, req, allocator))
		}
		for _, m in states {
			if m.deleted || m.type_key != "machine" do continue
			id := field_string(m.fields, MACHINE_ID_KEY)
			if id == "" do continue
			ok := true
			for servers in server_sets {
				hosted := false
				for s in servers do if s == id { hosted = true; break }
				if !hosted { ok = false; break }
			}
			if ok do insert_sorted(&out.candidates, id)
		}
	}
	capable :: proc(s: ^Serving, id: string) -> bool {
		for c in s.candidates do if c == id do return true
		return false
	}

	pin, lent := "", ""
	if object != nil {
		pin = served_by(object)
		if pin == "" do lent = agent_pin(object, states)
	}

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
	case lent != "" && len(out.requires) == 0:
		out.machine_id, out.reason = lent, "agent"
	case lent != "" && capable(&out, lent):
		out.machine_id, out.reason = lent, "agent-capable"
	case len(out.requires) == 0:
		out.machine_id, out.reason = "", "unserved"
	case len(out.candidates) > 0:
		out.machine_id, out.reason = out.candidates[0], "capability"
	case:
		out.machine_id, out.reason = lent, "unsatisfied"
	}
	return out
}

// Object states riding a payload array, entered into `states` by id.
@(private = "file")
payload_states :: proc(payload: json.Value, key, noun: string, states: ^map[string]^Object_State) -> string {
	list, present := json_field(payload, key)
	if !present do return ""
	arr, ok := list.(json.Array)
	if !ok do return fmt.tprintf("%s must be an array", key)
	for item in arr {
		state, sok := object_from_json(item, context.temp_allocator, clone_json = false)
		if !sok do return fmt.tprintf("invalid %s state", noun)
		states^[strings.clone(state.id, context.temp_allocator)] = new_clone(state, context.temp_allocator)
	}
	return ""
}

// {action: "resolve", object?: ObjectJSON, agents?: [ObjectJSON],
//  machines?: [ObjectJSON], capabilities?: [ObjectJSON]}
// → {machineId, reason, requires: [key], candidates: [machineId]}
// `agents` are the agent objects the object's guest list names, in any order:
// the object's own list order decides. Capability objects ride with their
// installs: the resolver needs both alongside the machines.
serving_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	switch json_str(payload, "action") {
	case "resolve":
		object, ook := optional_state(payload, "object")
		if !ook do return nil, "invalid object state"
		states := make(map[string]^Object_State, context.temp_allocator)
		if object != nil do states[object.id] = object
		if err := payload_states(payload, "agents", "agent", &states); err != "" do return nil, err
		if err := payload_states(payload, "machines", "machine", &states); err != "" do return nil, err
		if err := payload_states(payload, "capabilities", "capability", &states); err != "" do return nil, err
		return serving_to_json(resolve_server(object, states)), ""
	}
	return nil, "unknown serving action"
}

// Resolve by id over a full state map: every live `machine` object is a
// candidate and the object's agents are found among the states. `object_id`
// may name an object that does not exist yet - it then resolves `unserved`.
resolve_server_in :: proc(states: map[string]^Object_State, object_id: string, allocator := context.temp_allocator) -> Serving {
	return resolve_server(states[object_id], states, allocator)
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
