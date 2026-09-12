package core

// BIP-173 bech32 for nsec/npub identities; shared by the authority gate
// (members are listed by npub) and the native identity commands.

import "core:strings"

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

/** Encode raw bytes under an hrp (e.g. "nsec"). */
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

/** Hex pubkey from an npub or 64-hex string; "" when neither. */
pubkey_hex :: proc(key: string, allocator := context.temp_allocator) -> string {
	lower := strings.to_lower(strings.trim_space(key), context.temp_allocator)
	if is_hex_pubkey(lower) do return strings.clone(lower, allocator)
	hrp, raw, ok := bech32_decode(lower, context.temp_allocator)
	if !ok || hrp != "npub" || len(raw) != 32 do return ""
	return hex_id(raw, allocator)
}

is_hex_pubkey :: proc(key: string) -> bool {
	if len(key) != 64 do return false
	for c in key do if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') do return false
	return true
}
