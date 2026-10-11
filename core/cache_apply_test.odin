#+build !js
package core

// A committed change applied to the query cache (query_cache_apply, the
// mutation `apply` action) must leave exactly the state a full replay of the
// object's history caches: the host no longer re-sends the state after a
// local commit. The cache is process-global, so this runs inside
// corpus_contract, never on a parallel thread.

import "base:runtime"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:slice"
import "core:strings"
import "core:testing"

@(private = "file")
Apply_Host :: struct {
	changes: map[string][dynamic]Change,
	seq:     int,
}

@(private = "file")
apply_params :: proc(pairs: ..[2]string) -> json.Object {
	out := jobj()
	for p in pairs do out[p[0]] = json.String(p[1])
	return json.Object(out)
}

@(private = "file")
apply_plan :: proc(t: ^testing.T, h: ^Apply_Host, action: string, params: json.Object, absent: []string = nil) -> json.Value {
	h.seq += 1
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = params
	payload["timestamp"] = json.Integer(i64(h.seq) * 1000)
	payload["author"] = json.String("device-a")
	payload["id_seed"] = json.String(fmt.tprintf("apply-%d", h.seq))
	if absent != nil {
		values := make([dynamic]json.Value, context.temp_allocator)
		for id in absent do append(&values, json.String(id))
		payload["absent"] = json.Array(values)
	}
	out, err := mutation_dispatch(json.Object(payload))
	testing.expectf(t, err == "", "%s plans: %s", action, err)
	testing.expectf(t, len(json_array(out, "missing")) == 0, "%s names nothing the cache lacks", action)
	return out
}

/** Address `change` on `parents` as a host commits it. */
@(private = "file")
address :: proc(change: Change, parents: []string) -> Change {
	c := change
	c.parent_ids = make([dynamic][]byte, context.temp_allocator)
	for head in parents {
		id, _ := hex.decode(transmute([]byte)head, context.temp_allocator)
		append(&c.parent_ids, id)
	}
	digest := sha256(encode_change(c, true, context.temp_allocator))
	c.id = slice.clone(digest[:], context.temp_allocator)
	return c
}

@(private = "file")
cached_heads :: proc(object_id: string) -> []string {
	state, ok := query_cached_states[object_id]
	return ok ? state.heads[:] : nil
}

/** The `apply` action over one change, as a host sends it; true when applied. */
@(private = "file")
send_apply :: proc(t: ^testing.T, change: Change) -> bool {
	payload := jobj()
	payload["action"] = json.String("apply")
	changes := make([dynamic]json.Value, context.temp_allocator)
	append(&changes, change_to_json(change, context.temp_allocator, ordered = true))
	payload["changes"] = json.Array(changes)
	out, err := mutation_dispatch(json.Object(payload))
	testing.expect_value(t, err, "")
	applied := json_array(out, "applied")
	refused := json_array(out, "refused")
	testing.expect_value(t, len(applied) + len(refused), 1)
	return len(applied) == 1
}

/** The state a full replay caches: what the host's upsert used to send. */
@(private = "file")
replayed_json :: proc(state: Object_State) -> string {
	owner := new(Query_Cached_Object, runtime.default_allocator())
	defer query_cached_object_destroy(owner)
	if !query_cache_own(owner, state) do return "<own failed>"
	return fmt.tprint(string(object_to_json(&owner.state, context.temp_allocator)))
}

@(private = "file")
cached_json :: proc(object_id: string) -> string {
	state, ok := query_cached_states[object_id]
	if !ok do return "<not cached>"
	return fmt.tprint(string(object_to_json(state, context.temp_allocator)))
}

