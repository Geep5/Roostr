package core

// Shared-space authority gate and the vanish ledger, shared by every replica
// (browser, native daemon, iOS). Existing scope and privileges never come
// from the candidate change: the signer is the verified outer Nostr signer,
// ownership comes from the host's installed keyring, and the space object
// used for membership is the replica's trusted replay, not the payload.
//
// The gate is deliberately independent of DAG replay: a snapshot skips
// operations during replay, but both its full state AND every supplied
// operation must pass.

import "core:encoding/json"
import "core:strings"

VANISH_LOG_ID :: "__vanished__"
VANISH_LOG_TYPE :: "vanish_log"
// Entry keys are prefixed so the ledger's own metadata (name, …) can never
// be mistaken for a vanished object id.
VANISH_KEY_PREFIX :: "vanished:"

Shared_Provenance :: struct {
	space_id: string,
	key_id:   i64,
	signer:   string,
}

// What the host knows about the space from its keyring: the key version the
// payload must have been sealed under and the resolved owner pubkey hex
// (installed owner, else the local identity for spaces this device created).
Shared_Space :: struct {
	space_id: string,
	key_id:   i64,
	owner:    string,
}

protected_field :: proc(key: string) -> bool {
	switch key {
	case "members", "owner", "keyId", "key", "keys", "served_by", "machine", "machine_id", "machineId", "bound_object": return true
	}
	return false
}

control_type :: proc(key: string) -> bool {
	switch key {
	case "machine", "agent", "program", "typescript", "skill", "peer": return true
	}
	return false
}

field_string :: proc(fields: [dynamic]Value_Entry, key: string) -> string {
	v, ok := fields_get(fields, key)
	if ok && v.kind == .String do return v.str
	return ""
}

// Structural equality. Map entries compare by key regardless of order:
// browser hosts send plain JSON objects, whose parsed order is arbitrary.
values_equal :: proc(a, b: Value) -> bool {
	if a.kind != b.kind do return false
	switch a.kind {
	case .None: return true
	case .String: return a.str == b.str
	case .Int: return a.i == b.i
	case .Float: return a.f == b.f
	case .Bool: return a.b == b.b
	case .Bytes: return string(a.bytes) == string(b.bytes)
	case .Link: return a.link_target == b.link_target && a.link_relation == b.link_relation
	case .String_List:
		if len(a.strings) != len(b.strings) do return false
		for s, i in a.strings do if s != b.strings[i] do return false
		return true
	case .List:
		if len(a.items) != len(b.items) do return false
		for item, i in a.items do if !values_equal(item, b.items[i]) do return false
		return true
	case .Map:
		if len(a.entries) != len(b.entries) do return false
		for entry in a.entries {
			other, found := fields_get(b.entries, entry.key)
			if !found || !values_equal(entry.value, other) do return false
		}
		return true
	}
	return false
}

member_writer :: proc(space: ^Object_State, signer: string) -> bool {
	if space == nil do return false
	members, ok := fields_get(space.fields, "members")
	if !ok || members.kind != .List do return false
	for member in members.items {
		if member.kind != .Map || field_string(member.entries, "role") != "writer" do continue
		if pubkey_hex(field_string(member.entries, "npub")) == signer do return true
	}
	return false
}

