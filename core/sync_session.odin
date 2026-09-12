package core

// Receive-side sync session: turns verified kind-1078 relay events into
// importable changes. Owns chunk-group reassembly, the cursor high-water
// mark and replay-group bookkeeping, and reports replay faults the host
// must fold into its history floor. Like the query cache it persists across
// requests in runtime.default_allocator(); every string it keeps is cloned
// into a session arena, every chunk group into its own arena.
//
// Hosts still own: signature verification (before ingest), the relay walk
// and its floor, the durable outbox, and persisting cursor/replayGroups.

import "base:runtime"
import "core:encoding/json"
import "core:fmt"
import "core:mem"
import "core:strings"

SYNC_CHANGE_KIND :: 1078
SYNC_GROUP_TTL_MS :: 300_000
SYNC_MAX_GROUPS :: 128
SYNC_MAX_GROUP_BYTES :: 16 * 1024 * 1024

Sync_Space :: struct {
	space_id:  string,
	key_hex:   string,
	key_id:    i64,
	space_tag: string,
}

Sync_Group :: struct {
	arena:   mem.Dynamic_Arena,
	total:   int,
	parts:   map[int]string,
	bytes:   int,
	expires: i64,
	at:      i64,
}

Sync_Session :: struct {
	active:           bool,
	arena:            mem.Dynamic_Arena,
	pk:               string,
	conversation_key: string,
	spaces:           [dynamic]Sync_Space,
	cursor:           i64,
	groups:           map[string]^Sync_Group,
	group_bytes:      int,
	// Metadata survives buffer expiry/limits; unlike ciphertext, its
	// cardinality follows unresolved changes. Successful keys suppress replay.
	replay_groups:    map[string]i64,
	imported_groups:  map[string]bool,
	importing_groups: map[string]bool,
	// Interned group keys: one session-owned copy per distinct key.
	keys:             map[string]string,
}

sync_session: Sync_Session

sync_session_allocator :: proc() -> mem.Allocator {
	return mem.dynamic_arena_allocator(&sync_session.arena)
}

sync_group_destroy :: proc(key: string, group: ^Sync_Group) {
	sync_session.group_bytes -= group.bytes
	delete_key(&sync_session.groups, key)
	mem.dynamic_arena_destroy(&group.arena)
	free(group, runtime.default_allocator())
}

sync_session_close :: proc() {
	if !sync_session.active do return
	for key, group in sync_session.groups do sync_group_destroy(key, group)
	delete(sync_session.groups)
	delete(sync_session.replay_groups)
	delete(sync_session.imported_groups)
	delete(sync_session.importing_groups)
	delete(sync_session.keys)
	delete(sync_session.spaces)
	mem.dynamic_arena_destroy(&sync_session.arena)
	sync_session = {}
}

// Session-owned copy of a request string.
sync_keep :: proc(s: string) -> string {
	return strings.clone(s, sync_session_allocator())
}

// Session-owned group key, shared by every map that names the group.
sync_intern :: proc(key: string) -> string {
	if kept, ok := sync_session.keys[key]; ok do return kept
	kept := sync_keep(key)
	sync_session.keys[kept] = kept
	return kept
}

sync_session_open :: proc(payload: json.Value) -> string {
	sync_session_close()
	base := runtime.default_allocator()
	mem.dynamic_arena_init(&sync_session.arena, base, base)
	sync_session.active = true
	sync_session.groups = make(map[string]^Sync_Group, allocator = base)
	sync_session.replay_groups = make(map[string]i64, allocator = base)
	sync_session.imported_groups = make(map[string]bool, allocator = base)
	sync_session.importing_groups = make(map[string]bool, allocator = base)
	sync_session.keys = make(map[string]string, allocator = base)
	sync_session.spaces = make([dynamic]Sync_Space, base)
	pk := json_str(payload, "pk")
	key := json_str(payload, "conversationKey")
	if !is_hex_pubkey(pk) || len(key) != 64 do return "session needs pk and conversationKey hex"
	sync_session.pk = sync_keep(pk)
	sync_session.conversation_key = sync_keep(key)
	sync_session.cursor, _ = json_int(payload, "cursor")
	for entry in json_array(payload, "replayGroups") {
		pair, ok := entry.(json.Array)
		if !ok || len(pair) != 2 do return "replayGroups entries are [key, at] pairs"
		key_value, kok := pair[0].(json.String)
		at, aok := pair[1].(i64)
		if !kok || !aok do return "replayGroups entries are [key, at] pairs"
		sync_replay_group_note(string(key_value), at)
	}
	for entry in json_array(payload, "importedGroups") {
		if key_value, ok := entry.(json.String); ok do sync_session.imported_groups[sync_intern(string(key_value))] = true
	}
	return sync_session_set_spaces(payload)
}

