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
	_ = os.write_entire_file(nostr_settings_path(), marshal(json.Object(root)))
}

/** Settings with a key, generating one on first access. */
nostr_ensure :: proc(allocator := context.temp_allocator) -> Nostr_Settings {
	sync.lock(&g_nostr_mu)
	defer sync.unlock(&g_nostr_mu)
	s := nostr_read(allocator)
	if len(s.privkey_hex) != 64 {
		raw: [32]byte
		crypto.rand_bytes(raw[:])
		s.privkey_hex = strings.clone(string(hex.encode(raw[:], context.temp_allocator)), allocator)
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

// ── HTTP handlers ────────────────────────────────────────────────────

handle_settings :: proc(sock: net.TCP_Socket) {
	s := nostr_ensure()
	o := jobj()
	o["hasKey"] = json.Boolean(len(s.privkey_hex) == 64)
	relays := make([dynamic]json.Value, context.temp_allocator)
	for r in s.relays do append(&relays, json.String(r))
	o["relays"] = json.Array(relays)
	respond_json(sock, json.Object(o))
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
