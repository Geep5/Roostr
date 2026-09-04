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

/** Root block every message thread hangs under (chat + object discussions). */
DISCUSSION_ID :: "__discussion__"

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
			ch := oldest_channel_id()
			if ch != "" do append(&ops, Operation{kind = .Field_Set, key = "channel", value = string_value(ch)})
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
		if !commit_ops(object_id, ops[:]) {
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
			respond_error(sock, "object_id and text required")
			return
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
		if author == "" do author = author_id()
		append(&meta, Str_Pair{key = "author", value = author})
		append(&meta, Str_Pair{key = "ts", value = fmt.tprintf("%d", unix_ms())})
		append(&meta, Str_Pair{key = "text", value = text})
		if reply := json_str(parsed, "reply_to"); reply != "" {
			append(&meta, Str_Pair{key = "replyTo", value = reply})
		}
		mid := new_uuid(context.temp_allocator)
		append(&ops, Operation {
			kind      = .Block_Add,
			block     = Block{id = mid, content = {kind = .Custom, custom = {content_type = "chat", meta = meta}}},
			target_id = DISCUSSION_ID,
			position  = POS_INNER,
		})
		if !commit_ops(object_id, ops[:]) {
			respond_error(sock, "write failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["id"] = json.String(mid)
		ok_response(sock, extra)

	case "chat_react":
		object_id := json_str(parsed, "object_id")
		message_id := json_str(parsed, "message_id")
		emoji := json_str(parsed, "emoji")
		if object_id == "" || message_id == "" || emoji == "" {
			respond_error(sock, "object_id, message_id, emoji required")
			return
		}
		meta := block_custom_meta(object_id, message_id)
		if !meta.found {
			respond_error(sock, "message not found")
			return
		}
		me := author_id()
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
		if !commit_ops(object_id, {op}) {
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

	case "set_type":
		object_id := json_str(parsed, "object_id")
		type_key := json_str(parsed, "type_key")
		if object_id == "" || type_key == "" {
			respond_error(sock, "object_id and type_key required")
			return
		}
		// Replay treats a later Object_Create as "set typeKey" - the
		// object's history, blocks, and fields all survive a retype.
		if !commit_ops(object_id, {Operation{kind = .Object_Create, type_key = type_key}}) {
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
		// The object's bound agent (and its chat) go with it.
		cascade := bound_agent_cascade(object_id)
		for cid in cascade do commit_ops(cid, {Operation{kind = .Object_Delete}})
		ok_response(sock)

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
			respond_error(sock, "object_id or object_ids required")
			return
		}
		for id in ids do if id == VANISH_LOG_ID {
			respond_error(sock, "the vanish ledger cannot be vanished")
			return
		}
		// Bound agents (and their chats) vanish with their objects.
		expanded := make([dynamic]string, context.temp_allocator)
		for id in ids {
			append(&expanded, id)
			cascade := bound_agent_cascade(id)
			for cid in cascade do append(&expanded, cid)
		}
		vanished := vanish_objects(expanded[:])
		if vanished == 0 {
			respond_error(sock, "vanish failed", "500 Internal Server Error")
			return
		}
		extra := jobj()
		extra["vanished"] = json.Integer(i64(vanished))
		ok_response(sock, extra)

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
		seed_space_defaults(id)
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

	case "nostr_key_export":
		mutate_key_export(sock)

	case "nostr_relays_set":
		mutate_relays_set(sock, parsed)

	case "nostr_key_import":
		mutate_key_import(sock, parsed)

	case "identity_logout":
		mutate_identity_logout(sock)

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

// ── Bound-agent cascade ──────────────────────────────────────────────
//
// Deleting an object retires its object-bound agent and that agent's
// holistic chat: a mind whose object is gone has nothing to be. Pair
// chats survive - they are shared history with another agent.
bound_agent_cascade :: proc(object_id: string) -> [dynamic]string {
	out := make([dynamic]string, context.temp_allocator)
	Ctx :: struct {
		out:       ^[dynamic]string,
		object_id: string,
	}
	ctx := Ctx{&out, object_id}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
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
	return out
}

// ── Bundled relations ────────────────────────────────────────────────

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
seed_space_defaults :: proc(channel_id: string) {
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
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
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
				c.rels^[strings.clone(key.str, context.temp_allocator)] = e
			} else {
				c.types^[strings.clone(key.str, context.temp_allocator)] = e
			}
		}
	}, &ctx)

	// Deterministic per-space ids: every device's seeding of the same
	// space converges on the SAME objects, so multi-device sync unions
	// changes instead of duplicating definitions per install.
	prefix := len(channel_id) >= 8 ? channel_id[:8] : channel_id
	created := 0
	updated := 0
	for r in BUNDLED_RELATIONS {
		if e, ok := rels[r.key]; ok {
			if e.emoji != r.emoji {
				ops := []Operation{{kind = .Field_Set, key = "iconEmoji", value = string_value(r.emoji)}}
				if commit_ops(e.id, ops) do updated += 1
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
		if commit_ops(id, ops) do created += 1
	}
	for t in BUNDLED_TYPES {
		if e, ok := types[t.key]; ok {
			ops := make([dynamic]Operation, context.temp_allocator)
			if e.name != t.name do append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value(t.name)})
			if e.emoji != t.emoji do append(&ops, Operation{kind = .Field_Set, key = "iconEmoji", value = string_value(t.emoji)})
			if len(ops) > 0 && commit_ops(e.id, ops[:]) do updated += 1
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
		if commit_ops(id, ops) do created += 1
	}
	if created > 0 || updated > 0 do fmt.printfln("[glon-odin] space %s: seeded %d / converged %d default def(s)", prefix, created, updated)
}

/**
 * Startup pass: every space gets its own default definitions, and the
 * legacy GLOBAL bundled defs (no space stamp, from the vault-wide era)
 * are retired with a soft delete once per-space copies exist.
 */
bootstrap_space_defaults :: proc() {
	chans := make([dynamic]string)
	defer delete(chans)
	legacy := make([dynamic]string)
	defer delete(legacy)
	Ctx :: struct {
		chans:  ^[dynamic]string,
		legacy: ^[dynamic]string,
	}
	ctx := Ctx{&chans, &legacy}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
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

	for c in chans do seed_space_defaults(c)
	for id in legacy {
		ops := []Operation{{kind = .Object_Delete}}
		commit_ops(id, ops)
	}
	if len(legacy) > 0 do fmt.printfln("[glon-odin] retired %d legacy global def(s)", len(legacy))
}

// ── Bundled types ────────────────────────────────────────────────────
//
// Type objects (Anytype's ObjectType analog): `key` is the typeKey objects
// carry, `layout` drives rendering ("page" | "task" — task swaps the icon
// for a checkbox bound to the bundled `done` relation; that pairing is
// metadata, nothing enforces it), and `default_template_id` (set from the
// UI) names the template new objects copy their blocks from.

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

Block_Meta :: struct {
	object_id: string,
	block_id:  string,
	pairs:     [dynamic]Str_Pair,
	found:     bool,
}

/** Read a custom block's meta pairs from computed state (temp-cloned). */
block_custom_meta :: proc(object_id, block_id: string) -> Block_Meta {
	m := Block_Meta {
		object_id = object_id,
		block_id  = block_id,
	}
	m.pairs = make([dynamic]Str_Pair, context.temp_allocator)
	if object_id == "" || block_id == "" do return m
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
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
oldest_channel_id :: proc() -> string {
	Ctx :: struct {
		id:      string,
		created: i64,
	}
	ctx := Ctx{"", 0}
	with_states(proc(states: map[string]^Object_State, user: rawptr) {
		c := cast(^Ctx)user
		for _, s in states {
			if s.type_key != "channel" || s.deleted do continue
			if c.id == "" || s.created_at < c.created {
				c.created = s.created_at
				c.id = strings.clone(s.id, context.temp_allocator)
			}
		}
	}, &ctx)
	return ctx.id
}
