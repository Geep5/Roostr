#+build !js
package core

// The hidden `links` property mirrors the body's link and file blocks, set
// in the same Change that edits the blocks (mutation_sync_links).

import "core:encoding/json"
import "core:fmt"
import "core:strings"
import "core:testing"

@(private = "file")
Vault :: struct {
	changes: [dynamic]Change,
	states:  map[string]^Object_State,
	seq:     int,
}

/** Plan one mutation, append its changes (parented on the current heads), replay. */
@(private = "file")
apply :: proc(v: ^Vault, request: json.Object) -> (planned: [dynamic]Change, err: string) {
	if v.changes == nil do v.changes = make([dynamic]Change, context.temp_allocator)
	if v.states == nil do v.states = make(map[string]^Object_State, context.temp_allocator)
	v.seq += 1
	plan, perr := mutation_plan(json.Object(request), Mutation_Input{states = v.states, timestamp = i64(1000 + v.seq), author = "alice", id_seed = fmt.tprintf("seed-%d", v.seq)})
	if perr != "" do return nil, perr
	planned = make([dynamic]Change, context.temp_allocator)
	for change in plan.changes {
		c := change
		c.parent_ids = make([dynamic][]byte, context.temp_allocator)
		for prev in v.changes do if prev.object_id == c.object_id {
			clear(&c.parent_ids)
			append(&c.parent_ids, prev.id)
		}
		digest := sha256(encode_change(c, true, context.temp_allocator))
		id := make([]byte, len(digest), context.temp_allocator)
		copy(id, digest[:])
		c.id = id
		append(&v.changes, c)
		append(&planned, c)
		list := make([dynamic]Change, context.temp_allocator)
		for x in v.changes do if x.object_id == c.object_id do append(&list, x)
		state, ok := compute_state(list[:], context.temp_allocator)
		if !ok do return nil, "replay failed"
		ptr := new(Object_State, context.temp_allocator)
		ptr^ = state
		v.states[c.object_id] = ptr
	}
	return planned, ""
}

@(private = "file")
links_of :: proc(v: ^Vault, id: string) -> string {
	value, ok := fields_get(v.states[id].fields, "links")
	if !ok do return "<none>"
	out := make([dynamic]string, context.temp_allocator)
	for item in value.items do append(&out, fmt.tprintf("%s:%s", item.link_target, item.link_relation))
	return strings.join(out[:], ",", context.temp_allocator)
}

@(private = "file")
links_ops :: proc(c: Change) -> (sets: int, deletes: int) {
	for op in c.ops {
		if op.kind == .Field_Set && op.key == "links" do sets += 1
		if op.kind == .Field_Delete && op.key == "links" do deletes += 1
	}
	return
}

@(private = "file")
custom_block :: proc(id: string, content_type: string, meta_key: string, meta_value: string) -> json.Value {
	meta := jobj()
	meta[meta_key] = json.String(meta_value)
	custom := jobj()
	custom["contentType"] = json.String(content_type)
	custom["meta"] = json.Object(meta)
	content := jobj()
	content["custom"] = json.Object(custom)
	b := jobj()
	b["id"] = json.String(id)
	b["content"] = json.Object(content)
	return json.Object(b)
}

@(private = "file")
link_block :: proc(id: string, target: string) -> json.Value { return custom_block(id, "link", "target", target) }

@(private = "file")
file_block :: proc(id: string, file_id: string) -> json.Value { return custom_block(id, "file", "fileId", file_id) }

@(private = "file")
text_block :: proc(id: string, text: string) -> json.Value {
	t := jobj()
	t["text"] = json.String(text)
	content := jobj()
	content["text"] = json.Object(t)
	b := jobj()
	b["id"] = json.String(id)
	b["content"] = json.Object(content)
	return json.Object(b)
}

@(private = "file")
req :: proc(action: string, object_id := "") -> json.Object {
	r := jobj()
	r["action"] = json.String(action)
	if object_id != "" do r["object_id"] = json.String(object_id)
	return json.Object(r)
}

@(private = "file")
create_page :: proc(t: ^testing.T, v: ^Vault, id: string, blocks: []json.Value = nil) -> Change {
	r := req("create")
	r["id"] = json.String(id)
	r["type_key"] = json.String("page")
	if blocks != nil {
		list := make([dynamic]json.Value, context.temp_allocator)
		append(&list, ..blocks)
		r["blocks"] = json.Array(list)
	}
	planned, err := apply(v, r)
	testing.expect(t, err == "", err)
	return planned[0]
}

@(private = "file")
add_block :: proc(t: ^testing.T, v: ^Vault, object_id: string, block: json.Value) -> Change {
	r := req("block_add", object_id)
	r["block"] = block
	planned, err := apply(v, r)
	testing.expect(t, err == "", err)
	testing.expect_value(t, len(planned), 1)
	return planned[0]
}

