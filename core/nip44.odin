package core

// NIP-44 v2 payload encryption (https://github.com/nostr-protocol/nips/blob/master/44.md).
// The conversation key is an input: hosts derive it from a secp256k1 ECDH
// shared x (personal sync) via conversation_key, or use a raw 32-byte space
// key directly (shared spaces). Verified against core/nip44_vectors.json.

import "core:crypto"
import "core:crypto/chacha20"
import "core:crypto/hash"
import "core:crypto/hkdf"
import "core:crypto/hmac"
import "core:encoding/base64"

NIP44_VERSION :: 0x02
NIP44_MIN_PLAINTEXT :: 1
NIP44_MAX_PLAINTEXT :: 65535
NIP44_KEY_SIZE :: 32
NIP44_NONCE_SIZE :: 32
NIP44_MAC_SIZE :: 32
// version + nonce + minimum padded block (2-byte length + 32) + mac.
NIP44_MIN_PAYLOAD :: 1 + NIP44_NONCE_SIZE + 2 + 32 + NIP44_MAC_SIZE
// The largest plaintext pads to 65536 bytes.
NIP44_MAX_PAYLOAD :: 1 + NIP44_NONCE_SIZE + 2 + 65536 + NIP44_MAC_SIZE

// HKDF-extract of the ECDH shared x coordinate with the fixed spec salt.
nip44_conversation_key :: proc(shared_x: []byte) -> ([NIP44_KEY_SIZE]byte, bool) {
	key: [NIP44_KEY_SIZE]byte
	if len(shared_x) != 32 do return key, false
	hkdf.extract(.SHA256, transmute([]byte)string("nip44-v2"), shared_x, key[:])
	return key, true
}

nip44_padded_len :: proc(unpadded: int) -> int {
	if unpadded <= 32 do return 32
	next_power := 1
	for next_power < unpadded do next_power <<= 1
	chunk := next_power <= 256 ? 32 : next_power / 8
	return chunk * ((unpadded - 1) / chunk + 1)
}

Nip44_Message_Keys :: struct {
	chacha_key:   [32]byte,
	chacha_nonce: [12]byte,
	hmac_key:     [32]byte,
}

nip44_message_keys :: proc(conversation_key, nonce: []byte) -> Nip44_Message_Keys {
	keys: Nip44_Message_Keys
	material: [76]byte
	hkdf.expand(.SHA256, conversation_key, nonce, material[:])
	copy(keys.chacha_key[:], material[0:32])
	copy(keys.chacha_nonce[:], material[32:44])
	copy(keys.hmac_key[:], material[44:76])
	crypto.zero_explicit(&material, len(material))
	return keys
}

// Returns the base64 payload. A nil nonce draws a fresh random one; tests and
// parity fixtures pass the vector's nonce explicitly.
nip44_encrypt :: proc(plaintext: string, conversation_key: []byte, nonce: []byte = nil,
	allocator := context.allocator) -> (payload: string, ok: bool) {
	if len(conversation_key) != NIP44_KEY_SIZE do return "", false
	if len(plaintext) < NIP44_MIN_PLAINTEXT || len(plaintext) > NIP44_MAX_PLAINTEXT do return "", false
	nonce_bytes: [NIP44_NONCE_SIZE]byte
	if nonce == nil {
		crypto.rand_bytes(nonce_bytes[:])
	} else {
		if len(nonce) != NIP44_NONCE_SIZE do return "", false
		copy(nonce_bytes[:], nonce)
	}
	keys := nip44_message_keys(conversation_key, nonce_bytes[:])
	defer crypto.zero_explicit(&keys, size_of(keys))

	padded_len := nip44_padded_len(len(plaintext))
	raw := make([]byte, 1 + NIP44_NONCE_SIZE + 2 + padded_len + NIP44_MAC_SIZE, context.temp_allocator)
	raw[0] = NIP44_VERSION
	copy(raw[1:], nonce_bytes[:])
	ciphertext := raw[1 + NIP44_NONCE_SIZE:][:2 + padded_len]
	ciphertext[0] = byte(len(plaintext) >> 8)
	ciphertext[1] = byte(len(plaintext))
	copy(ciphertext[2:], transmute([]byte)plaintext)
	ctx: chacha20.Context
	chacha20.init(&ctx, keys.chacha_key[:], keys.chacha_nonce[:])
	chacha20.xor_bytes(&ctx, ciphertext, ciphertext)
	chacha20.reset(&ctx)
	mac := raw[1 + NIP44_NONCE_SIZE + 2 + padded_len:]
	hmac.sum(.SHA256, mac, raw[1:1 + NIP44_NONCE_SIZE + 2 + padded_len], keys.hmac_key[:])
	return base64.encode(raw, allocator = allocator), true
}

nip44_decrypt :: proc(payload: string, conversation_key: []byte, allocator := context.allocator) -> (plaintext: string, ok: bool) {
	if len(conversation_key) != NIP44_KEY_SIZE do return "", false
	// '#' marks a future version the client cannot read; not a base64 error.
	if len(payload) == 0 || payload[0] == '#' do return "", false
	raw, decoded := bytes_from_base64(payload, context.temp_allocator)
	if !decoded do return "", false
	if len(raw) < NIP44_MIN_PAYLOAD || len(raw) > NIP44_MAX_PAYLOAD do return "", false
	if raw[0] != NIP44_VERSION do return "", false
	nonce := raw[1:1 + NIP44_NONCE_SIZE]
	ciphertext := raw[1 + NIP44_NONCE_SIZE:len(raw) - NIP44_MAC_SIZE]
	mac := raw[len(raw) - NIP44_MAC_SIZE:]
	keys := nip44_message_keys(conversation_key, nonce)
	defer crypto.zero_explicit(&keys, size_of(keys))
	if !hmac.verify(.SHA256, mac, raw[1:len(raw) - NIP44_MAC_SIZE], keys.hmac_key[:]) do return "", false

	padded := make([]byte, len(ciphertext), context.temp_allocator)
	ctx: chacha20.Context
	chacha20.init(&ctx, keys.chacha_key[:], keys.chacha_nonce[:])
	chacha20.xor_bytes(&ctx, padded, ciphertext)
	chacha20.reset(&ctx)
	unpadded_len := int(padded[0]) << 8 | int(padded[1])
	if unpadded_len < NIP44_MIN_PLAINTEXT || unpadded_len > NIP44_MAX_PLAINTEXT do return "", false
	if len(padded) != 2 + nip44_padded_len(unpadded_len) do return "", false
	out := make([]byte, unpadded_len, allocator)
	copy(out, padded[2:2 + unpadded_len])
	return string(out), true
}
