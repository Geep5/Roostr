package core

// WebRTC signalling for live progress: how a computer running an agent and
// each open app device introduce themselves so live events (core/live.odin)
// can travel over a direct data channel. A viewer says `hello`; the host
// answers with an `offer`, the viewer with an `answer`; both trickle `ice`;
// `bye` closes. Nothing here is stored. A device sends `signal_publish`; the
// store hands it to its change stream (`/api/events`, frame
// {"type":"signal",...}) where the sync daemon carries local ones to the
// account's devices (and a shared space's members) as an encrypted ephemeral
// Nostr event (SIGNAL_KIND). A receiving replica opens it in `sync` `ingest`,
// which answers `signal`.

import "core:encoding/json"
import "core:fmt"

// Ephemeral range, next to LIVE_KIND.
SIGNAL_KIND :: 25079
SIGNAL_SDP_LIMIT :: 16 * 1024
SIGNAL_CANDIDATE_LIMIT :: 2 * 1024
// Device ids, session ids and the SDP mid.
SIGNAL_ID_LIMIT :: 256
SIGNAL_TYPES :: [?]string{"hello", "offer", "answer", "ice", "bye"}

@(private = "file")
signal_string :: proc(event: json.Value, key: string, limit: int) -> (string, string) {
	value, present := json_field(event, key)
	if !present || value == nil do return "", ""
	s, ok := value.(json.String)
	if !ok do return "", fmt.tprintf("signal %s must be a string", key)
	if len(s) > limit do return "", fmt.tprintf("signal %s is over %d bytes", key, limit)
	return string(s), ""
}

/**
 * The one shape every signal has, or why not. Unknown keys are dropped and
 * absent strings are empty, so what a subscriber receives is exactly
 * {v, type, from, to, session, role, sdp, candidate, mid, ts}.
 */
signal_event_normalize :: proc(event: json.Value, allocator := context.temp_allocator) -> (json.Value, string) {
	if _, ok := event.(json.Object); !ok do return nil, "signal must be an object"
	if v, ok := live_count(event, "v"); !ok || v != 1 do return nil, "signal v must be 1"
	out := jobj(allocator)
	out["v"] = json.Integer(1)
	type := json_str(event, "type")
	known := false
	types := SIGNAL_TYPES
	for t in types do if t == type do known = true
	if !known do return nil, "signal type must be hello, offer, answer, ice or bye"
	out["type"] = json.String(type)
	Field :: struct {
		key:   string,
		limit: int,
	}
	fields := []Field{{"from", SIGNAL_ID_LIMIT}, {"to", SIGNAL_ID_LIMIT}, {"session", SIGNAL_ID_LIMIT}, {"role", SIGNAL_ID_LIMIT}, {"sdp", SIGNAL_SDP_LIMIT}, {"candidate", SIGNAL_CANDIDATE_LIMIT}, {"mid", SIGNAL_ID_LIMIT}}
	for f in fields {
		value, err := signal_string(event, f.key, f.limit)
		if err != "" do return nil, err
		out[f.key] = json.String(value)
	}
	field := proc(out: map[string]json.Value, key: string) -> string {return string(out[key].(json.String))}
	if field(out, "from") == "" do return nil, "signal from required"
	if role := field(out, "role"); role != "viewer" && role != "host" do return nil, "signal role must be viewer or host"
	// Everything but a hello is for one device, inside one session.
	if type != "hello" && field(out, "to") == "" do return nil, "signal to required"
	if type != "hello" && field(out, "session") == "" do return nil, "signal session required"
	if (type == "offer" || type == "answer") && field(out, "sdp") == "" do return nil, fmt.tprintf("signal %s carries sdp", type)
	if type == "ice" && field(out, "candidate") == "" do return nil, "signal ice carries a candidate"
	ts, ts_ok := live_count(event, "ts")
	if !ts_ok do return nil, "signal ts must be an integer >= 0"
	out["ts"] = json.Integer(ts)
	return json.Object(out), ""
}

// `space`: the shared space a relayed signal arrived through (the sync daemon
// sets it; a viewer from that space only sees that space's live events).
signal_space :: proc(parsed: json.Value) -> (string, string) {
	value, present := json_field(parsed, "space")
	if !present || value == nil do return "", ""
	s, ok := value.(json.String)
	if !ok || len(s) > SIGNAL_ID_LIMIT do return "", "space must be a space id"
	return string(s), ""
}
