package core

// Relay wire helpers shared by every host: blinded tags, chunked NIP-44
// sealing of change bytes, opening received content, and raw-byte content
// address verification. Mirrors what RoostrWebsite/src/lib/engine/sync.ts and
// harness/src/nostrsync.ts did in TypeScript; core/wire_fixtures.json pins the
// bytes. Signing and ECDH stay with the host (secp256k1).

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"

// Keep full-sized 40k-character encrypted chunks inside the 8 MiB relay budget.
WIRE_CHUNK_CHARS :: 40_000
WIRE_MAX_CHUNKS :: 64
WIRE_TAG_LEN :: 16

// Blinded relay tag: first 16 hex chars of sha256(prefix || utf8(id)).
// Personal objects use the raw secret key as prefix; shared spaces use the
// utf8 of the space key hex, and "space:<spaceId>" as the space-wide tag.
wire_blind :: proc(prefix: []byte, id: string, allocator := context.allocator) -> string {
	buf := make([]byte, len(prefix) + len(id), context.temp_allocator)
	copy(buf, prefix)
	copy(buf[len(prefix):], transmute([]byte)string(id))
	digest := sha256(buf)
	return hex_id(digest[:8], allocator)
}

// Chunk group id: first 16 hex chars of sha256 over the full base64 text.
wire_group_id :: proc(full_base64: string, allocator := context.allocator) -> string {
	digest := sha256(transmute([]byte)full_base64)
	return hex_id(digest[:8], allocator)
}

// Lenient base64 shape check applied to decrypted parts before reassembly;
// strict decoding happens once the group is complete.
wire_part_ok :: proc(part: string) -> bool {
	if len(part) > WIRE_CHUNK_CHARS do return false
	padding := 0
	for ch in part {
		if ch == '=' {
			padding += 1
			if padding > 2 do return false
		} else if padding > 0 || !(ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '+' || ch == '/') {
			return false
		}
	}
	return true
}

// Raw wire content address: bytes must open with the 32-byte id field
// (0a 20 <id>); the address is sha256 over that field emptied (0a 00) plus
// the untouched remainder. Never re-encoded, so legacy explicit-default
// bytes keep hashing to their stored id.
wire_raw_address :: proc(bytes: []byte) -> ([32]byte, bool) {
	empty: [32]byte
	if len(bytes) < 34 || bytes[0] != 0x0a || bytes[1] != 0x20 do return empty, false
	buf := make([]byte, 2 + len(bytes) - 34, context.temp_allocator)
	buf[0], buf[1] = 0x0a, 0x00
	copy(buf[2:], bytes[34:])
	return sha256(buf), true
}

wire_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	switch action {
	case "conversation_key":
		shared_x, ok := hex_bytes(json_str(payload, "sharedX"))
		if !ok do return nil, "invalid sharedX hex"
		key, kok := nip44_conversation_key(shared_x)
		if !kok do return nil, "sharedX must be 32 bytes"
		return json.String(hex_id(key[:], context.temp_allocator)), ""
	case "encrypt":
		key, ok := hex_bytes(json_str(payload, "conversationKey"))
		if !ok do return nil, "invalid conversationKey hex"
		nonce, nok := optional_hex(payload, "nonce")
		if !nok do return nil, "invalid nonce hex"
		out, eok := nip44_encrypt(json_str(payload, "plaintext"), key, nonce, context.temp_allocator)
		if !eok do return nil, "nip44 encrypt rejected input"
		return json.String(out), ""
	case "decrypt":
		key, ok := hex_bytes(json_str(payload, "conversationKey"))
		if !ok do return nil, "invalid conversationKey hex"
		out, dok := nip44_decrypt(json_str(payload, "payload"), key, context.temp_allocator)
		if !dok do return nil, "nip44 decrypt failed"
		return json.String(out), ""
	case "blind":
		prefix, ok := blind_prefix(payload)
		if !ok do return nil, "blind needs secret hex or keyHex"
		return json.String(wire_blind(prefix, json_str(payload, "id"), context.temp_allocator)), ""
	case "seal":
		return wire_seal(payload)
	case "open":
		key, ok := hex_bytes(json_str(payload, "conversationKey"))
		if !ok do return nil, "invalid conversationKey hex"
		part, dok := nip44_decrypt(json_str(payload, "content"), key, context.temp_allocator)
		if !dok do return nil, "nip44 decrypt failed"
		if !wire_part_ok(part) do return nil, "decrypted part is not a chunk of base64"
		return json.String(part), ""
	case "verify":
		return wire_verify(payload)
	}
	return nil, "unknown wire action"
}

