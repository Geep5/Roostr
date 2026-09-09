package core

import "core:encoding/json"
import "core:fmt"
import "core:slice"
import "core:strings"

// All returned memory belongs to the caller's request allocator.
Mutation_Input :: struct {
 states: map[string]^Object_State,
 timestamp: i64,
 author: string,
 id_seed: string,
 key_id: i64,
}
Mutation_Plan :: struct {
 changes: [dynamic]Change,
 result: map[string]json.Value,
 vanish_ids: [dynamic]string,
 next_id: int,
}
mutation_id :: proc(plan: ^Mutation_Plan, input: Mutation_Input) -> string {
 n := plan.next_id
 plan.next_id += 1
 if n == 0 do return input.id_seed
 return fmt.tprintf("%s-%d", input.id_seed, n)
}
mutation_add :: proc(plan: ^Mutation_Plan, input: Mutation_Input, object_id: string, ops: []Operation) {
 c := Change{object_id = object_id, timestamp = input.timestamp, author = input.author}
 c.ops = make([dynamic]Operation, context.temp_allocator)
 append(&c.ops, ..ops)
 append(&plan.changes, c)
}
mutation_with_states :: proc(states: map[string]^Object_State, visit: proc(map[string]^Object_State, rawptr), user: rawptr) {
 visit(states, user)
}

// Membership values may reference a native store generation that commits invalidate.
mutation_clone_value :: proc(value: Value) -> Value {
 out := value
 out.str = strings.clone(value.str, context.temp_allocator)
 out.link_target = strings.clone(value.link_target, context.temp_allocator)
 out.link_relation = strings.clone(value.link_relation, context.temp_allocator)
 out.bytes = make([]byte, len(value.bytes), context.temp_allocator)
 copy(out.bytes, value.bytes)
 out.strings = make([dynamic]string, context.temp_allocator)
 for s in value.strings do append(&out.strings, strings.clone(s, context.temp_allocator))
 out.entries = make([dynamic]Value_Entry, context.temp_allocator)
 for e in value.entries do append(&out.entries, Value_Entry{key = strings.clone(e.key, context.temp_allocator), value = mutation_clone_value(e.value)})
 out.items = make([dynamic]Value, context.temp_allocator)
 for item in value.items do append(&out.items, mutation_clone_value(item))
 return out
}

mutation_vanish_ops :: proc(ids: []string, timestamp: i64, ledger_exists: bool) -> [dynamic]Operation {
 ops := make([dynamic]Operation, context.temp_allocator)
 if !ledger_exists {
  append(&ops, Operation{kind = .Object_Create, type_key = "vanish_log"})
  append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value("Vanished objects")})
 }
 for id in ids do append(&ops, Operation{kind = .Field_Set, key = fmt.tprintf("vanished:%s", id), value = int_value(timestamp)})
 return ops
}

DISCUSSION_ID :: "__discussion__"
string_value :: proc(s: string) -> Value {
	return Value{kind = .String, str = s}
}

int_value :: proc(i: i64) -> Value {
	return Value{kind = .Int, i = i}
}

bool_value :: proc(b: bool) -> Value {
	return Value{kind = .Bool, b = b}
}

list_value :: proc(items: []Value, allocator := context.temp_allocator) -> Value {
	v := Value{kind = .List}
	v.items = make([dynamic]Value, allocator)
	append(&v.items, ..items)
	return v
}

