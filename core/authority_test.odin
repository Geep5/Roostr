#+build !js
package core

import "core:encoding/json"
import "core:testing"

// core/authority_fixtures.json is the shared-space authority contract every
// replica enforces (browser, daemon, iOS): who may write what into a space,
// and how the vanish ledger is read. Expectations follow the documented
// rules, not any one prior implementation.
@(test)
authority_fixture_contract :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("authority_fixtures.json"), parse_integers = true)
	testing.expect(t, err == nil)
	if err != nil do return

	cases, _ := json_field(root, "authorize")
	for fixture in cases.(json.Array) {
		name := json_str(fixture, "name")
		payload := fixture.(json.Object)
		payload["action"] = json.String("authorize")
		result, derr := sync_dispatch(json.Object(payload))
		if expected_error := json_str(fixture, "error"); expected_error != "" {
			testing.expectf(t, derr == expected_error, "%s: expected error %q, got %q", name, expected_error, derr)
			continue
		}
		testing.expectf(t, derr == "", "%s: %s", name, derr)
		if derr != "" do continue
		want_ok, _ := json_bool(fixture, "ok")
		got_ok, _ := json_bool(result, "ok")
		testing.expectf(t, got_ok == want_ok, "%s: ok=%v reason=%q", name, got_ok, json_str(result, "reason"))
		testing.expectf(t, json_str(result, "reason") == json_str(fixture, "reason"), "%s: reason %q", name, json_str(result, "reason"))
	}

	ledgers, _ := json_field(root, "vanished")
	for fixture in ledgers.(json.Array) {
		name := json_str(fixture, "name")
		payload := fixture.(json.Object)
		payload["action"] = json.String("vanished")
		result, derr := sync_dispatch(json.Object(payload))
		testing.expectf(t, derr == "", "%s: %s", name, derr)
		expected, _ := json_field(fixture, "expected")
		// Map iteration order is unspecified; compare as sorted canonical text.
		testing.expectf(t, sorted_items(result) == sorted_items(expected), "%s: %s", name, string(marshal(result)))
	}
}

@(test)
authority_member_npub_matches_hex_signer :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	signer := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	raw := make([]byte, 32)
	for i in 0 ..< 32 do raw[i] = 0xbb
	npub := bech32_encode("npub", raw)
	testing.expect(t, pubkey_hex(npub) == signer, npub)
	testing.expect(t, pubkey_hex("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") == signer)
	testing.expect(t, pubkey_hex("npub1garbage") == "")
}

@(private = "file")
sorted_items :: proc(v: json.Value) -> string {
	items, ok := v.(json.Array)
	if !ok do return "<not array>"
	texts := make([dynamic]string, context.temp_allocator)
	for item in items do append(&texts, string(marshal(item)))
	for i in 0 ..< len(texts) do for j in i + 1 ..< len(texts) do if texts[j] < texts[i] do texts[i], texts[j] = texts[j], texts[i]
	out := make([dynamic]byte, context.temp_allocator)
	for text in texts { append(&out, ..transmute([]byte)text); append(&out, '\n') }
	return string(out[:])
}
