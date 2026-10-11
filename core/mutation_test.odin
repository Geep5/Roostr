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
			if expected := json_str(fixture, "expected_error"); expected != "" do testing.expectf(t, err == expected, "%s: error %q", name, err)
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

// A bundled default the user vanished (a deleted property) is not seeded
// back - the guard would refuse it and take every other default with it -
// while the rest of the catalog still lands.
@(test)
mutation_seed_skips_vanished_defaults :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	payload, err := json.parse(transmute([]byte)string(`{
		"action": "seed_space_defaults",
		"params": {"channel_id": "space-aa"},
		"objects": [
			{"id": "space-aa", "typeKey": "channel", "fields": [], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []},
			{"id": "__vanished__", "typeKey": "vanish_log", "fields": [["vanished:bundled-rel-modifiedDate-space-aa", {"intValue": 5}]], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []}
		],
		"timestamp": 1234, "author": "alice", "id_seed": "seed", "key_id": 0
	}`), parse_integers = true)
	testing.expect(t, err == nil)
	result, derr := mutation_dispatch(payload)
	testing.expect_value(t, derr, "")
	seeded, skipped := 0, 0
	for change in json_array(result, "changes") {
		switch json_str(change, "objectId") {
		case "bundled-rel-modifiedDate-space-aa": skipped += 1
		case: seeded += 1
		}
	}
	testing.expect_value(t, skipped, 0)
	testing.expect(t, seeded > 0, "the rest of the catalog is seeded")
}

// Types and properties the engine stopped shipping leave every space:
// install rows folded into capabilities, descriptor cards into Skills.
@(test)
mutation_seed_deletes_retired_types_and_relations :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	payload, err := json.parse(transmute([]byte)string(`{
		"action": "seed_space_defaults",
		"params": {"channel_id": "space-aa"},
		"objects": [
			{"id": "space-aa", "typeKey": "channel", "fields": [], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []},
			{"id": "bundled-type-install-space-aa", "typeKey": "type", "fields": [["channel", {"stringValue": "space-aa"}], ["key", {"stringValue": "install"}], ["bundled", {"boolValue": true}]], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []},
			{"id": "bundled-type-descriptor-space-aa", "typeKey": "type", "fields": [["channel", {"stringValue": "space-aa"}], ["key", {"stringValue": "descriptor"}], ["bundled", {"boolValue": true}]], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []},
			{"id": "bundled-rel-install-space-aa", "typeKey": "relation", "fields": [["channel", {"stringValue": "space-aa"}], ["key", {"stringValue": "install"}], ["bundled", {"boolValue": true}]], "blocks": [], "deleted": false, "createdAt": 1, "updatedAt": 1, "heads": []}
		],
		"timestamp": 1234, "author": "alice", "id_seed": "seed", "key_id": 0
	}`), parse_integers = true)
	testing.expect(t, err == nil)
	result, derr := mutation_dispatch(payload)
	testing.expect_value(t, derr, "")
	deleted := make(map[string]bool)
	for change in json_array(result, "changes") {
		for op in json_array(change, "ops") {
			if _, ok := json_field(op, "objectDelete"); ok do deleted[json_str(change, "objectId")] = true
		}
	}
	for id in ([]string{"bundled-type-install-space-aa", "bundled-type-descriptor-space-aa", "bundled-rel-install-space-aa"}) {
		testing.expectf(t, deleted[id], "%s is deleted", id)
	}
}

// Seeding converges: once a space holds its catalog, another run over the
// state the last one produced commits nothing. Restricted pickers'
// object_types and option lists used to be re-set on every run, so every
// daemon boot and web load re-wrote and re-published them on every space.
@(test)
mutation_seed_converges :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	history := make(map[string][dynamic]Change)
	channel := Object_State{id = "space-aa", type_key = "channel"}
	request := jobj()
	request["action"] = json.String("bootstrap_space_defaults")
	committed: [4]int
	serial := 0
	for run in 0 ..< len(committed) {
		states := make(map[string]^Object_State)
		states[channel.id] = &channel
		for id, changes in history {
			state, ok := compute_state(changes[:])
			testing.expect(t, ok, id)
			states[id] = new_clone(state)
		}
		plan, err := mutation_plan(json.Object(request), Mutation_Input{states = states, timestamp = i64(1000 + run), author = "alice", id_seed = "seed"})
		testing.expect_value(t, err, "")
		committed[run] = len(plan.changes)
		for change in plan.changes {
			c := change
			serial += 1
			c.id = make([]byte, 32)
			c.id[0], c.id[1] = byte(serial >> 8), byte(serial)
			prior := history[c.object_id]
			c.parent_ids = make([dynamic][]byte)
			if len(prior) > 0 do append(&c.parent_ids, prior[len(prior) - 1].id)
			append(&prior, c)
			history[c.object_id] = prior
		}
	}
	testing.expect(t, committed[0] > 0, "the first run seeds the catalog")
	for n, i in committed[1:] do testing.expectf(t, n == 0, "run %d committed %d change(s)", i + 2, n)
}
