#+build !js
package core

// A mutation without `objects` plans over the persistent query cache plus the
// request's overlay (mutate.odin mutation_states). The cache is process-global,
// so these scenarios run inside corpus_contract, never on a parallel thread.

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:testing"

@(private = "file")
Cache_Host :: struct {
	changes: map[string][dynamic]Change,
	seq:     int,
}

@(private = "file")
state_value :: proc(state: ^Object_State) -> json.Value {
	parsed, _ := json.parse(object_to_json(state, context.temp_allocator), allocator = context.temp_allocator, parse_integers = true)
	return parsed
}

/** A body-less query: the cache update a host flushes before it plans. */
@(private = "file")
cache_upsert :: proc(states: []json.Value, reset := false) -> string {
	payload := jobj()
	payload["nowMs"] = json.Integer(1)
	upserts := make([dynamic]json.Value, context.temp_allocator)
	append(&upserts, ..states)
	payload["upserts"] = json.Array(upserts)
	payload["removed"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	payload["reset"] = json.Boolean(reset)
	_, err := dispatch("query", json.Object(payload))
	return err
}

@(private = "file")
cache_plan :: proc(h: ^Cache_Host, action: string, params: json.Object, overlay: []json.Value = nil, absent: []string = nil) -> (json.Value, string) {
	h.seq += 1
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = params
	payload["timestamp"] = json.Integer(i64(h.seq))
	payload["author"] = json.String("device-a")
	payload["id_seed"] = json.String(fmt.tprintf("seed-%d", h.seq))
	if overlay != nil {
		values := make([dynamic]json.Value, context.temp_allocator)
		append(&values, ..overlay)
		payload["overlay"] = json.Array(values)
	}
	if absent != nil {
		values := make([dynamic]json.Value, context.temp_allocator)
		for id in absent do append(&values, json.String(id))
		payload["absent"] = json.Array(values)
	}
	return mutation_dispatch(json.Object(payload))
}

/** Commit a plan as a host does: parent on the cached heads, address, replay, upsert. */
@(private = "file")
cache_commit :: proc(h: ^Cache_Host, out: json.Value) -> string {
	changes_value, _ := json_field(out, "changes")
	touched := make(map[string]bool, context.temp_allocator)
	for item in changes_value.(json.Array) {
		change, ok := change_from_json(item, context.temp_allocator)
		if !ok do return "invalid change"
		parents := make([dynamic][]byte, context.temp_allocator)
		if state, cached := query_cached_states[change.object_id]; cached {
			for head in state.heads {
				id, decoded := hex.decode(transmute([]byte)head, context.temp_allocator)
				if !decoded do return "invalid head"
				append(&parents, id)
			}
		}
		change.parent_ids = parents
		digest := sha256(encode_change(change, true, context.temp_allocator))
		id := make([]byte, len(digest), context.temp_allocator)
		copy(id, digest[:])
		change.id = id
		list := h.changes[change.object_id]
		append(&list, change)
		h.changes[change.object_id] = list
		touched[change.object_id] = true
	}
	upserts := make([dynamic]json.Value, context.temp_allocator)
	for object_id in touched {
		state, ok := compute_state(h.changes[object_id][:], context.temp_allocator)
		if !ok do return "replay failed"
		append(&upserts, state_value(&state))
	}
	return cache_upsert(upserts[:])
}

@(private = "file")
field_set :: proc(out: json.Value, object_id, key: string) -> (string, bool) {
	changes_value, _ := json_field(out, "changes")
	for item in changes_value.(json.Array) {
		change, _ := change_from_json(item, context.temp_allocator)
		if change.object_id != object_id do continue
		for op in change.ops do if op.kind == .Field_Set && op.key == key do return op.value.str, true
	}
	return "", false
}

@(private = "file")
missing_of :: proc(out: json.Value) -> [dynamic]string {
	ids := make([dynamic]string, context.temp_allocator)
	value, present := json_field(out, "missing")
	if !present do return ids
	for id in value.(json.Array) do append(&ids, string(id.(json.String)))
	return ids
}

@(private = "file")
cache_params :: proc(pairs: ..[2]string) -> json.Object {
	out := jobj()
	for p in pairs do out[p[0]] = json.String(p[1])
	return json.Object(out)
}

mutation_cache_contract :: proc(t: ^testing.T) {
	query_cache_reset()
	defer query_cache_reset()
	h := Cache_Host{changes = make(map[string][dynamic]Change, context.temp_allocator)}

	// Consecutive mutations see each other once each commit is upserted: the
	// note lands in the space created just before it, found by a cache scan
	// (oldest_channel_id), and the block_add on it needs no overlay.
	space, space_error := cache_plan(&h, "create", cache_params({"type_key", "channel"}, {"name", "Home"}))
	testing.expect_value(t, space_error, "")
	space_id := json_str(json_field(space, "result") or_else nil, "id")
	testing.expect_value(t, cache_commit(&h, space), "")
	note, note_error := cache_plan(&h, "create", cache_params({"type_key", "note"}, {"name", "Plan"}))
	testing.expect_value(t, note_error, "")
	note_id := json_str(json_field(note, "result") or_else nil, "id")
	channel, has_channel := field_set(note, note_id, "channel")
	testing.expect(t, has_channel, "create scanned the cache for the oldest space")
	testing.expect_value(t, channel, space_id)
	testing.expect_value(t, cache_commit(&h, note), "")
	block := cache_params({"object_id", note_id})
	content := jobj()
	content["text"] = json.String("hello")
	block_json := jobj()
	block_json["content"] = json.Object(content)
	block["block"] = json.Object(block_json)
	added, add_error := cache_plan(&h, "block_add", block)
	testing.expect_value(t, add_error, "")
	testing.expect_value(t, len(missing_of(added)), 0)
	testing.expect_value(t, len(json_array(added, "changes")), 1)

	// A named object the cache lacks plans nothing until the host answers.
	ghost := cache_params({"object_id", "ghost"}, {"key", "status"})
	value := jobj()
	value["stringValue"] = json.String("done")
	ghost["value"] = json.Object(value)
	refused, refused_error := cache_plan(&h, "set_field", ghost)
	testing.expect_value(t, refused_error, "")
	missing := missing_of(refused)
	testing.expect_value(t, len(missing), 1)
	if len(missing) == 1 do testing.expect_value(t, missing[0], "ghost")
	_, has_changes := json_field(refused, "changes")
	testing.expect(t, !has_changes, "a refused plan carries no changes")

	// Retried with the host's state as overlay, it plans; the overlay wins
	// over the cache and never enters it.
	ghost_state := Object_State{id = "ghost", type_key = "agent", created_at = 1, updated_at = 1}
	overlaid, overlay_error := cache_plan(&h, "set_field", ghost, overlay = {state_value(&ghost_state)})
	testing.expect_value(t, overlay_error, "")
	testing.expect_value(t, len(missing_of(overlaid)), 0)
	testing.expect_value(t, len(json_array(overlaid, "changes")), 1)
	_, cached := query_cached_states["ghost"]
	testing.expect(t, !cached, "overlay states stay request-local")

	// A caller-chosen create id decides `existed`: absent plans the create,
	// an overlaid state answers existed.
	fixed := cache_params({"id", "fixed-1"}, {"type_key", "note"}, {"name", "Imported"})
	asked, _ := cache_plan(&h, "create", fixed)
	testing.expect_value(t, len(missing_of(asked)), 1)
	created, _ := cache_plan(&h, "create", fixed, absent = {"fixed-1"})
	testing.expect_value(t, len(json_array(created, "changes")), 1)
	fixed_state := Object_State{id = "fixed-1", type_key = "note", created_at = 1, updated_at = 1}
	existed, _ := cache_plan(&h, "create", fixed, overlay = {state_value(&fixed_state)})
	existed_flag, _ := json_bool(json_field(existed, "result") or_else nil, "existed")
	testing.expect(t, existed_flag, "overlay state counts as existing")

	// `objects` stays the authoritative snapshot: the cache is not consulted.
	payload := jobj()
	payload["action"] = json.String("create")
	payload["params"] = cache_params({"type_key", "note"}, {"name", "Snapshot"})
	payload["timestamp"] = json.Integer(100)
	payload["author"] = json.String("device-a")
	payload["id_seed"] = json.String("snapshot")
	payload["objects"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	snapshot, snapshot_error := mutation_dispatch(json.Object(payload))
	testing.expect_value(t, snapshot_error, "")
	_, snapshot_channel := field_set(snapshot, "snapshot", "channel")
	testing.expect(t, !snapshot_channel, "an explicit snapshot ignores the cache")
}