mutation_plan :: proc(parsed: json.Value, input: Mutation_Input) -> (Mutation_Plan, string) {
 plan := Mutation_Plan{changes = make([dynamic]Change, context.temp_allocator), result = jobj(), vanish_ids = make([dynamic]string, context.temp_allocator)}
 if _, ok := parsed.(json.Object); !ok do return plan, "mutation params must be an object"
 action := json_str(parsed, "action")
 if input.author == "" do return plan, "author required"
 if input.id_seed == "" do return plan, "id_seed required"
 for key in ([]string{"block", "content", "value"}) {
  if value, present := json_field(parsed, key); present {
   if _, valid := value.(json.Object); !valid do return plan, fmt.tprintf("%s must be an object", key)
  }
 }
 if fields, present := json_field(parsed, "fields"); present {
  _, object_ok := fields.(json.Object)
  _, array_ok := fields.(json.Array)
  if !object_ok && !array_ok do return plan, "fields must be an object or ordered pairs"
 }
	switch action {
	case "create":
		type_key := json_str(parsed, "type_key")
		if type_key == "" do type_key = "note"
		id := mutation_id(&plan, input)
		ops := make([dynamic]Operation, context.temp_allocator)
		append(&ops, Operation{kind = .Object_Create, type_key = type_key})
		name := json_str(parsed, "name")
		// An empty name stays empty: the title input shows an "Untitled"
		// placeholder instead, so typing needs no delete-first.
		append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value(name)})
		has_channel := false
		if fields, ok := json_field(parsed, "fields"); ok {
			for e in fields_from_json(fields, context.temp_allocator) {
				if e.key == "channel" do has_channel = true
				append(&ops, Operation{kind = .Field_Set, key = e.key, value = e.value})
			}
		}
		// Every object belongs to a space (Anytype invariant): unassigned
		// creations land in the oldest channel instead of floating into
		// whichever space happens to be the display default.
		if !has_channel && type_key != "channel" {
			ch := oldest_channel_id(input.states)
			if ch != "" do append(&ops, Operation{kind = .Field_Set, key = "channel", value = string_value(ch)})
		}
		mutation_add(&plan, input, id, ops[:])
		extra := jobj()
		extra["id"] = json.String(strings.clone(id, context.temp_allocator))
		plan.result = extra
		return plan, ""

	case "block_add":
		object_id := json_str(parsed, "object_id")
		block_json, has_block := json_field(parsed, "block")
		if object_id == "" || !has_block {
			return plan, "object_id and block required"
		}
		block := block_from_json(block_json, context.temp_allocator)
		if block.id == "" do block.id = mutation_id(&plan, input)
		position, _ := json_int(parsed, "position")
		target_id := json_str(parsed, "target_id")
		ops := make([dynamic]Operation, context.temp_allocator)
		// insert_to degrades an unknown target to a root block rather than
		// losing it, so adding into a discussion that doesn't exist yet
		// silently orphans the block: present in the object, absent from
		// the thread. chat_post has always guarded this by prepending an
		// idempotent root add (replay skips it when the id exists); do the
		// same here so the agent harness's first write to a fresh chat
		// lands in the thread instead of beside it.
		if target_id == DISCUSSION_ID {
			root_meta := make([dynamic]Str_Pair, context.temp_allocator)
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = DISCUSSION_ID, content = {kind = .Custom, custom = {content_type = "discussion", meta = root_meta}}},
				target_id = "",
				position  = 0,
			})
		}
		append(&ops, Operation{kind = .Block_Add, block = block, target_id = target_id, position = position})
		mutation_add(&plan, input, object_id, ops[:])
		return plan, ""

	case "block_update":
		object_id := json_str(parsed, "object_id")
		content_json, has_content := json_field(parsed, "content")
		block_id := json_str(parsed, "block_id")
		if object_id == "" || block_id == "" || !has_content {
			return plan, "object_id, block_id, content required"
		}
		op := Operation {
			kind     = .Block_Update,
			block_id = block_id,
			content  = content_from_json(content_json, context.temp_allocator),
		}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	case "block_move":
		object_id := json_str(parsed, "object_id")
		position, _ := json_int(parsed, "position")
		op := Operation {
			kind      = .Block_Move,
			block_id  = json_str(parsed, "block_id"),
			target_id = json_str(parsed, "target_id"),
			position  = position,
		}
		if object_id == "" || op.block_id == "" {
			return plan, "object_id and block_id required"
		}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	case "block_remove":
		object_id := json_str(parsed, "object_id")
		op := Operation{kind = .Block_Remove, block_id = json_str(parsed, "block_id")}
		if object_id == "" || op.block_id == "" {
			return plan, "object_id and block_id required"
		}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	// -- Tables (Anytype BlockTableCreate + row/column ops) --------
	//
	// A table is an ordinary block subtree (see glon.proto TableContent),
	// so every action below is just Block_Adds/Removes bundled into ONE
	// Change - atomic, and replays like any other block edit.

	case "table_create":
		object_id := json_str(parsed, "object_id")
		if object_id == "" {
			return plan, "object_id required"
		}
		rows, has_rows := json_int(parsed, "rows")
		cols, has_cols := json_int(parsed, "cols")
		if !has_rows || rows < 1 do rows = 3
		if !has_cols || cols < 1 do cols = 3
		if rows > 65536 || cols > 65536 || rows > 65536 / cols do return plan, "table exceeds 65536 cells"
		position, _ := json_int(parsed, "position")
		ops := make([dynamic]Operation, context.temp_allocator)
		tid := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = tid, content = {kind = .Table}},
			target_id = json_str(parsed, "target_id"),
			position  = position,
		})
		cols_layout := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = cols_layout, content = {kind = .Layout, layout_style = LAYOUT_TABLE_COLUMNS}},
			target_id = tid,
			position  = POS_INNER,
		})
		col_ids := make([dynamic]string, context.temp_allocator)
		for _ in 0 ..< cols {
			cid := mutation_id(&plan, input)
			append(&col_ids, cid)
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = cid, content = {kind = .Table_Column}},
				target_id = cols_layout,
				position  = POS_INNER,
			})
		}
		rows_layout := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = rows_layout, content = {kind = .Layout, layout_style = LAYOUT_TABLE_ROWS}},
			target_id = tid,
			position  = POS_INNER,
		})
		for _ in 0 ..< rows {
			rid := mutation_id(&plan, input)
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = rid, content = {kind = .Table_Row}},
				target_id = rows_layout,
				position  = POS_INNER,
			})
			append_cell_ops(&ops, rid, col_ids[:])
		}
		mutation_add(&plan, input, object_id, ops[:])
		extra := jobj()
		extra["id"] = json.String(tid)
		plan.result = extra
		return plan, ""

	case "table_row_add":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		shape := table_shape(input.states, object_id, table_id)
		if !shape.found {
			return plan, "table not found"
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		rid := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = rid, content = {kind = .Table_Row}},
			target_id = shape.rows_layout,
			position  = POS_INNER,
		})
		append_cell_ops(&ops, rid, shape.col_ids[:])
		mutation_add(&plan, input, object_id, ops[:])
		return plan, ""

	case "table_col_add":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		shape := table_shape(input.states, object_id, table_id)
		if !shape.found {
			return plan, "table not found"
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		cid := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = cid, content = {kind = .Table_Column}},
			target_id = shape.cols_layout,
			position  = POS_INNER,
		})
		for rid in shape.row_ids {
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = fmt.tprintf("%s-%s", rid, cid), content = {kind = .Text}},
				target_id = rid,
				position  = POS_INNER,
			})
		}
		mutation_add(&plan, input, object_id, ops[:])
		return plan, ""

	case "table_col_remove":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		column_id := json_str(parsed, "column_id")
		shape := table_shape(input.states, object_id, table_id)
		if !shape.found || column_id == "" {
			return plan, "table not found"
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		append(&ops, Operation{kind = .Block_Remove, block_id = column_id})
		for rid in shape.row_ids {
			append(&ops, Operation{kind = .Block_Remove, block_id = fmt.tprintf("%s-%s", rid, column_id)})
		}
		mutation_add(&plan, input, object_id, ops[:])
		return plan, ""

	// -- Discussion (Anytype object chat: reply + emoji reactions) --
	//
	// Messages are blocks under a "__discussion__" root: custom content
	// {contentType:"chat", meta:{author, ts, text, replyTo, reactions}}.
	// reactions is a JSON object emoji -> [author ids]. Block adds merge
	// cleanly across devices; a reaction toggle is a whole-message LWW.

	case "chat_post":
		object_id := json_str(parsed, "object_id")
		text := json_str(parsed, "text")
		if object_id == "" || text == "" {
			return plan, "object_id and text required"
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		// Idempotent: replay skips the add when the id already exists.
		root_meta := make([dynamic]Str_Pair, context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = DISCUSSION_ID, content = {kind = .Custom, custom = {content_type = "discussion", meta = root_meta}}},
			target_id = "",
			position  = 0,
		})
		meta := make([dynamic]Str_Pair, context.temp_allocator)
		// `as_author` lets the local agent harness post as the agent
		// identity; default is this device's key-derived author id.
		author := json_str(parsed, "as_author")
		if author == "" do author = input.author
		append(&meta, Str_Pair{key = "author", value = author})
		append(&meta, Str_Pair{key = "ts", value = fmt.tprintf("%d", input.timestamp)})
		append(&meta, Str_Pair{key = "text", value = text})
		if reply := json_str(parsed, "reply_to"); reply != "" {
			append(&meta, Str_Pair{key = "replyTo", value = reply})
		}
		mid := mutation_id(&plan, input)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = mid, content = {kind = .Custom, custom = {content_type = "chat", meta = meta}}},
			target_id = DISCUSSION_ID,
			position  = POS_INNER,
		})
		mutation_add(&plan, input, object_id, ops[:])
		extra := jobj()
		extra["id"] = json.String(mid)
		plan.result = extra
		return plan, ""

	case "chat_react":
		object_id := json_str(parsed, "object_id")
		message_id := json_str(parsed, "message_id")
		emoji := json_str(parsed, "emoji")
		if object_id == "" || message_id == "" || emoji == "" {
			return plan, "object_id, message_id, emoji required"
		}
		meta := block_custom_meta(input.states, object_id, message_id)
		if !meta.found {
			return plan, "message not found"
		}
		me := input.author
		// Reactions live in ONE meta pair: "reactions" -> "emoji|a1,a2;emoji|a1".
		// Odin's json marshal writes emoji object KEYS as \U escapes its own
		// parser (and every other consumer) rejects - so emoji stay in the
		// VALUE, which marshals as plain UTF-8.
		Entry :: struct {
			emoji:   string,
			authors: [dynamic]string,
		}
		entries := make([dynamic]Entry, context.temp_allocator)
		new_meta := make([dynamic]Str_Pair, context.temp_allocator)
		for p in meta.pairs {
			if p.key != "reactions" {
				append(&new_meta, p)
				continue
			}
			for chunk in strings.split(p.value, ";", context.temp_allocator) {
				bar := strings.index(chunk, "|")
				if bar <= 0 do continue
				e := Entry{emoji = chunk[:bar]}
				e.authors = make([dynamic]string, context.temp_allocator)
				for a in strings.split(chunk[bar + 1:], ",", context.temp_allocator) {
					if a != "" do append(&e.authors, a)
				}
				append(&entries, e)
			}
		}
		// Toggle me on the target emoji.
		found_entry := false
		for &e in entries {
			if e.emoji != emoji do continue
			found_entry = true
			had := false
			kept := make([dynamic]string, context.temp_allocator)
			for a in e.authors {
				if a == me {
					had = true
					continue
				}
				append(&kept, a)
			}
			if !had do append(&kept, me)
			e.authors = kept
		}
		if !found_entry {
			e := Entry{emoji = emoji}
			e.authors = make([dynamic]string, context.temp_allocator)
			append(&e.authors, me)
			append(&entries, e)
		}
		chunks := make([dynamic]string, context.temp_allocator)
		for e in entries {
			if len(e.authors) == 0 do continue
			append(&chunks, fmt.tprintf("%s|%s", e.emoji, strings.join(e.authors[:], ",", context.temp_allocator)))
		}
		if len(chunks) > 0 {
			append(&new_meta, Str_Pair{key = "reactions", value = strings.join(chunks[:], ";", context.temp_allocator)})
		}
		op := Operation {
			kind     = .Block_Update,
			block_id = message_id,
			content  = Block_Content{kind = .Custom, custom = {content_type = "chat", meta = new_meta}},
		}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	case "block_set_attrs":
		object_id := json_str(parsed, "object_id")
		block_id := json_str(parsed, "block_id")
		ops := make([dynamic]Operation, context.temp_allocator)
		if align, ok := json_int(parsed, "align"); ok {
			append(&ops, Operation{kind = .Block_Set_Align, block_id = block_id, align = align})
		}
		if bg, ok := json_field(parsed, "background_color"); ok {
			if s, sok := bg.(json.String); sok {
				append(&ops, Operation{kind = .Block_Set_Background, block_id = block_id, color = string(s)})
			}
		}
		if object_id == "" || block_id == "" || len(ops) == 0 {
			return plan, "object_id, block_id and at least one attr required"
		}
		mutation_add(&plan, input, object_id, ops[:])
		return plan, ""

	case "set_field":
		object_id := json_str(parsed, "object_id")
		key := json_str(parsed, "key")
		value_json, has_value := json_field(parsed, "value")
		if object_id == "" || key == "" || !has_value {
			return plan, "object_id, key, value required"
		}
		op := Operation{kind = .Field_Set, key = key, value = value_from_json(value_json, context.temp_allocator)}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	case "delete_field":
		object_id := json_str(parsed, "object_id")
		key := json_str(parsed, "key")
		if object_id == "" || key == "" {
			return plan, "object_id and key required"
		}
		op := Operation{kind = .Field_Delete, key = key}
		mutation_add(&plan, input, object_id, {op})
		return plan, ""

	case "restore":
		object_id := json_str(parsed, "object_id")
		if object_id == "" {
			return plan, "object_id required"
		}
		// Revival = re-create under the object's own type. Replay clears
		// the tombstone; fields, blocks, and history are all still there.
		tk := ""
		{
			Ctx :: struct {
				tk: ^string,
				id: string,
			}
			ctx := Ctx{&tk, object_id}
			mutation_with_states(input.states, proc(states: map[string]^Object_State, user: rawptr) {
				c := cast(^struct {
					tk: ^string,
					id: string,
				})user
				if s, ok := states[c.id]; ok do c.tk^ = strings.clone(s.type_key, context.temp_allocator)
			}, &ctx)
		}
		if tk == "" {
			return plan, "unknown object"
		}
		mutation_add(&plan, input, object_id, {Operation{kind = .Object_Create, type_key = tk}})
		return plan, ""

	case "set_type":
		object_id := json_str(parsed, "object_id")
		type_key := json_str(parsed, "type_key")
		if object_id == "" || type_key == "" {
			return plan, "object_id and type_key required"
		}
		// Replay treats a later Object_Create as "set typeKey" - the
		// object's history, blocks, and fields all survive a retype.
		mutation_add(&plan, input, object_id, {Operation{kind = .Object_Create, type_key = type_key}})
		return plan, ""

	case "delete":
		object_id := json_str(parsed, "object_id")
		if object_id == "" {
			return plan, "object_id required"
		}
		// A type definition takes its instances with it (computed before
		// the tombstone lands).
		instances := type_instance_cascade(input.states, object_id)
		// A property definition takes its values with it.
		rel_ids, rel_key := relation_value_cascade(input.states, object_id)
		mutation_add(&plan, input, object_id, {Operation{kind = .Object_Delete}})
		// The object's bound agent (and its chat) go with it.
		cascade := bound_agent_cascade(input.states, object_id)
		for cid in cascade do mutation_add(&plan, input, cid, {Operation{kind = .Object_Delete}})
		for iid in instances {
			mutation_add(&plan, input, iid, {Operation{kind = .Object_Delete}})
			icascade := bound_agent_cascade(input.states, iid)
			for cid in icascade do mutation_add(&plan, input, cid, {Operation{kind = .Object_Delete}})
		}
		for oid in rel_ids do mutation_add(&plan, input, oid, {Operation{kind = .Field_Delete, key = rel_key}})
		return plan, ""

	// Real deletion: purge the change files and record it in the synced
	// ledger so no device republishes the object and no relay copy is
	// accepted back. `delete` only appends a tombstone.
	case "vanish":
		ids := make([dynamic]string, context.temp_allocator)
		if object_id := json_str(parsed, "object_id"); object_id != "" do append(&ids, object_id)
		if arr, ok := json_field(parsed, "object_ids"); ok {
			if items, aok := arr.(json.Array); aok {
				for item in items do if s, sok := item.(json.String); sok do append(&ids, string(s))
			}
		}
		if len(ids) == 0 {
			return plan, "object_id or object_ids required"
		}
		for id in ids do if id == "__vanished__" {
			return plan, "the vanish ledger cannot be vanished"
		}
		for id in ids {
			if id == "" || strings.contains(id, "/") || strings.contains(id, "..") do return plan, "invalid object id"
		}
		// A type definition takes its instances with it; then bound agents
		// (and their chats) vanish with every object in the set. A property
		// definition wipes its values from the survivors first.
		expanded := make([dynamic]string, context.temp_allocator)
		for id in ids {
			append(&expanded, id)
			for iid in type_instance_cascade(input.states, id) do append(&expanded, iid)
			rel_ids, rel_key := relation_value_cascade(input.states, id)
			for oid in rel_ids do mutation_add(&plan, input, oid, {Operation{kind = .Field_Delete, key = rel_key}})
		}
		root_count := len(expanded)
		for i in 0 ..< root_count {
			cascade := bound_agent_cascade(input.states, expanded[i])
			for cid in cascade do append(&expanded, cid)
		}
		plan.vanish_ids = expanded
        plan.result["vanished"] = json.Integer(i64(len(expanded)))
        return plan, ""


	// Sweep every tombstone. `delete` leaves the object's changes on disk and
	// on the relays forever; the bin in each space can only reach tombstones
	// whose space still exists, so objects orphaned by a deleted space were
	// unreclaimable by any surface. The daemon collects the set itself rather
	// than trusting a client's list, and reports before it destroys: no
	// `confirm: true`, no writes.
	case "purge_deleted":
		Sweep :: struct {
			ids: [dynamic]string,
		}
		sweep := Sweep{make([dynamic]string, context.temp_allocator)}
		mutation_with_states(input.states, proc(states: map[string]^Object_State, user: rawptr) {
			s := cast(^Sweep)user
			for id, st in states {
				if !st.deleted do continue
				if id == "__vanished__" do continue
				// Cloned, per the convention the cascade helpers follow: these
				// keys belong to the store, and vanish_objects invalidates it
				// (freeing them) before its own broadcast loop reads them back.
				append(&s.ids, strings.clone(id, context.temp_allocator))
			}
			slice.sort(s.ids[:]) // deterministic report and cascade order
		}, &sweep)
		confirmed, _ := json_bool(parsed, "confirm")
		if !confirmed {
			sample := make([dynamic]json.Value, context.temp_allocator)
			for id in sweep.ids do append(&sample, json.String(id))
			extra := jobj()
			extra["wouldPurge"] = json.Integer(i64(len(sweep.ids)))
			extra["ids"] = json.Array(sample)
			plan.result = extra
		return plan, ""
		}
		if len(sweep.ids) == 0 {
			extra := jobj()
			extra["purged"] = json.Integer(0)
			plan.result = extra
		return plan, ""
		}
		plan.vanish_ids = sweep.ids
		purged := len(sweep.ids)
		extra := jobj()
		extra["purged"] = json.Integer(i64(purged))
		plan.result = extra
		return plan, ""

	case "channel_create":
		name := json_str(parsed, "name")
		if name == "" {
			return plan, "name required"
		}
		id := mutation_id(&plan, input)
		empty: []Value
		ops := []Operation{
			{kind = .Object_Create, type_key = "channel"},
			{kind = .Field_Set, key = "name", value = string_value(name)},
			{kind = .Field_Set, key = "iconEmoji", value = string_value(json_str(parsed, "icon"))},
			{kind = .Field_Set, key = "pinnedIds", value = list_value(empty)},
			{kind = .Field_Set, key = "members", value = list_value(empty)},
			{kind = .Field_Set, key = "keyId", value = int_value(1)},
		}
		mutation_add(&plan, input, id, ops)
		mutation_seed_space_defaults(&plan, input, id)
		extra := jobj()
		extra["id"] = json.String(strings.clone(id, context.temp_allocator))
		extra["key_id"] = json.Integer(1)
		plan.result = extra
		return plan, ""

	case "channel_member_add":
		channel_id := json_str(parsed, "channel_id")
		npub := json_str(parsed, "npub")
		if channel_id == "" || npub == "" {
			return plan, "channel_id and npub required"
		}
		role := json_str(parsed, "role")
		if role == "" do role = "writer"
		members := channel_members(input.states, channel_id)
		exists := false
		for m in members do if m.key == npub do exists = true
		if !exists {
			entry := Value{kind = .Map}
			entry.entries = make([dynamic]Value_Entry, context.temp_allocator)
			append(&entry.entries, Value_Entry{key = "npub", value = string_value(npub)})
			append(&entry.entries, Value_Entry{key = "role", value = string_value(role)})
			items := make([dynamic]Value, context.temp_allocator)
			for m in members do append(&items, m.value)
			append(&items, entry)
			op := Operation{kind = .Field_Set, key = "members", value = list_value(items[:])}
			mutation_add(&plan, input, channel_id, {op})
		}
		return plan, ""

	case "channel_member_remove":
		channel_id := json_str(parsed, "channel_id")
		npub := json_str(parsed, "npub")
		if channel_id == "" || npub == "" {
			return plan, "channel_id and npub required"
		}
		members := channel_members(input.states, channel_id)
		items := make([dynamic]Value, context.temp_allocator)
		for m in members do if m.key != npub do append(&items, m.value)
		key_id := input.key_id
		if key_id < 1 do return plan, "key_id required"
		ops := []Operation{
			{kind = .Field_Set, key = "members", value = list_value(items[:])},
			{kind = .Field_Set, key = "keyId", value = int_value(key_id)},
		}
		mutation_add(&plan, input, channel_id, ops)
		extra := jobj()
		extra["key_id"] = json.Integer(key_id)
		plan.result = extra
		return plan, ""

	case "channel_key_rotate":
		channel_id := json_str(parsed, "channel_id")
		if channel_id == "" {
			return plan, "channel_id required"
		}
		key_id := input.key_id
		if key_id < 1 do return plan, "key_id required"
		op := Operation{kind = .Field_Set, key = "keyId", value = int_value(key_id)}
		mutation_add(&plan, input, channel_id, {op})
		extra := jobj()
		extra["key_id"] = json.Integer(key_id)
		plan.result = extra
		return plan, ""


 case "seed_space_defaults":
  channel_id := json_str(parsed, "channel_id")
  if channel_id == "" do return plan, "channel_id required"
  mutation_seed_space_defaults(&plan, input, channel_id)
  return plan, ""
 case "bootstrap_space_defaults":
  mutation_bootstrap_space_defaults(&plan, input)
  return plan, ""
 case:
  return plan, fmt.tprintf("unknown action %q", action)
 }
}

