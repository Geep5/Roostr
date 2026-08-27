package glon

// POST /api/mutate — every write lands as a content-addressed Change.
// Also: bundled relation bootstrap and channel key management (the
// Nostr-ready capability model: per-channel symmetric keys in
// <data>/channel-keys.json, invites as gift-wrap payloads).

import "core:net"
import "core:os"
import "core:fmt"
import "core:sync"
import "core:strings"
import "core:path/filepath"
import "core:encoding/json"
import "core:encoding/hex"
import "core:crypto"

// ── Change builders ──────────────────────────────────────────────────

make_change :: proc(object_id: string, ops: []Operation, author := "glon-odin") -> Change {
	c: Change
	c.object_id = object_id
	c.ops = make([dynamic]Operation, context.temp_allocator)
	append(&c.ops, ..ops)
	c.parent_ids = object_heads(object_id)
	c.timestamp = unix_ms()
	c.author = author
	return c
}

commit_ops :: proc(object_id: string, ops: []Operation) -> bool {
	c := make_change(object_id, ops)
	_, ok := commit_change(&c)
	if ok do sse_broadcast(object_id)
	return ok
}

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

// ── Mutate dispatch ──────────────────────────────────────────────────

handle_mutate :: proc(sock: net.TCP_Socket, body: []byte) {
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	action := json_str(parsed, "action")

	ok_response :: proc(sock: net.TCP_Socket, extra: map[string]json.Value = nil) {
		o := jobj()
		o["ok"] = json.Boolean(true)
		for k, v in extra do o[k] = v
		respond_json(sock, json.Object(o))
	}

	switch action {
	case "create":
		type_key := json_str(parsed, "type_key")
		if type_key == "" do type_key = "note"
		id := new_uuid(context.temp_allocator)
		ops := make([dynamic]Operation, context.temp_allocator)
		append(&ops, Operation{kind = .Object_Create, type_key = type_key})
		name := json_str(parsed, "name")
		if name == "" do name = "Untitled"
		append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value(name)})
		if fields, ok := json_field(parsed, "fields"); ok {
			for e in fields_from_json(fields, context.temp_allocator) {
				append(&ops, Operation{kind = .Field_Set, key = e.key, value = e.value})
			}
		}
		if !commit_ops(id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["id"] = json.String(strings.clone(id, context.temp_allocator))
		ok_response(sock, extra)

	case "block_add":
		object_id := json_str(parsed, "object_id")
		block_json, has_block := json_field(parsed, "block")
		if object_id == "" || !has_block {
			respond_error(sock, "object_id and block required")
			return
		}
		block := block_from_json(block_json, context.temp_allocator)
		if block.id == "" do block.id = new_uuid(context.temp_allocator)
		position, _ := json_int(parsed, "position")
		op := Operation {
			kind      = .Block_Add,
			block     = block,
			target_id = json_str(parsed, "target_id"),
			position  = position,
		}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "block_update":
		object_id := json_str(parsed, "object_id")
		content_json, has_content := json_field(parsed, "content")
		block_id := json_str(parsed, "block_id")
		if object_id == "" || block_id == "" || !has_content {
			respond_error(sock, "object_id, block_id, content required")
			return
		}
		op := Operation {
			kind     = .Block_Update,
			block_id = block_id,
			content  = content_from_json(content_json, context.temp_allocator),
		}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

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
			respond_error(sock, "object_id and block_id required")
			return
		}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "block_remove":
		object_id := json_str(parsed, "object_id")
		op := Operation{kind = .Block_Remove, block_id = json_str(parsed, "block_id")}
		if object_id == "" || op.block_id == "" {
			respond_error(sock, "object_id and block_id required")
			return
		}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	// -- Tables (Anytype BlockTableCreate + row/column ops) --------
	//
	// A table is an ordinary block subtree (see glon.proto TableContent),
	// so every action below is just Block_Adds/Removes bundled into ONE
	// Change - atomic, and replays like any other block edit.

	case "table_create":
		object_id := json_str(parsed, "object_id")
		if object_id == "" {
			respond_error(sock, "object_id required")
			return
		}
		rows, has_rows := json_int(parsed, "rows")
		cols, has_cols := json_int(parsed, "cols")
		if !has_rows || rows < 1 do rows = 3
		if !has_cols || cols < 1 do cols = 3
		position, _ := json_int(parsed, "position")
		ops := make([dynamic]Operation, context.temp_allocator)
		tid := new_uuid(context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = tid, content = {kind = .Table}},
			target_id = json_str(parsed, "target_id"),
			position  = position,
		})
		cols_layout := new_uuid(context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = cols_layout, content = {kind = .Layout, layout_style = LAYOUT_TABLE_COLUMNS}},
			target_id = tid,
			position  = POS_INNER,
		})
		col_ids := make([dynamic]string, context.temp_allocator)
		for _ in 0 ..< cols {
			cid := new_uuid(context.temp_allocator)
			append(&col_ids, cid)
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = cid, content = {kind = .Table_Column}},
				target_id = cols_layout,
				position  = POS_INNER,
			})
		}
		rows_layout := new_uuid(context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = rows_layout, content = {kind = .Layout, layout_style = LAYOUT_TABLE_ROWS}},
			target_id = tid,
			position  = POS_INNER,
		})
		for _ in 0 ..< rows {
			rid := new_uuid(context.temp_allocator)
			append(&ops, Operation {
				kind      = .Block_Add,
				block     = Block{id = rid, content = {kind = .Table_Row}},
				target_id = rows_layout,
				position  = POS_INNER,
			})
			append_cell_ops(&ops, rid, col_ids[:])
		}
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["id"] = json.String(tid)
		ok_response(sock, extra)

	case "table_row_add":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		shape := table_shape(object_id, table_id)
		if !shape.found {
			respond_error(sock, "table not found")
			return
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		rid := new_uuid(context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = rid, content = {kind = .Table_Row}},
			target_id = shape.rows_layout,
			position  = POS_INNER,
		})
		append_cell_ops(&ops, rid, shape.col_ids[:])
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "table_col_add":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		shape := table_shape(object_id, table_id)
		if !shape.found {
			respond_error(sock, "table not found")
			return
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		cid := new_uuid(context.temp_allocator)
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
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "table_col_remove":
		object_id := json_str(parsed, "object_id")
		table_id := json_str(parsed, "table_id")
		column_id := json_str(parsed, "column_id")
		shape := table_shape(object_id, table_id)
		if !shape.found || column_id == "" {
			respond_error(sock, "table not found")
			return
		}
		ops := make([dynamic]Operation, context.temp_allocator)
		append(&ops, Operation{kind = .Block_Remove, block_id = column_id})
		for rid in shape.row_ids {
			append(&ops, Operation{kind = .Block_Remove, block_id = fmt.tprintf("%s-%s", rid, column_id)})
		}
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

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
			respond_error(sock, "object_id, block_id and at least one attr required")
			return
		}
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "set_field":
		object_id := json_str(parsed, "object_id")
		key := json_str(parsed, "key")
		value_json, has_value := json_field(parsed, "value")
		if object_id == "" || key == "" || !has_value {
			respond_error(sock, "object_id, key, value required")
			return
		}
		op := Operation{kind = .Field_Set, key = key, value = value_from_json(value_json, context.temp_allocator)}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "delete_field":
		object_id := json_str(parsed, "object_id")
		key := json_str(parsed, "key")
		if object_id == "" || key == "" {
			respond_error(sock, "object_id and key required")
			return
		}
		op := Operation{kind = .Field_Delete, key = key}
		if !commit_ops(object_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "delete":
		object_id := json_str(parsed, "object_id")
		if object_id == "" {
			respond_error(sock, "object_id required")
			return
		}
		if !commit_ops(object_id, {Operation{kind = .Object_Delete}}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		ok_response(sock)

	case "channel_create":
		name := json_str(parsed, "name")
		if name == "" {
			respond_error(sock, "name required")
			return
		}
		id := new_uuid(context.temp_allocator)
		empty: []Value
		ops := []Operation{
			{kind = .Object_Create, type_key = "channel"},
			{kind = .Field_Set, key = "name", value = string_value(name)},
			{kind = .Field_Set, key = "iconEmoji", value = string_value(json_str(parsed, "icon"))},
			{kind = .Field_Set, key = "pinnedIds", value = list_value(empty)},
			{kind = .Field_Set, key = "members", value = list_value(empty)},
			{kind = .Field_Set, key = "keyId", value = int_value(1)},
		}
		if !commit_ops(id, ops) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		channel_key_set(id, 1)
		extra := jobj()
		extra["id"] = json.String(strings.clone(id, context.temp_allocator))
		extra["key_id"] = json.Integer(1)
		ok_response(sock, extra)

	case "channel_member_add":
		channel_id := json_str(parsed, "channel_id")
		npub := json_str(parsed, "npub")
		if channel_id == "" || npub == "" {
			respond_error(sock, "channel_id and npub required")
			return
		}
		role := json_str(parsed, "role")
		if role == "" do role = "writer"
		members := channel_members(channel_id)
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
			if !commit_ops(channel_id, {op}) {
				respond_error(sock, "write failed", "500 Internal Server Error")
				return
			}
		}
		ok_response(sock)

	case "channel_member_remove":
		channel_id := json_str(parsed, "channel_id")
		npub := json_str(parsed, "npub")
		if channel_id == "" || npub == "" {
			respond_error(sock, "channel_id and npub required")
			return
		}
		members := channel_members(channel_id)
		items := make([dynamic]Value, context.temp_allocator)
		for m in members do if m.key != npub do append(&items, m.value)
		key_id := channel_key_rotate(channel_id)
		ops := []Operation{
			{kind = .Field_Set, key = "members", value = list_value(items[:])},
			{kind = .Field_Set, key = "keyId", value = int_value(key_id)},
		}
		if !commit_ops(channel_id, ops) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["key_id"] = json.Integer(key_id)
		ok_response(sock, extra)

	case "channel_key_rotate":
		channel_id := json_str(parsed, "channel_id")
		if channel_id == "" {
			respond_error(sock, "channel_id required")
			return
		}
		key_id := channel_key_rotate(channel_id)
		op := Operation{kind = .Field_Set, key = "keyId", value = int_value(key_id)}
		if !commit_ops(channel_id, {op}) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["key_id"] = json.Integer(key_id)
		ok_response(sock, extra)

	case "channel_invite_payload":
		channel_id := json_str(parsed, "channel_id")
		npub := json_str(parsed, "npub")
		key_hex, key_id, found := channel_key_get(channel_id)
		if !found {
			respond_error(sock, "no local key for channel")
			return
		}
		name := ""
		Ctx :: struct {
			id:   string,
			name: ^string,
		}
		ctx := Ctx{channel_id, &name}
		with_states(proc(states: map[string]^Object_State, user: rawptr) {
			c := cast(^struct {
				id:   string,
				name: ^string,
			})user
			if s, ok := states[c.id]; ok {
				if v, vok := fields_get(s.fields, "name"); vok && v.kind == .String do c.name^ = v.str
			}
		}, &ctx)
		payload := jobj()
		payload["v"] = json.Integer(1)
		payload["type"] = json.String("glon/channel-invite")
		payload["channel_id"] = json.String(channel_id)
		payload["name"] = json.String(name)
		payload["key"] = json.String(key_hex)
		payload["key_id"] = json.Integer(key_id)
		payload["invitee"] = json.String(npub)
		payload["relays"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
		payload["note"] = json.String("deliver via NIP-59 gift wrap to the invitee npub (nostr sync)")
		extra := jobj()
		extra["payload"] = json.Object(payload)
		ok_response(sock, extra)

	case "nostr_key_export":
		mutate_key_export(sock)

	case "nostr_relays_set":
		mutate_relays_set(sock, parsed)

	case:
		respond_error(sock, fmt.tprintf("unknown action %q", action))
	}
}

