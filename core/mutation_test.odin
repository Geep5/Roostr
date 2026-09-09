#+build !js
package core

import "core:encoding/json"
import "core:fmt"
import "core:testing"

@(test)
mutation_fixture_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	value, parse_error := json.parse(#load("mutation_fixtures.json"), parse_integers = true)
	testing.expect(t, parse_error == nil)
	if parse_error != nil do return
	fixtures, ok := value.(json.Array)
	testing.expect(t, ok)
	if !ok do return
	for fixture in fixtures {
		name := json_str(fixture, "name")
		payload, _ := json_field(fixture, "payload")
		actual, err := mutation_dispatch(payload)
		want_error, _ := json_bool(fixture, "error")
		if want_error {
			testing.expect(t, err != "", name)
			continue
		}
		testing.expect(t, err == "", name)
		if err != "" do continue
		for key in ([]string{"changes", "vanish_changes"}) {
			expected_value, _ := json_field(fixture, fmt.tprintf("expected_%s", key))
			expected_array, _ := expected_value.(json.Array)
			canonical := make([dynamic]json.Value)
			for item in expected_array {
				change, valid := change_from_json(item)
				testing.expect(t, valid, name)
				append(&canonical, change_to_json(change, ordered = true))
			}
			got, _ := json_field(actual, key)
			testing.expect(t, string(marshal(got)) == string(marshal(json.Array(canonical))), fmt.tprintf("%s: %s", name, key))
		}
		for key in ([]string{"result", "vanish_ids"}) {
			expected, _ := json_field(fixture, fmt.tprintf("expected_%s", key))
			got, _ := json_field(actual, key)
			testing.expect(t, string(marshal(got)) == string(marshal(expected)), fmt.tprintf("%s: %s", name, key))
		}
	}
}