channel_members :: proc(states: map[string]^Object_State, channel_id: string) -> [dynamic]Value_Entry {
	out := make([dynamic]Value_Entry, context.temp_allocator)
	Ctx :: struct {
		id:  string,
		out: ^[dynamic]Value_Entry,
	}
	ctx := Ctx{channel_id, &out}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			id:  string,
			out: ^[dynamic]Value_Entry,
		})user
		s, ok := states[c.id]
		if !ok do return
		v, vok := fields_get(s.fields, "members")
		if !vok || v.kind != .List do return
		for item in v.items {
			if item.kind != .Map do continue
			npub := ""
			for e in item.entries do if e.key == "npub" && e.value.kind == .String do npub = e.value.str
			append(c.out, Value_Entry{key = strings.clone(npub, context.temp_allocator), value = mutation_clone_value(item)})
		}
	}, &ctx)
	return out
}
type_instance_cascade :: proc(states: map[string]^Object_State, object_id: string) -> [dynamic]string {
	out := make([dynamic]string, context.temp_allocator)
	Ctx :: struct {
		out: ^[dynamic]string,
		id:  string,
	}
	ctx := Ctx{&out, object_id}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			out: ^[dynamic]string,
			id:  string,
		})user
		def, ok := states[c.id]
		if !ok || def.type_key != "type" do return
		key, kok := fields_get(def.fields, "key")
		if !kok || key.kind != .String || key.str == "" do return
		ch := ""
		if v, vok := fields_get(def.fields, "channel"); vok && v.kind == .String do ch = v.str
		for _, s in states {
			if s.deleted || s.id == c.id do continue
			if s.type_key != key.str do continue
			sch := ""
			if v, vok := fields_get(s.fields, "channel"); vok && v.kind == .String do sch = v.str
			if sch != ch do continue
			append(c.out, strings.clone(s.id, context.temp_allocator))
		}
	}, &ctx)
	slice.sort(out[:])
	return out
}