/** Channel members as (npub → member map value) pairs. */
channel_members :: proc(channel_id: string) -> [dynamic]Value_Entry {
	out := make([dynamic]Value_Entry, context.temp_allocator)
	Ctx :: struct {
		id:  string,
		out: ^[dynamic]Value_Entry,
	}
	ctx := Ctx{channel_id, &out}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
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
			append(c.out, Value_Entry{key = npub, value = item})
		}
	}, &ctx)
	return out
}

// ── Channel keys (<data>/channel-keys.json) ──────────────────────────

channel_keys_path :: proc() -> string {
	p, _ := filepath.join({g_store.data_root, "channel-keys.json"}, context.temp_allocator)
	return p
}

g_keys_mu: sync.Mutex

channel_keys_read :: proc() -> json.Value {
	data, rerr := os.read_entire_file(channel_keys_path(), context.temp_allocator)
	if rerr != nil do return nil
	parsed, perr := json.parse(data, allocator = context.temp_allocator)
	if perr != nil do return nil
	return parsed
}

channel_key_get :: proc(channel_id: string) -> (key: string, key_id: i64, found: bool) {
	sync.lock(&g_keys_mu)
	defer sync.unlock(&g_keys_mu)
	file := channel_keys_read()
	channels, ok := json_field(file, "channels")
	if !ok do return "", 0, false
	entry, eok := json_field(channels, channel_id)
	if !eok do return "", 0, false
	kid, _ := json_int(entry, "keyId")
	return json_str(entry, "key"), kid, true
}

