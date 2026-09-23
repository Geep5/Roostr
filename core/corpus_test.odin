#+build !js
package core

// The corpus path must answer exactly what the JSON path answers - it is the
// same replay, reached without a serialisation - and it must refuse damage
// loudly rather than cache half a vault.

import "core:encoding/json"
import "core:strings"
import "core:fmt"
import "core:testing"

@(private = "file")
note_changes :: proc(object_id, name: string, timestamp: i64) -> []byte {
	// One change per object: create + name. Encoded exactly as the store
	// writes it, then content-addressed like a host does.
	c: Change
	c.object_id = object_id
	c.timestamp = timestamp
	c.author = "fixture"
	c.ops = make([dynamic]Operation, context.temp_allocator)
	append(&c.ops, Operation{kind = .Object_Create, type_key = "note"})
	append(&c.ops, Operation{kind = .Field_Set, key = "name", value = Value{kind = .String, str = name}})
	digest := sha256(encode_change(c, true, context.temp_allocator))
	id := make([]byte, len(digest), context.temp_allocator)
	copy(id, digest[:])
	c.id = id
	return encode_change(c, false, context.temp_allocator)
}

@(private = "file")
push :: proc(frames: [][]byte, reset := true) -> (json.Value, string) {
	set_request_blob(corpus_frame(frames, context.temp_allocator))
	defer set_request_blob(nil)
	request := jobj()
	request["action"] = json.String("push")
	request["reset"] = json.Boolean(reset)
	return dispatch("corpus", json.Object(request))
}

