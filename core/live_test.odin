#+build !js
package core

import "core:encoding/json"
import "core:fmt"
import "core:testing"

@(private = "file")
PK :: "abababababababababababababababababababababababababababababababab"
@(private = "file")
CONV :: "0202020202020202020202020202020202020202020202020202020202020202"
@(private = "file")
SPACE_KEY :: "0303030303030303030303030303030303030303030303030303030303030303"

@(private = "file")
plan :: proc(action: string, params: map[string]json.Value) -> (json.Value, string) {
	params := params
	params["action"] = json.String(action)
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = json.Object(params)
	payload["timestamp"] = json.Integer(1_000)
	payload["author"] = json.String("device-a")
	payload["id_seed"] = json.String("seed-1")
	payload["objects"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	return mutation_dispatch(json.Object(payload))
}

// The meta of the chat message a chat_post plan adds.
@(private = "file")
posted_meta :: proc(t: ^testing.T, out: json.Value) -> map[string]string {
	meta := make(map[string]string, allocator = context.temp_allocator)
	changes, _ := json_field(out, "changes")
	for item in changes.(json.Array) {
		change, ok := change_from_json(item, context.temp_allocator)
		testing.expect(t, ok, "planned change decodes")
		for op in change.ops {
			if op.kind != .Block_Add || op.block.content.custom.content_type != "chat" do continue
			for p in op.block.content.custom.meta do meta[p.key] = p.value
		}
	}
	return meta
}

@(private = "file")
live_event :: proc() -> map[string]json.Value {
	event := jobj()
	event["v"] = json.Integer(1)
	event["run"] = json.String("run-1")
	event["agent"] = json.String("agent-1")
	event["object"] = json.String("object-1")
	event["thread"] = json.String(DISCUSSION_ID)
	event["seq"] = json.Integer(3)
	event["kind"] = json.String("thinking")
	event["text"] = json.String("weighing the options")
	event["ts"] = json.Integer(1_700_000_000_000)
	return event
}

@(test)
chat_post_keeps_the_work_behind_a_reply :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	thinking := `[{"kind":"thinking","text":"check the repo","ts":1},{"kind":"step","text":"shell_exec: git status","ts":2}]`
	params := jobj()
	params["object_id"] = json.String("object-1")
	params["text"] = json.String("All clean.")
	params["as_author"] = json.String("agent-1")
	params["thinking"] = json.String(thinking)
	params["thought_ms"] = json.Integer(4_250)
	out, err := plan("chat_post", params)
	testing.expect(t, err == "", err)
	meta := posted_meta(t, out)
	testing.expect_value(t, meta["thinking"], thinking)
	testing.expect_value(t, meta["thought_ms"], "4250")
	testing.expect_value(t, meta["text"], "All clean.")

	// Without them the message carries neither key.
	plain := jobj()
	plain["object_id"] = json.String("object-1")
	plain["text"] = json.String("hi")
	plain_out, plain_err := plan("chat_post", plain)
	testing.expect(t, plain_err == "", plain_err)
	plain_meta := posted_meta(t, plain_out)
	testing.expect(t, "thinking" not_in plain_meta && "thought_ms" not_in plain_meta, "a plain message has no work record")

	// Malformed records are refused, not stored.
	bad := []struct { key: string, value: json.Value } {
		{"thinking", json.String("not json")},
		{"thinking", json.String(`{"kind":"step"}`)},
		{"thinking", json.Integer(1)},
		{"thought_ms", json.Integer(-1)},
		{"thought_ms", json.String("12")},
	}
	for c in bad {
		p := jobj()
		p["object_id"] = json.String("object-1")
		p["text"] = json.String("x")
		p[c.key] = c.value
		_, bad_err := plan("chat_post", p)
		testing.expectf(t, bad_err != "", "%s %v is refused", c.key, c.value)
	}
}

@(test)
live_publish_validates_and_persists_nothing :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	event := live_event()
	event["extra"] = json.String("dropped")
	params := jobj()
	params["event"] = json.Object(event)
	out, err := plan("live_publish", params)
	testing.expect(t, err == "", err)
	changes, _ := json_field(out, "changes")
	testing.expect_value(t, len(changes.(json.Array)), 0)
	result, _ := json_field(out, "result")
	testing.expect_value(t, json_str(result, "origin"), "local")
	live, _ := json_field(result, "live")
	testing.expect_value(t, string(marshal(live)), `{"agent":"agent-1","kind":"thinking","object":"object-1","run":"run-1","seq":3,"text":"weighing the options","thread":"__discussion__","ts":1700000000000,"v":1}`)

	relayed := jobj()
	relayed["event"] = json.Object(live_event())
	relayed["origin"] = json.String("relay")
	relay_out, relay_err := plan("live_publish", relayed)
	testing.expect(t, relay_err == "", relay_err)
	relay_result, _ := json_field(relay_out, "result")
	testing.expect_value(t, json_str(relay_result, "origin"), "relay")

	Case :: struct { key: string, value: json.Value }
	bad := []Case {
		{"v", json.Integer(2)},
		{"run", json.String("")},
		{"object", json.Integer(1)},
		{"seq", json.Integer(-1)},
		{"seq", json.Float(1.5)},
		{"kind", json.String("chatter")},
		{"text", json.Integer(5)},
		{"ts", json.String("now")},
	}
	for c in bad {
		e := live_event()
		e[c.key] = c.value
		p := jobj()
		p["event"] = json.Object(e)
		_, bad_err := plan("live_publish", p)
		testing.expectf(t, bad_err != "", "%s %v is refused", c.key, c.value)
	}
	missing := live_event()
	delete_key(&missing, "thread")
	p := jobj()
	p["event"] = json.Object(missing)
	_, missing_err := plan("live_publish", p)
	testing.expect(t, missing_err != "", "an event names its thread")
	big := live_event()
	text := make([]byte, LIVE_TEXT_LIMIT + 1, context.temp_allocator)
	for &b in text do b = 'a'
	big["text"] = json.String(string(text))
	p = jobj()
	p["event"] = json.Object(big)
	_, big_err := plan("live_publish", p)
	testing.expect(t, big_err != "", "an oversized delta is refused")
	p = jobj()
	p["event"] = json.Object(live_event())
	p["origin"] = json.String("elsewhere")
	_, origin_err := plan("live_publish", p)
	testing.expect(t, origin_err != "", "origin is local or relay")
}