@(test)
links_follow_link_blocks_in_the_same_change :: proc(t: ^testing.T) {
	v: Vault
	create_page(t, &v, "p")
	testing.expect_value(t, links_of(&v, "p"), "<none>")

	c := add_block(t, &v, "p", link_block("l1", "target-a"))
	sets, deletes := links_ops(c)
	testing.expect_value(t, deletes, 0)
	testing.expect_value(t, sets, 1)
	testing.expect_value(t, links_of(&v, "p"), "target-a:links")

	// A file block counts; order is the body's, duplicates once.
	add_block(t, &v, "p", file_block("f1", "file-b"))
	add_block(t, &v, "p", link_block("l2", "target-a"))
	testing.expect_value(t, links_of(&v, "p"), "target-a:links,file-b:links")

	// A plain edit when links already match adds nothing.
	plain := add_block(t, &v, "p", text_block("t1", "hello"))
	sets, deletes = links_ops(plain)
	testing.expect_value(t, sets + deletes, 0)
	testing.expect_value(t, len(plain.ops), 1)

	// Moving the file block first reorders links.
	mv := req("block_move", "p")
	mv["block_id"] = json.String("f1")
	mv["target_id"] = json.String("l1")
	mv["position"] = json.Integer(POS_TOP)
	_, err := apply(&v, mv)
	testing.expect(t, err == "", err)
	testing.expect_value(t, links_of(&v, "p"), "file-b:links,target-a:links")

	// Removing one of two blocks to the same target keeps it.
	rm := req("block_remove", "p")
	rm["block_id"] = json.String("l1")
	planned, rerr := apply(&v, rm)
	testing.expect(t, rerr == "", rerr)
	sets, deletes = links_ops(planned[0])
	testing.expect_value(t, sets + deletes, 0)
	testing.expect_value(t, links_of(&v, "p"), "file-b:links,target-a:links")

	// Retargeting a link block via update follows.
	up := req("block_update", "p")
	up["block_id"] = json.String("l2")
	up_content, _ := json_field(link_block("l2", "target-c"), "content")
	up["content"] = up_content
	_, uerr := apply(&v, up)
	testing.expect(t, uerr == "", uerr)
	testing.expect_value(t, links_of(&v, "p"), "file-b:links,target-c:links")

	// Removing every link block clears the property.
	for id in ([]string{"f1", "l2"}) {
		r := req("block_remove", "p")
		r["block_id"] = json.String(id)
		_, e := apply(&v, r)
		testing.expect(t, e == "", e)
	}
	testing.expect_value(t, links_of(&v, "p"), "<none>")
	last := v.changes[len(v.changes) - 1]
	_, deletes = links_ops(last)
	testing.expect_value(t, deletes, 1)
}

@(test)
links_stale_property_is_fixed_by_the_next_block_edit :: proc(t: ^testing.T) {
	v: Vault
	create_page(t, &v, "p", {link_block("l1", "x")})
	set := req("set_field", "p")
	set["key"] = json.String("links")
	value := jobj()
	value["valuesValue"] = json.Object(jobj())
	set["value"] = json.Object(value)
	_, err := apply(&v, set)
	testing.expect(t, err == "", err)
	testing.expect_value(t, links_of(&v, "p"), "")
	add_block(t, &v, "p", text_block("t", "plain"))
	testing.expect_value(t, links_of(&v, "p"), "x:links")
}

@(test)
links_ride_create_and_blocks_append :: proc(t: ^testing.T) {
	v: Vault
	created := create_page(t, &v, "p", {text_block("h", "Title"), link_block("l1", "a"), file_block("f1", "b"), link_block("l2", "a")})
	sets, _ := links_ops(created)
	testing.expect_value(t, sets, 1)
	testing.expect_value(t, links_of(&v, "p"), "a:links,b:links")

	// A create with only plain blocks writes no links.
	plain := create_page(t, &v, "q", {text_block("h", "Title")})
	sets, _ = links_ops(plain)
	testing.expect_value(t, sets, 0)

	app := req("blocks_append", "p")
	more := make([dynamic]json.Value, context.temp_allocator)
	append(&more, link_block("l1", "a"), link_block("l3", "c"))
	app["blocks"] = json.Array(more)
	planned, err := apply(&v, app)
	testing.expect(t, err == "", err)
	testing.expect_value(t, len(planned), 1)
	testing.expect_value(t, links_of(&v, "p"), "a:links,b:links,c:links")

	// Re-appending what is there commits nothing.
	again, aerr := apply(&v, app)
	testing.expect(t, aerr == "", aerr)
	testing.expect_value(t, len(again), 0)
}
