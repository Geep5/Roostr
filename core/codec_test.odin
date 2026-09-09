#+build !js
package core

import "core:encoding/json"
import "core:encoding/hex"
import "core:testing"

// Fixed legacy-wire goldens are shared with the browser WASM parity script.
// Expected bytes and hashes are never produced by the codec under test.
@(test)
codec_canonical_fixture_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	value, err := json.parse(#load("codec_fixtures.json"))
	testing.expect(t, err == nil)
	if err != nil do return
	fixtures := value.(json.Array)
	for fixture in fixtures {
		name := json_str(fixture, "name")
		if malformed := json_str(fixture, "malformedBytesHex"); malformed != "" {
			original, _ := hex.decode(transmute([]byte)malformed)
			_, accepted := decode_change(original)
			testing.expect(t, !accepted, "original malformed golden must remain rejected")
		}
		bytes, bytes_ok := hex.decode(transmute([]byte)json_str(fixture, "bytesHex"))
		testing.expect(t, bytes_ok, name)
		change, ok := decode_change(bytes)
		testing.expect(t, ok, name)
		if !ok do continue
		testing.expect(t, hex_id(encode_change(change)) == json_str(fixture, "bytesHex"), name)
		preimage := encode_change(change, true)
		testing.expect(t, hex_id(preimage) == json_str(fixture, "preimageHex"), name)
		digest := sha256(preimage)
		testing.expect(t, hex_id(digest[:]) == json_str(fixture, "id"), name)

		// Ordered maps must survive an unordered JSON marshal/parse boundary.
		transport := marshal(change_to_json(change, ordered = true))
		parsed, parse_err := json.parse(transport)
		testing.expect(t, parse_err == nil, name)
		roundtrip, roundtrip_ok := change_from_json(parsed)
		testing.expect(t, roundtrip_ok, name)
		testing.expect(t, hex_id(encode_change(roundtrip)) == json_str(fixture, "bytesHex"), name)
		payload := jobj()
		payload["action"], payload["change"] = json.String("hash"), parsed
		result, dispatch_err := codec_dispatch(json.Object(payload))
		testing.expect(t, dispatch_err == "", name)
		result_id, result_ok := result.(json.String)
		testing.expect(t, result_ok && string(result_id) == json_str(fixture, "id"), name)
	}
}

@(test)
codec_rejects_malformed_nested_messages :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	for wire in ([]string{
		"00",                         // illegal field zero
		"0a80",                       // unterminated length
		"22021a01",                   // FieldSet nested length exceeds Operation
		"22041a021201",               // Value nested length exceeds FieldSet
		"3a032a0100",                 // snapshot block contains field zero
		"22091a0712051900000000",     // truncated nested fixed64
		"22020a01",                   // malformed ObjectCreate
		"3a023200",                   // snapshot bool has wrong wire type
		"2880808080808080808002",     // overflowing varint
		"0affffffffffffffffff01",     // length cannot wrap signed int
	}) {
		bytes, _ := hex.decode(transmute([]byte)wire)
		_, ok := decode_change(bytes)
		testing.expect(t, !ok, wire)
	}
}

// ROOSTR-PROTO-001: a length-delimited repeated field is ~2 wire bytes
// per element but allocates a full model struct, a ~425x amplification.
// Element caps reject such payloads through the normal decode error path.
@(test)
codec_rejects_over_capped_repeated_fields :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator

	// Change.ops (field 4) capped at MAX_DECODE_ITEMS.
	over: Writer
	over.buf = make([dynamic]byte, context.temp_allocator)
	for _ in 0 ..< MAX_DECODE_ITEMS + 1 do write_len_prefixed(&over, 4, {})
	_, ok := decode_change(over.buf[:])
	testing.expect(t, !ok, "ops beyond the decode cap must be rejected")

	at: Writer
	at.buf = make([dynamic]byte, context.temp_allocator)
	for _ in 0 ..< MAX_DECODE_ITEMS do write_len_prefixed(&at, 4, {})
	_, ok = decode_change(at.buf[:])
	testing.expect(t, ok, "ops at the decode cap must still decode")

	// Block.children_ids (field 2) capped at MAX_DECODE_REFS, nested
	// inside a snapshot block to exercise the recursive check.
	blk: Writer
	blk.buf = make([dynamic]byte, context.temp_allocator)
	write_string_field(&blk, 1, "b")
	for _ in 0 ..< MAX_DECODE_REFS + 1 do write_string_field(&blk, 2, "x")
	snap: Writer
	snap.buf = make([dynamic]byte, context.temp_allocator)
	write_len_prefixed(&snap, 5, blk.buf[:])
	change: Writer
	change.buf = make([dynamic]byte, context.temp_allocator)
	write_len_prefixed(&change, 7, snap.buf[:])
	_, ok = decode_change(change.buf[:])
	testing.expect(t, !ok, "children_ids beyond the decode cap must be rejected")
}
