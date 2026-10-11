#+build !js
package core

// `create` with `blocks` and `blocks_append`: a whole object (fields + body
// tree) in ONE Change, idempotent under fixed ids, bounded to one relay part.

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:strings"
import "core:testing"

@(private = "file")
Vault :: struct {
	changes: [dynamic]Change,
	states:  map[string]^Object_State,
	clock:   i64,
	seq:     int,
}

@(private = "file")
replay :: proc(v: ^Vault) -> bool {
	v.states = make(map[string]^Object_State, context.temp_allocator)
	grouped := make(map[string][dynamic]Change, context.temp_allocator)
	for change in v.changes {
		list, seen := grouped[change.object_id]
		if !seen do list = make([dynamic]Change, context.temp_allocator)
		append(&list, change)
		grouped[change.object_id] = list
	}
	for object_id, list in grouped {
		state, ok := compute_state(list[:], context.temp_allocator)
		if !ok do return false
		ptr := new(Object_State, context.temp_allocator)
		ptr^ = state
		v.states[object_id] = ptr
	}
	return true
}

/** Plan one mutation against the vault, parent + hash its changes like a host, replay. */
@(private = "file")
apply :: proc(v: ^Vault, request: json.Object) -> (json.Value, string) {
	if v.changes == nil do v.changes = make([dynamic]Change, context.temp_allocator)
	v.clock += 1
	v.seq += 1
	payload := jobj()
	payload["action"] = request["action"]
	payload["params"] = request
	payload["timestamp"] = json.Integer(v.clock)
	payload["author"] = json.String("device-a")
	payload["id_seed"] = json.String(fmt.tprintf("seed-%d", v.seq))
	objects := make([dynamic]json.Value, context.temp_allocator)
	for _, state in v.states {
		parsed, err := json.parse(object_to_json(state, context.temp_allocator), allocator = context.temp_allocator, parse_integers = true)
		if err != nil do return nil, "state did not round trip"
		append(&objects, parsed)
	}
	payload["objects"] = json.Array(objects)
	out, mutation_error := mutation_dispatch(json.Object(payload))
	if mutation_error != "" do return nil, mutation_error
	changes_value, _ := json_field(out, "changes")
	array, _ := changes_value.(json.Array)
	for item in array {
		change, ok := change_from_json(item, context.temp_allocator)
		if !ok do return nil, "invalid change"
		if state, seen := v.states[change.object_id]; seen {
			parents := make([dynamic][]byte, context.temp_allocator)
			for head in state.heads {
				id, decoded := hex.decode(transmute([]byte)head, context.temp_allocator)
				if !decoded do return nil, "invalid head"
				append(&parents, id)
			}
			change.parent_ids = parents
		}
		digest := sha256(encode_change(change, true, context.temp_allocator))
		id := make([]byte, len(digest), context.temp_allocator)
		copy(id, digest[:])
		change.id = id
		append(&v.changes, change)
	}
	if !replay(v) do return nil, "replay failed"
	result, _ := json_field(out, "result")
	return result, ""
}

@(private = "file")
changes_of :: proc(v: ^Vault, object_id: string) -> (n: int, last: Change) {
	for c in v.changes do if c.object_id == object_id {
		n += 1
		last = c
	}
	return
}

@(private = "file")
block_of :: proc(st: ^Object_State, id: string) -> ^Block {
	for &b in st.blocks do if b.id == id do return &b
	return nil
}

@(private = "file")
roots_of :: proc(st: ^Object_State) -> [dynamic]string {
	child := make(map[string]bool, allocator = context.temp_allocator)
	for b in st.blocks do for c in b.children_ids do child[c] = true
	out := make([dynamic]string, context.temp_allocator)
	for b in st.blocks do if b.id not_in child do append(&out, b.id)
	return out
}

@(private = "file")
joined :: proc(ids: []string) -> string {
	return strings.join(ids, ",", context.temp_allocator)
}

@(private = "file")
content_text :: proc(text: string, style: i64) -> json.Value {
	t := jobj()
	t["text"] = json.String(text)
	t["style"] = json.Integer(style)
	c := jobj()
	c["text"] = json.Object(t)
	return json.Object(c)
}

