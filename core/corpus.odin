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
// implementation on the host, which is the trap the descriptor work removed.
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

	// Group frames by object WITHOUT decoding yet. The codec borrows every
	// string out of the bytes it reads (zero-copy, by design), so a decode
	// against the blob would leave the cached state pointing into a buffer
	// the ABI reuses on the next request: garbage names, replays that fail
	// for no visible reason, and a response that will not even parse. Each
	// object's bytes are copied into its own cache region first, and decoded
	// from that copy, so the region owns everything it hands out.
	grouped := make(map[string][dynamic]Corpus_Frame, allocator = context.temp_allocator)
	skipped := 0
	for frame in frames {
		// Peek only at the object id; the real decode happens in the region.
		object_id := ""
		if frame.checkpoint {
			if peek, ok := decode_checkpoint(frame.bytes, context.temp_allocator); ok do object_id = peek.object_id
		} else if peek, ok := decode_change(frame.bytes, context.temp_allocator); ok {
			object_id = peek.object_id
		}
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

	pending := make(map[string]^Query_Cached_Object, allocator = context.temp_allocator)
	query_pending_objects = make([dynamic]^Query_Cached_Object, 0, len(grouped), runtime.default_allocator())
	defer query_pending_reset()
	unreplayable := 0
	decoded := 0
	for object_id, list in grouped {
		owner, alloc_error := new(Query_Cached_Object, runtime.default_allocator())
		if alloc_error != nil do return nil, "query cache allocation failed"
		append(&query_pending_objects, owner)
		region := query_region_allocator(owner)
		changes := make([dynamic]Change, 0, len(list), region)
		checkpoint: ^Checkpoint
		for frame in list {
			owned := make([]byte, len(frame.bytes), region)
			if owner.failed do return nil, "query cache memory limit exceeded"
			copy(owned, frame.bytes)
			if frame.checkpoint {
				// Several checkpoints for one object: the store rule applies.
				cp, cp_ok := decode_checkpoint(owned, region)
				if !cp_ok do continue
				if checkpoint != nil && !checkpoint_supersedes(&cp, checkpoint_hash(owned, context.temp_allocator), checkpoint, checkpoint_hash(encode_checkpoint(checkpoint^, context.temp_allocator), context.temp_allocator)) do continue
				checkpoint = new(Checkpoint, region)
				checkpoint^ = cp
				continue
			}
			change, change_ok := decode_change(owned, region)
			if !change_ok do continue
			append(&changes, change)
		}
		if owner.failed do return nil, "query cache memory limit exceeded"
		state, ok := compute_state(changes[:], region, checkpoint)
		if owner.failed do return nil, "query cache memory limit exceeded"
		if !ok {
			// A history that cannot replay (missing parent, cyclic blocks) is
			// left out rather than cached half-built.
			unreplayable += 1
			continue
		}
		decoded += len(changes)
		owner.state = state
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
 * refused push leaves the previous cache exactly as it was.
 */
@(private = "file")
corpus_commit :: proc(pending: map[string]^Query_Cached_Object, reset: bool) -> bool {
	count := reset ? 0 : len(query_cached_objects)
	for id in pending {
		_, exists := query_cached_objects[id]
		if reset || !exists do count += 1
	}
	if count > QUERY_CACHE_MAX_OBJECTS do return false

	if reset {
		for _, owner in query_cached_objects do query_cached_object_destroy(owner)
		delete(query_cached_objects)
		query_cached_objects = nil
		delete(query_cached_states)
		query_cached_states = nil
	}
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
