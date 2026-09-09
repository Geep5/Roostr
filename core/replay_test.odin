#+build !js
package core

import "core:encoding/json"
import "core:testing"

@(test)
replay_legacy_fixture_parity :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	fixtures_value, parse_err := json.parse(#load("replay_fixtures.json"), parse_integers = true)
	testing.expect(t, parse_err == nil, "replay fixtures must parse")
	if parse_err != nil do return
	fixtures, fixtures_ok := fixtures_value.(json.Array)
	testing.expect(t, fixtures_ok)
	if !fixtures_ok do return
	for fixture in fixtures {
		name := json_str(fixture, "name")
		expected, _ := json_field(fixture, "expected")
		wire_changes, _ := json_field(fixture, "changes")
		payload := jobj()
		payload["changes"] = wire_changes
		actual, err := replay_dispatch(json.Object(payload))
		testing.expect(t, err == "", name)
		if err != "" do continue
		testing.expect(t, string(marshal(actual)) == string(marshal(expected)), name)

		// Exercise the native entry point using the same decoded models, twice:
		// layout width normalization must not modify source snapshot fields.
		items := wire_changes.(json.Array)
		changes := make([]Change, len(items))
		for item, i in items {
			change, ok := change_from_json(item)
			testing.expect(t, ok, name)
			changes[i] = change
		}
		for repeat in 0..<2 {
			state, ok := compute_state(changes)
			native: json.Value
			if ok do native = object_to_json_value(&state)
			testing.expect(t, string(marshal(native)) == string(marshal(expected)), name)
		}

		// Input order is not replay order. Reversing the transport batch must
		// preserve FIFO Kahn ordering and timestamp-selected snapshots.
		reversed := make([dynamic]json.Value)
		for i := len(items) - 1; i >= 0; i -= 1 do append(&reversed, items[i])
		payload["changes"] = json.Array(reversed)
		actual, err = replay_dispatch(json.Object(payload))
		testing.expect(t, err == "", name)
		testing.expect(t, string(marshal(actual)) == string(marshal(expected)), name)
	}
}

@(test)
replay_rejects_invalid_boundary_inputs :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	for wire in ([]string{
		`null`,
		`{}`,
		`{"changes":{}}`,
		`{"changes":[null]}`,
		`{"changes":[{"id":"01","objectId":"a","parentIds":["01"],"ops":[],"timestamp":1,"author":""}]}`,
		`{"changes":[{"id":"01","objectId":"a","parentIds":[],"ops":[],"timestamp":1,"author":"","snapshot":{"blocks":[{"id":"a","childrenIds":["b"]},{"id":"b","childrenIds":["a"]}]}}]}`,
	}) {
		payload, parse_err := json.parse(wire)
		testing.expect(t, parse_err == nil)
		_, err := replay_dispatch(payload)
		testing.expect(t, err != "", wire)
	}
}
