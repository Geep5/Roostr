#+build !js
package core

import "core:encoding/hex"
import "core:encoding/json"
import "core:strings"
import "core:testing"

// Official vectors from github.com/paulmillr/nip44. get_conversation_key
// vectors need secp256k1 ECDH, which hosts provide; the HKDF half is covered
// by feeding the vector's shared secret x through nip44_conversation_key.
@(test)
nip44_official_vectors :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("nip44_vectors.json"), parse_integers = true)
	testing.expect(t, err == nil)
	if err != nil do return
	v2, _ := json_field(root, "v2")
	valid, _ := json_field(v2, "valid")
	invalid, _ := json_field(v2, "invalid")

	unhex :: proc(s: string) -> []byte {
		bytes, _ := hex.decode(transmute([]byte)s, context.temp_allocator)
		return bytes
	}
	sha_hex :: proc(data: []byte) -> string {
		digest := sha256(data)
		return hex_id(digest[:], context.temp_allocator)
	}

	padded, _ := json_field(valid, "calc_padded_len")
	for pair in padded.(json.Array) {
		cells := pair.(json.Array)
		testing.expectf(t, nip44_padded_len(int(cells[0].(i64))) == int(cells[1].(i64)), "padded_len(%v)", cells[0])
	}

	round_trips, _ := json_field(valid, "encrypt_decrypt")
	for fixture in round_trips.(json.Array) {
		key := unhex(json_str(fixture, "conversation_key"))
		payload, ok := nip44_encrypt(json_str(fixture, "plaintext"), key, unhex(json_str(fixture, "nonce")))
		testing.expect(t, ok, "encrypt vector")
		testing.expectf(t, payload == json_str(fixture, "payload"), "encrypt payload mismatch for %q", json_str(fixture, "plaintext"))
		plaintext, dok := nip44_decrypt(json_str(fixture, "payload"), key)
		testing.expect(t, dok, "decrypt vector")
		testing.expectf(t, plaintext == json_str(fixture, "plaintext"), "decrypt plaintext mismatch")
	}

	long, _ := json_field(valid, "encrypt_decrypt_long_msg")
	for fixture in long.(json.Array) {
		repeat, _ := json_int(fixture, "repeat")
		plaintext := strings.repeat(json_str(fixture, "pattern"), int(repeat), context.temp_allocator)
		testing.expect(t, sha_hex(transmute([]byte)plaintext) == json_str(fixture, "plaintext_sha256"))
		key := unhex(json_str(fixture, "conversation_key"))
		payload, ok := nip44_encrypt(plaintext, key, unhex(json_str(fixture, "nonce")))
		testing.expect(t, ok, "encrypt long vector")
		testing.expect(t, sha_hex(transmute([]byte)payload) == json_str(fixture, "payload_sha256"), "long payload digest")
		back, dok := nip44_decrypt(payload, key)
		testing.expect(t, dok && back == plaintext, "long round trip")
	}

	lengths, _ := json_field(invalid, "encrypt_msg_lengths")
	key: [32]byte
	for length in lengths.(json.Array) {
		plaintext := strings.repeat("a", int(length.(i64)), context.temp_allocator)
		_, ok := nip44_encrypt(plaintext, key[:], key[:])
		testing.expectf(t, !ok, "plaintext length %v must be rejected", length)
	}

	bad, _ := json_field(invalid, "decrypt")
	for fixture in bad.(json.Array) {
		_, ok := nip44_decrypt(json_str(fixture, "payload"), unhex(json_str(fixture, "conversation_key")))
		testing.expectf(t, !ok, "must reject: %s", json_str(fixture, "note"))
	}

	// Shared-space keys are used raw; personal keys come from ECDH x via HKDF,
	// which must reject anything but a 32-byte x.
	zero: [32]byte
	_, dok := nip44_conversation_key(zero[:])
	testing.expect(t, dok)
	_, short_ok := nip44_conversation_key(zero[:31])
	testing.expect(t, !short_ok)
}
