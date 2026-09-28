#+build !js
package core

import "core:encoding/json"
import "core:strings"
import "core:testing"

text_state :: proc(text: string, allocator := context.allocator) -> Object_State {
	s: Object_State
	s.blocks = make([dynamic]Block, allocator)
	b: Block
	b.id = "b1"
	b.content.kind = .Text
	b.content.text.text = text
	append(&s.blocks, b)
	return s
}

// ROOSTR-QUERY-001: to_lower expands each invalid UTF-8 byte to the
// 3-byte replacement char, so a hit index into the lowered copy can land
// past len(text). The snippet window must clamp to the original text
// instead of slicing out of bounds.
@(test)
text_snippet_clamps_lowered_offsets :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator

	// Hit stays inside the original text: snippet content is preserved.
	mild := strings.concatenate({strings.repeat("\xff", 20, context.temp_allocator), "hello NEEDLE world"}, context.temp_allocator)
	s := text_state(mild, context.temp_allocator)
	snippet := text_snippet(&s, "needle")
	testing.expect(t, strings.contains(snippet, "NEEDLE"), snippet)

	// Hit lands past len(text) in the lowered copy: previously a bounds
	// abort; now the window clamps to empty and the snippet is "".
	severe := strings.concatenate({strings.repeat("\xff", 64, context.temp_allocator), "NEEDLE rest"}, context.temp_allocator)
	s2 := text_state(severe, context.temp_allocator)
	testing.expect(t, text_snippet(&s2, "needle") == "", "clamped window must not slice out of bounds")
}

// A query's sources are types. `agent` is also the guest-list property; a
// query of Agents once returned every object with a guest instead.
@(test)
query_sources_are_types_even_when_a_property_shares_the_key :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	states := make(map[string]^Object_State)
	add :: proc(states: ^map[string]^Object_State, id, type_key: string, fields: ..Value_Entry) {
		s := new(Object_State)
		s.id = id
		s.type_key = type_key
		s.fields = make([dynamic]Value_Entry)
		s.blocks = make([dynamic]Block)
		append(&s.fields, ..fields)
		states[id] = s
	}
	add(&states, "rel-agent", "relation", Value_Entry{key = "key", value = string_value("agent")})
	add(&states, "marco", "agent", Value_Entry{key = "name", value = string_value("Marco")})
	add(&states, "plan", "task", Value_Entry{key = "agent", value = list_value({string_value("marco")})})
	add(&states, "q", "query", Value_Entry{key = "setOf", value = list_value({string_value("agent")})})
	body := jobj()
	body["setId"] = json.String("q")
	result := query_result(states, json.Object(body), 0)
	records := json_array(result, "records")
	testing.expect_value(t, len(records), 1)
	if len(records) == 1 do testing.expect_value(t, json_str(records[0], "id"), "marco")
}
