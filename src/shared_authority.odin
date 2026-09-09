package glon

import "../core"

// Only the authenticated sync service may attest this transport provenance.
// The signer is the verified outer Nostr signer, never Change.author. Ownership
// comes from the locally installed keyring, not the imported object's fields.
import "core:encoding/json"
import "core:encoding/hex"
import "core:strings"
import "core:sync"
import "core:os"

Shared_Provenance :: struct {
	space_id: string,
	key_id: i64,
	signer: string,
}

shared_hex_pubkey :: proc(key: string) -> bool {
	if len(key) != 64 do return false
	for c in key do if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') do return false
	return true
}

shared_provenance_parse :: proc(body: json.Value) -> (Shared_Provenance, bool, bool) {
	value, present := core.json_field(body, "provenance")
	if !present do return Shared_Provenance{}, false, true // trusted personal import
	p := Shared_Provenance{core.json_str(value, "spaceId"), 0, core.json_str(value, "signer")}
	p.key_id, _ = core.json_int(value, "keyId")
	valid := p.space_id != "" && !strings.contains(p.space_id, "/") && !strings.contains(p.space_id, "..") && p.key_id > 0 && shared_hex_pubkey(p.signer)
	return p, true, valid
}

shared_protected_field :: proc(key: string) -> bool {
	switch key {
	case "members", "owner", "keyId", "key", "keys", "served_by", "machine", "machine_id", "machineId", "bound_object": return true
	}
	return false
}

shared_control_type :: proc(key: string) -> bool {
	switch key {
	case "machine", "agent", "program", "typescript", "skill", "peer": return true
	}
	return false
}

shared_field_string :: proc(fields: [dynamic]core.Value_Entry, key: string) -> string {
	v, ok := core.fields_get(fields, key)
	if ok && v.kind == .String do return v.str
	return ""
}

shared_values_equal :: proc(a, b: core.Value) -> bool {
	wa := core.Writer{buf = make([dynamic]byte, context.temp_allocator)}
	wb := core.Writer{buf = make([dynamic]byte, context.temp_allocator)}
	core.encode_value(a, &wa)
	core.encode_value(b, &wb)
	return string(wa.buf[:]) == string(wb.buf[:])
}

shared_member_writer :: proc(space: ^core.Object_State, signer: string) -> bool {
	if space == nil || space.deleted || space.type_key != "channel" do return false
	members, ok := core.fields_get(space.fields, "members")
	if !ok || members.kind != .List do return false
	for member in members.items {
		if member.kind != .Map || shared_field_string(member.entries, "role") != "writer" do continue
		key := shared_field_string(member.entries, "npub")
		if key == signer do return true
		hrp, raw, valid := bech32_decode(key, context.temp_allocator)
		if valid && hrp == "npub" && len(raw) == 32 && string(hex.encode(raw, context.temp_allocator)) == signer do return true
	}
	return false
}

// This is deliberately independent of DAG replay: a snapshot skips operations
// during replay, but both its full state AND every supplied operation must pass.
shared_change_allowed :: proc(c: ^core.Change, p: Shared_Provenance, owner: string, states: map[string]^core.Object_State) -> bool {
	space := states[p.space_id]
	is_owner := p.signer == owner
	if !is_owner && !shared_member_writer(space, p.signer) do return false
	if c.object_id == VANISH_LOG_ID do return false
	existing, exists := states[c.object_id]
	is_space := c.object_id == p.space_id
	if exists {
		if existing.type_key == VANISH_LOG_TYPE do return false
		if is_space {
			if existing.type_key != "channel" do return false
		} else if existing.type_key == "channel" || shared_field_string(existing.fields, "channel") != p.space_id {
			return false
		}
		if !is_owner && shared_control_type(existing.type_key) do return false
	}
	created := exists
	stamped := exists || is_space
	if c.has_snapshot {
		snap := &c.snapshot
		seen_fields := make(map[string]bool, context.temp_allocator)
		for entry in snap.fields {
			if entry.key in seen_fields do return false
			seen_fields[entry.key] = true
		}
		if snap.id != c.object_id || snap.type_key == "" || snap.type_key == VANISH_LOG_TYPE do return false
		if exists && snap.type_key != existing.type_key do return false
		if is_space {
			if snap.type_key != "channel" do return false
			if _, present := core.fields_get(snap.fields, "channel"); present do return false
		} else if snap.type_key == "channel" || shared_field_string(snap.fields, "channel") != p.space_id {
			return false
		}
		if !is_owner {
			if shared_control_type(snap.type_key) || !exists && is_space do return false
			if is_space && snap.deleted != existing.deleted do return false
			// Compare both directions: omitting a protected field is a delete.
			for entry in snap.fields {
				if !shared_protected_field(entry.key) do continue
				if !exists do return false
				old, found := core.fields_get(existing.fields, entry.key)
				if !found || !shared_values_equal(old, entry.value) do return false
			}
			if exists {
				for entry in existing.fields {
					if !shared_protected_field(entry.key) do continue
					value, found := core.fields_get(snap.fields, entry.key)
					if !found || !shared_values_equal(value, entry.value) do return false
				}
			}
		}
		created = true
		stamped = true
	}
	for op in c.ops {
		switch op.kind {
		case .Object_Create:
			if op.type_key == "" || op.type_key == VANISH_LOG_TYPE do return false
			if exists && op.type_key != existing.type_key do return false
			if c.has_snapshot && op.type_key != c.snapshot.type_key do return false
			if is_space != (op.type_key == "channel") do return false
			if !is_owner && (is_space || shared_control_type(op.type_key)) do return false
			created = true
		case .Object_Delete:
			if is_space && !is_owner do return false
		case .Field_Set, .Field_Delete:
			if op.key == "channel" {
				if is_space || op.kind != .Field_Set || op.value.kind != .String || op.value.str != p.space_id do return false
				stamped = true
			}
			if !is_owner && shared_protected_field(op.key) do return false
		case .None: return false
		case .Block_Add, .Block_Remove, .Block_Update, .Block_Move, .Block_Set_Align, .Block_Set_Background:
		}
	}
	return created && stamped
}

