package core

import "core:encoding/json"

// Legacy imports add children as roots before adding parents that reference
// those same children. Repeated references are valid — tree_serialize emits
// each block id once. Only an active-path revisit is a cycle.
replay_tree_valid :: proc(t: ^Block_Tree) -> bool {
	Visit :: struct { id: string, exiting: bool }
	colors := make(map[string]u8, allocator = context.temp_allocator)
	defer delete(colors)
	stack := make([dynamic]Visit, context.temp_allocator)
	defer delete(stack)
	for id in t.by_id {
		if colors[id] == 2 do continue
		append(&stack, Visit{id = id})
		for len(stack) > 0 {
			visit := pop(&stack)
			if visit.exiting {
				colors[visit.id] = 2
				continue
			}
			block, exists := t.by_id[visit.id]
			if !exists do continue
			if colors[visit.id] == 1 do return false
			if colors[visit.id] == 2 do continue
			colors[visit.id] = 1
			append(&stack, Visit{id = visit.id, exiting = true})
			for child in block.children_ids do append(&stack, Visit{id = child})
		}
	}
	return true
}

// Stateless JSON boundary shared by the browser WASM bridge and native callers.
// Payload: {changes: ChangeJSON[]}. Result: ObjectJSON, or null for no changes.
replay_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	if _, ok := payload.(json.Object); !ok do return nil, "replay payload must be an object"
	wire, present := json_field(payload, "changes")
	if !present do return nil, "replay requires changes"
	items, ok := wire.(json.Array)
	if !ok do return nil, "replay changes must be an array"
	if len(items) == 0 do return nil, ""

	changes := make([]Change, len(items), context.allocator)
	ids := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(ids)
	for item, i in items {
		for key in ([]string{"parentIds", "ops"}) {
			field, present := json_field(item, key)
			if !present do return nil, "replay change requires parentIds and ops arrays"
			if _, array_ok := field.(json.Array); !array_ok do return nil, "replay parentIds and ops must be arrays"
		}
		if snapshot, present := json_field(item, "snapshot"); present && snapshot != nil {
			if _, snapshot_ok := snapshot.(json.Object); !snapshot_ok do return nil, "replay snapshot must be an object"
		}
		if _, present := json_int(item, "timestamp"); !present do return nil, "replay change requires numeric timestamp"
		change, valid := change_from_json(item)
		if !valid do return nil, "invalid replay change"
		if change.object_id == "" do return nil, "replay change requires objectId"
		if i > 0 && change.object_id != changes[0].object_id do return nil, "replay changes must belong to one object"
		if len(change.id) == 0 do return nil, "replay change requires id"
		id := hex_id(change.id, context.temp_allocator)
		if ids[id] do return nil, "duplicate replay change id"
		ids[id] = true
		changes[i] = change
	}
	state, valid := compute_state(changes)
	if !valid do return nil, "replay changes and block references must be acyclic"
	return object_to_json_value(&state), ""
}