@(private = "file")
query_names :: proc() -> (int, string) {
	body := jobj()
	body["filters"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	payload := jobj()
	payload["body"] = json.Object(body)
	payload["nowMs"] = json.Integer(1)
	payload["upserts"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	payload["removed"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	out, err := dispatch("query", json.Object(payload))
	if err != "" do return 0, err
	total, _ := json_int(out, "total")
	return int(total), ""
}

@(test)
corpus_contract :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	defer query_cache_reset()
	replays_a_vault_without_json(t)
	corpus_and_json_agree(t)
	counts_damage_instead_of_hiding_it(t)
	refuses_a_truncated_frame(t)
	push_without_reset_merges(t)
	survives_the_blob_being_reused(t)
	checkpoint_frames_seed_the_tail(t)
}

/**
 * A checkpoint frame plus the object's tail must cache exactly what the full
 * history caches: a cold browser loading from a relay checkpoint sees the
 * same object as one that walked every change.
 */
@(private = "file")
checkpoint_frames_seed_the_tail :: proc(t: ^testing.T) {
	query_cache_reset()
	create := note_changes("obj-cp", "First", 1)
	first, _ := decode_change(create, context.temp_allocator)
	rename: Change
	rename.object_id = "obj-cp"
	rename.timestamp = 2
	rename.author = "fixture"
	rename.parent_ids = make([dynamic][]byte, context.temp_allocator)
	append(&rename.parent_ids, first.id)
	rename.ops = make([dynamic]Operation, context.temp_allocator)
	append(&rename.ops, Operation{kind = .Field_Set, key = "name", value = Value{kind = .String, str = "Second"}})
	digest := sha256(encode_change(rename, true, context.temp_allocator))
	rename.id = make([]byte, 32, context.temp_allocator)
	copy(rename.id, digest[:])
	tail := encode_change(rename, false, context.temp_allocator)

	prefix := make([dynamic]Change, context.temp_allocator)
	append(&prefix, first)
	seed, _ := compute_state(prefix[:], context.temp_allocator)
	cp := encode_checkpoint(checkpoint_build(&seed, prefix[:], 1, allocator = context.temp_allocator), context.temp_allocator)

	set_request_blob(corpus_frame([][]byte{tail}, context.temp_allocator, [][]byte{cp}))
	defer set_request_blob(nil)
	request := jobj()
	request["action"] = json.String("push")
	request["reset"] = json.Boolean(true)
	out, err := dispatch("corpus", json.Object(request))
	testing.expect_value(t, err, "")
	objects, _ := json_int(out, "objects")
	testing.expect_value(t, objects, 1)
	state, ok := query_cached_states["obj-cp"]
	testing.expect(t, ok, "checkpointed object is cached")
	if !ok do return
	name, _ := fields_get(state.fields, "name")
	testing.expect_value(t, name.str, "Second")
	testing.expect_value(t, state.type_key, "note")
	testing.expect_value(t, len(state.heads), 1)
	testing.expect_value(t, state.heads[0], hex_id(rename.id, context.temp_allocator))
}

/**
 * The bug this pins: the codec BORROWS strings from the bytes it reads, so a
 * cached state decoded straight from the request blob pointed into a buffer
 * the ABI overwrites on the next call. It showed up as garbage names, replays
 * that failed for no visible reason, and a query response that would not
 * parse - never as an error.
 */
@(private = "file")
survives_the_blob_being_reused :: proc(t: ^testing.T) {
	query_cache_reset()
	frames := make([dynamic][]byte, context.temp_allocator)
	append(&frames, note_changes("obj-keep", "Durable name", 1))
	_, err := push(frames[:])
	testing.expect_value(t, err, "")

	// Simulate the next request: the host writes different bytes into the
	// same blob, and the core sees only that.
	overwrite := make([dynamic][]byte, context.temp_allocator)
	append(&overwrite, note_changes("obj-other", "ZZZZZZZZZZZZ", 2))
	framed := corpus_frame(overwrite[:], context.temp_allocator)
	set_request_blob(framed)
	defer set_request_blob(nil)

	state, ok := query_cached_states["obj-keep"]
	testing.expect(t, ok, "the object is still cached")
	if !ok do return
	name, has_name := fields_get(state.fields, "name")
	testing.expect(t, has_name, "name survives")
	testing.expect_value(t, name.str, "Durable name")
	testing.expect_value(t, state.type_key, "note")
}

@(private = "file")
replays_a_vault_without_json :: proc(t: ^testing.T) {
	query_cache_reset()
	frames := make([dynamic][]byte, context.temp_allocator)
	for i in 0 ..< 50 {
		append(&frames, note_changes(fmt.tprintf("obj-%d", i), fmt.tprintf("Note %d", i), i64(i + 1)))
	}
	out, err := push(frames[:])
	testing.expect_value(t, err, "")
	objects, _ := json_int(out, "objects")
	changes, _ := json_int(out, "changes")
	skipped, _ := json_int(out, "skipped")
	testing.expect_value(t, objects, 50)
	testing.expect_value(t, changes, 50)
	testing.expect_value(t, skipped, 0)

	// The cache is now queryable, with no object JSON ever having existed.
	total, query_error := query_names()
	testing.expect_value(t, query_error, "")
	testing.expect_value(t, total, 50)
}

@(private = "file")
corpus_and_json_agree :: proc(t: ^testing.T) {
	query_cache_reset()
	// Same three objects, loaded both ways: the states must be identical,
	// because it is the same replay either side of the boundary.
	frames := make([dynamic][]byte, context.temp_allocator)
	names := []string{"Alpha", "Beta", "Gamma"}
	for name, i in names {
		append(&frames, note_changes(fmt.tprintf("obj-%d", i), name, i64(i + 1)))
	}
	_, err := push(frames[:])
	testing.expect_value(t, err, "")
	// Ids and values live in the cache REGIONS, which the reset below frees.
	// Copy them out first, or this comparison reads dangling memory - the
	// same lifetime trap the corpus loader itself had to fix.
	from_corpus := make(map[string]string, context.temp_allocator)
	for id, state in query_cached_states {
		value, _ := fields_get(state.fields, "name")
		from_corpus[strings.clone(id, context.temp_allocator)] = strings.clone(value.str, context.temp_allocator)
	}

	// Now the JSON path: replay host-side and push object JSON as upserts.
	query_cache_reset()
	upserts := make([dynamic]json.Value, context.temp_allocator)
	for name, i in names {
		object_id := fmt.tprintf("obj-%d", i)
		change, ok := decode_change(frames[i], context.temp_allocator)
		testing.expect(t, ok, "change decodes")
		single := make([dynamic]Change, context.temp_allocator)
		append(&single, change)
		state, valid := compute_state(single[:], context.temp_allocator)
		testing.expect(t, valid, "state replays")
		parsed, parse_error := json.parse(object_to_json(&state, context.temp_allocator), parse_integers = true)
		testing.expect(t, parse_error == nil, "state JSON parses")
		append(&upserts, parsed)
		_ = object_id
	}
	body := jobj()
	body["filters"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	payload := jobj()
	payload["body"] = json.Object(body)
	payload["nowMs"] = json.Integer(1)
	payload["upserts"] = json.Array(upserts)
	payload["removed"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	payload["reset"] = json.Boolean(true)
	_, json_error := dispatch("query", json.Object(payload))
	testing.expect_value(t, json_error, "")

	testing.expect_value(t, len(query_cached_states), len(from_corpus))
	for id, state in query_cached_states {
		value, _ := fields_get(state.fields, "name")
		testing.expect_value(t, value.str, from_corpus[id])
		testing.expect_value(t, state.type_key, "note")
	}
}

@(private = "file")
counts_damage_instead_of_hiding_it :: proc(t: ^testing.T) {
	query_cache_reset()
	frames := make([dynamic][]byte, context.temp_allocator)
	append(&frames, note_changes("obj-good", "Good", 1))
	// Undecodable bytes: a change whose wire form is nonsense.
	bad := make([]byte, 6, context.temp_allocator)
	bad[0] = 0xff
	bad[1] = 0xff
	append(&frames, bad)
	append(&frames, note_changes("obj-second", "Second", 2))

	out, err := push(frames[:])
	testing.expect_value(t, err, "")
	objects, _ := json_int(out, "objects")
	skipped, _ := json_int(out, "skipped")
	testing.expect_value(t, objects, 2)
	testing.expect(t, skipped >= 1, "damage is counted, not silently dropped")
}

@(private = "file")
refuses_a_truncated_frame :: proc(t: ^testing.T) {
	query_cache_reset()
	good := note_changes("obj-a", "A", 1)
	framed := corpus_frame([][]byte{good}, context.temp_allocator)
	// Claiming more bytes than the blob holds must fail the whole push: a
	// partially loaded vault is indistinguishable from a small one.
	set_request_blob(framed[:len(framed) - 3])
	defer set_request_blob(nil)
	request := jobj()
	request["action"] = json.String("push")
	_, err := dispatch("corpus", json.Object(request))
	testing.expect_value(t, err, "corpus frame is truncated")
	testing.expect_value(t, len(query_cached_states), 0)

	// And a push with no bytes at all is a refusal, not an empty success -
	// the host would otherwise read it as "your vault is empty".
	set_request_blob(nil)
	_, empty_error := dispatch("corpus", json.Object(request))
	testing.expect_value(t, empty_error, "corpus push requires change bytes")
}

@(private = "file")
push_without_reset_merges :: proc(t: ^testing.T) {
	query_cache_reset()
	first := make([dynamic][]byte, context.temp_allocator)
	append(&first, note_changes("obj-a", "A", 1))
	_, err := push(first[:])
	testing.expect_value(t, err, "")

	second := make([dynamic][]byte, context.temp_allocator)
	append(&second, note_changes("obj-b", "B", 2))
	// A batched cold start pushes more than once; the later batch must not
	// wipe the earlier one.
	out, merge_error := push(second[:], reset = false)
	testing.expect_value(t, merge_error, "")
	cached, _ := json_int(out, "cached")
	testing.expect_value(t, cached, 2)
	total, query_error := query_names()
	testing.expect_value(t, query_error, "")
	testing.expect_value(t, total, 2)
}
