package main

import "base:runtime"
import "core:mem"
import "core:encoding/json"
import "../core"

ABI_VERSION :: 1
REQUEST_LIMIT :: 16 * 1024 * 1024
SCRATCH_LIMIT :: 128 * 1024 * 1024

request_bytes: [REQUEST_LIMIT]byte
scratch_bytes: [SCRATCH_LIMIT]byte
scratch: mem.Arena
response: []byte
reserved_length: int
busy: bool

main :: proc() {
	mem.arena_init(&scratch, scratch_bytes[:])
}

// A failed allocator operation must not let ignored append errors return a
// partial successful result. The host catches the trap and resets this arena.
request_allocator :: proc(data: rawptr, mode: mem.Allocator_Mode, size, alignment: int,
	old_memory: rawptr, old_size: int, loc := #caller_location) -> ([]byte, mem.Allocator_Error) {
	bytes, err := mem.arena_allocator_proc(data, mode, size, alignment, old_memory, old_size, loc)
	if err == .Out_Of_Memory do panic("core request memory limit exceeded")
	return bytes, err
}

// Bound recursive JSON parsing independently of the byte and arena limits.
request_depth_ok :: proc(bytes: []byte) -> bool {
	depth := 0
	in_string, escaped := false, false
	for b in bytes {
		if in_string {
			if escaped { escaped = false } else if b == '\\' { escaped = true } else if b == '"' { in_string = false }
			continue
		}
		switch b {
		case '"': in_string = true
		case '{', '[':
			depth += 1
			if depth > 128 do return false
		case '}', ']': depth -= 1
		}
	}
	return true
}

@(export)
core_abi_version :: proc "c" () -> u32 {
	return ABI_VERSION
}

// One host call owns the request buffer until reset. No host pointer is ever
// dereferenced: the host writes only into this fixed exported reservation.
@(export)
core_reserve :: proc "c" (length: u32) -> rawptr {
	context = runtime.default_context()
	if busy || length == 0 || length > REQUEST_LIMIT do return nil
	busy = true
	reserved_length = int(length)
	response = nil
	mem.arena_free_all(&scratch)
	return raw_data(request_bytes[:])
}

@(export)
core_execute :: proc "c" () -> u32 {
	context = runtime.default_context()
	if !busy || reserved_length == 0 do return 1
	allocator := mem.Allocator{procedure = request_allocator, data = &scratch}
	context.allocator = allocator
	context.temp_allocator = allocator
	envelope := core.jobj()
	if !request_depth_ok(request_bytes[:reserved_length]) {
		envelope["error"] = json.String("request JSON nesting exceeds 128 levels")
		response = core.marshal(json.Object(envelope))
		return 0
	}
	request, parse_error := json.parse(request_bytes[:reserved_length], parse_integers = true, allocator = allocator)
	if parse_error != nil {
		envelope["error"] = json.String("invalid request JSON")
	} else {
		method := core.json_str(request, "method")
		payload, present := core.json_field(request, "payload")
		if !present {
			envelope["error"] = json.String("missing request payload")
		} else {
			result, err := core.dispatch(method, payload)
			if err != "" {
				envelope["error"] = json.String(err)
			} else {
				envelope["result"] = result
			}
		}
	}
	response = core.marshal(json.Object(envelope))
	return 0
}

@(export)
core_response_pointer :: proc "c" () -> rawptr {
	return raw_data(response)
}

@(export)
core_response_length :: proc "c" () -> u32 {
	return u32(len(response))
}

// Safe after either success or a trapped execution. Response pointers become
// invalid immediately. reset_all additionally releases the persistent cache.
@(export)
core_reset :: proc "c" (reset_all: u32) {
	context = runtime.default_context()
	response = nil
	reserved_length = 0
	busy = false
	mem.arena_free_all(&scratch)
	if reset_all != 0 do core.query_cache_reset()
}