// ── Relation-value cascade ───────────────────────────────────────────
//
// Deleting a property definition wipes that field from every live
// object in the def's space: a value whose meaning is gone is noise
// that would silently resurrect if the key were ever reused.
relation_value_cascade :: proc(states: map[string]^Object_State, object_id: string) -> (ids: [dynamic]string, key: string) {
	ids = make([dynamic]string, context.temp_allocator)
	Ctx :: struct {
		ids: ^[dynamic]string,
		key: ^string,
		id:  string,
	}
	ctx := Ctx{&ids, &key, object_id}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			ids: ^[dynamic]string,
			key: ^string,
			id:  string,
		})user
		def, ok := states[c.id]
		if !ok || def.type_key != "relation" do return
		k, kok := fields_get(def.fields, "key")
		if !kok || k.kind != .String || k.str == "" do return
		c.key^ = strings.clone(k.str, context.temp_allocator)
		ch := ""
		if v, vok := fields_get(def.fields, "channel"); vok && v.kind == .String do ch = v.str
		for _, s in states {
			if s.deleted || s.id == c.id do continue
			sch := ""
			if v, vok := fields_get(s.fields, "channel"); vok && v.kind == .String do sch = v.str
			if sch != ch do continue
			if _, has := fields_get(s.fields, k.str); has {
				append(c.ids, strings.clone(s.id, context.temp_allocator))
			}
		}
	}, &ctx)
	slice.sort(ids[:])
	return
}

