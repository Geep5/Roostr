#+build !js
package core

import "core:encoding/base64"
import "core:encoding/json"
import "core:fmt"
import "core:strings"
import "core:testing"

// Events are produced by the engine's own seal so the test exercises the
// exact tags and ciphertext a Roostr writer emits; only the signature is
// missing, which hosts verify before ingest.

@(private = "file")
PK :: "abababababababababababababababababababababababababababababababab"
@(private = "file")
SECRET :: "0101010101010101010101010101010101010101010101010101010101010101"
@(private = "file")
CONV :: "0202020202020202020202020202020202020202020202020202020202020202"
@(private = "file")
SPACE_KEY :: "0303030303030303030303030303030303030303030303030303030303030303"

@(private = "file")
call :: proc(t: ^testing.T, action: string, fields: map[string]json.Value) -> json.Value {
	payload := jobj()
	payload["action"] = json.String(action)
	for k, v in fields do payload[k] = v
	result, err := sync_dispatch(json.Object(payload))
	testing.expectf(t, err == "", "%s: %s", action, err)
	return result
}

@(private = "file")
open_session :: proc(t: ^testing.T) {
	spaces := make([dynamic]json.Value, context.temp_allocator)
	space := jobj()
	space["spaceId"] = json.String("space-1")
	space["keyHex"] = json.String(SPACE_KEY)
	space["keyId"] = json.Integer(1)
	append(&spaces, json.Object(space))
	fields := jobj()
	fields["pk"] = json.String(PK)
	fields["conversationKey"] = json.String(CONV)
	fields["cursor"] = json.Integer(10)
	fields["spaces"] = json.Array(spaces)
	call(t, "session", fields)
}

// Personal or shared seal of `bytes`; returns parts as event JSON.
@(private = "file")
seal_events :: proc(t: ^testing.T, bytes: []byte, object_id: string, shared: bool, pubkey: string, created_at: i64) -> []json.Value {
	payload := jobj()
	payload["action"] = json.String("seal")
	payload["change"] = json.String(base64.encode(bytes, allocator = context.temp_allocator))
	payload["objectId"] = json.String(object_id)
	if shared {
		payload["conversationKey"] = json.String(SPACE_KEY)
		space := jobj()
		space["keyHex"] = json.String(SPACE_KEY)
		space["spaceId"] = json.String("space-1")
		payload["space"] = json.Object(space)
	} else {
		payload["conversationKey"] = json.String(CONV)
		payload["secret"] = json.String(SECRET)
	}
	sealed, err := wire_dispatch(json.Object(payload))
	testing.expect(t, err == "", err)
	events := make([dynamic]json.Value, context.temp_allocator)
	for part in json_array(sealed, "parts") {
		event := jobj()
		event["pubkey"] = json.String(pubkey)
		event["created_at"] = json.Integer(created_at)
		event["kind"] = json.Integer(SYNC_CHANGE_KIND)
		event["tags"], _ = json_field(part, "tags")
		event["content"] = json.String(json_str(part, "content"))
		append(&events, json.Object(event))
	}
	return events[:]
}

@(private = "file")
ingest :: proc(t: ^testing.T, event: json.Value, now: i64) -> json.Value {
	fields := jobj()
	fields["event"] = event
	fields["nowMs"] = json.Integer(now)
	return call(t, "ingest", fields)
}