// trusted_space and existing are the replica's current states for the space
// object and the target object, or nil when unknown. Returns the rejection
// reason, "" when the change may be imported.
authorize_shared_change :: proc(c: ^Change, p: Shared_Provenance, space: Shared_Space,
	trusted_space: ^Object_State, existing: ^Object_State) -> (ok: bool, reason: string) {
	if p.space_id == "" || p.space_id != space.space_id || p.key_id != space.key_id do return false, "provenance does not match the installed space key"
	if !is_hex_pubkey(p.signer) do return false, "signer is not a hex pubkey"
	is_owner := space.owner != "" && p.signer == space.owner
	if trusted_space != nil && (trusted_space.type_key != "channel" || trusted_space.id != space.space_id || trusted_space.deleted) {
		return false, "space object is not a live channel"
	}
	if !is_owner && !member_writer(trusted_space, p.signer) do return false, "signer is not a writer of the space"
	if c.object_id == "" || c.object_id == VANISH_LOG_ID do return false, "object id is not shareable"
	is_space := c.object_id == space.space_id
	exists := existing != nil
	if exists {
		if existing.type_key == VANISH_LOG_TYPE do return false, "vanish ledger is not shareable"
		if is_space {
			if existing.type_key != "channel" do return false, "space object is not a channel"
		} else if existing.type_key == "channel" || field_string(existing.fields, "channel") != space.space_id {
			return false, "existing object belongs to another scope"
		}
		if !is_owner && control_type(existing.type_key) do return false, "only the owner may change control objects"
	}
	created := exists
	stamped := exists || is_space
	if c.has_snapshot {
		snap := &c.snapshot
		seen_fields := make(map[string]bool, context.temp_allocator)
		for entry in snap.fields {
			if entry.key in seen_fields do return false, "snapshot repeats a field"
			seen_fields[entry.key] = true
		}
		if snap.id != c.object_id || snap.type_key == "" || snap.type_key == VANISH_LOG_TYPE do return false, "snapshot does not describe the object"
		if exists && snap.type_key != existing.type_key do return false, "snapshot changes the object type"
		if is_space {
			if snap.type_key != "channel" do return false, "space snapshot is not a channel"
			if _, present := fields_get(snap.fields, "channel"); present do return false, "channel carries a channel field"
		} else if snap.type_key == "channel" || field_string(snap.fields, "channel") != space.space_id {
			return false, "snapshot is not scoped to the space"
		}
		if !is_owner {
			if control_type(snap.type_key) || !exists && is_space do return false, "only the owner may snapshot this object"
			if is_space && snap.deleted != existing.deleted do return false, "only the owner may delete or restore the space"
			// Compare both directions: omitting a protected field is a delete.
			for entry in snap.fields {
				if !protected_field(entry.key) do continue
				if !exists do return false, "only the owner may set protected fields"
				old, found := fields_get(existing.fields, entry.key)
				if !found || !values_equal(old, entry.value) do return false, "only the owner may change protected fields"
			}
			if exists {
				for entry in existing.fields {
					if !protected_field(entry.key) do continue
					value, found := fields_get(snap.fields, entry.key)
					if !found || !values_equal(value, entry.value) do return false, "only the owner may change protected fields"
				}
			}
		}
		created = true
		stamped = true
	}
	for op in c.ops {
		switch op.kind {
		case .Object_Create:
			if op.type_key == "" || op.type_key == VANISH_LOG_TYPE do return false, "create needs a shareable type"
			if exists && op.type_key != existing.type_key do return false, "create changes the object type"
			if c.has_snapshot && op.type_key != c.snapshot.type_key do return false, "create disagrees with the snapshot type"
			if is_space != (op.type_key == "channel") do return false, "channels are created only as the space object"
			if !is_owner && (is_space || control_type(op.type_key)) do return false, "only the owner may create this object"
			created = true
		case .Object_Delete:
			if is_space && !is_owner do return false, "only the owner may delete the space"
		case .Field_Set, .Field_Delete:
			if op.key == "channel" {
				if is_space || op.kind != .Field_Set || op.value.kind != .String || op.value.str != space.space_id do return false, "channel field must stamp this space"
				stamped = true
			}
			if !is_owner && protected_field(op.key) do return false, "only the owner may change protected fields"
		case .None:
			return false, "operation is empty"
		case .Block_Add, .Block_Remove, .Block_Update, .Block_Move, .Block_Set_Align, .Block_Set_Background:
		}
	}
	if !created do return false, "object was never created"
	if !stamped do return false, "object is not scoped to the space"
	return true, ""
}

/** Vanished object ids → purge timestamp (ms) from the ledger state, if any. */
vanished_from_ledger :: proc(ledger: ^Object_State, allocator := context.temp_allocator) -> map[string]i64 {
	out := make(map[string]i64, allocator = allocator)
	if ledger == nil do return out
	for e in ledger.fields {
		if !strings.has_prefix(e.key, VANISH_KEY_PREFIX) do continue
		object_id := e.key[len(VANISH_KEY_PREFIX):]
		if object_id == "" || object_id == VANISH_LOG_ID do continue
		at: i64 = 0
		if e.value.kind == .Int do at = e.value.i
		out[object_id] = at
	}
	return out
}

