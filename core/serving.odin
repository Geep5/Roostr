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
//   object.skills         skill objects the work uses; a skill with a `key`
//                         needs a computer with an active capability of it
//   capability objects    one per (skill key x machine), usable once active
//
// Resolution, in order:
//   self                the object is a machine (or an install): its own machine_id
//   pinned              served_by set and capable (or no machine skill needed)
//   pinned-uncapable    served_by set but lacks a skill - the host files a holdup
//   agent               no machine skill needed → the agent pin
//   agent-capable       the agent pin has every machine skill
//   capability          smallest machine_id among capable machines
//   unsatisfied         nothing capable → the agent pin (else nobody), and a holdup
//   unserved            no pin, no agent pin, no machine skill → nobody
//
// Machine choice lives on agents; the space plays no part. An agent object's
// own served_by is its pin, so its transcript resolves `pinned`, and every
// object naming it follows through the agent pin. An agent with no pin is
// `unserved` whatever skills it lists - nothing picks a computer for it.

import "core:encoding/json"
import "core:fmt"
import "core:strings"

SERVED_BY_KEY :: "served_by"
SKILLS_KEY :: "skills"
MACHINE_ID_KEY :: "machine_id"
MACHINE_TYPE_KEY :: "machine"

Serving :: struct {
	machine_id: string,
	reason:     string,
	skills:     [dynamic]string, // keys of the machine skills the work needs
	candidates: [dynamic]string, // machine ids able to serve, sorted
}

// Strings of a list-valued field: String_List (`listValue`) or a List of
// strings or links (`valuesValue`) - hosts write any of these shapes.
// `skills` links skill objects; `served_by` links a machine. Empty for
// anything else.
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

// The machine skill keys an object's work needs: the `key` of each skill
// object it lists. A skill with no key is instructions only (no software to
// have), and a skill the states do not carry cannot be resolved - neither
// constrains the machine.
skill_keys :: proc(object: ^Object_State, states: map[string]^Object_State, allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	if object == nil do return out
	for id in field_strings(object.fields, SKILLS_KEY, allocator) {
		skill := states[id]
		if skill == nil || skill.deleted || skill.type_key != "skill" do continue
		key := field_string(skill.fields, "key")
		if key == "" do continue
		dup := false
		for k in out do if k == key { dup = true; break }
		if !dup do append(&out, key)
	}
	return out
}

// Machines that have a skill working: each serves a capability object of
// that key whose gate (its linked install, else the same-key install on
// that machine) is active. An unset or inactive capability does not exist
// for the resolver.
skill_servers :: proc(states: map[string]^Object_State, key: string, allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	for _, cap in states {
		if cap.deleted || cap.type_key != "capability" || field_string(cap.fields, "key") != key do continue
		machine := served_by(cap)
		if machine == "" do continue
		install_id := field_string(cap.fields, "install")
		if install_id == "" {
			if v, ok := fields_get(cap.fields, "install"); ok && v.kind == .Link do install_id = v.link_target
		}
		inst := states[install_id]
		if inst == nil {
			for _, s in states {
				if s.deleted || s.type_key != "install" do continue
				if field_string(s.fields, "key") == key && field_string(s.fields, "machine_id") == machine do inst = s
			}
		}
		if inst != nil && field_string(inst.fields, "status") == "active" do insert_sorted(&out, machine)
	}
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

// `states` carries the candidate machines, the skill objects the object
// lists, the capability objects and their installs, and the agents the
// object's guest list names.
resolve_server :: proc(object: ^Object_State, states: map[string]^Object_State, allocator := context.temp_allocator) -> Serving {
	out: Serving
	out.candidates = make([dynamic]string, allocator)
	out.skills = skill_keys(object, states, allocator)
	// Installations are machine-owned services. Neither an agent pin nor an
	// object pin may approve credentials or install software elsewhere. An
	// installation missing its owner stays unserved, rather than falling back
	// to whichever machine happens to serve its agent.
	if object != nil && object.type_key == "install" {
		out.machine_id = field_string(object.fields, MACHINE_ID_KEY)
		out.reason = "self"
		return out
	}

	// A machine is a candidate iff it has every machine skill working. With
	// none needed every live machine is a candidate (a pin decides between
	// them).
	if len(out.skills) == 0 {
		for _, m in states {
			if m.deleted || m.type_key != "machine" do continue
			if id := field_string(m.fields, MACHINE_ID_KEY); id != "" do insert_sorted(&out.candidates, id)
		}
	} else {
		server_sets := make([dynamic][dynamic]string, allocator)
		for key in out.skills {
			append(&server_sets, skill_servers(states, key, allocator))
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
	case object != nil && object.type_key == "agent" && pin == "":
		// An agent runs only where its own served_by says: no capability
		// fallback, no borrowed pin. Its error says so (agent_serving.odin).
		out.machine_id, out.reason = "", "unserved"
	case pin != "" && (len(out.skills) == 0 || capable(&out, pin)):
		out.machine_id, out.reason = pin, "pinned"
	case pin != "":
		out.machine_id, out.reason = pin, "pinned-uncapable"
	case lent != "" && len(out.skills) == 0:
		out.machine_id, out.reason = lent, "agent"
	case lent != "" && capable(&out, lent):
		out.machine_id, out.reason = lent, "agent-capable"
	case len(out.skills) == 0:
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
//  machines?: [ObjectJSON], skills?: [ObjectJSON], capabilities?: [ObjectJSON]}
// → {machineId, reason, skills: [key], candidates: [machineId]}
// `agents` are the agent objects the object's guest list names, in any order:
// the object's own list order decides. `skills` are the skill objects it
// lists. Capability objects ride with their installs: the resolver needs
// both alongside the machines.
serving_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	switch json_str(payload, "action") {
	case "resolve":
		object, ook := optional_state(payload, "object")
		if !ook do return nil, "invalid object state"
		states := make(map[string]^Object_State, context.temp_allocator)
		if object != nil do states[object.id] = object
		if err := payload_states(payload, "agents", "agent", &states); err != "" do return nil, err
		if err := payload_states(payload, "machines", "machine", &states); err != "" do return nil, err
		if err := payload_states(payload, "skills", "skill", &states); err != "" do return nil, err
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
	skills := make([dynamic]json.Value, allocator)
	for k in s.skills do append(&skills, json.String(k))
	out["skills"] = json.Array(skills)
	candidates := make([dynamic]json.Value, allocator)
	for c in s.candidates do append(&candidates, json.String(c))
	out["candidates"] = json.Array(candidates)
	return json.Object(out)
}