channel_key_write :: proc(channel_id: string, key_hex: string, key_id: i64) {
	file := channel_keys_read()
	root := jobj()
	root["version"] = json.Integer(1)
	channels := jobj()
	if existing, ok := json_field(file, "channels"); ok {
		if obj, ook := existing.(json.Object); ook {
			for k, v in obj do channels[k] = v
		}
	}
	entry := jobj()
	entry["key"] = json.String(key_hex)
	entry["keyId"] = json.Integer(key_id)
	entry["createdAt"] = json.Integer(unix_ms())
	channels[channel_id] = json.Object(entry)
	root["channels"] = json.Object(channels)
	_ = os.write_entire_file(channel_keys_path(), marshal(json.Object(root)))
}

channel_key_set :: proc(channel_id: string, key_id: i64) {
	sync.lock(&g_keys_mu)
	defer sync.unlock(&g_keys_mu)
	raw: [32]byte
	crypto.rand_bytes(raw[:])
	channel_key_write(channel_id, string(hex.encode(raw[:], context.temp_allocator)), key_id)
}

channel_key_rotate :: proc(channel_id: string) -> i64 {
	_, key_id, found := channel_key_get(channel_id)
	next := found ? key_id + 1 : 1
	channel_key_set(channel_id, next)
	return next
}

