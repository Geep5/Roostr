package core

// Loading a vault into the query cache from raw change bytes.
//
// Why this exists, with the numbers that justify it. Seeding the cache used to
// mean the host serialising every object to JSON, the ABI parsing it, and the
// cache then re-marshalling and re-parsing each object into its own region -
// three serialisations per object, on a path measured at 303 ms for 10k
// objects and 8.3 MB of JSON, and rejected outright past the 16 MiB request
// limit (which is why cold start had to be split into batches).
//
// The host already holds the protobuf: every change is stored with its bytes
// beside its JSON. So it hands those bytes over untouched, and the core does
// what it already knows how to do - decode, toposort, replay - straight into
// the cache region. No JSON anywhere on the path, and no second protobuf
// implementation on the host, which is the trap the shared codec exists to avoid.
//
// Frame format in the blob, repeated until the end:
//
//   [u32 little-endian length][length bytes of Change protobuf]
//   [u32 little-endian length | CORPUS_CHECKPOINT_FLAG][bytes of Checkpoint protobuf]
//
// Self-describing on purpose: the request JSON carries no per-change length
// array, so a 12,000-change vault costs no JSON at all. A checkpoint frame
// seeds its object's state; the object's remaining frames are its tail
// (docs/checkpoint-sync.md).

import "base:runtime"
import "core:encoding/json"
import "core:mem"
import "core:strings"

CORPUS_MAX_CHANGES :: 1_000_000
CORPUS_CHECKPOINT_FLAG :: u32(1) << 31

Corpus_Frame :: struct {
	bytes:      []byte,
	checkpoint: bool,
}

corpus_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	if action != "push" do return nil, "unknown corpus action"
	blob := get_request_blob()
	if len(blob) == 0 do return nil, "corpus push requires change bytes"
	reset, _ := json_bool(payload, "reset")
	// As in `query_dispatch`: a reset frees the old snapshot before the new
	// one is built (one snapshot at peak); a refused reset leaves it empty.
	if reset do query_cache_clear()

	// Group by object without decoding twice: one pass to read frames, then
	// per-object replay. Frames are borrowed from the blob, which outlives
	// this call.
	frames := make([dynamic]Corpus_Frame, context.temp_allocator)
	position := 0
	for position < len(blob) {
		if position + 4 > len(blob) do return nil, "corpus frame header is truncated"
		header := u32(blob[position]) | u32(blob[position + 1]) << 8 | u32(blob[position + 2]) << 16 | u32(blob[position + 3]) << 24
		length := int(header &~ CORPUS_CHECKPOINT_FLAG)
		position += 4
		if length <= 0 || position + length > len(blob) do return nil, "corpus frame is truncated"
		append(&frames, Corpus_Frame{blob[position:position + length], header & CORPUS_CHECKPOINT_FLAG != 0})
		position += length
		if len(frames) > CORPUS_MAX_CHANGES do return nil, "corpus exceeds the change limit"
	}

	// Group frames by object WITHOUT keeping any decode. A peek decodes the
	// whole message, so it runs in a scratch arena emptied after every frame
	// and only the object id is kept: a 20 MB corpus of 30k changes otherwise
	// piles every decoded change into the request arena and overruns it.
	scratch: mem.Dynamic_Arena
	mem.dynamic_arena_init(&scratch, runtime.default_allocator(), runtime.default_allocator())
	defer mem.dynamic_arena_destroy(&scratch)
	scratch_allocator := mem.dynamic_arena_allocator(&scratch)
	grouped := make(map[string][dynamic]Corpus_Frame, allocator = context.temp_allocator)
	skipped := 0
	for frame in frames {
		object_id := ""
		if frame.checkpoint {
			if peek, ok := decode_checkpoint(frame.bytes, scratch_allocator); ok do object_id = strings.clone(peek.object_id, context.temp_allocator)
		} else if peek, ok := decode_change(frame.bytes, scratch_allocator); ok {
			object_id = strings.clone(peek.object_id, context.temp_allocator)
		}
		mem.dynamic_arena_free_all(&scratch)
		if object_id == "" {
			// A damaged frame is skipped and COUNTED, never guessed at -
			// same discipline as the store's quarantine.
			skipped += 1
			continue
		}
		list, seen := grouped[object_id]
		if !seen do list = make([dynamic]Corpus_Frame, context.temp_allocator)
		append(&list, frame)
		grouped[object_id] = list
	}

	// Each object decodes and replays in the scratch arena - borrowing from the
	// blob is fine there, nothing of it survives - and only its compact state
	// is copied into the cache region (query_cache_own); then the arena empties.
	pending := make(map[string]^Query_Cached_Object, allocator = context.temp_allocator)
	query_pending_objects = make([dynamic]^Query_Cached_Object, 0, len(grouped), runtime.default_allocator())
	defer query_pending_reset()
	unreplayable := 0
	decoded := 0
	for object_id, list in grouped {
		defer mem.dynamic_arena_free_all(&scratch)
		context.allocator = scratch_allocator
		context.temp_allocator = scratch_allocator
		changes := make([dynamic]Change, 0, len(list))
		checkpoint: ^Checkpoint
		for frame in list {
			if frame.checkpoint {
				// Several checkpoints for one object: the store rule applies.
				cp, cp_ok := decode_checkpoint(frame.bytes)
				if !cp_ok do continue
				if checkpoint != nil && !checkpoint_supersedes(&cp, checkpoint_hash(frame.bytes), checkpoint, checkpoint_hash(encode_checkpoint(checkpoint^))) do continue
				checkpoint = new(Checkpoint)
				checkpoint^ = cp
				continue
			}
			change, change_ok := decode_change(frame.bytes)
			if !change_ok do continue
			append(&changes, change)
		}
		state, ok := compute_state(changes[:], scratch_allocator, checkpoint)
		if !ok {
			// A history that cannot replay (missing parent, cyclic blocks) is
			// left out rather than cached half-built.
			unreplayable += 1
			continue
		}
		owner, alloc_error := new(Query_Cached_Object, runtime.default_allocator())
		if alloc_error != nil do return nil, "query cache allocation failed"
		append(&query_pending_objects, owner)
		if !query_cache_own(owner, state) do return nil, "query cache memory limit exceeded"
		decoded += len(changes)
		pending[object_id] = owner
	}

	if !corpus_commit(pending, reset) do return nil, "query cache object limit exceeded"

	out := jobj()
	out["objects"] = json.Integer(i64(len(pending)))
	out["changes"] = json.Integer(i64(decoded))
	out["bytes"] = json.Integer(i64(len(blob)))
	out["skipped"] = json.Integer(i64(skipped))
	out["unreplayable"] = json.Integer(i64(unreplayable))
	out["cached"] = json.Integer(i64(len(query_cached_objects)))
	out["cacheBytes"] = json.Integer(i64(query_cache_bytes))
	return json.Object(out), ""
}