@(private = "file")
ingest :: proc(t: ^testing.T, event: map[string]json.Value) -> json.Value {
	payload := jobj()
	payload["action"] = json.String("ingest")
	payload["event"] = json.Object(event)
	payload["nowMs"] = json.Integer(5_000)
	out, err := sync_dispatch(json.Object(payload))
	testing.expect(t, err == "", err)
	return out
}

@(private = "file")
sealed_live :: proc(plaintext, key_hex, pubkey: string, tags: json.Array) -> map[string]json.Value {
	key, _ := hex_bytes(key_hex)
	content, _ := nip44_encrypt(plaintext, key, allocator = context.temp_allocator)
	event := jobj()
	event["pubkey"] = json.String(pubkey)
	event["created_at"] = json.Integer(99)
	event["kind"] = json.Integer(LIVE_KIND)
	event["tags"] = tags
	event["content"] = json.String(content)
	return event
}

// One scenario of sync_session_contract: the session is process-global.
sync_session_opens_live_events_without_importing_them :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	defer sync_session_close()
	spaces := make([dynamic]json.Value, context.temp_allocator)
	space := jobj()
	space["spaceId"] = json.String("space-1")
	space["keyHex"] = json.String(SPACE_KEY)
	space["keyId"] = json.Integer(1)
	append(&spaces, json.Object(space))
	session := jobj()
	session["action"] = json.String("session")
	session["pk"] = json.String(PK)
	session["conversationKey"] = json.String(CONV)
	session["cursor"] = json.Integer(10)
	session["spaces"] = json.Array(spaces)
	_, open_err := sync_dispatch(json.Object(session))
	testing.expect(t, open_err == "", open_err)

	payload := string(marshal(json.Object(live_event())))
	personal := ingest(t, sealed_live(payload, CONV, PK, make(json.Array, 0, context.temp_allocator)))
	live, has_live := json_field(personal, "live")
	testing.expect(t, has_live, "a personal live event opens")
	testing.expect_value(t, json_str(live, "text"), "weighing the options")
	_, has_item := json_field(personal, "item")
	testing.expect(t, !has_item, "nothing to import")
	cursor, _ := json_int(personal, "cursor")
	testing.expect_value(t, cursor, 10)
	_, has_provenance := json_field(personal, "provenance")
	testing.expect(t, !has_provenance, "personal events carry no provenance")

	// A space member's event opens with the space key its stream tag names.
	tag := make(json.Array, 0, context.temp_allocator)
	append(&tag, json.String("h"), json.String(wire_blind(transmute([]byte)string(SPACE_KEY), fmt.tprintf("space:%s", "space-1"), context.temp_allocator)))
	tags := make(json.Array, 0, context.temp_allocator)
	append(&tags, json.Array(tag))
	member := "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
	shared := ingest(t, sealed_live(payload, SPACE_KEY, member, tags))
	_, shared_live := json_field(shared, "live")
	testing.expect(t, shared_live, "a shared live event opens")
	provenance, _ := json_field(shared, "provenance")
	testing.expect_value(t, json_str(provenance, "spaceId"), "space-1")
	testing.expect_value(t, json_str(provenance, "signer"), member)

	// Someone else's personal key, or a payload that is no live event.
	stranger := ingest(t, sealed_live(payload, CONV, member, make(json.Array, 0, context.temp_allocator)))
	failed, _ := json_bool(stranger, "decryptFailure")
	testing.expect(t, failed, "an untagged event from another key does not open")
	bad := live_event()
	bad["kind"] = json.String("chatter")
	garbled := ingest(t, sealed_live(string(marshal(json.Object(bad))), CONV, PK, make(json.Array, 0, context.temp_allocator)))
	decode, _ := json_bool(garbled, "decodeFailure")
	testing.expect(t, decode, "an invalid payload is a decode failure")
	_, garbled_live := json_field(garbled, "live")
	testing.expect(t, !garbled_live, "and surfaces nothing")
}