// ── Bundled relations ────────────────────────────────────────────────

Bundled_Relation :: struct {
	key:       string,
	format:    string,
	name:      string,
	hidden:    bool,
	read_only: bool,
	max_count: i64,
}

BUNDLED_RELATIONS :: []Bundled_Relation{
	{"name", "shorttext", "Name", false, false, 0},
	{"description", "longtext", "Description", false, false, 0},
	{"iconEmoji", "emoji", "Icon", true, false, 0},
	{"createdDate", "date", "Created date", false, true, 0},
	{"modifiedDate", "date", "Modified date", false, true, 0},
	{"dueDate", "date", "Due date", false, false, 0},
	{"tag", "tag", "Tag", false, false, 0},
	{"status", "status", "Status", false, false, 1},
	{"done", "checkbox", "Done", false, false, 0},
	{"url", "url", "URL", false, false, 0},
	{"email", "email", "Email", false, false, 0},
	{"phone", "phone", "Phone", false, false, 0},
	{"featuredRelations", "relations", "Featured relations", true, false, 0},
	{"setOf", "object", "Set of", true, false, 0},
}

/** Idempotent: creates any bundled relation whose key is missing. */
bootstrap_relations :: proc() {
	have := make(map[string]bool)
	defer delete(have)
	Ctx :: struct {
		have: ^map[string]bool,
	}
	ctx := Ctx{&have}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^struct {
			have: ^map[string]bool,
		})user
		for _, s in states {
			if s.type_key != "relation" || s.deleted do continue
			if v, ok := fields_get(s.fields, "key"); ok && v.kind == .String do c.have^[v.str] = true
		}
	}, &ctx)

	created := 0
	for r in BUNDLED_RELATIONS {
		if have[r.key] do continue
		id := new_uuid(context.temp_allocator)
		empty: []Value
		ops := []Operation{
			{kind = .Object_Create, type_key = "relation"},
			{kind = .Field_Set, key = "key", value = string_value(r.key)},
			{kind = .Field_Set, key = "format", value = string_value(r.format)},
			{kind = .Field_Set, key = "name", value = string_value(r.name)},
			{kind = .Field_Set, key = "hidden", value = bool_value(r.hidden)},
			{kind = .Field_Set, key = "readOnly", value = bool_value(r.read_only)},
			{kind = .Field_Set, key = "maxCount", value = int_value(r.max_count)},
			{kind = .Field_Set, key = "bundled", value = bool_value(true)},
			{kind = .Field_Set, key = "options", value = list_value(empty)},
		}
		if commit_ops(id, ops) do created += 1
	}
	if created > 0 do fmt.printfln("[glon-odin] bootstrapped %d bundled relation(s)", created)
}

// -- Table helpers ------------------------------------------------

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
table_shape :: proc(object_id, table_id: string) -> Table_Shape {
	shape := Table_Shape {
		object_id = object_id,
		table_id  = table_id,
	}
	shape.col_ids = make([dynamic]string, context.temp_allocator)
	shape.row_ids = make([dynamic]string, context.temp_allocator)
	if object_id == "" || table_id == "" do return shape
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		s := (^Table_Shape)(user)
		st, ok := states[s.object_id]
		if !ok do return
		by_id := make(map[string]^Block, context.temp_allocator)
		for &b in st.blocks do by_id[b.id] = &b
		t, tok := by_id[s.table_id]
		if !tok || t.content.kind != .Table do return
		for cid in t.children_ids {
			c, cok := by_id[cid]
			if !cok || c.content.kind != .Layout do continue
			switch c.content.layout_style {
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