// Personal blinding hashes the raw secret; shared blinding hashes the key's
// hex text, matching every existing writer.
blind_prefix :: proc(payload: json.Value) -> ([]byte, bool) {
	if secret := json_str(payload, "secret"); secret != "" {
		return hex_bytes(secret)
	}
	if key_hex := json_str(payload, "keyHex"); key_hex != "" {
		return transmute([]byte)key_hex, true
	}
	return nil, false
}

// {change: base64, conversationKey: hex, secret?: hex | space?: {keyHex, spaceId}, objectId, nonce?}
// → {gid, parts: [{content, tags}]}. Hosts sign each part as a kind-1078 event.
wire_seal :: proc(payload: json.Value) -> (json.Value, string) {
	change := json_str(payload, "change")
	if change == "" do return nil, "seal needs change base64"
	key, ok := hex_bytes(json_str(payload, "conversationKey"))
	if !ok || len(key) != NIP44_KEY_SIZE do return nil, "invalid conversationKey hex"
	nonce, nok := optional_hex(payload, "nonce")
	if !nok do return nil, "invalid nonce hex"
	object_id := json_str(payload, "objectId")
	if object_id == "" do return nil, "seal needs objectId"

	tags := make([dynamic]json.Value, context.temp_allocator)
	if space, present := json_field(payload, "space"); present {
		key_hex, space_id := json_str(space, "keyHex"), json_str(space, "spaceId")
		if key_hex == "" || space_id == "" do return nil, "space needs keyHex and spaceId"
		append(&tags, tag("h", wire_blind(transmute([]byte)key_hex, object_id, context.temp_allocator)))
		append(&tags, tag("h", wire_blind(transmute([]byte)key_hex, fmt.tprintf("space:%s", space_id), context.temp_allocator)))
	} else {
		secret, sok := hex_bytes(json_str(payload, "secret"))
		if !sok || len(secret) != 32 do return nil, "seal needs secret hex or space"
		append(&tags, tag("h", wire_blind(secret, object_id, context.temp_allocator)))
	}

	count := (len(change) + WIRE_CHUNK_CHARS - 1) / WIRE_CHUNK_CHARS
	if count > WIRE_MAX_CHUNKS do return nil, "change exceeds chunk limit"
	gid := count > 1 ? wire_group_id(change, context.temp_allocator) : ""
	parts := make([dynamic]json.Value, context.temp_allocator)
	for index in 0 ..< count {
		start := index * WIRE_CHUNK_CHARS
		end := min(start + WIRE_CHUNK_CHARS, len(change))
		content, eok := nip44_encrypt(change[start:end], key, nonce, context.temp_allocator)
		if !eok do return nil, "nip44 encrypt rejected part"
		part_tags := make([dynamic]json.Value, context.temp_allocator)
		append(&part_tags, ..tags[:])
		if gid != "" do append(&part_tags, tag("c", gid, fmt.tprintf("%d", index), fmt.tprintf("%d", count)))
		part := jobj()
		part["content"] = json.String(content)
		part["tags"] = json.Array(part_tags)
		append(&parts, json.Object(part))
	}
	out := jobj()
	out["gid"] = json.String(gid)
	out["parts"] = json.Array(parts)
	return json.Object(out), ""
}

// {bytes: base64, gid?: hex16} → {id, change}. gid, when given, must match the
// base64 text exactly as reassembled; the decoded id must equal the raw address.
wire_verify :: proc(payload: json.Value) -> (json.Value, string) {
	text := json_str(payload, "bytes")
	if gid := json_str(payload, "gid"); gid != "" {
		if wire_group_id(text, context.temp_allocator) != gid do return nil, "chunk group id mismatch"
	}
	bytes, ok := bytes_from_base64(text)
	if !ok do return nil, "invalid base64 change"
	change, cok := decode_change(bytes)
	if !cok do return nil, "invalid protobuf change"
	address, aok := wire_raw_address(bytes)
	if !aok || len(change.id) != 32 || string(change.id) != string(address[:]) do return nil, "content address mismatch"
	out := jobj()
	out["id"] = json.String(hex_id(change.id, context.temp_allocator))
	out["change"] = change_to_json(change, ordered = true)
	return json.Object(out), ""
}

tag :: proc(values: ..string) -> json.Value {
	items := make([dynamic]json.Value, context.temp_allocator)
	for v in values do append(&items, json.String(v))
	return json.Array(items)
}

hex_bytes :: proc(text: string) -> ([]byte, bool) {
	if len(text) == 0 || len(text) % 2 != 0 do return nil, false
	bytes, ok := hex.decode(transmute([]byte)text, context.temp_allocator)
	return bytes, ok
}

optional_hex :: proc(payload: json.Value, key: string) -> ([]byte, bool) {
	text := json_str(payload, key)
	if text == "" do return nil, true
	return hex_bytes(text)
}