// ── Bound-agent cascade ──────────────────────────────────────────────
//
// Deleting an object retires its object-bound agent and that agent's
// holistic chat: a mind whose object is gone has nothing to be. Pair
// chats survive - they are shared history with another agent.
bound_agent_cascade :: proc(states: map[string]^Object_State, object_id: string) -> [dynamic]string {
	out := make([dynamic]string, context.temp_allocator)
	Ctx :: struct {
		out:       ^[dynamic]string,
		object_id: string,
	}
	ctx := Ctx{&out, object_id}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			out:       ^[dynamic]string,
			object_id: string,
		})user
		agent_ids := make([dynamic]string, context.temp_allocator)
		for _, s in states {
			// Deleted rows cascade too: vanishing a binned object must
			// take its binned agent along, not orphan the tombstone.
			if s.type_key != "agent" do continue
			if v, ok := fields_get(s.fields, "bound_object"); ok && v.kind == .String && v.str == c.object_id {
				append(&agent_ids, strings.clone(s.id, context.temp_allocator))
			}
		}
		for aid in agent_ids {
			append(c.out, aid)
			for _, s in states {
				if s.type_key != "chat" do continue
				// The agent's own holistic chat, not a shared pair chat.
				if p, pok := fields_get(s.fields, "a2a_pair"); pok && p.kind == .String && p.str != "" do continue
				if v, ok := fields_get(s.fields, "agent"); ok && v.kind == .String && v.str == aid {
					append(c.out, strings.clone(s.id, context.temp_allocator))
				}
			}
		}
	}, &ctx)
	slice.sort(out[:])
	return out
}
Bundled_Relation :: struct {
	key:       string,
	format:    string,
	name:      string,
	emoji:     string,
	hidden:    bool,
	read_only: bool,
	max_count: i64,
}