// A wire change with a valid content address, carrying `size` bytes of text.
@(private = "file")
wire_change :: proc(t: ^testing.T, object_id: string, size: int) -> []byte {
	change := jobj()
	change["objectId"] = json.String(object_id)
	change["parentIds"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	change["timestamp"] = json.Integer(1)
	change["author"] = json.String("t")
	ops := make([dynamic]json.Value, context.temp_allocator)
	create := jobj()
	inner := jobj()
	inner["typeKey"] = json.String("page")
	create["objectCreate"] = json.Object(inner)
	append(&ops, json.Object(create))
	if size > 0 {
		set := jobj()
		field := jobj()
		field["key"] = json.String("body")
		value := jobj()
		value["stringValue"] = json.String(strings.repeat("x", size, context.temp_allocator))
		field["value"] = json.Object(value)
		set["fieldSet"] = json.Object(field)
		append(&ops, json.Object(set))
	}
	change["ops"] = json.Array(ops)
	payload := jobj()
	payload["action"] = json.String("encode")
	payload["change"] = json.Object(change)
	encoded, err := codec_dispatch(json.Object(payload))
	testing.expect(t, err == "", err)
	bytes, ok := bytes_from_base64(string(encoded.(json.String)), context.temp_allocator)
	testing.expect(t, ok)
	return bytes
}

@(private = "file")
sync_session_single_part_and_pubkey_rule :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	open_session(t)
	defer sync_session_close()
	bytes := wire_change(t, "note-1", 0)
	events := seal_events(t, bytes, "note-1", false, PK, 100)
	testing.expect(t, len(events) == 1)

	r := ingest(t, events[0], 1_000)
	cursor, _ := json_int(r, "cursor")
	testing.expect(t, cursor == 100, "cursor advances to the event")
	item, has_item := json_field(r, "item")
	testing.expect(t, has_item, "single part yields an item")
	change, _ := json_field(item, "change")
	testing.expect(t, json_str(change, "objectId") == "note-1")
	testing.expect(t, json_str(item, "chunkKey") == "", "no chunk key for a whole change")
	if _, has_prov := json_field(item, "provenance"); has_prov do testing.fail_now(t, "personal items carry no provenance")

	// Same ciphertext under someone else's pubkey is not ours.
	forged := seal_events(t, bytes, "note-1", false, strings.repeat("cd", 32, context.temp_allocator), 200)
	r = ingest(t, forged[0], 1_000)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item, "personal ciphertext must be authored by our key")
	cursor, _ = json_int(r, "cursor")
	testing.expect(t, cursor == 100, "a dropped event does not move the cursor")

	// Wrong kind is ignored outright.
	other := events[0].(json.Object)
	other["kind"] = json.Integer(1)
	r = ingest(t, json.Object(other), 1_000)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item)
}

@(private = "file")
sync_session_reassembles_out_of_order_chunks :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	open_session(t)
	defer sync_session_close()
	writer := strings.repeat("ef", 32, context.temp_allocator)
	bytes := wire_change(t, "big-1", 70_000)
	events := seal_events(t, bytes, "big-1", true, writer, 300)
	testing.expectf(t, len(events) == 3, "expected 3 parts, got %d", len(events))

	r := ingest(t, events[2], 1_000)
	_, has_item := json_field(r, "item")
	testing.expect(t, !has_item, "first part alone is not a change")
	groups, _ := json_field(r, "replayGroups")
	testing.expect(t, len(groups.(json.Array)) == 1, "an open group is a replay obligation")

	r = ingest(t, events[0], 1_001)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item)
	// Re-delivery of a part already held is idempotent.
	r = ingest(t, events[0], 1_002)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item)
	state := call(t, "state", jobj())
	open_groups, _ := json_int(state, "groups")
	testing.expect(t, open_groups == 1)

	r = ingest(t, events[1], 1_003)
	item, complete := json_field(r, "item")
	testing.expect(t, complete, "last part completes the change")
	if !complete do return
	change, _ := json_field(item, "change")
	testing.expect(t, json_str(change, "objectId") == "big-1")
	chunk_key := json_str(item, "chunkKey")
	expected_key := fmt.tprintf(`["%s","space-1",1,"%s",1078]`, writer, tag_string(event_tag(json_array(events[1], "tags"), "c") or_else nil, 1))
	testing.expectf(t, chunk_key == expected_key, "chunk key %s", chunk_key)
	provenance, _ := json_field(item, "provenance")
	testing.expect(t, json_str(provenance, "spaceId") == "space-1" && json_str(provenance, "signer") == writer)
	state = call(t, "state", jobj())
	open_groups, _ = json_int(state, "groups")
	testing.expect(t, open_groups == 0, "completed group is released")
	floor, has_floor := json_int(state, "replayFloor")
	testing.expect(t, has_floor && floor == 300, "obligation stays until the import settles")

	// A repeat of the group while it is importing is ignored; settling retires it.
	r = ingest(t, events[1], 1_004)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item, "importing group is not reassembled twice")
	settle := jobj()
	settle["chunkKey"] = json.String(chunk_key)
	settle["imported"] = json.Boolean(true)
	r = call(t, "settle", settle)
	groups, _ = json_field(r, "replayGroups")
	testing.expect(t, len(groups.(json.Array)) == 0, "settled import clears the replay group")
	r = ingest(t, events[0], 1_005)
	_, has_item = json_field(r, "item")
	testing.expect(t, !has_item, "imported group parts are ignored afterwards")
}

