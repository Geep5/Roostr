package glon

// Nostr identity + relay settings (<data>/nostr.json, 0600).
//
// The private key is generated on first access and NEVER leaves this
// file except through the explicit export endpoint (nsec/hex for the
// settings UI). Relays are the user's write/read set for the upcoming
// nostr sync.

import "core:os"
import "core:sync"
import "core:crypto"
import "core:encoding/json"
import "core:encoding/hex"
import "core:crypto/sha2"
import "core:fmt"
import "core:path/filepath"
import "core:net"
import "core:strings"
import "../core"

g_nostr_mu: sync.Mutex

nostr_settings_path :: proc() -> string {
	p, _ := filepath.join({g_store.data_root, "nostr.json"}, context.temp_allocator)
	return p
}

Nostr_Settings :: struct {
	privkey_hex: string,
	relays:      [dynamic]string,
}

nostr_read :: proc(allocator := context.temp_allocator) -> Nostr_Settings {
	s: Nostr_Settings
	s.relays = make([dynamic]string, allocator)
	data, rerr := os.read_entire_file(nostr_settings_path(), allocator)
	if rerr == nil {
		parsed, perr := json.parse(data, allocator = allocator)
		if perr == nil {
			s.privkey_hex = core.json_str(parsed, "privkey")
			if rv, ok := core.json_field(parsed, "relays"); ok {
				if arr, aok := rv.(json.Array); aok {
					for r in arr {
						if str, sok := r.(json.String); sok do append(&s.relays, string(str))
					}
				}
			}
		}
	}
	return s
}

nostr_write :: proc(s: Nostr_Settings) {
	root := core.jobj()
	root["version"] = json.Integer(1)
	root["privkey"] = json.String(s.privkey_hex)
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	root["relays"] = json.Array(relays)
	// Private key inside — owner-only, like wallet.json.
	_ = os.write_entire_file(nostr_settings_path(), core.marshal(json.Object(root)), perm = {.Read_User, .Write_User})
}
/** Battle-tested public relays seeded on fresh installs (Settings can edit). */
DEFAULT_RELAYS :: []string{"wss://roostr-relay.fly.dev"}

/** Settings with a key, generating one on first access. */
nostr_ensure :: proc(allocator := context.temp_allocator) -> Nostr_Settings {
	sync.lock(&g_nostr_mu)
	defer sync.unlock(&g_nostr_mu)
	s := nostr_read(allocator)
	if len(s.privkey_hex) != 64 {
		raw: [32]byte
		crypto.rand_bytes(raw[:])
		s.privkey_hex = strings.clone(string(hex.encode(raw[:], context.temp_allocator)), allocator)
		// Fresh identity = fresh install: seed the default relay so sync
		// works out of the box. An existing (even empty) list is the
		// user's choice - Settings offers public relays as toggles now,
		// so no migration may strip them back out.
		if len(s.relays) == 0 {
			for r in DEFAULT_RELAYS do append(&s.relays, r)
		}
		nostr_write(s)
	}
	return s
}

// ── Bech32 (NIP-19 nsec) ─────────────────────────────────────────────

bech32_encode :: core.bech32_encode
bech32_decode :: core.bech32_decode

/** mutate action: nostr_key_import {key: "nsec1…" | 64-hex}. Replaces the identity.
   On an actual key change the vault is archived and replay restarts from zero:
   the old identity's objects must not leak into the new one, and the sync
   cursor has to rewind so relay history re-imports against the new key. */
mutate_key_import :: proc(sock: net.TCP_Socket, parsed: json.Value) {
	raw := strings.trim_space(core.json_str(parsed, "key"))
	priv_hex := ""
	if strings.has_prefix(raw, "nsec1") {
		hrp, data, ok := bech32_decode(raw)
		if !ok || hrp != "nsec" || len(data) != 32 {
			respond_error(sock, "invalid nsec")
			return
		}
		priv_hex = string(hex.encode(data, context.temp_allocator))
	} else if len(raw) == 64 {
		if _, ok := hex.decode(transmute([]byte)raw, context.temp_allocator); !ok {
			respond_error(sock, "invalid hex key")
			return
		}
		priv_hex = strings.to_lower(raw, context.temp_allocator)
	} else {
		respond_error(sock, "key must be nsec1… or 64 hex chars")
		return
	}
	sync.lock(&g_nostr_mu)
	defer sync.unlock(&g_nostr_mu)
	s := nostr_read()
	if s.privkey_hex != priv_hex {
		if !shared_forget_local_identity() {
			respond_error(sock, "could not invalidate previous identity authority", "500 Internal Server Error")
			return
		}
		root := g_store.data_root
		arch := fmt.tprintf("%s/import-%d", root, unix_ms())
		os.make_directory(arch)
		names := []string{"changes", "nostr.json", "sync-state.json", "channel-keys.json"}
		for n in names {
			from := fmt.tprintf("%s/%s", root, n)
			to := fmt.tprintf("%s/%s", arch, n)
			os.rename(from, to) // absent files are a no-op
		}
		os.make_directory(fmt.tprintf("%s/changes", root))
		store_invalidate()
		s = nostr_read() // archived along with the vault; re-read the fresh file
	}
	s.privkey_hex = priv_hex
	nostr_write(s)
	o := core.jobj()
	o["ok"] = json.Boolean(true)
	respond_json(sock, json.Object(o))
}

