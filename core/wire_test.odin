#+build !js
package core

import "core:encoding/json"
import "core:testing"

// core/wire_fixtures.json was produced by the TypeScript reference
// (nostr-tools nip44 + @noble sha256/secp256k1) that the relays already carry.
// The Odin wire helpers must reproduce those bytes exactly through dispatch.
@(test)
wire_fixture_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("wire_fixtures.json"), parse_integers = true)
	testing.expect(t, err == nil)
	if err != nil do return

	call :: proc(payload: json.Value, action: string) -> (json.Value, string) {
		obj := payload.(json.Object)
		obj["action"] = json.String(action)
		return wire_dispatch(json.Object(obj))
	}

	blinds, _ := json_field(root, "blind")
	for fixture in blinds.(json.Array) {
		result, derr := call(fixture, "blind")
		testing.expectf(t, derr == "", "blind %s: %s", json_str(fixture, "name"), derr)
		testing.expectf(t, string(marshal(result)) == string(marshal(json.String(json_str(fixture, "expected")))), "blind %s", json_str(fixture, "name"))
	}

	keys, _ := json_field(root, "conversationKeys")
	for fixture in keys.(json.Array) {
		result, derr := call(fixture, "conversation_key")
		testing.expect(t, derr == "", derr)
		testing.expect(t, string(marshal(result)) == string(marshal(json.String(json_str(fixture, "expected")))), "conversation key from shared x")
	}

	seals, _ := json_field(root, "seal")
	for fixture in seals.(json.Array) {
		name := json_str(fixture, "name")
		result, derr := call(fixture, "seal")
		testing.expectf(t, derr == "", "seal %s: %s", name, derr)
		if derr != "" do continue
		expected, _ := json_field(fixture, "expected")
		testing.expectf(t, json_str(result, "gid") == json_str(expected, "gid"), "seal %s gid", name)
		got, _ := json_field(result, "parts")
		want, _ := json_field(expected, "parts")
		testing.expectf(t, string(marshal(got)) == string(marshal(want)), "seal %s parts", name)
	}

	opens, _ := json_field(root, "open")
	for fixture in opens.(json.Array) {
		name := json_str(fixture, "name")
		result, derr := call(fixture, "open")
		if wants_error, _ := json_bool(fixture, "error"); wants_error {
			testing.expectf(t, derr != "", "open %s must fail", name)
		} else {
			testing.expectf(t, derr == "" && string(marshal(result)) == string(marshal(json.String(json_str(fixture, "expected")))), "open %s", name)
		}
	}

	verifies, _ := json_field(root, "verify")
	for fixture in verifies.(json.Array) {
		name := json_str(fixture, "name")
		result, derr := call(fixture, "verify")
		if wants_error, _ := json_bool(fixture, "error"); wants_error {
			testing.expectf(t, derr != "", "verify %s must fail", name)
		} else {
			testing.expectf(t, derr == "", "verify %s: %s", name, derr)
			testing.expectf(t, json_str(result, "id") == json_str(fixture, "expectedId"), "verify %s id", name)
			change, _ := json_field(result, "change")
			testing.expectf(t, json_str(change, "id") == json_str(fixture, "expectedId"), "verify %s change id", name)
		}
	}
}

@(test)
wire_seal_rejects_oversized_change :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	payload := jobj()
	payload["action"] = json.String("seal")
	payload["change"] = json.String(string(make([]byte, WIRE_CHUNK_CHARS * WIRE_MAX_CHUNKS + 1, context.temp_allocator)))
	payload["conversationKey"] = json.String("00000000000000000000000000000000000000000000000000000000000000ff")
	payload["secret"] = json.String("00000000000000000000000000000000000000000000000000000000000000ff")
	payload["objectId"] = json.String("x")
	_, err := wire_dispatch(json.Object(payload))
	testing.expect(t, err == "change exceeds chunk limit", err)
}
