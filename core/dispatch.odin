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
	case: return nil, "unknown core method"
	}
}