shared_import_allowed :: proc(c: ^core.Change, p: Shared_Provenance) -> bool {
	// Keyring metadata is installed by the trusted service, never imported DAG
	// operations. A rotation invalidates all prior-key shared import capability.
	sync.lock(&g_keys_mu)
	keyring := channel_keys_read()
	channels, _ := core.json_field(keyring, "channels")
	entry, found := core.json_field(channels, p.space_id)
	key_id, _ := core.json_int(entry, "keyId")
	if _, present := core.json_field(entry, "keyId"); !present do key_id = 1
	owner := core.json_str(entry, "owner")
	local_owner := owner == ""
	if local_owner do owner = core.json_str(keyring, "localPubkey")
	valid := found && key_id == p.key_id && len(core.json_str(entry, "key")) == 64 && shared_hex_pubkey(owner)
	sync.unlock(&g_keys_mu)
	if !valid do return false
	if local_owner {
		sync.lock(&g_nostr_mu)
		identity := nostr_read()
		sync.unlock(&g_nostr_mu)
		raw, ok := hex.decode(transmute([]byte)identity.privkey_hex, context.temp_allocator)
		if !ok || len(raw) != 32 do return false
		digest := core.sha256(raw)
		if core.json_str(keyring, "localIdentityHash") != string(hex.encode(digest[:], context.temp_allocator)) do return false
	}
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	return shared_change_allowed(c, p, owner, g_store.states)
}

// Called before replacing the private identity, while g_nostr_mu is held.
// Freeze locally owned entries to their old owner before clearing the cached
// local identity, so a newly loaded signer cannot inherit ownership by accident.
shared_forget_local_identity :: proc(preserve_owner := true) -> bool {
	sync.lock(&g_keys_mu)
	defer sync.unlock(&g_keys_mu)
	keyring := channel_keys_read()
	root, ok := keyring.(json.Object)
	if !ok do return true
	owner := core.json_str(keyring, "localPubkey")
	identity := nostr_read() // caller holds g_nostr_mu
	raw, valid_identity := hex.decode(transmute([]byte)identity.privkey_hex, context.temp_allocator)
	valid_owner := valid_identity && len(raw) == 32 && shared_hex_pubkey(owner)
	if valid_owner {
		digest := core.sha256(raw)
		valid_owner = core.json_str(keyring, "localIdentityHash") == string(hex.encode(digest[:], context.temp_allocator))
	}
	if channels, present := core.json_field(keyring, "channels"); present && preserve_owner {
		if entries, valid := channels.(json.Object); valid {
			for _, entry in entries {
				if obj, valid := entry.(json.Object); valid && core.json_str(entry, "owner") == "" {
					// Without a binding, changing identities would silently grant
					// the next signer ownership of existing local spaces.
					if !valid_owner do return false
					obj["owner"] = json.String(owner)
				}
			}
		}
	}
	delete_key(&root, "localPubkey")
	delete_key(&root, "localIdentityHash")
	return os.write_entire_file(channel_keys_path(), core.marshal(json.Object(root)), perm = {.Read_User, .Write_User}) == nil
}
