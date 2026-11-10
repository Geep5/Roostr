package core

// Live progress in chats: what an agent is thinking and doing while it
// answers an object's chat, as it happens. Nothing here is stored. A
// publisher (the harness) sends `live_publish`; the store hands the event to
// its change stream (`/api/events`, frame {"type":"live",...}) and the sync
// daemon carries it to the account's other devices as an encrypted
// ephemeral Nostr event (LIVE_KIND: relays forward it, never keep it). A
// receiving replica opens it in `sync` `ingest`, which answers `live`
// instead of an importable item. The record that lasts is the reply's own
// `thinking`/`thought_ms` meta (chat_post).

import "core:encoding/json"
import "core:fmt"

// Ephemeral range (20000-29999). 21078 is the files' WebRTC signalling.
LIVE_KIND :: 25078
LIVE_TEXT_LIMIT :: 32 * 1024
LIVE_EVENT_KINDS :: [?]string{"thinking", "step", "text", "done", "error"}

// An exact non-negative integer field: a float must carry no fraction.
@(private = "file")
live_count :: proc(event: json.Value, key: string) -> (i64, bool) {
	value, present := json_field(event, key)
	if !present do return 0, false
	#partial switch x in value {
	case json.Integer:
		return i64(x), x >= 0
	case json.Float:
		return i64(x), x >= 0 && x == json.Float(i64(x))
	}
	return 0, false
}

/**
 * The one shape every live event has, or why not. Unknown keys are dropped,
 * so what a subscriber receives is exactly
 * {v, run, agent, object, thread, seq, kind, text, ts}.
 */
live_event_normalize :: proc(event: json.Value, allocator := context.temp_allocator) -> (json.Value, string) {
	if _, ok := event.(json.Object); !ok do return nil, "event must be an object"
	if v, ok := live_count(event, "v"); !ok || v != 1 do return nil, "event v must be 1"
	out := jobj(allocator)
	out["v"] = json.Integer(1)
	for key in ([]string{"run", "agent", "object", "thread"}) {
		value := json_str(event, key)
		if value == "" do return nil, fmt.tprintf("event %s required", key)
		out[key] = json.String(value)
	}
	seq, seq_ok := live_count(event, "seq")
	if !seq_ok do return nil, "event seq must be an integer >= 0"
	out["seq"] = json.Integer(seq)
	kind := json_str(event, "kind")
	known := false
	kinds := LIVE_EVENT_KINDS
	for k in kinds do if k == kind do known = true
	if !known do return nil, "event kind must be thinking, step, text, done or error"
	out["kind"] = json.String(kind)
	text := ""
	if value, present := json_field(event, "text"); present && value != nil {
		s, ok := value.(json.String)
		if !ok do return nil, "event text must be a string"
		text = string(s)
	}
	if len(text) > LIVE_TEXT_LIMIT do return nil, fmt.tprintf("event text is over %d bytes", LIVE_TEXT_LIMIT)
	out["text"] = json.String(text)
	ts, ts_ok := live_count(event, "ts")
	if !ts_ok do return nil, "event ts must be an integer >= 0"
	out["ts"] = json.Integer(ts)
	return json.Object(out), ""
}

// `origin`: "local" (published on this computer, default) or "relay" (another device's).
live_origin :: proc(parsed: json.Value) -> (string, string) {
	origin := json_str(parsed, "origin")
	if origin == "" do return "local", ""
	if origin != "local" && origin != "relay" do return "", "origin must be local or relay"
	return origin, ""
}