sync_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	switch json_str(payload, "action") {
	case "authorize":
		change_value, _ := json_field(payload, "change")
		change, cok := change_from_json(change_value)
		if !cok do return nil, "invalid change JSON"
		prov_value, _ := json_field(payload, "provenance")
		provenance := Shared_Provenance{json_str(prov_value, "spaceId"), 0, strings.to_lower(json_str(prov_value, "signer"), context.temp_allocator)}
		provenance.key_id, _ = json_int(prov_value, "keyId")
		space_value, _ := json_field(payload, "space")
		space := Shared_Space{json_str(space_value, "spaceId"), 0, strings.to_lower(json_str(space_value, "owner"), context.temp_allocator)}
		space.key_id, _ = json_int(space_value, "keyId")
		trusted, tok := optional_state(payload, "trustedSpace")
		if !tok do return nil, "invalid trustedSpace state"
		existing, eok := optional_state(payload, "existing")
		if !eok do return nil, "invalid existing state"
		ok, reason := authorize_shared_change(&change, provenance, space, trusted, existing)
		out := jobj()
		out["ok"] = json.Boolean(ok)
		out["reason"] = json.String(reason)
		return json.Object(out), ""
	case "vanished":
		ledger, lok := optional_state(payload, "ledger")
		if !lok do return nil, "invalid ledger state"
		items := make([dynamic]json.Value, context.temp_allocator)
		for object_id, at in vanished_from_ledger(ledger) {
			item := jobj()
			item["objectId"] = json.String(object_id)
			item["at"] = json.Integer(at)
			append(&items, json.Object(item))
		}
		return json.Array(items), ""
	// ── Receive session (sync_session.odin) ──
	case "session":
		// {pk, conversationKey, spaces: [{spaceId, keyHex, keyId}], cursor, replayGroups: [[key, at]], importedGroups?: [key]}
		if err := sync_session_open(payload); err != "" {
			sync_session_close()
			return nil, err
		}
		return sync_state_json(), ""
	case "spaces":
		if !sync_session.active do return nil, "no sync session"
		if err := sync_session_set_spaces(payload); err != "" do return nil, err
		return sync_state_json(), ""
	case "ingest":
		// {event: {pubkey, created_at, kind, tags, content}, nowMs} → {cursor, item?, faultAt?, replayGroups?, decryptFailure?, decodeFailure?, hTag?}
		// The host has already verified the event signature.
		if !sync_session.active do return nil, "no sync session"
		event, present := json_field(payload, "event")
		if _, ok := event.(json.Object); !present || !ok do return nil, "ingest needs an event object"
		now, has_now := json_int(payload, "nowMs")
		if !has_now do return nil, "ingest needs nowMs"
		r := sync_ingest(event, now)
		out := jobj()
		out["cursor"] = json.Integer(sync_session.cursor)
		if r.item != nil do out["item"] = r.item
		if r.faulted do out["faultAt"] = json.Integer(r.fault_at)
		if r.replay_changed do out["replayGroups"] = sync_replay_groups_json()
		if r.decrypt_failure do out["decryptFailure"] = json.Boolean(true)
		if r.decode_failure do out["decodeFailure"] = json.Boolean(true)
		if r.h_tag != "" do out["hTag"] = json.String(r.h_tag)
		return json.Object(out), ""
	case "settle":
		// {chunkKey, imported} → {replayGroups?}
		if !sync_session.active do return nil, "no sync session"
		imported, _ := json_bool(payload, "imported")
		out := jobj()
		if sync_settle(json_str(payload, "chunkKey"), imported) do out["replayGroups"] = sync_replay_groups_json()
		return json.Object(out), ""
	case "state":
		if !sync_session.active do return nil, "no sync session"
		return sync_state_json(), ""
	case "close":
		sync_session_close()
		return json.Boolean(true), ""
	}
	return nil, "unknown sync action"
}

// Missing or null → nil; anything else must parse as an object state.
optional_state :: proc(payload: json.Value, key: string) -> (^Object_State, bool) {
	value, present := json_field(payload, key)
	if !present || value == nil do return nil, true
	if _, is_null := value.(json.Null); is_null do return nil, true
	state, ok := object_from_json(value, context.temp_allocator, clone_json = false)
	if !ok do return nil, false
	out := new(Object_State, context.temp_allocator)
	out^ = state
	return out, true
}
