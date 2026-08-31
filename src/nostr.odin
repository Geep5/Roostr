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
			s.privkey_hex = json_str(parsed, "privkey")
			if rv, ok := json_field(parsed, "relays"); ok {
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
	root := jobj()
	root["version"] = json.Integer(1)
	root["privkey"] = json.String(s.privkey_hex)
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	root["relays"] = json.Array(relays)
	// Private key inside — owner-only, like wallet.json.
	_ = os.write_entire_file(nostr_settings_path(), marshal(json.Object(root)), perm = {.Read_User, .Write_User})
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
		// Fresh identity ⇒ fresh install: seed the default relay set so
		// sync works out of the box.
		if len(s.relays) == 0 {
			for r in DEFAULT_RELAYS do append(&s.relays, r)
		}
		nostr_write(s)
	}
	return s
}

// ── Bech32 (NIP-19 nsec) ─────────────────────────────────────────────

BECH32_CHARSET :: "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

bech32_polymod :: proc(values: []u8) -> u32 {
	gen := [5]u32{0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3}
	chk: u32 = 1
	for v in values {
		top := chk >> 25
		chk = (chk & 0x1ffffff) << 5 ~ u32(v)
		for i in 0 ..< 5 {
			if (top >> u32(i)) & 1 == 1 do chk ~= gen[i]
		}
	}
	return chk
}

/** Encode 32 raw bytes under an hrp (e.g. "nsec"). */
bech32_encode :: proc(hrp: string, data: []byte, allocator := context.temp_allocator) -> string {
	// 8-bit → 5-bit groups, padded.
	five := make([dynamic]u8, context.temp_allocator)
	acc: u32 = 0
	bits: u32 = 0
	for b in data {
		acc = acc << 8 | u32(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			append(&five, u8(acc >> bits & 31))
		}
	}
	if bits > 0 do append(&five, u8(acc << (5 - bits) & 31))

	// Checksum over expanded hrp + data + 6 zero groups.
	expanded := make([dynamic]u8, context.temp_allocator)
	for c in hrp do append(&expanded, u8(c) >> 5)
	append(&expanded, 0)
	for c in hrp do append(&expanded, u8(c) & 31)
	append(&expanded, ..five[:])
	for _ in 0 ..< 6 do append(&expanded, 0)
	polymod := bech32_polymod(expanded[:]) ~ 1

	charset := BECH32_CHARSET
	out := strings.builder_make(allocator)
	strings.write_string(&out, hrp)
	strings.write_byte(&out, '1')
	for v in five do strings.write_byte(&out, charset[v])
	for i in 0 ..< 6 {
		strings.write_byte(&out, charset[polymod >> u32(5 * (5 - i)) & 31])
	}
	return strings.to_string(out)
}

/** Decode a bech32 string; returns (hrp, 8-bit data). Checksum-verified. */
bech32_decode :: proc(s: string, allocator := context.temp_allocator) -> (hrp: string, data: []byte, ok: bool) {
	lower := strings.to_lower(s, context.temp_allocator)
	sep := strings.last_index(lower, "1")
	if sep <= 0 || sep + 7 > len(lower) do return "", nil, false
	hrp = lower[:sep]
	charset := BECH32_CHARSET
	five := make([dynamic]u8, context.temp_allocator)
	for c in lower[sep + 1:] {
		idx := strings.index_byte(charset, u8(c))
		if idx < 0 do return "", nil, false
		append(&five, u8(idx))
	}
	// Verify checksum.
	expanded := make([dynamic]u8, context.temp_allocator)
	for c in hrp do append(&expanded, u8(c) >> 5)
	append(&expanded, 0)
	for c in hrp do append(&expanded, u8(c) & 31)
	append(&expanded, ..five[:])
	if bech32_polymod(expanded[:]) != 1 do return "", nil, false
	// 5-bit → 8-bit, dropping the 6 checksum groups.
	payload := five[:len(five) - 6]
	out := make([dynamic]u8, allocator)
	acc: u32 = 0
	bits: u32 = 0
	for v in payload {
		acc = acc << 5 | u32(v)
		bits += 5
		if bits >= 8 {
			bits -= 8
			append(&out, u8(acc >> bits & 255))
		}
	}
	return hrp, out[:], true
}

/** mutate action: nostr_key_import {key: "nsec1…" | 64-hex}. Replaces the identity. */
mutate_key_import :: proc(sock: net.TCP_Socket, parsed: json.Value) {
	raw := strings.trim_space(json_str(parsed, "key"))
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
	s.privkey_hex = priv_hex
	nostr_write(s)
	o := jobj()
	o["ok"] = json.Boolean(true)
	respond_json(sock, json.Object(o))
}

// ── HTTP handlers ────────────────────────────────────────────────────

handle_settings :: proc(sock: net.TCP_Socket) {
	s := nostr_ensure()
	o := jobj()
	o["hasKey"] = json.Boolean(len(s.privkey_hex) == 64)
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
	o := jobj()
	o["ok"] = json.Boolean(true)
	o["nsec"] = json.String(bech32_encode("nsec", raw))
	o["hex"] = json.String(s.privkey_hex)
	respond_json(sock, json.Object(o))
}

/** mutate action: nostr_relays_set {relays: string[]}. */
mutate_relays_set :: proc(sock: net.TCP_Socket, parsed: json.Value) {
	relays_json, ok := json_field(parsed, "relays")
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
	o := jobj()
	o["ok"] = json.Boolean(true)
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	o["relays"] = json.Array(relays)
	respond_json(sock, json.Object(o))
}