@(private = "file")
sync_session_faults_on_conflict_expiry_and_limits :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	open_session(t)
	defer sync_session_close()
	writer := strings.repeat("ef", 32, context.temp_allocator)
	a := seal_events(t, wire_change(t, "big-a", 70_000), "big-a", true, writer, 400)
	b := seal_events(t, wire_change(t, "big-b", 70_000), "big-b", true, writer, 500)

	// Conflicting content for a held index tears the group down and faults at its start.
	ingest(t, a[0], 1_000)
	// Reuse a's chunk tag (same gid/index) but b's ciphertext.
	conflict := json.clone_value(a[0], context.temp_allocator).(json.Object)
	conflict["content"] = json.String(json_str(b[0], "content"))
	r := ingest(t, json.Object(conflict), 1_001)
	fault, faulted := json_int(r, "faultAt")
	testing.expect(t, faulted && fault == 400, "conflicting part faults at the group's earliest event")
	state := call(t, "state", jobj())
	open_groups, _ := json_int(state, "groups")
	testing.expect(t, open_groups == 0)

	// Expiry: a stale group faults when the next chunk arrives after its TTL.
	ingest(t, a[1], 2_000)
	r = ingest(t, b[1], 2_000 + SYNC_GROUP_TTL_MS)
	fault, faulted = json_int(r, "faultAt")
	testing.expect(t, faulted && fault == 400, "expired group faults at its earliest event")

	// Group limit: the 129th distinct open group faults instead of buffering.
	ingest(t, b[2], 3_000) // b already open → 1 group
	for i in 0 ..< SYNC_MAX_GROUPS - 1 {
		parts := seal_events(t, wire_change(t, fmt.tprintf("fill-%d", i), 70_000), fmt.tprintf("fill-%d", i), true, writer, 600)
		ingest(t, parts[0], 3_000)
	}
	state = call(t, "state", jobj())
	open_groups, _ = json_int(state, "groups")
	testing.expectf(t, open_groups == SYNC_MAX_GROUPS, "groups=%d", open_groups)
	extra := seal_events(t, wire_change(t, "overflow", 70_000), "overflow", true, writer, 700)
	r = ingest(t, extra[0], 3_000)
	fault, faulted = json_int(r, "faultAt")
	testing.expect(t, faulted && fault == 700, "group limit faults the new event")
}

@(private = "file")
sync_session_restores_replay_groups_and_rejects_without_session :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	sync_session_close()
	payload := jobj()
	payload["action"] = json.String("state")
	_, err := sync_dispatch(json.Object(payload))
	testing.expect(t, err == "no sync session")

	pairs := make([dynamic]json.Value, context.temp_allocator)
	pair := make([dynamic]json.Value, context.temp_allocator)
	append(&pair, json.String(`["x","",0,"0000000000000000"]`), json.Integer(42))
	append(&pairs, json.Array(pair))
	fields := jobj()
	fields["pk"] = json.String(PK)
	fields["conversationKey"] = json.String(CONV)
	fields["cursor"] = json.Integer(7)
	fields["replayGroups"] = json.Array(pairs)
	state := call(t, "session", fields)
	defer sync_session_close()
	floor, has_floor := json_int(state, "replayFloor")
	testing.expect(t, has_floor && floor == 42, "persisted replay groups restore the floor")
	cursor, _ := json_int(state, "cursor")
	testing.expect(t, cursor == 7)
}

