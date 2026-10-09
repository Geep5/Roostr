#+build !js
package core

// Fixed-id create: two machines importing the same source object at once
// write one object, not two (mutate.odin "create" `id`).

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:strings"
import "core:testing"

@(private = "file")
Vault :: struct {
	changes: [dynamic]Change,
	states:  map[string]^Object_State,
	clock:   i64,
	seq:     int,
}

/** Replay every change in the vault, grouped by object: a single mutation
 *  touches several objects (a `create` also seeds its type), and
 *  `compute_state` is per-object by design. */
@(private = "file")
replay :: proc(v: ^Vault) -> bool {
	v.states = make(map[string]^Object_State, context.temp_allocator)
	grouped := make(map[string][dynamic]Change, context.temp_allocator)
	for change in v.changes {
		list, seen := grouped[change.object_id]
		if !seen do list = make([dynamic]Change, context.temp_allocator)
		append(&list, change)
		grouped[change.object_id] = list
	}
	for object_id, list in grouped {
		state, ok := compute_state(list[:], context.temp_allocator)
		if !ok do return false
		ptr := new(Object_State, context.temp_allocator)
		ptr^ = state
		v.states[object_id] = ptr
	}
	return true
}

/** Run one mutation against the vault's current state and replay the result,
 *  exactly as a host does. Returns the mutation's `result` object. */
@(private = "file")
apply :: proc(v: ^Vault, action: string, request: json.Object, author := "device-a") -> (json.Value, string) {
	v.clock += 1
	v.seq += 1
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = request
	payload["timestamp"] = json.Integer(v.clock)
	payload["author"] = json.String(author)
	payload["id_seed"] = json.String(fmt.tprintf("seed-%d", v.seq))
	objects := make([dynamic]json.Value, context.temp_allocator)
	for _, state in v.states {
		parsed, err := json.parse(object_to_json(state, context.temp_allocator), allocator = context.temp_allocator, parse_integers = true)
		if err != nil do return nil, "state did not round trip"
		append(&objects, parsed)
	}
	payload["objects"] = json.Array(objects)
	out, mutation_error := mutation_dispatch(json.Object(payload))
	if mutation_error != "" do return nil, mutation_error
	changes_value, _ := json_field(out, "changes")
	array, _ := changes_value.(json.Array)
	for item in array {
		change, ok := change_from_json(item, context.temp_allocator)
		if !ok do return nil, "invalid change"
		// Parent linkage is the HOST's job (`src/mutate.odin:19` reads the
		// object's current heads); the planner returns unparented changes.
		if state, seen := v.states[change.object_id]; seen {
			// `Object_State.heads` are hex; `Change.parent_ids` are raw
			// bytes. Appending the hex text would leave every change
			// parentless, and the head set would grow without bound.
			parents := make([dynamic][]byte, context.temp_allocator)
			for head in state.heads {
				id, decoded := hex.decode(transmute([]byte)head, context.temp_allocator)
				if !decoded do return nil, "invalid head"
				append(&parents, id)
			}
			change.parent_ids = parents
		}
		// The planner returns unhashed changes; content-addressing them is
		// the host's job (`codec_dispatch` "encode"), and the next plan's
		// parent_ids come from these ids.
		digest := sha256(encode_change(change, true, context.temp_allocator))
		// `digest` is a stack array: slicing it directly would leave every
		// change pointing at the same reused slot.
		id := make([]byte, len(digest), context.temp_allocator)
		copy(id, digest[:])
		change.id = id
		append(&v.changes, change)
	}
	if !replay(v) do return nil, "replay failed"
	result, _ := json_field(out, "result")
	return result, ""
}

@(private = "file")
state_of :: proc(v: ^Vault, object_id: string) -> ^Object_State {
	state, ok := v.states[object_id]
	if !ok do return nil
	return state
}

@(private = "file")
params :: proc(pairs: ..[2]string) -> json.Object {
	out := jobj()
	for p in pairs do out[p[0]] = json.String(p[1])
	return json.Object(out)
}


@(private = "file")
text_block :: proc(id, text: string) -> json.Object {
	content := jobj()
	t := jobj()
	t["text"] = json.String(text)
	t["style"] = json.Integer(0)
	content["text"] = json.Object(t)
	block := jobj()
	block["id"] = json.String(id)
	block["childrenIds"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	block["content"] = json.Object(content)
	return json.Object(block)
}

/** One machine's import of a thread: the Email under a fixed id, one message block under a fixed id. */
@(private = "file")
import_thread :: proc(t: ^testing.T, v: ^Vault, author, name: string) {
	created, err := apply(v, "create", params({"id", "gmail-me-x-com-thr1"}, {"type_key", "email"}, {"name", name}), author)
	testing.expect(t, err == "", err)
	testing.expect_value(t, json_str(created, "id"), "gmail-me-x-com-thr1")
	add := params({"object_id", "gmail-me-x-com-thr1"})
	add["block"] = json.Object(text_block("msg:m1", "hello"))
	_, add_err := apply(v, "block_add", add, author)
	testing.expect(t, add_err == "", add_err)
}

@(test)
fixed_id_concurrent_creates_merge_into_one_object :: proc(t: ^testing.T) {
	// Two computers import the same Gmail thread before either sees the other's write.
	a, b: Vault
	import_thread(t, &a, "machine-a", "Hi")
	b.clock = 10 // b's import lands later on the shared clock
	import_thread(t, &b, "machine-b", "Hi")
	merged: Vault
	append(&merged.changes, ..a.changes[:])
	append(&merged.changes, ..b.changes[:])
	testing.expect(t, replay(&merged), "merged history replays")
	objects := 0
	for id, st in merged.states do if st.type_key == "email" {
		objects += 1
		testing.expect_value(t, id, "gmail-me-x-com-thr1")
	}
	testing.expect_value(t, objects, 1)
	state := state_of(&merged, "gmail-me-x-com-thr1")
	copies := 0
	for blk in state.blocks do if blk.id == "msg:m1" do copies += 1
	testing.expect_value(t, copies, 1)
}

@(test)
fixed_id_create_is_create_if_absent :: proc(t: ^testing.T) {
	v: Vault
	import_thread(t, &v, "machine-a", "Original")
	before := len(v.changes)
	again, err := apply(&v, "create", params({"id", "gmail-me-x-com-thr1"}, {"type_key", "email"}, {"name", "Renamed"}))
	testing.expect(t, err == "", err)
	existed, _ := json_bool(again, "existed")
	testing.expect(t, existed, "an id already held answers existed")
	testing.expect_value(t, len(v.changes), before)
	name := ""
	if got, ok := fields_get(state_of(&v, "gmail-me-x-com-thr1").fields, "name"); ok do name = got.str
	testing.expect_value(t, name, "Original")
}

@(test)
fixed_id_rejects_unsafe_ids :: proc(t: ^testing.T) {
	v: Vault
	_, err := apply(&v, "create", params({"id", "../etc"}, {"type_key", "email"}))
	testing.expect(t, err != "", "path-like id refused")
}
