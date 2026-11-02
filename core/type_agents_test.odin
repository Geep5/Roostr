#+build !js
package core

import "core:encoding/json"
import "core:strings"
import "core:testing"

@(private = "file")
TYPE_AGENT_OBJECTS :: `[
	{"id":"t-pub","typeKey":"type","fields":[["key",{"stringValue":"game_publisher"}],["channel",{"stringValue":"s"}],["agent",{"valuesValue":{"items":[{"linkValue":{"relationKey":"agent","targetId":"space-agent"}}]}}]],"blocks":[],"deleted":false,"createdAt":1,"updatedAt":1,"heads":[]},
	{"id":"p1","typeKey":"game_publisher","fields":[["channel",{"stringValue":"s"}],["agent",{"valuesValue":{"items":[{"linkValue":{"relationKey":"agent","targetId":"space-agent"}}]}}]],"blocks":[],"deleted":false,"createdAt":2,"updatedAt":2,"heads":[]},
	{"id":"p2","typeKey":"game_publisher","fields":[["channel",{"stringValue":"s"}]],"blocks":[],"deleted":false,"createdAt":3,"updatedAt":3,"heads":[]},
	{"id":"p-other-space","typeKey":"game_publisher","fields":[["channel",{"stringValue":"elsewhere"}]],"blocks":[],"deleted":false,"createdAt":4,"updatedAt":4,"heads":[]},
	{"id":"g1","typeKey":"game","fields":[["channel",{"stringValue":"s"}]],"blocks":[],"deleted":false,"createdAt":5,"updatedAt":5,"heads":[]}
]`

/** The plan's changes as one JSON text per object id. */
@(private = "file")
type_agent_run :: proc(t: ^testing.T, action: string, params: string) -> map[string]string {
	src := strings.concatenate({`{"action":"`, action, `","params":`, params, `,"objects":`, TYPE_AGENT_OBJECTS, `,"timestamp":10,"author":"me","id_seed":"new","key_id":0}`}, context.temp_allocator)
	payload, err := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	testing.expect(t, err == nil)
	out, merr := mutation_dispatch(payload)
	testing.expectf(t, merr == "", "mutation: %s", merr)
	changes, _ := json_field(out, "changes")
	by := make(map[string]string, context.temp_allocator)
	for c in changes.(json.Array) do by[json_str(c, "objectId")] = string(marshal(c))
	return by
}

@(test)
agents_added_to_a_type_join_every_object_of_it :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	by := type_agent_run(t, "set_field", `{"object_id":"t-pub","key":"agent","value":{"valuesValue":{"items":[{"linkValue":{"relationKey":"agent","targetId":"space-agent"}},{"linkValue":{"relationKey":"agent","targetId":"publisher-agent"}}]}}}`)
	testing.expect(t, strings.contains(by["p1"], `"space-agent"`) && strings.contains(by["p1"], `"publisher-agent"`), by["p1"])
	testing.expect(t, strings.contains(by["p2"], `"publisher-agent"`) && !strings.contains(by["p2"], `"space-agent"`), "only what was added")
	_, other := by["p-other-space"]
	_, game := by["g1"]
	testing.expect(t, !other && !game, "another space's publishers and other types are untouched")
}

@(test)
agents_removed_from_a_type_leave_its_objects :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	by := type_agent_run(t, "delete_field", `{"object_id":"t-pub","key":"agent"}`)
	testing.expect(t, strings.contains(by["p1"], `fieldDelete`), by["p1"])
	_, p2 := by["p2"]
	testing.expect(t, !p2, "nothing to take off")
}

@(test)
a_new_object_starts_with_its_types_agents :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	by := type_agent_run(t, "create", `{"type_key":"game_publisher","name":"Capcom","fields":{"channel":{"stringValue":"s"},"agent":{"valuesValue":{"items":[{"linkValue":{"relationKey":"agent","targetId":"mine"}}]}}}}`)
	created := ""
	for _, c in by do created = c
	testing.expect(t, strings.contains(created, `"mine"`) && strings.contains(created, `"space-agent"`), created)
	testing.expect(t, strings.index(created, `"mine"`) < strings.index(created, `"space-agent"`), "its own first")
}
