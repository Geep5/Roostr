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

Shared_Provenance :: core.Shared_Provenance

shared_provenance_parse :: proc(body: json.Value) -> (Shared_Provenance, bool, bool) {
	value, present := core.json_field(body, "provenance")
	if !present do return Shared_Provenance{}, false, true // trusted personal import
	p := Shared_Provenance{core.json_str(value, "spaceId"), 0, core.json_str(value, "signer")}
	p.key_id, _ = core.json_int(value, "keyId")
	valid := p.space_id != "" && !strings.contains(p.space_id, "/") && !strings.contains(p.space_id, "..") && p.key_id > 0 && core.is_hex_pubkey(p.signer)
	return p, true, valid
}

// The shared gate lives in core (authorize_shared_change); this binds it to
// the daemon's state map and the keyring-resolved owner. shared_import_allowed
// has already matched the keyring's key version against the provenance.
shared_change_allowed :: proc(c: ^core.Change, p: Shared_Provenance, owner: string, states: map[string]^core.Object_State) -> bool {
	space := core.Shared_Space{p.space_id, p.key_id, owner}
	ok, _ := core.authorize_shared_change(c, p, space, states[p.space_id], states[c.object_id])
	return ok
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
	valid := found && key_id == p.key_id && len(core.json_str(entry, "key")) == 64 && core.is_hex_pubkey(owner)
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
	valid_owner := valid_identity && len(raw) == 32 && core.is_hex_pubkey(owner)
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