sync_session_set_spaces :: proc(payload: json.Value) -> string {
	clear(&sync_session.spaces)
	for entry in json_array(payload, "spaces") {
		space_id, key_hex := json_str(entry, "spaceId"), json_str(entry, "keyHex")
		key_id, _ := json_int(entry, "keyId")
		if space_id == "" || len(key_hex) != 64 do return "spaces need spaceId and keyHex"
		append(&sync_session.spaces, Sync_Space{
			space_id = sync_keep(space_id),
			key_hex = sync_keep(key_hex),
			key_id = key_id,
			space_tag = wire_blind(transmute([]byte)key_hex, fmt.tprintf("space:%s", space_id), sync_session_allocator()),
		})
	}
	return ""
}

sync_replay_group_note :: proc(key: string, at: i64) -> (changed: bool) {
	if key in sync_session.imported_groups do return false
	if current, ok := sync_session.replay_groups[key]; ok {
		if at >= current do return false
		sync_session.replay_groups[key] = at
		return true
	}
	sync_session.replay_groups[sync_intern(key)] = at
	return true
}

Sync_Ingest :: struct {
	item:            json.Value,
	fault_at:        i64,
	faulted:         bool,
	replay_changed:  bool,
	decrypt_failure: bool,
	decode_failure:  bool,
	h_tag:           string,
}

sync_fault :: proc(r: ^Sync_Ingest, at: i64) {
	if !r.faulted || at < r.fault_at do r.fault_at = at
	r.faulted = true
}

event_tag :: proc(tags: json.Array, name: string) -> (json.Array, bool) {
	for tag in tags {
		if arr, ok := tag.(json.Array); ok && len(arr) > 0 {
			if first, sok := arr[0].(json.String); sok && string(first) == name do return arr, true
		}
	}
	return nil, false
}

tag_string :: proc(tag: json.Array, index: int) -> string {
	if index >= len(tag) do return ""
	if s, ok := tag[index].(json.String); ok do return string(s)
	return ""
}

digits :: proc(s: string) -> (int, bool) {
	if s == "" || len(s) > 9 do return 0, false
	n := 0
	for c in s {
		if c < '0' || c > '9' do return 0, false
		n = n * 10 + int(c - '0')
	}
	return n, true
}