BUNDLED_RELATIONS :: []Bundled_Relation{
	{"name", "shorttext", "Name", "✏️", false, false, 0},
	{"description", "longtext", "Description", "📝", false, false, 0},
	{"iconEmoji", "emoji", "Icon", "🖼️", true, false, 0},
	{"createdDate", "date", "Created date", "📅", false, true, 0},
	{"modifiedDate", "date", "Modified date", "🗓️", false, true, 0},
	{"dueDate", "date", "Due date", "⏰", false, false, 0},
	{"tag", "tag", "Tag", "🏷️", false, false, 0},
	{"status", "status", "Status", "🚦", false, false, 1},
	{"done", "checkbox", "Done", "✅", false, false, 0},
	{"url", "url", "URL", "🔗", false, false, 0},
	{"email", "email", "Email", "✉️", false, false, 0},
	{"phone", "phone", "Phone", "📞", false, false, 0},
	{"featuredRelations", "relations", "Featured relations", "⭐", true, false, 0},
	{"setOf", "object", "Set of", "🗂️", true, false, 0},
}

/**
 * Seed one space's default definitions (idempotent per key+space) and
 * converge their name/emoji onto the current catalog. There are no
 * global definitions: every space owns its OWN copies of the default
 * relations and types - spaces are fully self-contained.
 */
