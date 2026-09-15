#+build !js
package core

import "core:encoding/json"
import "core:testing"

// core/serving_fixtures.json is the per-object serving contract: given the
// object, its space, and the machine roster, which machine does the work and
// why. Every host (harness, website, iOS) calls this and none re-derives it.
@(test)
serving_fixture_contract :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	root, err := json.parse(#load("serving_fixtures.json"), parse_integers = true)
	testing.expect(t, err == nil)
	if err != nil do return

	cases, _ := json_field(root, "resolve")
	for fixture in cases.(json.Array) {
		name := json_str(fixture, "name")
		payload := fixture.(json.Object)
		payload["action"] = json.String("resolve")
		result, derr := serving_dispatch(json.Object(payload))
		if expected_error := json_str(fixture, "error"); expected_error != "" {
			testing.expectf(t, derr == expected_error, "%s: expected error %q, got %q", name, expected_error, derr)
			continue
		}
		testing.expectf(t, derr == "", "%s: %s", name, derr)
		if derr != "" do continue
		expected, _ := json_field(fixture, "expected")
		for key in ([]string{"machineId", "reason", "requires", "candidates"}) {
			got, _ := json_field(result, key)
			want, _ := json_field(expected, key)
			testing.expectf(t, string(marshal(got)) == string(marshal(want)), "%s: %s = %s, want %s", name, key, string(marshal(got)), string(marshal(want)))
		}
	}
}