/**
 * Swap the replayed objects into the persistent cache. Mirrors the commit in
 * `query_dispatch`: the bound is checked BEFORE any live state changes, so a
 * refused push leaves the previous cache exactly as it was (a reset already
 * emptied it).
 */
@(private = "file")
corpus_commit :: proc(pending: map[string]^Query_Cached_Object, reset: bool) -> bool {
	count := reset ? 0 : len(query_cached_objects)
	for id in pending {
		_, exists := query_cached_objects[id]
		if reset || !exists do count += 1
	}
	if count > QUERY_CACHE_MAX_OBJECTS do return false

	if query_cached_objects == nil do query_cached_objects = make(map[string]^Query_Cached_Object, allocator = runtime.default_allocator())
	if query_cached_states == nil do query_cached_states = make(map[string]^Object_State, allocator = runtime.default_allocator())
	for id, owner in pending {
		if previous, ok := query_cached_objects[id]; ok {
			delete_key(&query_cached_objects, id)
			delete_key(&query_cached_states, id)
			query_cached_object_destroy(previous)
		}
		query_cached_objects[owner.state.id] = owner
		query_cached_states[owner.state.id] = &owner.state
	}
	return true
}

/**
 * Frame changes (and optionally checkpoints) for the blob, host-side helpers'
 * counterpart - used by the native parity harness and the tests so the
 * framing has exactly one definition.
 */
corpus_frame :: proc(changes: [][]byte, allocator := context.allocator, checkpoints: [][]byte = nil) -> []byte {
	total := 0
	for change in changes do total += 4 + len(change)
	for cp in checkpoints do total += 4 + len(cp)
	out := make([dynamic]byte, 0, total, allocator)
	frame :: proc(out: ^[dynamic]byte, bytes: []byte, flag: u32) {
		header := u32(len(bytes)) | flag
		append(out, byte(header), byte(header >> 8), byte(header >> 16), byte(header >> 24))
		append(out, ..bytes)
	}
	for cp in checkpoints do frame(&out, cp, CORPUS_CHECKPOINT_FLAG)
	for change in changes do frame(&out, change, 0)
	return out[:]
}