// One verified kind-1078 event → at most one importable change. Mirrors the
// former RelaySync.eventToChange step for step; see the ingest response
// contract in sync_dispatch.
sync_ingest :: proc(event: json.Value, now_ms: i64) -> (r: Sync_Ingest) {
	kind, _ := json_int(event, "kind")
	if kind != SYNC_CHANGE_KIND do return
	tags := json_array(event, "tags")
	if h, ok := event_tag(tags, "h"); ok do r.h_tag = tag_string(h, 1)
	pubkey := json_str(event, "pubkey")
	created_at, _ := json_int(event, "created_at")
	content := json_str(event, "content")

	part, opened := sync_open(content, sync_session.conversation_key)
	space: ^Sync_Space
	if opened {
		if pubkey != sync_session.pk do return
	} else {
		for &candidate in sync_session.spaces {
			tagged := false
			for tag in tags {
				if arr, ok := tag.(json.Array); ok && tag_string(arr, 0) == "h" && tag_string(arr, 1) == candidate.space_tag { tagged = true; break }
			}
			if !tagged do continue
			if part, opened = sync_open(content, candidate.key_hex); opened {
				space = &candidate
				break
			}
		}
		if !opened {
			r.decrypt_failure = true
			return
		}
	}
	chunk_tags := 0
	for tag in tags do if arr, ok := tag.(json.Array); ok && tag_string(arr, 0) == "c" do chunk_tags += 1
	if chunk_tags > 1 do return
	if created_at > sync_session.cursor do sync_session.cursor = created_at

	full := part
	replay_at := created_at
	chunk_key := ""
	gid := ""
	if chunk, chunked := event_tag(tags, "c"); chunked {
		gid = tag_string(chunk, 1)
		index, iok := digits(tag_string(chunk, 2))
		total, tok := digits(tag_string(chunk, 3))
		if len(gid) != WIRE_TAG_LEN || !iok || !tok || total < 2 || total > WIRE_MAX_CHUNKS || index >= total do return
		for c in gid do if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') do return
		for key, group in sync_session.groups do if group.expires <= now_ms {
			sync_fault(&r, group.at)
			sync_group_destroy(key, group)
		}
		space_id, key_id := "", i64(0)
		if space != nil do space_id, key_id = space.space_id, space.key_id
		key_parts := make([dynamic]json.Value, context.temp_allocator)
		append(&key_parts, json.String(pubkey), json.String(space_id), json.Integer(key_id), json.String(gid))
		key := sync_intern(string(marshal(json.Array(key_parts))))
		if key in sync_session.imported_groups || key in sync_session.importing_groups do return
		if sync_replay_group_note(key, created_at) do r.replay_changed = true
		group, exists := sync_session.groups[key]
		if exists {
			previous, has_part := group.parts[index]
			if group.total != total || has_part && previous != part {
				sync_fault(&r, min(group.at, created_at))
				sync_group_destroy(key, group)
				return
			}
		} else {
			if len(sync_session.groups) >= SYNC_MAX_GROUPS {
				sync_fault(&r, created_at)
				return
			}
			base := runtime.default_allocator()
			group = new(Sync_Group, base)
			mem.dynamic_arena_init(&group.arena, base, base)
			group.total = total
			group.parts = make(map[int]string, allocator = mem.dynamic_arena_allocator(&group.arena))
			group.expires = now_ms + SYNC_GROUP_TTL_MS
			group.at = sync_session.replay_groups[key]
			sync_session.groups[key] = group
		}
		group.at = min(group.at, created_at)
		if _, has_part := group.parts[index]; !has_part {
			if sync_session.group_bytes + len(part) > SYNC_MAX_GROUP_BYTES {
				sync_fault(&r, group.at)
				return
			}
			group.parts[index] = strings.clone(part, mem.dynamic_arena_allocator(&group.arena))
			group.bytes += len(part)
			sync_session.group_bytes += len(part)
		}
		if len(group.parts) != group.total do return
		replay_at = group.at
		builder := strings.builder_make(context.temp_allocator)
		for i in 0 ..< group.total do strings.write_string(&builder, group.parts[i])
		full = strings.to_string(builder)
		chunk_key = key
		sync_group_destroy(key, group)
	}

	verify := jobj()
	verify["bytes"] = json.String(full)
	if gid != "" do verify["gid"] = json.String(gid)
	verified, verify_error := wire_verify(json.Object(verify))
	if verify_error != "" {
		r.decode_failure = true
		sync_fault(&r, replay_at)
		return
	}
	if chunk_key != "" do sync_session.importing_groups[chunk_key] = true
	item := jobj()
	item["bytes"] = json.String(full)
	item["change"], _ = json_field(verified, "change")
	if chunk_key != "" do item["chunkKey"] = json.String(chunk_key)
	if space != nil {
		provenance := jobj()
		provenance["spaceId"] = json.String(space.space_id)
		provenance["keyId"] = json.Integer(space.key_id)
		provenance["signer"] = json.String(pubkey)
		item["provenance"] = json.Object(provenance)
	}
	r.item = json.Object(item)
	return
}

sync_open :: proc(content, conversation_key: string) -> (string, bool) {
	key, ok := hex_bytes(conversation_key)
	if !ok do return "", false
	part, dok := nip44_decrypt(content, key, context.temp_allocator)
	if !dok || !wire_part_ok(part) do return "", false
	return part, true
}

// Import outcome for a reassembled group: success retires its replay
// obligation; either way it is no longer in flight.
sync_settle :: proc(chunk_key: string, imported: bool) -> (changed: bool) {
	delete_key(&sync_session.importing_groups, chunk_key)
	if !imported do return false
	sync_session.imported_groups[sync_intern(chunk_key)] = true
	if _, pending := sync_session.replay_groups[chunk_key]; pending {
		delete_key(&sync_session.replay_groups, chunk_key)
		return true
	}
	return false
}

sync_replay_groups_json :: proc() -> json.Value {
	pairs := make([dynamic]json.Value, context.temp_allocator)
	for key, at in sync_session.replay_groups {
		pair := make([dynamic]json.Value, context.temp_allocator)
		append(&pair, json.String(key), json.Integer(at))
		append(&pairs, json.Array(pair))
	}
	return json.Array(pairs)
}

sync_state_json :: proc() -> json.Value {
	out := jobj()
	out["cursor"] = json.Integer(sync_session.cursor)
	out["groups"] = json.Integer(i64(len(sync_session.groups)))
	out["replayGroups"] = sync_replay_groups_json()
	floor: i64 = 0
	has_floor := false
	for _, at in sync_session.replay_groups do if !has_floor || at < floor { floor = at; has_floor = true }
	if has_floor do out["replayFloor"] = json.Integer(floor)
	return json.Object(out)
}