/**
 * mutate action: identity_logout — park the identity and every
 * identity-bound artifact in <data>/logout-<ms>/, then invalidate the
 * store. The next access generates a fresh key over an empty vault;
 * the relays still hold the old identity's encrypted history.
 */
mutate_identity_logout :: proc(sock: net.TCP_Socket) {
	sync.lock(&g_nostr_mu)
	defer sync.unlock(&g_nostr_mu)
	if !shared_forget_local_identity(false) {
		respond_error(sock, "could not invalidate previous identity authority", "500 Internal Server Error")
		return
	}
	root := g_store.data_root
	arch := fmt.tprintf("%s/logout-%d", root, unix_ms())
	os.make_directory(arch)
	names := []string{"changes", "nostr.json", "sync-state.json", "channel-keys.json"}
	for n in names {
		from := fmt.tprintf("%s/%s", root, n)
		to := fmt.tprintf("%s/%s", arch, n)
		os.rename(from, to) // absent files are a no-op
	}
	os.make_directory(fmt.tprintf("%s/changes", root))
	store_invalidate()
	o := core.jobj()
	o["ok"] = json.Boolean(true)
	o["archived"] = json.String(strings.clone(arch, context.temp_allocator))
	respond_json(sock, json.Object(o))
}

// ── HTTP handlers ────────────────────────────────────────────────────

handle_settings :: proc(sock: net.TCP_Socket) {
	s := nostr_ensure()
	o := core.jobj()
	o["hasKey"] = json.Boolean(len(s.privkey_hex) == 64)
	// The native runtime does not derive secp256k1 public keys. Only expose
	// the trusted service's cached public identity when bound to this key.
	sync.lock(&g_keys_mu)
	keyring := channel_keys_read()
	sync.unlock(&g_keys_mu)
	public_key := core.json_str(keyring, "localPubkey")
	bound := false
	if raw, ok := hex.decode(transmute([]byte)s.privkey_hex, context.temp_allocator); ok && len(raw) == 32 && core.is_hex_pubkey(public_key) {
		ctx: sha2.Context_256
		sha2.init_256(&ctx)
		sha2.update(&ctx, raw)
		digest: [32]byte
		sha2.final(&ctx, digest[:])
		bound = core.json_str(keyring, "localIdentityHash") == string(hex.encode(digest[:], context.temp_allocator))
	}
	o["identityPending"] = json.Boolean(!bound)
	if bound {
		public_bytes, _ := hex.decode(transmute([]byte)public_key, context.temp_allocator)
		o["publicKey"] = json.String(public_key)
		o["npub"] = json.String(bech32_encode("npub", public_bytes, context.temp_allocator))
	}
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	o["relays"] = json.Array(relays)
	o["authorId"] = json.String(author_id())
	respond_json(sock, json.Object(o))
}

/**
 * Stable non-reversible author id for chat messages: first 16 hex chars of
 * sha256(privkey). Every device sharing the key posts as the same author.
 */
author_id :: proc(allocator := context.temp_allocator) -> string {
	s := nostr_ensure()
	ctx: sha2.Context_256
	sha2.init_256(&ctx)
	sha2.update(&ctx, transmute([]byte)s.privkey_hex)
	digest: [32]byte
	sha2.final(&ctx, digest[:])
	return strings.clone(string(hex.encode(digest[:8], context.temp_allocator)), allocator)
}

/** mutate action: nostr_key_export → {nsec, hex}. */
mutate_key_export :: proc(sock: net.TCP_Socket) {
	s := nostr_ensure()
	raw, ok := hex.decode(transmute([]byte)s.privkey_hex, context.temp_allocator)
	if !ok || len(raw) != 32 {
		respond_error(sock, "key unavailable", "500 Internal Server Error")
		return
	}
	o := core.jobj()
	o["ok"] = json.Boolean(true)
	o["nsec"] = json.String(bech32_encode("nsec", raw))
	o["hex"] = json.String(s.privkey_hex)
	respond_json(sock, json.Object(o))
}

/** mutate action: nostr_relays_set {relays: string[]}. */
mutate_relays_set :: proc(sock: net.TCP_Socket, parsed: json.Value) {
	relays_json, ok := core.json_field(parsed, "relays")
	arr, aok := relays_json.(json.Array)
	if !ok || !aok {
		respond_error(sock, "relays array required")
		return
	}
	sync.lock(&g_nostr_mu)
	defer sync.unlock(&g_nostr_mu)
	s := nostr_read()
	clear(&s.relays)
	for r in arr {
		str, sok := r.(json.String)
		if !sok do continue
		v := strings.trim_space(string(str))
		if strings.has_prefix(v, "wss://") || strings.has_prefix(v, "ws://") {
			append(&s.relays, v)
		}
	}
	nostr_write(s)
	o := core.jobj()
	o["ok"] = json.Boolean(true)
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	o["relays"] = json.Array(relays)
	respond_json(sock, json.Object(o))
}

