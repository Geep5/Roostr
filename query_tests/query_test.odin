package query_tests

import "core:encoding/json"
import "core:fmt"
import "core:testing"
import "core:mem"
import "../core"

fixture :: #load("../fixtures/query-parity.json")

@(test)
query_native_and_dispatch_fixtures :: proc(t: ^testing.T) {
	data, parse_error := json.parse(fixture, parse_integers = true)
	testing.expect(t, parse_error == nil)
	if parse_error != nil do return
	defer json.destroy_value(data)
	now, _ := core.json_int(data, "nowMs")
	objects := core.json_array(data, "objects")
	states := make(map[string]^core.Object_State, context.temp_allocator)
	for object in objects {
		state, ok := core.object_from_json(object, context.temp_allocator)
		testing.expect(t, ok)
		stored := new(core.Object_State, context.temp_allocator)
		stored^ = state
		states[state.id] = stored
	}
	for c in core.json_array(data, "cases") {
		name := core.json_str(c, "name")
		body, _ := core.json_field(c, "body")
		payload := core.jobj()
		payload["objects"] = objects
		payload["body"] = body
		payload["nowMs"] = json.Integer(now)
		result, err := core.query_dispatch(json.Object(payload))
		testing.expect(t, err == "", name)
		if err != "" do continue
		records := core.json_array(result, "records")
		expected := core.json_array(c, "ids")
		total, _ := core.json_int(result, "total")
		expected_total, _ := core.json_int(c, "total")
		testing.expect(t, total == expected_total, name)
		testing.expect(t, len(records) == len(expected), name)
		for row, i in records {
			if i < len(expected) do testing.expect(t, core.json_str(row, "id") == string(expected[i].(json.String)), name)
		}
		if snippet := core.json_str(c, "snippet"); snippet != "" && len(records) > 0 {
			testing.expect(t, core.json_str(records[0], "snippet") == snippet, name)
		}
		extra: json.Value
		if set_obj, ok := states[core.json_str(body, "setId")]; ok do extra = core.resolve_set_filter(set_obj)
		matched := 0
		direct := core.run_query(states, body, f64(now), extra, context.temp_allocator, &matched)
		testing.expect(t, matched == int(total) && len(direct) == len(records), name)
		for row, i in direct {
			if i < len(records) do testing.expect(t, row.id == core.json_str(records[i], "id"), name)
		}
	}
}

// Each call destroys its request storage before the next invocation, matching
// the WASM ABI rather than accidentally letting borrowed strings survive.
cache_call :: proc(text: string, allocator := context.temp_allocator) -> (json.Value, string) {
	arena: mem.Dynamic_Arena
	mem.dynamic_arena_init(&arena)
	defer mem.dynamic_arena_destroy(&arena)
	context.allocator = mem.dynamic_arena_allocator(&arena)
	context.temp_allocator = context.allocator
	payload, parse_error := json.parse(text, parse_integers = true)
	if parse_error != nil do return nil, "invalid fixture"
	result, err := core.query_dispatch(payload)
	return json.clone_value(result, allocator), err
}

@(test)
query_cache_lifetime_and_atomic_errors :: proc(t: ^testing.T) {
	defer core.query_cache_reset()
	result, err := cache_call(`{"reset":true,"upserts":[{"id":"a","typeKey":"page","fields":{"name":{"stringValue":"Before"}},"blocks":[]}],"removed":[],"body":{},"nowMs":0}`)
	testing.expect(t, err == "")
	result, err = cache_call(`{"upserts":[],"removed":[],"body":{},"nowMs":0}`)
	testing.expect(t, err == "")
	rows := core.json_array(result, "records")
	testing.expect(t, len(rows) == 1)
	if len(rows) == 1 do testing.expect(t, core.json_str(rows[0], "name") == "Before")
	_, err = cache_call(`{"upserts":[{"id":"a","typeKey":"page","fields":{"name":{"stringValue":"After"}}},{"fields":{}}],"removed":["a"],"body":{},"nowMs":0}`)
	testing.expect(t, err != "")
	result, err = cache_call(`{"upserts":[],"removed":[],"body":{},"nowMs":0}`)
	rows = core.json_array(result, "records")
	testing.expect(t, err == "" && len(rows) == 1)
	if len(rows) == 1 do testing.expect(t, core.json_str(rows[0], "name") == "Before")
	result, err = cache_call(`{"upserts":[],"removed":["a"],"body":{},"nowMs":0}`)
	testing.expect(t, err == "" && len(core.json_array(result, "records")) == 0)
	for malformed in ([]string{`null`, `{"objects":[],"body":{}}`, `{"objects":false,"body":{},"nowMs":0}`, `{"upserts":[],"removed":[42],"body":{},"nowMs":0}`, `{"objects":[],"body":{},"nowMs":1e100}`, `{"objects":[],"body":{"limit":1e100},"nowMs":0}`}) {
		_, err = cache_call(malformed)
		testing.expect(t, err != "")
	}
	core.query_cache_reset()
	testing.expect(t, core.query_cache_bytes == 0, "reset must release every cached object allocation")
	testing.expect(t, len(core.query_pending_objects) == 0 && len(core.query_cached_objects) == 0, "reset must release pending and committed owners")
}

@(test)
query_links_lists_backlinks :: proc(t: ^testing.T) {
	// Linked three ways: a link field, a list of links, a collection's
	// members. The channel is not a link; an object never lists itself.
	objects := `[
		{"id":"target","typeKey":"page","fields":{"name":{"stringValue":"Target"},"channel":{"stringValue":"sp"}},"blocks":[]},
		{"id":"by-field","typeKey":"task","fields":{"owner":{"linkValue":{"relationKey":"owner","targetId":"target"}}},"blocks":[]},
		{"id":"by-list","typeKey":"task","fields":{"agent":{"valuesValue":{"items":[{"linkValue":{"relationKey":"agent","targetId":"other"}},{"linkValue":{"relationKey":"agent","targetId":"target"}}]}}},"blocks":[]},
		{"id":"by-collection","typeKey":"collection","fields":{"collectionIds":{"valuesValue":{"items":[{"stringValue":"target"}]}}},"blocks":[]},
		{"id":"by-channel","typeKey":"page","fields":{"channel":{"stringValue":"target"}},"blocks":[]},
		{"id":"by-text","typeKey":"page","fields":{"note":{"stringValue":"target"}},"blocks":[]}
	]`
	result, err := cache_call(fmt.tprintf(`{{"objects":%s,"body":{{"filters":[{{"key":"$links","condition":"in","value":["target"]}}]}},"nowMs":0}}`, objects))
	testing.expect(t, err == "", err)
	ids := make(map[string]bool, context.temp_allocator)
	for row in core.json_array(result, "records") do ids[core.json_str(row, "id")] = true
	testing.expectf(t, len(ids) == 3 && ids["by-field"] && ids["by-list"] && ids["by-collection"], "%v", ids)
}