// A clean scan retires open CHECKPOINT groups (their chunks were NIP-09'd
// with the superseded checkpoint) but never change groups: a missing change
// keeps its replay floor until a covering repair.
@(private = "file")
sync_session_retire_drops_only_checkpoint_groups :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	open_session(t)
	defer sync_session_close()
	writer := strings.repeat("ef", 32, context.temp_allocator)
	change_parts := seal_events(t, wire_change(t, "big-c", 70_000), "big-c", true, writer, 400)
	cp_parts := seal_events(t, wire_change(t, "big-k", 70_000), "big-k", true, writer, 500)
	for part in cp_parts {
		obj := part.(json.Object)
		obj["kind"] = json.Integer(SYNC_CHECKPOINT_KIND)
	}
	ingest(t, change_parts[0], 1_000)
	ingest(t, cp_parts[0], 1_000)
	state := call(t, "state", jobj())
	open_groups, _ := json_int(state, "groups")
	testing.expect(t, open_groups == 2)

	retire := jobj()
	retire["since"] = json.Integer(450)
	r := call(t, "retire", retire)
	groups, changed := json_field(r, "replayGroups")
	testing.expect(t, changed && len(groups.(json.Array)) == 1, "the checkpoint group at 500 is retired")
	state = call(t, "state", jobj())
	open_groups, _ = json_int(state, "groups")
	floor, _ := json_int(state, "replayFloor")
	testing.expectf(t, open_groups == 1 && floor == 400, "groups=%d floor=%d", open_groups, floor)

	retire["since"] = json.Integer(0)
	r = call(t, "retire", retire)
	_, changed = json_field(r, "replayGroups")
	testing.expect(t, !changed, "a change group is never retired by an empty scan")
	state = call(t, "state", jobj())
	floor, _ = json_int(state, "replayFloor")
	testing.expect(t, floor == 400)
}


@(private = "file")
enqueue :: proc(t: ^testing.T, key, object_id, change_id, change: string, space_id := "", key_id: i64 = 0, has_events := false) -> json.Value {
	pending := jobj()
	pending["key"] = json.String(key)
	pending["objectId"] = json.String(object_id)
	pending["changeId"] = json.String(change_id)
	pending["bytes"] = json.String(change)
	if space_id != "" {
		pending["spaceId"] = json.String(space_id)
		pending["keyId"] = json.Integer(key_id)
	}
	pending["hasEvents"] = json.Boolean(has_events)
	fields := jobj()
	fields["pending"] = json.Object(pending)
	return call(t, "outbox_enqueue", fields)
}

@(private = "file")
outbox_next_at :: proc(t: ^testing.T, now: i64) -> json.Value {
	fields := jobj()
	fields["nowMs"] = json.Integer(now)
	return call(t, "outbox_next", fields)
}

@(private = "file")
outbox_report :: proc(t: ^testing.T, key: string, ok, sealed: bool, now: i64) -> json.Value {
	fields := jobj()
	fields["key"] = json.String(key)
	fields["ok"] = json.Boolean(ok)
	fields["sealed"] = json.Boolean(sealed)
	fields["nowMs"] = json.Integer(now)
	return call(t, "outbox_result", fields)
}