@(private = "file")
content_kind :: proc(kind: string, style := i64(-1)) -> json.Value {
	inner := jobj()
	if style >= 0 do inner["style"] = json.Integer(style)
	c := jobj()
	c[kind] = json.Object(inner)
	return json.Object(c)
}

@(private = "file")
blk :: proc(list: ^[dynamic]json.Value, id: string, content: json.Value, parent := "") {
	b := jobj()
	b["id"] = json.String(id)
	b["childrenIds"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	b["content"] = content
	if parent != "" do b["parent"] = json.String(parent)
	append(list, json.Object(b))
}

/** A page body: heading, toggle with two children (one nested deeper), a 2x2 table, a closing paragraph. */
@(private = "file")
body :: proc() -> json.Array {
	l := make([dynamic]json.Value, context.temp_allocator)
	blk(&l, "h", content_text("Title", 2))
	blk(&l, "tg", content_text("Toggle", 10))
	blk(&l, "tg.a", content_text("first", 0), "tg")
	blk(&l, "tg.b", content_text("second", 6), "tg")
	blk(&l, "tg.b.x", content_text("deeper", 6), "tg.b")
	blk(&l, "t", content_kind("table"))
	blk(&l, "t.cols", content_kind("layout", LAYOUT_TABLE_COLUMNS), "t")
	blk(&l, "c1", content_kind("tableColumn"), "t.cols")
	blk(&l, "c2", content_kind("tableColumn"), "t.cols")
	blk(&l, "t.rows", content_kind("layout", LAYOUT_TABLE_ROWS), "t")
	blk(&l, "r1", content_kind("tableRow"), "t.rows")
	blk(&l, "r1-c1", content_text("a", 0), "r1")
	blk(&l, "r1-c2", content_text("b", 0), "r1")
	blk(&l, "r2", content_kind("tableRow"), "t.rows")
	blk(&l, "r2-c1", content_text("c", 0), "r2")
	blk(&l, "r2-c2", content_text("d", 0), "r2")
	blk(&l, "p", content_text("end", 0))
	return json.Array(l)
}

@(private = "file")
create_req :: proc(id: string, blocks: json.Array) -> json.Object {
	r := jobj()
	r["action"] = json.String("create")
	r["id"] = json.String(id)
	r["type_key"] = json.String("page")
	r["name"] = json.String("Imported")
	fields := jobj()
	fields["channel"] = json.Object(map_of("stringValue", json.String("space-1")))
	fields["description"] = json.Object(map_of("stringValue", json.String("from Anytype")))
	r["fields"] = json.Object(fields)
	r["blocks"] = blocks
	return json.Object(r)
}

@(private = "file")
map_of :: proc(k: string, v: json.Value) -> json.Object {
	o := jobj()
	o[k] = v
	return json.Object(o)
}

@(test)
create_with_blocks_is_one_change_and_replays_the_tree :: proc(t: ^testing.T) {
	v: Vault
	_, err := apply(&v, create_req("any-page", body()))
	testing.expect(t, err == "", err)
	n, change := changes_of(&v, "any-page")
	testing.expect_value(t, n, 1)
	// Object_Create + name + 2 fields + 17 Block_Adds, all in the one Change.
	testing.expect_value(t, len(change.ops), 21)
	st := v.states["any-page"]
	testing.expect_value(t, st.type_key, "page")
	testing.expect_value(t, joined(roots_of(st)[:]), "h,tg,t,p")
	testing.expect_value(t, joined(block_of(st, "tg").children_ids[:]), "tg.a,tg.b")
	testing.expect_value(t, joined(block_of(st, "tg.b").children_ids[:]), "tg.b.x")
	testing.expect_value(t, joined(block_of(st, "t").children_ids[:]), "t.cols,t.rows")
	testing.expect_value(t, joined(block_of(st, "t.cols").children_ids[:]), "c1,c2")
	testing.expect_value(t, joined(block_of(st, "t.rows").children_ids[:]), "r1,r2")
	testing.expect_value(t, joined(block_of(st, "r2").children_ids[:]), "r2-c1,r2-c2")
	testing.expect_value(t, block_of(st, "r2-c2").content.text.text, "d")
	testing.expect_value(t, block_of(st, "tg").content.text.style, 10)
	testing.expect_value(t, block_of(st, "t").content.kind, Content_Kind.Table)
	desc, _ := fields_get(st.fields, "description")
	testing.expect_value(t, desc.str, "from Anytype")
}

@(test)
create_with_blocks_fixed_id_twice_adds_nothing :: proc(t: ^testing.T) {
	v: Vault
	_, err := apply(&v, create_req("any-page", body()))
	testing.expect(t, err == "", err)
	before := len(v.changes)
	blocks_before := len(v.states["any-page"].blocks)
	again, err2 := apply(&v, create_req("any-page", body()))
	testing.expect(t, err2 == "", err2)
	existed, _ := json_bool(again, "existed")
	testing.expect(t, existed, "a held id answers existed")
	testing.expect_value(t, len(v.changes), before)
	testing.expect_value(t, len(v.states["any-page"].blocks), blocks_before)
}

@(test)
blocks_append_is_one_change_and_skips_what_is_there :: proc(t: ^testing.T) {
	v: Vault
	first := make([dynamic]json.Value, context.temp_allocator)
	blk(&first, "h", content_text("Title", 2))
	_, err := apply(&v, create_req("obj", json.Array(first)))
	testing.expect(t, err == "", err)

	more := make([dynamic]json.Value, context.temp_allocator)
	blk(&more, "h", content_text("Title", 2)) // already held: skipped
	blk(&more, "div", content_kind("custom"))
	blk(&more, "x", content_text("under the existing heading", 0), "h") // parent from the object
	blk(&more, "y", content_text("after", 0))
	req := jobj()
	req["action"] = json.String("blocks_append")
	req["object_id"] = json.String("obj")
	req["blocks"] = json.Array(more)
	fields := jobj()
	fields["tag"] = json.Object(map_of("stringValue", json.String("imported")))
	req["fields"] = json.Object(fields)
	out, aerr := apply(&v, json.Object(req))
	testing.expect(t, aerr == "", aerr)
	added, _ := json_int(out, "added")
	skipped, _ := json_int(out, "skipped")
	testing.expect_value(t, added, 3)
	testing.expect_value(t, skipped, 1)
	n, change := changes_of(&v, "obj")
	testing.expect_value(t, n, 2)
	testing.expect_value(t, len(change.ops), 4) // Field_Set tag + 3 Block_Adds
	st := v.states["obj"]
	testing.expect_value(t, joined(roots_of(st)[:]), "h,div,y")
	testing.expect_value(t, joined(block_of(st, "h").children_ids[:]), "x")
	tag, _ := fields_get(st.fields, "tag")
	testing.expect_value(t, tag.str, "imported")

	// Re-sending a fully applied append (no fields) commits nothing.
	req2 := jobj()
	req2["action"] = json.String("blocks_append")
	req2["object_id"] = json.String("obj")
	req2["blocks"] = json.Array(more)
	before := len(v.changes)
	out2, err2 := apply(&v, json.Object(req2))
	testing.expect(t, err2 == "", err2)
	skipped2, _ := json_int(out2, "skipped")
	testing.expect_value(t, skipped2, 4)
	testing.expect_value(t, len(v.changes), before)
}

@(test)
blocks_batch_rejects_bad_trees :: proc(t: ^testing.T) {
	v: Vault
	orphan := make([dynamic]json.Value, context.temp_allocator)
	blk(&orphan, "a", content_text("x", 0), "nowhere")
	_, err := apply(&v, create_req("o1", json.Array(orphan)))
	testing.expect(t, strings.contains(err, "parent \"nowhere\""), err)

	later := make([dynamic]json.Value, context.temp_allocator)
	blk(&later, "child", content_text("x", 0), "parent")
	blk(&later, "parent", content_text("y", 0))
	_, err = apply(&v, create_req("o2", json.Array(later)))
	testing.expect(t, err != "", "a parent must come before its children")

	dup := make([dynamic]json.Value, context.temp_allocator)
	blk(&dup, "a", content_text("x", 0))
	blk(&dup, "a", content_text("y", 0))
	_, err = apply(&v, create_req("o3", json.Array(dup)))
	testing.expect(t, strings.contains(err, "duplicate block id"), err)

	kids := make([dynamic]json.Value, context.temp_allocator)
	b := jobj()
	b["id"] = json.String("a")
	ids := make([dynamic]json.Value, context.temp_allocator)
	append(&ids, json.String("b"))
	b["childrenIds"] = json.Array(ids)
	b["content"] = content_text("x", 0)
	append(&kids, json.Object(b))
	_, err = apply(&v, create_req("o4", json.Array(kids)))
	testing.expect(t, strings.contains(err, "childrenIds"), err)

	req := jobj()
	req["action"] = json.String("blocks_append")
	req["object_id"] = json.String("missing")
	req["blocks"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	_, err = apply(&v, json.Object(req))
	testing.expect_value(t, err, "object not found")
	testing.expect_value(t, len(v.changes), 0)
}

@(test)
blocks_batch_rejects_a_change_over_one_relay_part :: proc(t: ^testing.T) {
	v: Vault
	big := make([dynamic]json.Value, context.temp_allocator)
	line := strings.repeat("x", 1000, context.temp_allocator)
	for i in 0 ..< 40 do blk(&big, fmt.tprintf("b%d", i), content_text(line, 0))
	_, err := apply(&v, create_req("big", json.Array(big)))
	testing.expect(t, strings.has_prefix(err, "change too large"), err)
	testing.expect_value(t, len(v.changes), 0)

	// The same body split in two fits: create with half, append the rest.
	half := make([dynamic]json.Value, context.temp_allocator)
	append(&half, ..big[:20])
	_, err = apply(&v, create_req("big", json.Array(half)))
	testing.expect(t, err == "", err)
	rest := make([dynamic]json.Value, context.temp_allocator)
	append(&rest, ..big[20:])
	req := jobj()
	req["action"] = json.String("blocks_append")
	req["object_id"] = json.String("big")
	req["blocks"] = json.Array(rest)
	_, err = apply(&v, json.Object(req))
	testing.expect(t, err == "", err)
	testing.expect_value(t, len(v.states["big"].blocks), 40)
	for c in v.changes do testing.expect(t, len(encode_change(c, false, context.temp_allocator)) <= MUTATION_CHANGE_MAX_BYTES, "each change fits one part")

	// An oversized append is rejected too.
	all := jobj()
	all["action"] = json.String("blocks_append")
	all["object_id"] = json.String("big")
	more := make([dynamic]json.Value, context.temp_allocator)
	for i in 0 ..< 40 do blk(&more, fmt.tprintf("m%d", i), content_text(line, 0))
	all["blocks"] = json.Array(more)
	_, err = apply(&v, json.Object(all))
	testing.expect(t, strings.has_prefix(err, "change too large"), err)
}

@(test)
create_created_at_backdates_a_fixed_id_import :: proc(t: ^testing.T) {
	v: Vault
	v.clock = 1_790_000_000_000
	req := create_req("any-old", body())
	req["created_at"] = json.Integer(1_691_744_414_000)
	_, err := apply(&v, json.Object(req))
	testing.expect(t, err == "", err)
	testing.expect_value(t, v.states["any-old"].created_at, 1_691_744_414_000)

	future := create_req("any-new", body())
	future["created_at"] = json.Integer(v.clock + 10_000)
	_, err = apply(&v, future)
	testing.expect_value(t, err, "created_at must be a past unix-ms time")

	anon := create_req("", body())
	delete_key(&anon, "id")
	anon["created_at"] = json.Integer(1_691_744_414_000)
	_, err = apply(&v, anon)
	testing.expect_value(t, err, "created_at needs a caller-chosen id")
}
