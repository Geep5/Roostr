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

// Tag and multi-value properties are lists: sorting by one must order rows by
// their values. Every list compared equal, so a sort by Customer left the
// rows in id order and the same customer never grouped together.
@(test)
query_sort_by_a_list_property_groups_its_values :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	states := make(map[string]^Object_State)
	add :: proc(states: ^map[string]^Object_State, id: string, tags: ..string) {
		s := new(Object_State)
		s.id = id
		s.type_key = "task"
		s.fields = make([dynamic]Value_Entry)
		s.blocks = make([dynamic]Block)
		items := make([dynamic]Value)
		for tag in tags do append(&items, string_value(tag))
		if len(tags) > 0 do append(&s.fields, Value_Entry{key = "customer", value = list_value(items[:])})
		states[id] = s
	}
	add(&states, "a", "Team")
	add(&states, "b", "Finance")
	add(&states, "c", "Team")
	add(&states, "d")
	add(&states, "e", "Finance")
	add(&states, "f", "Finance", "Team")
	order :: proc(states: map[string]^Object_State, dir: string) -> string {
		body := jobj()
		sort := jobj()
		sort["key"] = json.String("customer")
		sort["type"] = json.String(dir)
		sort["emptyPlacement"] = json.String("end")
		sorts := make(json.Array)
		append(&sorts, json.Object(sort))
		body["sorts"] = sorts
		ids := make([dynamic]string)
		for r in json_array(query_result(states, json.Object(body), 0), "records") do append(&ids, json_str(r, "id"))
		return strings.join(ids[:], "")
	}
	// Finance, then Finance+Team (a longer list after its prefix), then Team; empty last.
	testing.expect_value(t, order(states, "asc"), "befacd")
	testing.expect_value(t, order(states, "desc"), "acfbed")
}

// A view asks for the properties it shows (`fields`); filters and sorts still
// see every property. A big view used to ship every row's icon image.
@(test)
query_returns_only_the_requested_fields_and_still_filters_on_the_rest :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	states := make(map[string]^Object_State)
	add :: proc(states: ^map[string]^Object_State, id: string, fields: ..Value_Entry) {
		s := new(Object_State)
		s.id = id
		s.type_key = "bookmark"
		s.fields = make([dynamic]Value_Entry)
		s.blocks = make([dynamic]Block)
		append(&s.fields, ..fields)
		states[id] = s
	}
	add(&states, "a", Value_Entry{key = "name", value = string_value("Alpha")}, Value_Entry{key = "iconImage", value = string_value("data:image/png;base64,AAAA")}, Value_Entry{key = "url", value = string_value("https://a.example")})
	add(&states, "b", Value_Entry{key = "name", value = string_value("Beta")}, Value_Entry{key = "iconImage", value = string_value("data:image/png;base64,BBBB")}, Value_Entry{key = "url", value = string_value("https://b.example")})

	filter := jobj()
	filter["key"] = json.String("url")
	filter["condition"] = json.String("equal")
	filter["value"] = json.String("https://b.example")
	filters := make([dynamic]json.Value)
	append(&filters, json.Object(filter))
	keys := make([dynamic]json.Value)
	append(&keys, json.String("name"))
	body := jobj()
	body["filters"] = json.Array(filters)
	body["fields"] = json.Array(keys)

	result := query_result(states, json.Object(body), 0)
	records := json_array(result, "records")
	testing.expect_value(t, len(records), 1)
	fields := records[0].(json.Object)["fields"].(json.Object)
	testing.expect_value(t, json_str(records[0], "id"), "b")
	testing.expect_value(t, len(fields), 1)
	_, has_name := fields["name"]
	testing.expect(t, has_name, "the requested property is returned")
	_, has_icon := fields["iconImage"]
	testing.expect(t, !has_icon, "an unrequested property is not")

	// No `fields`: every property, as before.
	all := query_result(states, json.Object(jobj()), 0)
	for r in json_array(all, "records") do testing.expect_value(t, len(r.(json.Object)["fields"].(json.Object)), 3)
}

// "Repeat is (not) empty" runs in the engine: a repeat rule is a map, which
// used to read as nothing, so the app filtered it after the query - and a
// paged view came back short.
@(test)
query_filters_a_map_property_by_empty_and_not_empty :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	states := make(map[string]^Object_State)
	add :: proc(states: ^map[string]^Object_State, id: string, fields: ..Value_Entry) {
		s := new(Object_State)
		s.id = id
		s.type_key = "task"
		s.fields = make([dynamic]Value_Entry)
		s.blocks = make([dynamic]Block)
		append(&s.fields, ..fields)
		states[id] = s
	}
	rule: Value
	rule.kind = .Map
	rule.entries = make([dynamic]Value_Entry)
	append(&rule.entries, Value_Entry{key = "freq", value = string_value("day")})
	add(&states, "repeats", Value_Entry{key = "repeat", value = rule})
	add(&states, "once")
	ids := proc(states: map[string]^Object_State, condition: string) -> [dynamic]string {
		f := jobj()
		f["key"] = json.String("repeat")
		f["condition"] = json.String(condition)
		filters := make([dynamic]json.Value)
		append(&filters, json.Object(f))
		body := jobj()
		body["filters"] = json.Array(filters)
		out := make([dynamic]string)
		for r in json_array(query_result(states, json.Object(body), 0), "records") do append(&out, json_str(r, "id"))
		return out
	}
	not_empty := ids(states, "notEmpty")
	testing.expect(t, len(not_empty) == 1 && not_empty[0] == "repeats", "notEmpty finds the repeating task")
	empty := ids(states, "empty")
	testing.expect(t, len(empty) == 1 && empty[0] == "once", "empty finds the one-off task")
}

// Search ranks titles first: a text query with no sort used to come back in
// id order, so a page merely mentioning the word could bury (or, at the
// limit, cut) the object named by it.
@(test)
query_text_ranks_title_matches_first :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	states := make(map[string]^Object_State)
	add :: proc(states: ^map[string]^Object_State, id, name, body: string, updated: i64) {
		s := new(Object_State)
		s.id = id
		s.type_key = "page"
		s.updated_at = updated
		s.fields = make([dynamic]Value_Entry)
		s.blocks = make([dynamic]Block)
		if name != "" do append(&s.fields, Value_Entry{key = "name", value = string_value(name)})
		b: Block
		b.id = "b"
		b.content.kind = .Text
		b.content.text.text = body
		append(&s.blocks, b)
		states[id] = s
	}
	// Ids in reverse of the wanted order: id order alone gets it wrong.
	add(&states, "a-body-new", "Notes", "talked about the invoice", 9)
	add(&states, "b-body-old", "Other", "invoice attached", 1)
	add(&states, "c-inside", "Reinvoiced items", "", 5)
	add(&states, "d-word", "Paid invoice", "", 5)
	add(&states, "e-prefix", "Invoice 42", "", 5)
	add(&states, "f-exact", "invoice", "", 5)
	body := jobj()
	body["textQuery"] = json.String("Invoice")
	body["limit"] = json.Integer(5)
	result := query_result(states, json.Object(body), 0)
	records := json_array(result, "records")
	want := []string{"f-exact", "e-prefix", "d-word", "c-inside", "a-body-new"}
	testing.expect_value(t, len(records), len(want))
	for id, i in want do if i < len(records) do testing.expect_value(t, json_str(records[i], "id"), id)
}