mutation_seed_space_defaults :: proc(plan: ^Mutation_Plan, input: Mutation_Input, channel_id: string) {
	Present :: struct {
		id:    string,
		name:  string,
		emoji: string,
	}
	rels := make(map[string]Present)
	defer delete(rels)
	types := make(map[string]Present)
	defer delete(types)
	Ctx :: struct {
		rels:    ^map[string]Present,
		types:   ^map[string]Present,
		chan_id: string,
	}
	ctx := Ctx{&rels, &types, channel_id}
	mutation_with_states(input.states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			rels:    ^map[string]Present,
			types:   ^map[string]Present,
			chan_id: string,
		})user
		for _, s in states {
			if s.deleted do continue
			if s.type_key != "relation" && s.type_key != "type" do continue
			ch := ""
			if v, ok := fields_get(s.fields, "channel"); ok && v.kind == .String do ch = v.str
			if ch != c.chan_id do continue
			key, kok := fields_get(s.fields, "key")
			if !kok || key.kind != .String do continue
			e := Present{id = strings.clone(s.id, context.temp_allocator)}
			if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do e.name = strings.clone(v.str, context.temp_allocator)
			if v, ok := fields_get(s.fields, "iconEmoji"); ok && v.kind == .String do e.emoji = strings.clone(v.str, context.temp_allocator)
			if s.type_key == "relation" {
				if prior, exists := c.rels^[key.str]; !exists || e.id < prior.id do c.rels^[strings.clone(key.str, context.temp_allocator)] = e
			} else {
				if prior, exists := c.types^[key.str]; !exists || e.id < prior.id do c.types^[strings.clone(key.str, context.temp_allocator)] = e
			}
		}
	}, &ctx)

	// Deterministic per-space ids: every device's seeding of the same
	// space converges on the SAME objects, so multi-device sync unions
	// changes instead of duplicating definitions per install.
	prefix := len(channel_id) >= 8 ? channel_id[:8] : channel_id


	for r in BUNDLED_RELATIONS {
		if e, ok := rels[r.key]; ok {
			if e.emoji != r.emoji {
				ops := []Operation{{kind = .Field_Set, key = "iconEmoji", value = string_value(r.emoji)}}
				mutation_add(plan, input, e.id, ops)
			}
			continue
		}
		id := fmt.tprintf("bundled-rel-%s-%s", r.key, prefix)
		empty: []Value
		ops := []Operation{
			{kind = .Object_Create, type_key = "relation"},
			{kind = .Field_Set, key = "channel", value = string_value(channel_id)},
			{kind = .Field_Set, key = "key", value = string_value(r.key)},
			{kind = .Field_Set, key = "format", value = string_value(r.format)},
			{kind = .Field_Set, key = "name", value = string_value(r.name)},
			{kind = .Field_Set, key = "iconEmoji", value = string_value(r.emoji)},
			{kind = .Field_Set, key = "hidden", value = bool_value(r.hidden)},
			{kind = .Field_Set, key = "readOnly", value = bool_value(r.read_only)},
			{kind = .Field_Set, key = "maxCount", value = int_value(r.max_count)},
			{kind = .Field_Set, key = "bundled", value = bool_value(true)},
			{kind = .Field_Set, key = "options", value = list_value(empty)},
		}
		mutation_add(plan, input, id, ops)
	}
	for t in BUNDLED_TYPES {
		if e, ok := types[t.key]; ok {
			ops := make([dynamic]Operation, context.temp_allocator)
			if e.name != t.name do append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value(t.name)})
			if e.emoji != t.emoji do append(&ops, Operation{kind = .Field_Set, key = "iconEmoji", value = string_value(t.emoji)})
			if len(ops) > 0 do mutation_add(plan, input, e.id, ops[:])
			continue
		}
		id := fmt.tprintf("bundled-type-%s-%s", t.key, prefix)
		ops := []Operation{
			{kind = .Object_Create, type_key = "type"},
			{kind = .Field_Set, key = "channel", value = string_value(channel_id)},
			{kind = .Field_Set, key = "key", value = string_value(t.key)},
			{kind = .Field_Set, key = "name", value = string_value(t.name)},
			{kind = .Field_Set, key = "iconEmoji", value = string_value(t.emoji)},
			{kind = .Field_Set, key = "layout", value = string_value(t.layout)},
			{kind = .Field_Set, key = "bundled", value = bool_value(true)},
		}
		mutation_add(plan, input, id, ops)
	}

}
mutation_bootstrap_space_defaults :: proc(plan: ^Mutation_Plan, input: Mutation_Input) {
	chans := make([dynamic]string)
	defer delete(chans)
	legacy := make([dynamic]string)
	defer delete(legacy)
	Ctx :: struct {
		chans:  ^[dynamic]string,
		legacy: ^[dynamic]string,
	}
	ctx := Ctx{&chans, &legacy}
	mutation_with_states(input.states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			chans:  ^[dynamic]string,
			legacy: ^[dynamic]string,
		})user
		for _, s in states {
			if s.deleted do continue
			if s.type_key == "channel" {
				append(c.chans, strings.clone(s.id, context.temp_allocator))
				continue
			}
			if s.type_key != "relation" && s.type_key != "type" do continue
			bundled, bok := fields_get(s.fields, "bundled")
			if !bok || bundled.kind != .Bool || !bundled.b do continue
			ch := ""
			if v, ok := fields_get(s.fields, "channel"); ok && v.kind == .String do ch = v.str
			if ch == "" do append(c.legacy, strings.clone(s.id, context.temp_allocator))
		}
	}, &ctx)

	slice.sort(chans[:])
	slice.sort(legacy[:])
	for c in chans do mutation_seed_space_defaults(plan, input, c)
	for id in legacy {
		ops := []Operation{{kind = .Object_Delete}}
		mutation_add(plan, input, id, ops)
	}

}
Bundled_Type :: struct {
	key:    string,
	name:   string,
	emoji:  string,
	layout: string,
}

// Anytype's default library (heart bundle/types.json), emoji equivalents
// of their iconNames: page/document, note/create, task/checkbox,
// profile("Human")/man, project/hammer, bookmark/bookmark. `person` keeps
// its key so existing objects stay typed. Agent infrastructure (skills)
// deliberately has NO type object - it lives outside the knowledge space
// (harness reads typeKey "skill" through the raw query API).
BUNDLED_TYPES :: []Bundled_Type{
	{"page", "Page", "📄", "page"},
	{"note", "Note", "📝", "page"},
	{"task", "Task", "✅", "task"},
	{"person", "Human", "👤", "page"},
	{"project", "Project", "🔨", "page"},
	{"bookmark", "Bookmark", "🔖", "page"},
	{"chat", "Chat", "💬", "chat"},
}
Table_Shape :: struct {
	object_id:   string,
	table_id:    string,
	cols_layout: string,
	rows_layout: string,
	col_ids:     [dynamic]string,
	row_ids:     [dynamic]string,
	found:       bool,
}

/**
 * Read a table's live structure (column/row ids in order) from computed
 * state. Ids are cloned to the temp allocator - store strings die when
 * the generation arena is invalidated by our own commit.
 */
table_shape :: proc(states: map[string]^Object_State, object_id, table_id: string) -> Table_Shape {
	shape := Table_Shape {
		object_id = object_id,
		table_id  = table_id,
	}
	shape.col_ids = make([dynamic]string, context.temp_allocator)
	shape.row_ids = make([dynamic]string, context.temp_allocator)
	if object_id == "" || table_id == "" do return shape
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		s := (^Table_Shape)(user)
		st, ok := states[s.object_id]
		if !ok do return
		by_id := make(map[string]^Block, context.temp_allocator)
		for &b in st.blocks do by_id[b.id] = &b
		t, tok := by_id[s.table_id]
		if !tok || t.content.kind != .Table do return
		// Early browser versions wrote the two layout styles reversed. Child
		// content identifies that persisted encoding, including an empty sibling.
		legacy_styles := false
		for cid in t.children_ids {
			layout, exists := by_id[cid]
			if !exists || layout.content.kind != .Layout do continue
			for child_id in layout.children_ids {
				child, child_exists := by_id[child_id]
				if !child_exists do continue
				if child.content.kind == .Table_Column && layout.content.layout_style == LAYOUT_TABLE_ROWS do legacy_styles = true
				if child.content.kind == .Table_Row && layout.content.layout_style == LAYOUT_TABLE_COLUMNS do legacy_styles = true
			}
		}
		for cid in t.children_ids {
			c, cok := by_id[cid]
			if !cok || c.content.kind != .Layout do continue
			style := c.content.layout_style
			if legacy_styles {
				if style == LAYOUT_TABLE_COLUMNS {
					style = LAYOUT_TABLE_ROWS
				} else if style == LAYOUT_TABLE_ROWS {
					style = LAYOUT_TABLE_COLUMNS
				}
			}
			switch style {
			case LAYOUT_TABLE_COLUMNS:
				s.cols_layout = strings.clone(cid, context.temp_allocator)
				for k in c.children_ids do append(&s.col_ids, strings.clone(k, context.temp_allocator))
			case LAYOUT_TABLE_ROWS:
				s.rows_layout = strings.clone(cid, context.temp_allocator)
				for k in c.children_ids do append(&s.row_ids, strings.clone(k, context.temp_allocator))
			}
		}
		s.found = s.cols_layout != "" && s.rows_layout != ""
	}, &shape)
	return shape
}

