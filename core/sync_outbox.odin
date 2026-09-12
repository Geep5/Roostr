package core

// Publish-side sync session: the paced, eventually-durable outbox that the
// browser (RelaySync.runPublishQueue) and the daemon's harness (publishOnce)
// each carried. The core owns queue order, dedupe, the rotated-key rule,
// attempts and backoff, and seals a change the first time it goes out. The
// host signs the sealed parts, persists the exact signed events, sends them,
// and reports the outcome. Pacing sleeps stay with the host.

import "base:runtime"
import "core:encoding/json"
import "core:strings"

OUTBOX_BACKOFF_BASE_MS :: 2_000
OUTBOX_BACKOFF_MAX_MS :: 300_000

Outbox_Item :: struct {
	key:        string,
	object_id:  string,
	change_id:  string,
	change:     string, // base64 wire bytes
	space_id:   string, // "" for the personal obligation
	key_hex:    string, // space key captured at enqueue, as the browser did
	key_id:     i64,
	has_events: bool, // host holds signed ciphertext; never re-seal
	attempts:   int,
	not_before: i64,
	in_flight:  bool,
}

outbox_item_free :: proc(item: ^Outbox_Item) {
	base := runtime.default_allocator()
	delete(item.key, base)
	delete(item.object_id, base)
	delete(item.change_id, base)
	delete(item.change, base)
	delete(item.space_id, base)
	delete(item.key_hex, base)
}

outbox_clear :: proc() {
	for &item in sync_session.outbox do outbox_item_free(&item)
	delete(sync_session.outbox)
	sync_session.outbox = nil
}

outbox_find :: proc(key: string) -> int {
	for item, i in sync_session.outbox do if item.key == key do return i
	return -1
}

// Items not currently handed to the host.
outbox_pending :: proc() -> int {
	n := 0
	for item in sync_session.outbox do if !item.in_flight do n += 1
	return n
}

Outbox_Enqueue :: enum {
	Queued,
	Already_Queued,
	Rotated_Key, // a rotated space key cannot recreate the ciphertext; the host retains the record for export
}

outbox_enqueue :: proc(pending: json.Value) -> (Outbox_Enqueue, string) {
	key := json_str(pending, "key")
	change := json_str(pending, "bytes")
	object_id, change_id := json_str(pending, "objectId"), json_str(pending, "changeId")
	if key == "" || change == "" || object_id == "" || change_id == "" do return .Queued, "pending needs key, objectId, changeId and bytes"
	if outbox_find(key) >= 0 do return .Already_Queued, ""
	has_events, _ := json_bool(pending, "hasEvents")
	space_id := json_str(pending, "spaceId")
	key_id, _ := json_int(pending, "keyId")
	key_hex := ""
	if space_id != "" {
		for space in sync_session.spaces do if space.space_id == space_id && space.key_id == key_id { key_hex = space.key_hex; break }
		if key_hex == "" && !has_events do return .Rotated_Key, ""
	}
	base := runtime.default_allocator()
	append(&sync_session.outbox, Outbox_Item{
		key = strings.clone(key, base),
		object_id = strings.clone(object_id, base),
		change_id = strings.clone(change_id, base),
		change = strings.clone(change, base),
		space_id = strings.clone(space_id, base),
		key_hex = strings.clone(key_hex, base),
		key_id = key_id,
		has_events = has_events,
	})
	return .Queued, ""
}

// The first ready item, sealed when the host holds no signed events for it
// yet. nil item + wait_ms when nothing is ready; nil item + wait_ms 0 when
// the queue is empty.
outbox_next :: proc(now_ms: i64) -> (item: json.Value, wait_ms: i64, err: string) {
	wait: i64 = -1
	for &candidate in sync_session.outbox {
		if candidate.in_flight do continue
		if candidate.not_before > now_ms {
			remaining := candidate.not_before - now_ms
			if wait < 0 || remaining < wait do wait = remaining
			continue
		}
		out := jobj()
		out["key"] = json.String(candidate.key)
		out["objectId"] = json.String(candidate.object_id)
		out["changeId"] = json.String(candidate.change_id)
		out["attempts"] = json.Integer(i64(candidate.attempts))
		if candidate.space_id != "" {
			out["spaceId"] = json.String(candidate.space_id)
			out["keyId"] = json.Integer(candidate.key_id)
		}
		if !candidate.has_events {
			seal := jobj()
			seal["change"] = json.String(candidate.change)
			seal["objectId"] = json.String(candidate.object_id)
			if candidate.space_id != "" {
				seal["conversationKey"] = json.String(candidate.key_hex)
				space := jobj()
				space["keyHex"] = json.String(candidate.key_hex)
				space["spaceId"] = json.String(candidate.space_id)
				seal["space"] = json.Object(space)
			} else {
				if sync_session.secret == "" do return nil, 0, "session has no secret to seal personal changes"
				seal["conversationKey"] = json.String(sync_session.conversation_key)
				seal["secret"] = json.String(sync_session.secret)
			}
			sealed, seal_error := wire_seal(json.Object(seal))
			if seal_error != "" {
				// Unsealable forever (e.g. beyond the chunk limit): back off like a failed send so it stays visible, never spins.
				outbox_backoff(&candidate, now_ms)
				return nil, 0, seal_error
			}
			out["sealed"] = sealed
		}
		candidate.in_flight = true
		return json.Object(out), 0, ""
	}
	return nil, max(wait, 0), ""
}

outbox_backoff :: proc(item: ^Outbox_Item, now_ms: i64) {
	item.attempts += 1
	delay := i64(OUTBOX_BACKOFF_BASE_MS)
	for _ in 0 ..< min(item.attempts, 20) do delay *= 2
	item.not_before = now_ms + min(delay, OUTBOX_BACKOFF_MAX_MS)
	item.in_flight = false
}

// ok: the relays accepted every part (or the store already knew it published).
// sealed: the host signed and persisted this attempt's ciphertext, so retries reuse it.
outbox_result :: proc(key: string, ok: bool, sealed: bool, now_ms: i64) -> string {
	index := outbox_find(key)
	if index < 0 do return "unknown outbox key"
	item := &sync_session.outbox[index]
	if sealed do item.has_events = true
	if ok {
		outbox_item_free(item)
		ordered_remove(&sync_session.outbox, index)
		return ""
	}
	outbox_backoff(item, now_ms)
	// Failed items go to the back, behind everything queued meanwhile.
	retry := sync_session.outbox[index]
	ordered_remove(&sync_session.outbox, index)
	append(&sync_session.outbox, retry)
	return ""
}