/** Commit every planned change on the cached heads, apply it, and check parity with a full replay. */
@(private = "file")
commit_apply :: proc(t: ^testing.T, h: ^Apply_Host, out: json.Value, label: string) {
	planned := json_array(out, "changes")
	testing.expectf(t, len(planned) > 0, "%s plans a change", label)
	for item in planned {
		parsed, ok := change_from_json(item, context.temp_allocator)
		testing.expect(t, ok, label)
		change := address(parsed, cached_heads(parsed.object_id))
		list := h.changes[change.object_id]
		append(&list, change)
		h.changes[change.object_id] = list
		testing.expectf(t, send_apply(t, change), "%s applies", label)
		state, replayed := compute_state(h.changes[change.object_id][:], context.temp_allocator)
		testing.expectf(t, replayed, "%s replays", label)
		testing.expectf(t, cached_json(change.object_id) == replayed_json(state), "%s: applied state equals a full replay", label)
		heads := cached_heads(change.object_id)
		testing.expectf(t, len(heads) == 1 && heads[0] == hex_id(change.id, context.temp_allocator), "%s: the cache's heads are the applied change", label)
	}
}

/** A host's query upsert of a replayed state, heads included as replay_from_base reports them. */
@(private = "file")
upsert_state :: proc(t: ^testing.T, state: ^Object_State) {
	value := object_to_json_value(state).(json.Object)
	heads := make([dynamic]json.Value, context.temp_allocator)
	for head in state.heads do append(&heads, json.String(head))
	value["heads"] = json.Array(heads)
	payload := jobj()
	payload["nowMs"] = json.Integer(1)
	upserts := make([dynamic]json.Value, context.temp_allocator)
	append(&upserts, json.Value(value))
	payload["upserts"] = json.Array(upserts)
	payload["removed"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	_, err := dispatch("query", json.Object(payload))
	testing.expect_value(t, err, "")
}

@(private = "file")
text_content :: proc(text: string) -> json.Value {
	inner := jobj()
	inner["text"] = json.String(text)
	c := jobj()
	c["text"] = json.Object(inner)
	return json.Object(c)
}

@(private = "file")
body_block :: proc(list: ^[dynamic]json.Value, id: string, content: json.Value, parent := "") {
	b := jobj()
	b["id"] = json.String(id)
	b["childrenIds"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	b["content"] = content
	if parent != "" do b["parent"] = json.String(parent)
	append(list, json.Object(b))
}

@(private = "file")
kind_content :: proc(kind: string) -> json.Value {
	c := jobj()
	c[kind] = json.Object(jobj())
	return json.Object(c)
}

@(private = "file")
with :: proc(params: json.Object, key: string, value: json.Value) -> json.Object {
	p := params
	p[key] = value
	return p
}

@(private = "file")
string_field :: proc(text: string) -> json.Value {
	v := jobj()
	v["stringValue"] = json.String(text)
	return json.Object(v)
}

cache_apply_contract :: proc(t: ^testing.T) {
	query_cache_reset()
	defer query_cache_reset()
	h := Apply_Host{changes = make(map[string][dynamic]Change, context.temp_allocator)}

	// Genesis changes need no cached state: a space, then an imported page
	// created under a fixed id with its whole body in one change.
	commit_apply(t, &h, apply_plan(t, &h, "create", apply_params({"type_key", "channel"}, {"name", "Home"})), "create space")
	blocks := make([dynamic]json.Value, context.temp_allocator)
	body_block(&blocks, "h", text_content("Title"))
	body_block(&blocks, "tg", text_content("Toggle"))
	body_block(&blocks, "tg.a", text_content("first"), "tg")
	body_block(&blocks, "tg.b", text_content("second"), "tg")
	body_block(&blocks, "t", kind_content("table"))
	body_block(&blocks, "p", text_content("end"))
	page := apply_params({"id", "any-page"}, {"type_key", "page"}, {"name", "Imported"})
	page["blocks"] = json.Array(blocks)
	page["created_at"] = json.Integer(500)
	commit_apply(t, &h, apply_plan(t, &h, "create", page, absent = {"any-page"}), "fixed-id create with blocks")

	on_page :: proc(pairs: ..[2]string) -> json.Object {
		out := jobj()
		out["object_id"] = json.String("any-page")
		for p in pairs do out[p[0]] = json.String(p[1])
		return json.Object(out)
	}
	added := with(on_page({"target_id", "p"}), "block", json.Object(jobj()))
	added["position"] = json.Integer(POS_BOTTOM)
	added_block := jobj()
	added_block["id"] = json.String("new")
	added_block["content"] = text_content("typed")
	added["block"] = json.Object(added_block)
	commit_apply(t, &h, apply_plan(t, &h, "block_add", added), "block_add")
	commit_apply(t, &h, apply_plan(t, &h, "block_update", with(on_page({"block_id", "h"}), "content", text_content("Renamed"))), "block_update")
	// A side move builds a row of columns; moving back out normalizes it away.
	left := on_page({"block_id", "p"}, {"target_id", "h"})
	left["position"] = json.Integer(POS_LEFT)
	commit_apply(t, &h, apply_plan(t, &h, "block_move", left), "block_move left")
	right := on_page({"block_id", "new"}, {"target_id", "h"})
	right["position"] = json.Integer(POS_RIGHT)
	commit_apply(t, &h, apply_plan(t, &h, "block_move", right), "block_move right")
	back := on_page({"block_id", "p"}, {"target_id", "tg"})
	back["position"] = json.Integer(POS_BOTTOM)
	commit_apply(t, &h, apply_plan(t, &h, "block_move", back), "block_move out of the row")
	commit_apply(t, &h, apply_plan(t, &h, "block_remove", on_page({"block_id", "tg"})), "block_remove subtree")

	table_out := apply_plan(t, &h, "table_create", with(on_page(), "rows", json.Integer(2)))
	commit_apply(t, &h, table_out, "table_create")
	table_id := json_str(json_field(table_out, "result") or_else nil, "id")
	commit_apply(t, &h, apply_plan(t, &h, "table_row_add", on_page({"table_id", table_id})), "table_row_add")
	commit_apply(t, &h, apply_plan(t, &h, "table_col_add", on_page({"table_id", table_id})), "table_col_add")
	column_id := ""
	for b in query_cached_states["any-page"].blocks do if b.content.kind == .Table_Column {
		column_id = b.id
		break
	}
	commit_apply(t, &h, apply_plan(t, &h, "table_col_remove", on_page({"table_id", table_id}, {"column_id", column_id})), "table_col_remove")

	commit_apply(t, &h, apply_plan(t, &h, "set_field", with(on_page({"key", "status"}), "value", string_field("done"))), "set_field")
	commit_apply(t, &h, apply_plan(t, &h, "delete_field", on_page({"key", "status"})), "delete_field")
	commit_apply(t, &h, apply_plan(t, &h, "delete", on_page()), "delete")
	testing.expect(t, query_cached_states["any-page"].deleted, "delete applied")
	commit_apply(t, &h, apply_plan(t, &h, "restore", on_page()), "restore")
	testing.expect(t, !query_cached_states["any-page"].deleted, "restore applied")

	// A planned create scans the cache for its space; a chat post on it.
	note_out := apply_plan(t, &h, "create", apply_params({"type_key", "note"}, {"name", "Plan"}))
	commit_apply(t, &h, note_out, "create note")
	note_id := json_str(json_field(note_out, "result") or_else nil, "id")
	commit_apply(t, &h, apply_plan(t, &h, "chat_post", apply_params({"object_id", note_id}, {"text", "hello"})), "chat_post")

	// Refusals leave the cached state exactly as it was.
	before := cached_json("any-page")
	genesis := hex_id(h.changes["any-page"][0].id, context.temp_allocator)
	stale := address(Change{object_id = "any-page", timestamp = 99_000, author = "device-a", ops = h.changes["any-page"][1].ops}, {genesis})
	testing.expect(t, !send_apply(t, stale), "a change not on the cached heads is refused")
	unaddressed := address(Change{object_id = "any-page", timestamp = 99_000, author = "device-a", ops = h.changes["any-page"][1].ops}, cached_heads("any-page"))
	unaddressed.timestamp += 1
	testing.expect(t, !send_apply(t, unaddressed), "a change whose id is not its content address is refused")
	orphan := address(Change{object_id = "nowhere", timestamp = 99_000, author = "device-a", ops = h.changes["any-page"][1].ops}, cached_heads("any-page"))
	testing.expect(t, !send_apply(t, orphan), "a non-genesis change on an uncached object is refused")
	testing.expect_value(t, cached_json("any-page"), before)
	_, nowhere := query_cached_states["nowhere"]
	testing.expect(t, !nowhere, "a refused change caches nothing")

	// A remote change the host upserted in full moves the heads: a local
	// change planned on the old heads is refused, and the newer full state
	// stays (the host then upserts the merged replay).
	local_heads := make([dynamic]string, context.temp_allocator)
	for head in cached_heads("any-page") do append(&local_heads, strings.clone(head, context.temp_allocator))
	remote_ops := make([dynamic]Operation, context.temp_allocator)
	append(&remote_ops, Operation{kind = .Field_Set, key = "remote", value = string_value("yes")})
	remote := address(Change{object_id = "any-page", timestamp = 120_000, author = "device-b", ops = remote_ops}, local_heads[:])
	list := h.changes["any-page"]
	append(&list, remote)
	h.changes["any-page"] = list
	merged, merged_ok := compute_state(h.changes["any-page"][:], context.temp_allocator)
	testing.expect(t, merged_ok, "remote history replays")
	upsert_state(t, &merged)
	late := address(Change{object_id = "any-page", timestamp = 121_000, author = "device-a", ops = h.changes["any-page"][1].ops}, local_heads[:])
	testing.expect(t, !send_apply(t, late), "a local change on heads the cache moved past is refused")
	testing.expect_value(t, cached_json("any-page"), replayed_json(merged))
	// The upsert carried its heads, so the next local commit applies again.
	commit_apply(t, &h, apply_plan(t, &h, "set_field", with(on_page({"key", "status"}), "value", string_field("merged"))), "set_field after a remote upsert")

	// On a base (state sync): the host caches base + live deltas; a change
	// tagged with the base and built on those heads applies to exactly what
	// replay_from_base computes.
	deltas := make([dynamic]Delta, context.temp_allocator)
	for c in h.changes["any-page"] do append(&deltas, Delta{change = c})
	plan, planned := base_compact_plan(nil, deltas[:], nil, nil, 200_000, true, context.temp_allocator)
	testing.expect(t, planned && plan.compact, "forced compaction builds a base")
	base, decoded := decode_checkpoint(plan.bytes, context.temp_allocator)
	testing.expect(t, decoded, "base decodes")
	on_base, has_base, base_ok := base_replay({base}, deltas[:], nil, nil, context.temp_allocator)
	testing.expect(t, has_base && base_ok, "replay from base")
	upsert_state(t, &on_base)
	for action in ([]string{"set_field", "block_add"}) {
		params := action == "set_field" ? with(on_page({"key", "after"}), "value", string_field("base")) : with(on_page({"target_id", ""}), "block", json.Object(jobj()))
		out := apply_plan(t, &h, action, params)
		for item in json_array(out, "changes") {
			c, _ := change_from_json(item, context.temp_allocator)
			committed := address(c, cached_heads("any-page"))
			append(&deltas, Delta{change = committed, b = base.base_hash, tagged = true})
			testing.expectf(t, send_apply(t, committed), "%s on a base applies", action)
		}
		want, has_want, want_ok := base_replay({base}, deltas[:], nil, nil, context.temp_allocator)
		testing.expect(t, has_want && want_ok, "replay from base")
		testing.expectf(t, cached_json("any-page") == replayed_json(want), "%s on a base equals replay_from_base", action)
	}
}
