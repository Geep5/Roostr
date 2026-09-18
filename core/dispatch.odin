package core

import "core:encoding/json"

// Shared JSON boundary used by the WASM ABI and native parity harness.
// All request-owned values die at the caller's arena reset. Only the query
// dispatcher owns persistent storage, with its own bounded allocator.
dispatch :: proc(method: string, payload: json.Value) -> (json.Value, string) {
	switch method {
	case "codec": return codec_dispatch(payload)
	case "replay": return replay_dispatch(payload)
	case "query": return query_dispatch(payload)
	case "mutation": return mutation_dispatch(payload)
	case "wire": return wire_dispatch(payload)
	case "sync": return sync_dispatch(payload)
	case "serving": return serving_dispatch(payload)
	// Descriptors and conversations: one codec, reached by every host.
	case "descriptor": return descriptor_dispatch(payload)
	// A whole vault, as the protobuf the host already holds.
	case "corpus": return corpus_dispatch(payload)
	case: return nil, "unknown core method"
	}
}

/**
 * Binary side-channel for the current request: protobuf bytes the host
 * already has, handed over without a JSON hop. Set by the ABI before dispatch
 * and cleared after, so nothing here may retain it.
 */
@(private = "file")
request_blob: []byte

set_request_blob :: proc(blob: []byte) {
	request_blob = blob
}

/** The bytes the host attached to this request; empty when it attached none. */
get_request_blob :: proc() -> []byte {
	return request_blob
}