@(private = "file")
sync_session_outbox_order_backoff_and_sealing :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// Session without a secret: personal items cannot be sealed.
	fields := jobj()
	fields["pk"] = json.String(PK)
	fields["conversationKey"] = json.String(CONV)
	call(t, "session", fields)
	change := base64.encode(wire_change(t, "note-1", 0), allocator = context.temp_allocator)
	enqueue(t, "c1", "note-1", "c1", change)
	payload := jobj()
	payload["action"] = json.String("outbox_next")
	payload["nowMs"] = json.Integer(0)
	_, err := sync_dispatch(json.Object(payload))
	testing.expect(t, err == "session has no secret to seal personal changes", err)
	sync_session_close()

	open_session_with_secret(t)
	defer sync_session_close()
	r := enqueue(t, "c1", "note-1", "c1", change)
	queued, _ := json_bool(r, "queued")
	testing.expect(t, queued)
	r = enqueue(t, "c1", "note-1", "c1", change)
	queued, _ = json_bool(r, "queued")
	testing.expect(t, !queued && json_str(r, "reason") == "already queued")
	r = enqueue(t, "space-1/1/c1", "note-1", "c1", change, "space-1", 1)
	queued, _ = json_bool(r, "queued")
	testing.expect(t, queued, "shared obligation under the installed key")
	r = enqueue(t, "space-1/9/c1", "note-1", "c1", change, "space-1", 9)
	queued, _ = json_bool(r, "queued")
	testing.expect(t, !queued && json_str(r, "reason") == "rotated space key", "old key version without ciphertext is retained, not queued")
	r = enqueue(t, "space-1/9/c2", "note-1", "c2", change, "space-1", 9, has_events = true)
	queued, _ = json_bool(r, "queued")
	testing.expect(t, queued, "old key version with persisted ciphertext still publishes")
	pending, _ := json_int(r, "pending")
	testing.expect(t, pending == 3)

	// FIFO: the personal item first, sealed with personal tags.
	r = outbox_next_at(t, 1_000)
	item, has_item := json_field(r, "item")
	testing.expect(t, has_item && json_str(item, "key") == "c1")
	sealed, has_sealed := json_field(item, "sealed")
	testing.expect(t, has_sealed, "first attempt seals")
	parts := json_array(sealed, "parts")
	testing.expect(t, len(parts) == 1)
	first_tag := event_tag(json_array(parts[0], "tags"), "h") or_else nil
	testing.expect(t, tag_string(first_tag, 1) == wire_blind(hex_bytes(SECRET) or_else nil, "note-1"), "personal blind tag")
	pending, _ = json_int(r, "pending")
	testing.expect(t, pending == 2, "an in-flight item is not pending")

	// Failure: attempts=1 → 4 s backoff, item moves behind the others.
	r = outbox_report(t, "c1", false, true, 1_000)
	r = outbox_next_at(t, 1_001)
	item, _ = json_field(r, "item")
	testing.expect(t, json_str(item, "key") == "space-1/1/c1", "next ready item is the shared one")
	sealed, has_sealed = json_field(item, "sealed")
	testing.expect(t, has_sealed)
	tags := json_array(json_array(sealed, "parts")[0], "tags")
	testing.expect(t, len(tags) == 2, "shared seal carries object and space tags")
	outbox_report(t, "space-1/1/c1", true, true, 1_002)
	r = outbox_next_at(t, 1_003)
	item, _ = json_field(r, "item")
	testing.expect(t, json_str(item, "key") == "space-1/9/c2")
	if _, resealed := json_field(item, "sealed"); resealed do testing.fail_now(t, "persisted ciphertext must not be re-sealed")
	outbox_report(t, "space-1/9/c2", true, false, 1_004)

	// Only the failed personal item remains, not ready until 1_000 + 4_000.
	r = outbox_next_at(t, 1_005)
	_, has_item = json_field(r, "item")
	wait, _ := json_int(r, "waitMs")
	testing.expectf(t, !has_item && wait == 3_995, "wait %d", wait)
	r = outbox_next_at(t, 5_000)
	item, has_item = json_field(r, "item")
	testing.expect(t, has_item && json_str(item, "key") == "c1")
	attempts, _ := json_int(item, "attempts")
	testing.expect(t, attempts == 1)
	if _, resealed := json_field(item, "sealed"); resealed do testing.fail_now(t, "retry reuses the signed events the host kept")
	outbox_report(t, "c1", true, false, 5_001)
	r = outbox_next_at(t, 5_002)
	_, has_item = json_field(r, "item")
	pending, _ = json_int(r, "pending")
	wait, _ = json_int(r, "waitMs")
	testing.expect(t, !has_item && pending == 0 && wait == 0, "drained")
	ghost := jobj()
	ghost["action"] = json.String("outbox_result")
	ghost["key"] = json.String("ghost")
	ghost["ok"] = json.Boolean(true)
	ghost["nowMs"] = json.Integer(1)
	_, err = sync_dispatch(json.Object(ghost))
	testing.expect(t, err == "unknown outbox key", err)
}

@(private = "file")
open_session_with_secret :: proc(t: ^testing.T) {
	spaces := make([dynamic]json.Value, context.temp_allocator)
	space := jobj()
	space["spaceId"] = json.String("space-1")
	space["keyHex"] = json.String(SPACE_KEY)
	space["keyId"] = json.Integer(1)
	append(&spaces, json.Object(space))
	fields := jobj()
	fields["pk"] = json.String(PK)
	fields["conversationKey"] = json.String(CONV)
	fields["secret"] = json.String(SECRET)
	fields["cursor"] = json.Integer(0)
	fields["spaces"] = json.Array(spaces)
	call(t, "session", fields)
}

// The session is process-global (the ABI is single-flight), so its scenarios
// run sequentially inside one test rather than on the runner's threads.
@(test)
sync_session_contract :: proc(t: ^testing.T) {
	sync_session_single_part_and_pubkey_rule(t)
	sync_session_reassembles_out_of_order_chunks(t)
	sync_session_faults_on_conflict_expiry_and_limits(t)
	sync_session_restores_replay_groups_and_rejects_without_session(t)
	sync_session_retire_drops_only_checkpoint_groups(t)
	sync_session_outbox_order_backoff_and_sealing(t)
}