/** Append one empty text-cell Block_Add per column, id "<row>-<col>". */
append_cell_ops :: proc(ops: ^[dynamic]Operation, row_id: string, col_ids: []string) {
	for cid in col_ids {
		append(ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = fmt.tprintf("%s-%s", row_id, cid), content = {kind = .Text}},
			target_id = row_id,
			position  = POS_INNER,
		})
	}
}

Block_Meta :: struct {
	object_id: string,
	block_id:  string,
	pairs:     [dynamic]Str_Pair,
	found:     bool,
}

/** Read a custom block's meta pairs from computed state (temp-cloned). */
block_custom_meta :: proc(states: map[string]^Object_State, object_id, block_id: string) -> Block_Meta {
	m := Block_Meta {
		object_id = object_id,
		block_id  = block_id,
	}
	m.pairs = make([dynamic]Str_Pair, context.temp_allocator)
	if object_id == "" || block_id == "" do return m
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		m := (^Block_Meta)(user)
		st, ok := states[m.object_id]
		if !ok do return
		for &b in st.blocks {
			if b.id != m.block_id || b.content.kind != .Custom do continue
			for p in b.content.custom.meta {
				append(&m.pairs, Str_Pair {
					key   = strings.clone(p.key, context.temp_allocator),
					value = strings.clone(p.value, context.temp_allocator),
				})
			}
			m.found = true
			return
		}
	}, &m)
	return m
}

/** The oldest live channel's id - the stable home for unassigned objects. */
oldest_channel_id :: proc(states: map[string]^Object_State) -> string {
	Ctx :: struct {
		id:      string,
		created: i64,
	}
	ctx := Ctx{"", 0}
	mutation_with_states(states, proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^Ctx)user
		for _, s in states {
			if s.type_key != "channel" || s.deleted do continue
			if c.id == "" || s.created_at < c.created || (s.created_at == c.created && s.id < c.id) {
				c.created = s.created_at
				c.id = strings.clone(s.id, context.temp_allocator)
			}
		}
	}, &ctx)
	return ctx.id
}


// JSON ABI: state and entropy are explicit; no store or host calls occur here.
mutation_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
 if _, ok := payload.(json.Object); !ok do return nil, "mutation payload must be an object"
 if json_str(payload, "action") == "heads" {
  value, present := json_field(payload, "changes")
  array, valid := value.(json.Array)
  if !present || !valid do return nil, "changes must be an array"
  changes := make([dynamic]Change, context.temp_allocator)
  for item in array {
   change, ok := change_from_json(item, context.temp_allocator)
   if !ok do return nil, "invalid change"
   append(&changes, change)
  }
  result := make([dynamic]json.Value, context.temp_allocator)
  for id in find_heads(changes[:], context.temp_allocator) do append(&result, json.String(id))
  return json.Array(result), ""
 }
 params, has_params := json_field(payload, "params")
 if !has_params do return nil, "params required"
 obj, ok := params.(json.Object)
 if !ok do return nil, "params must be an object"
 request := jobj()
 for k, v in obj do request[k] = v
 request["action"] = json.String(json_str(payload, "action"))
 objects, has_objects := json_field(payload, "objects")
 if !has_objects do return nil, "objects required"
 array, array_ok := objects.(json.Array)
 if !array_ok do return nil, "objects must be an array"
 states := make(map[string]^Object_State, context.temp_allocator)
 for item in array {
  state, valid := object_from_json(item, context.temp_allocator)
  if !valid do return nil, "invalid object state"
  if _, exists := states[state.id]; exists do return nil, "duplicate object state"
  ptr := new(Object_State, context.temp_allocator)
  ptr^ = state
  states[state.id] = ptr
 }
 timestamp, has_timestamp := json_int(payload, "timestamp")
 if !has_timestamp do return nil, "timestamp required"
 key_id, _ := json_int(payload, "key_id")
 input := Mutation_Input{states = states, timestamp = timestamp, author = json_str(payload, "author"), id_seed = json_str(payload, "id_seed"), key_id = key_id}
 plan, err := mutation_plan(json.Object(request), input)
 if err != "" do return nil, err
 changes := make([dynamic]json.Value, context.temp_allocator)
 for change in plan.changes do append(&changes, change_to_json(change, context.temp_allocator, ordered = true))
 vanished := make([dynamic]json.Value, context.temp_allocator)
 for id in plan.vanish_ids do append(&vanished, json.String(id))
 vanish_changes := make([dynamic]json.Value, context.temp_allocator)
 if len(plan.vanish_ids) > 0 {
  vanished_plan := Mutation_Plan{changes = make([dynamic]Change, context.temp_allocator)}
  for id in plan.vanish_ids do mutation_add(&vanished_plan, input, id, {Operation{kind = .Object_Delete}})
  _, ledger_exists := input.states["__vanished__"]
  ops := mutation_vanish_ops(plan.vanish_ids[:], timestamp, ledger_exists)
  mutation_add(&vanished_plan, input, "__vanished__", ops[:])
  for change in vanished_plan.changes do append(&vanish_changes, change_to_json(change, context.temp_allocator, ordered = true))
 }
 result := jobj()
 result["changes"] = json.Array(changes)
 result["result"] = json.Object(plan.result)
 result["vanish_ids"] = json.Array(vanished)
 result["vanish_changes"] = json.Array(vanish_changes)
 return json.Object(result), ""
}
