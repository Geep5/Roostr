package core

// Query engine — port of glon/src/query.ts (Anytype database.Query
// semantics): 17 conditions, and/or nesting, date quickOptions,
// hierarchical sorts with emptyPlacement, text search, paging.

import "core:strings"
import "core:slice"
import "core:fmt"
import "core:encoding/json"
import "core:mem"
import "base:runtime"

Plain_Kind :: enum u8 {
	Null,
	String,
	Number,
	Bool,
	List,
}

Plain :: struct {
	kind:    Plain_Kind,
	str:     string,
	num:     f64,
	b:       bool,
	list:    [dynamic]Plain,
}

plain_null :: proc() -> Plain {
	return Plain{kind = .Null}
}

value_to_plain :: proc(v: Value, allocator := context.temp_allocator) -> Plain {
	switch v.kind {
	case .None:
		return plain_null()
	case .String:
		return Plain{kind = .String, str = v.str}
	case .Int:
		return Plain{kind = .Number, num = f64(v.i)}
	case .Float:
		return Plain{kind = .Number, num = v.f}
	case .Bool:
		return Plain{kind = .Bool, b = v.b}
	case .Bytes:
		return plain_null()
	case .String_List:
		out := Plain{kind = .List}
		out.list = make([dynamic]Plain, allocator)
		for s in v.strings do append(&out.list, Plain{kind = .String, str = s})
		return out
	case .Map:
		return plain_null() // maps aren't comparable
	case .List:
		out := Plain{kind = .List}
		out.list = make([dynamic]Plain, allocator)
		for item in v.items do append(&out.list, value_to_plain(item, allocator))
		return out
	case .Link:
		return Plain{kind = .String, str = v.link_target}
	}
	return plain_null()
}

json_to_plain :: proc(v: json.Value, allocator := context.temp_allocator) -> Plain {
	#partial switch x in v {
	case json.String:
		return Plain{kind = .String, str = string(x)}
	case json.Integer:
		return Plain{kind = .Number, num = f64(x)}
	case json.Float:
		return Plain{kind = .Number, num = f64(x)}
	case json.Boolean:
		return Plain{kind = .Bool, b = bool(x)}
	case json.Array:
		out := Plain{kind = .List}
		out.list = make([dynamic]Plain, allocator)
		for item in x do append(&out.list, json_to_plain(item, allocator))
		return out
	case json.Object:
		// ValueJSON-shaped filter values arrive from stored viewFilters.
		return value_to_plain(value_from_json(v, allocator), allocator)
	}
	return plain_null()
}

read_record_value :: proc(s: ^Object_State, key: string, allocator := context.temp_allocator) -> Plain {
	switch key {
	case "id":
		return Plain{kind = .String, str = s.id}
	case "type", "typeKey":
		return Plain{kind = .String, str = s.type_key}
	case "createdAt":
		return Plain{kind = .Number, num = f64(s.created_at)}
	case "updatedAt":
		return Plain{kind = .Number, num = f64(s.updated_at)}
	case "deleted":
		return Plain{kind = .Bool, b = s.deleted}
	}
	if v, ok := fields_get(s.fields, key); ok do return value_to_plain(v, allocator)
	return plain_null()
}

is_empty_plain :: proc(p: Plain) -> bool {
	switch p.kind {
	case .Null:
		return true
	case .String:
		return p.str == ""
	case .Number:
		return p.num == 0
	case .Bool:
		return !p.b
	case .List:
		return len(p.list) == 0
	}
	return false
}

plain_equal :: proc(a, b: Plain) -> bool {
	if a.kind != b.kind {
		return false
	}
	switch a.kind {
	case .Null:
		return true
	case .String:
		return a.str == b.str
	case .Number:
		return a.num == b.num
	case .Bool:
		return a.b == b.b
	case .List:
		if len(a.list) != len(b.list) do return false
		for x, i in a.list do if !plain_equal(x, b.list[i]) do return false
		return true
	}
	return false
}

compare_plain :: proc(a, b: Plain) -> int {
	if a.kind == .Number && b.kind == .Number {
		if a.num < b.num do return -1
		if a.num > b.num do return 1
		return 0
	}
	if a.kind == .Bool && b.kind == .Bool {
		return int(a.b ? 1 : 0) - int(b.b ? 1 : 0)
	}
	sa := plain_string(a)
	sb := plain_string(b)
	return strings.compare(sa, sb)
}

plain_string :: proc(p: Plain) -> string {
	#partial switch p.kind {
	case .String:
		return p.str
	case .Number:
		if p.num >= -9_223_372_036_854_775_808.0 && p.num < 9_223_372_036_854_775_808.0 {
			if p.num == f64(i64(p.num)) do return fmt.tprintf("%d", i64(p.num))
		}
		return fmt.tprintf("%v", p.num)
	case .Bool:
		return p.b ? "true" : "false"
	}
	return ""
}

as_list :: proc(p: Plain, allocator := context.temp_allocator) -> [dynamic]Plain {
	out := make([dynamic]Plain, allocator)
	if p.kind == .Null do return out
	if p.kind == .List {
		append(&out, ..p.list[:])
		return out
	}
	append(&out, p)
	return out
}

list_contains :: proc(haystack: [dynamic]Plain, needle: Plain) -> bool {
	for h in haystack do if plain_equal(h, needle) do return true
	return false
}

// ── Filters ──────────────────────────────────────────────────────────

DAY_MS :: 86_400_000.0

Quick_Range :: struct {
	start: f64,
	end:   f64,
}

quick_option_range :: proc(option: string, value: Plain, now_unix_ms: f64) -> (Quick_Range, bool) {
	// Shared native/browser contract: UTC day boundaries, Monday-start weeks.
	day_start := now_unix_ms - mod_f64(now_unix_ms, DAY_MS)
	// Week starts Monday: unix epoch (1970-01-01) was a Thursday (weekday 3).
	days_since_epoch := day_start / DAY_MS
	weekday := mod_f64(days_since_epoch + 3, 7)
	week_start := day_start - weekday * DAY_MS
	days := value.kind == .Number ? value.num : 0

	switch option {
	case "today":
		return {day_start, day_start + DAY_MS - 1}, true
	case "yesterday":
		return {day_start - DAY_MS, day_start - 1}, true
	case "tomorrow":
		return {day_start + DAY_MS, day_start + 2 * DAY_MS - 1}, true
	case "currentWeek":
		return {week_start, week_start + 7 * DAY_MS - 1}, true
	case "lastWeek":
		return {week_start - 7 * DAY_MS, week_start - 1}, true
	case "nextWeek":
		return {week_start + 7 * DAY_MS, week_start + 14 * DAY_MS - 1}, true
	case "numberOfDaysAgo":
		return {day_start - days * DAY_MS, day_start - 1}, true
	case "numberOfDaysNow":
		return {day_start, day_start + days * DAY_MS - 1}, true
	case "exactDate":
		ts := value.num
		s := ts - mod_f64(ts, DAY_MS)
		return {s, s + DAY_MS - 1}, true
	}
	return {}, false
}

mod_f64 :: proc(a, b: f64) -> f64 {
	m := a - b * f64(i64(a / b))
	if m < 0 do m += b
	return m
}

eval_condition :: proc(v: Plain, condition: string, filter_value: Plain) -> bool {
	switch condition {
	case "equal", "":
		if v.kind == .List || filter_value.kind == .List {
			a := as_list(v)
			b := as_list(filter_value)
			if len(a) != len(b) do return false
			for x, i in a do if !plain_equal(x, b[i]) do return false
			return true
		}
		return plain_equal(v, filter_value)
	case "notEqual":
		return !eval_condition(v, "equal", filter_value)
	case "greater", "less", "greaterOrEqual", "lessOrEqual":
		if v.kind == .Null || filter_value.kind == .Null || v.kind == .List || filter_value.kind == .List do return false
		c := compare_plain(v, filter_value)
		switch condition {
		case "greater":
			return c > 0
		case "less":
			return c < 0
		case "greaterOrEqual":
			return c >= 0
		}
		return c <= 0
	case "like", "notLike":
		hit := false
		if v.kind != .Null {
			hv := strings.to_lower(plain_string(v), context.temp_allocator)
			nv := strings.to_lower(plain_string(filter_value), context.temp_allocator)
			hit = strings.contains(hv, nv)
		}
		return condition == "like" ? hit : !hit
	case "in", "notIn":
		fset := as_list(filter_value)
		vset := as_list(v)
		hit := false
		for x in vset do if list_contains(fset, x) {
			hit = true
			break
		}
		return condition == "in" ? hit : !hit
	case "allIn", "notAllIn":
		fset := as_list(filter_value)
		vset := as_list(v)
		hit := len(fset) > 0
		for x in fset do if !list_contains(vset, x) {
			hit = false
			break
		}
		return condition == "allIn" ? hit : !hit
	case "exactIn", "notExactIn":
		fset := as_list(filter_value)
		vset := as_list(v)
		hit := len(fset) == len(vset)
		if hit {
			for x in fset do if !list_contains(vset, x) {
				hit = false
				break
			}
		}
		return condition == "exactIn" ? hit : !hit
	case "empty":
		return is_empty_plain(v)
	case "notEmpty":
		return !is_empty_plain(v)
	case "exists":
		return v.kind != .Null
	}
	return false
}

eval_date_window :: proc(v: Plain, condition: string, window: Quick_Range) -> bool {
	if v.kind != .Number do return condition == "notEqual"
	x := v.num
	switch condition {
	case "equal", "":
		return x >= window.start && x <= window.end
	case "notEqual":
		return x < window.start || x > window.end
	case "greater":
		return x > window.end
	case "greaterOrEqual":
		return x >= window.start
	case "less":
		return x < window.start
	case "lessOrEqual":
		return x <= window.end
	}
	return eval_condition(v, condition, plain_null())
}

/** One filter (possibly a nested and/or group) against a state. */
matches_filter :: proc(s: ^Object_State, filter: json.Value, now_ms: f64) -> bool {
	if nested, ok := json_field(filter, "nested"); ok {
		if arr, aok := nested.(json.Array); aok && len(arr) > 0 {
			op := json_str(filter, "operator")
			if op == "or" {
				for f in arr do if matches_filter(s, f, now_ms) do return true
				return false
			}
			for f in arr do if !matches_filter(s, f, now_ms) do return false
			return true
		}
	}
	key := json_str(filter, "key")
	condition := json_str(filter, "condition")
	if condition == "exists" {
		switch key {
		case "id", "type", "typeKey", "deleted":
			return true
		case "createdAt", "updatedAt":
			return true
		}
		_, ok := fields_get(s.fields, key)
		return ok
	}
	v := read_record_value(s, key)
	raw_value, _ := json_field(filter, "value")
	fv := json_to_plain(raw_value)
	quick := json_str(filter, "quickOption")
	if quick != "" {
		if window, ok := quick_option_range(quick, fv, now_ms); ok {
			return eval_date_window(v, condition, window)
		}
	}
	return eval_condition(v, condition, fv)
}

// ── Text search ──────────────────────────────────────────────────────

text_matches :: proc(s: ^Object_State, needle: string) -> bool {
	n := strings.to_lower(needle, context.temp_allocator)
	if strings.contains(strings.to_lower(s.id, context.temp_allocator), n) do return true
	if strings.contains(strings.to_lower(s.type_key, context.temp_allocator), n) do return true
	for e in s.fields {
		p := value_to_plain(e.value)
		flat := as_list(p)
		for x in flat {
			if x.kind == .String && strings.contains(strings.to_lower(x.str, context.temp_allocator), n) do return true
		}
	}
	// Fulltext over block content (Anytype's ObjectSearchWithMeta scope).
	for b in s.blocks {
		if b.content.kind != .Text do continue
		if strings.contains(strings.to_lower(b.content.text.text, context.temp_allocator), n) do return true
	}
	return false
}

/** First block whose text matches, trimmed around the hit — the result
 * row's snippet line (Anytype's search meta). */
text_snippet :: proc(s: ^Object_State, needle: string) -> string {
	n := strings.to_lower(needle, context.temp_allocator)
	for b in s.blocks {
		if b.content.kind != .Text do continue
		text := b.content.text.text
		lower := strings.to_lower(text, context.temp_allocator)
		idx := strings.index(lower, n)
		if idx < 0 do continue
		// idx is an offset into the LOWERED copy: to_lower can expand
		// invalid UTF-8 (each bad byte becomes a 3-byte replacement
		// char), so idx may land past len(text). Clamp both ends to the
		// original before slicing.
		start := clamp(idx - 40, 0, len(text))
		end := clamp(idx + len(n) + 60, 0, len(text))
		if start >= end do return ""
		out := text[start:end]
		if start > 0 do out = strings.concatenate({"…", out}, context.temp_allocator)
		if end < len(text) do out = strings.concatenate({out, "…"}, context.temp_allocator)
		return out
	}
	return ""
}

// ── Entry point ──────────────────────────────────────────────────────

Sort_Spec :: struct {
	key:             string,
	desc:            bool,
	empty_placement: string,
}

// `matched` is the number of objects the filters selected, before paging:
// a caller that asked for one page still learns how many exist, which is
// what lets a client page to exhaustion instead of silently truncating.
run_query :: proc(
	states: map[string]^Object_State,
	body: json.Value,
	now_ms: f64,
	extra_filter: json.Value = nil,
	allocator := context.temp_allocator,
	matched: ^int = nil,
) -> [dynamic]^Object_State {
	include_deleted, _ := json_bool(body, "includeDeleted")
	text := json_str(body, "textQuery")
	type_eq := json_str(body, "type")

	filters: json.Array
	if f, ok := json_field(body, "filters"); ok {
		if arr, aok := f.(json.Array); aok do filters = arr
	}

	out := make([dynamic]^Object_State, allocator)
	loop: for _, s in states {
		if s.deleted && !include_deleted do continue
		if type_eq != "" && s.type_key != type_eq do continue
		// The vanish ledger is bookkeeping, not content: a singleton whose
		// fields are one key per deleted object. It is already absent from
		// /api/objects, but an untyped query returned it, so any query-driven
		// list showed a nameless row that opened an empty object page. Asking
		// for it by type still works, which is how the sync daemon reads it.
		if type_eq == "" && s.type_key == "vanish_log" do continue
		for f in filters {
			if !matches_filter(s, f, now_ms) do continue loop
		}
		if extra_filter != nil && !matches_filter(s, extra_filter, now_ms) do continue
		if text != "" && !text_matches(s, text) do continue
		append(&out, s)
	}

	// Sorts (hierarchical, empties per placement, id tiebreak).
	sorts := make([dynamic]Sort_Spec, context.temp_allocator)
	if sv, ok := json_field(body, "sorts"); ok {
		if arr, aok := sv.(json.Array); aok {
			for sspec in arr {
				append(&sorts, Sort_Spec{
					key = json_str(sspec, "key"),
					desc = json_str(sspec, "type") == "desc",
					empty_placement = json_str(sspec, "emptyPlacement"),
				})
			}
		}
	}
	if len(sorts) > 0 {
		slice.sort_by_with_data(out[:], sort_less, &sorts)
	}

	// Paging. The full match count goes out before the slice.
	if matched != nil do matched^ = len(out)
	offset, has_offset := json_int(body, "offset")
	limit, has_limit := json_int(body, "limit")
	// A page is only meaningful over a total order. Sorted queries already
	// tiebreak on id; an unsorted one is in map order, which rehashes on
	// insert — so consecutive pages could repeat or skip a record. Order
	// by id when paging, and only then: full reads pay nothing.
	if len(sorts) == 0 && (has_offset || has_limit) {
		slice.sort_by(out[:], proc(a, b: ^Object_State) -> bool {return a.id < b.id})
	}
	start := has_offset ? int(clamp(offset, 0, i64(len(out)))) : 0
	count := has_limit ? int(clamp(limit, 0, i64(len(out) - start))) : len(out) - start
	// Retain the allocation and capacity; paging needs no second row array.
	copy(out[:count], out[start:start + count])
	resize(&out, count)
	return out
}

sort_less :: proc(a, b: ^Object_State, user_data: rawptr) -> bool {
	sorts := (^([dynamic]Sort_Spec))(user_data)
	for s in sorts^ {
		va := read_record_value(a, s.key)
		vb := read_record_value(b, s.key)
		ea := is_empty_plain(va)
		eb := is_empty_plain(vb)
		if ea || eb {
			if ea && eb do continue
			empty_first := s.empty_placement == "start"
			return ea ? empty_first : !empty_first
		}
		c := compare_plain(va, vb)
		if c != 0 do return s.desc ? c > 0 : c < 0
	}
	return strings.compare(a.id, b.id) < 0
}

// Anytype resolveSources: type keys become type-in, relation keys exists; OR.
resolve_set_filter :: proc(states: map[string]^Object_State, set_obj: ^Object_State) -> json.Value {
	sources := make([dynamic]string, context.temp_allocator)
	if v, ok := fields_get(set_obj.fields, "setOf"); ok && v.kind == .List {
		for item in v.items do if item.kind == .String do append(&sources, item.str)
	}
	if len(sources) == 0 do return nil
	relation_keys := make(map[string]bool, allocator = context.temp_allocator)
	for _, s in states {
		if s.type_key != "relation" do continue
		if v, ok := fields_get(s.fields, "key"); ok && v.kind == .String do relation_keys[v.str] = true
	}
	parts := make([dynamic]json.Value, context.temp_allocator)
	type_values := make([dynamic]json.Value, context.temp_allocator)
	for src in sources {
		if relation_keys[src] {
			f := jobj()
			f["key"] = json.String(src)
			f["condition"] = json.String("exists")
			append(&parts, json.Object(f))
		} else {
			append(&type_values, json.String(src))
		}
	}
	if len(type_values) > 0 {
		f := jobj()
		f["key"] = json.String("type")
		f["condition"] = json.String("in")
		f["value"] = json.Array(type_values)
		append(&parts, json.Object(f))
	}
	if len(parts) == 1 do return parts[0]
	group := jobj()
	group["operator"] = json.String("or")
	group["nested"] = json.Array(parts)
	return json.Object(group)
}

query_result :: proc(states: map[string]^Object_State, body: json.Value, now_ms: f64) -> json.Value {
	extra: json.Value
	if set_obj, ok := states[json_str(body, "setId")]; ok do extra = resolve_set_filter(states, set_obj)
	total := 0
	matched := run_query(states, body, now_ms, extra, context.temp_allocator, &total)
	text := json_str(body, "textQuery")
	records := make([dynamic]json.Value, 0, len(matched), context.temp_allocator)
	for s in matched {
		row := jobj()
		row["id"] = json.String(s.id)
		row["typeKey"] = json.String(s.type_key)
		name := ""
		if v, ok := fields_get(s.fields, "name"); ok && v.kind == .String do name = v.str
		row["name"] = json.String(name)
		row["fields"] = fields_to_json(s.fields)
		row["createdAt"] = json.Integer(s.created_at)
		row["updatedAt"] = json.Integer(s.updated_at)
		if s.deleted do row["deleted"] = json.Boolean(true)
		if text != "" {
			if snippet := text_snippet(s, text); snippet != "" do row["snippet"] = json.String(snippet)
		}
		append(&records, json.Object(row))
	}
	out := jobj()
	out["total"] = json.Integer(total)
	out["records"] = json.Array(records)
	return json.Object(out)
}

// Each cached object owns a region; no dispatch-arena reference survives.
QUERY_CACHE_MAX_BYTES :: 128 * 1024 * 1024
QUERY_CACHE_MAX_OBJECTS :: 100_000
Query_Allocation :: struct {
	next: ^Query_Allocation,
	size: int,
}
Query_Cached_Object :: struct {
	state: Object_State,
	allocations: ^Query_Allocation,
	failed: bool,
}
query_cached_objects: map[string]^Query_Cached_Object
query_cached_states: map[string]^Object_State
query_cache_bytes: int
query_pending_objects: [dynamic]^Query_Cached_Object

query_pending_reset :: proc() {
	for owner in query_pending_objects {
		// A committed owner is now reachable through the snapshot map.
		if cached, ok := query_cached_objects[owner.state.id]; !ok || cached != owner {
			query_cached_object_destroy(owner)
		}
	}
	delete(query_pending_objects)
	query_pending_objects = nil
}

query_region_allocator :: proc(owner: ^Query_Cached_Object) -> mem.Allocator {
	return {procedure = query_region_allocate, data = owner}
}

query_region_allocate :: proc(
	data: rawptr, mode: mem.Allocator_Mode, size, alignment: int,
	old_memory: rawptr, old_size: int, loc := #caller_location,
) -> ([]byte, mem.Allocator_Error) {
	owner := (^Query_Cached_Object)(data)
	switch mode {
	case .Alloc, .Alloc_Non_Zeroed:
		if size == 0 do return nil, nil
		total := size + size_of(Query_Allocation) + alignment
		if total < size || total > QUERY_CACHE_MAX_BYTES - query_cache_bytes {
			owner.failed = true
			return nil, .Out_Of_Memory
		}
		heap := runtime.default_allocator()
		bytes, err := heap.procedure(heap.data, .Alloc, total, max(alignment, align_of(Query_Allocation)), nil, 0, loc)
		if err != nil {
			owner.failed = true
			return nil, err
		}
		node := (^Query_Allocation)(raw_data(bytes))
		node^ = {next = owner.allocations, size = total}
		owner.allocations = node
		query_cache_bytes += total
		start := mem.align_forward(rawptr(([^]byte)(node)[size_of(Query_Allocation):]), uintptr(alignment))
		return ([^]byte)(start)[:size], nil
	case .Resize, .Resize_Non_Zeroed:
		return mem.default_resize_bytes_align(mem.byte_slice(old_memory, old_size), size, alignment, query_region_allocator(owner), loc)
	case .Free:
		return nil, nil // reclaimed together when the cached object is replaced
	case .Query_Features:
		if set := (^mem.Allocator_Mode_Set)(old_memory); set != nil {
			set^ = {.Alloc, .Alloc_Non_Zeroed, .Resize, .Resize_Non_Zeroed, .Free, .Query_Features}
		}
		return nil, nil
	case .Free_All, .Query_Info:
		return nil, .Mode_Not_Implemented
	}
	return nil, nil
}

query_cached_object_destroy :: proc(owner: ^Query_Cached_Object) {
	node := owner.allocations
	for node != nil {
		next := node.next
		query_cache_bytes -= node.size
		mem.free(node, runtime.default_allocator())
		node = next
	}
	free(owner, runtime.default_allocator())
}

query_cache_reset :: proc() {
	query_pending_reset()
	for _, owner in query_cached_objects do query_cached_object_destroy(owner)
	delete(query_cached_objects)
	query_cached_objects = nil
	delete(query_cached_states)
	query_cached_states = nil
}

// Unknown conditions and quickOptions retain historical false/fallback behavior.
query_json_depth_ok :: proc(value: json.Value, depth := 0) -> bool {
	if depth > 64 do return false
	#partial switch v in value {
	case json.Object:
		for _, child in v do if !query_json_depth_ok(child, depth + 1) do return false
	case json.Array:
		for child in v do if !query_json_depth_ok(child, depth + 1) do return false
	case json.Float:
		// Model integer fields truncate floats; reject values that would trap
		// the WASM f64-to-i64 conversion before invoking those decoders.
		n := f64(v)
		if n != n || n < -9_223_372_036_854_775_808.0 || n >= 9_223_372_036_854_775_808.0 do return false
	}
	return true
}

query_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	if _, ok := payload.(json.Object); !ok do return nil, "query payload must be an object"
	if !query_json_depth_ok(payload) do return nil, "query exceeds nesting or numeric limits"
	body, _ := json_field(payload, "body")
	if _, ok := body.(json.Object); !ok do return nil, "query body must be an object"
	now, has_now := json_int(payload, "nowMs")
	if !has_now || now < -8_640_000_000_000_000 || now > 8_640_000_000_000_000 do return nil, "query nowMs must be a valid timestamp"
	if raw, present := json_field(payload, "objects"); present {
		states := make(map[string]^Object_State, allocator = context.temp_allocator)
		objects, ok := raw.(json.Array)
		if !ok || len(objects) > QUERY_CACHE_MAX_OBJECTS do return nil, "query objects must be a bounded array"
		for value in objects {
			state, valid := object_from_json(value, context.temp_allocator, clone_json = false)
			if !valid do return nil, "invalid query object"
			stored := new(Object_State, context.temp_allocator)
			stored^ = state
			states[state.id] = stored
		}
		return query_result(states, body, f64(now)), ""
	}
	upserts_value, _ := json_field(payload, "upserts")
	removed_value, _ := json_field(payload, "removed")
	upserts, upserts_ok := upserts_value.(json.Array)
	removed, removed_ok := removed_value.(json.Array)
	if !upserts_ok || !removed_ok || len(upserts) > QUERY_CACHE_MAX_OBJECTS || len(removed) > QUERY_CACHE_MAX_OBJECTS do return nil, "query cache updates must be bounded arrays"
	for id in removed do if _, ok := id.(json.String); !ok do return nil, "query removed ids must be strings"
	reset, _ := json_bool(payload, "reset")
	pending := make(map[string]^Query_Cached_Object, allocator = context.temp_allocator)
	query_pending_objects = make([dynamic]^Query_Cached_Object, 0, len(upserts), runtime.default_allocator())
	defer query_pending_reset()
	for value in upserts {
		if id := json_str(value, "id"); id == "" do return nil, "query object id is required"
		owner, alloc_error := new(Query_Cached_Object, runtime.default_allocator())
		if alloc_error != nil do return nil, "query cache allocation failed"
		append(&query_pending_objects, owner)
		// JSON parsing copies strings; model arrays share the same owner.
		owned, parse_error := json.parse(marshal(value), allocator = query_region_allocator(owner), parse_integers = true)
		if parse_error != nil || owner.failed {
			return nil, "query cache memory limit exceeded"
		}
		state, valid := object_from_json(owned, query_region_allocator(owner), clone_json = false)
		if !valid || owner.failed {
			return nil, "invalid query object or cache memory limit exceeded"
		}
		owner.state = state
		delete_key(&pending, state.id)
		pending[state.id] = owner
	}
	// Validate the prospective snapshot before changing persistent state.
	removed_ids := make(map[string]bool, allocator = context.temp_allocator)
	for id in removed do removed_ids[string(id.(json.String))] = true
	count := reset ? 0 : len(query_cached_objects)
	if !reset {
		for id in removed_ids do if _, ok := query_cached_objects[id]; ok do count -= 1
	}
	for id in pending {
		_, exists := query_cached_objects[id]
		if reset || !exists || removed_ids[id] do count += 1
	}
	if count > QUERY_CACHE_MAX_OBJECTS do return nil, "query cache object limit exceeded"
	if reset {
		for _, owner in query_cached_objects do query_cached_object_destroy(owner)
		delete(query_cached_objects)
		query_cached_objects = nil
		delete(query_cached_states)
		query_cached_states = nil
	}
	if query_cached_objects == nil do query_cached_objects = make(map[string]^Query_Cached_Object, allocator = runtime.default_allocator())
	if query_cached_states == nil do query_cached_states = make(map[string]^Object_State, allocator = runtime.default_allocator())
	for id_value in removed {
		id := string(id_value.(json.String))
		if owner, ok := query_cached_objects[id]; ok {
			delete_key(&query_cached_objects, id)
			delete_key(&query_cached_states, id)
			query_cached_object_destroy(owner)
		}
	}
	for id, owner in pending {
		if previous, ok := query_cached_objects[id]; ok {
			delete_key(&query_cached_objects, id)
			delete_key(&query_cached_states, id)
			query_cached_object_destroy(previous)
		}
		query_cached_objects[owner.state.id] = owner
		query_cached_states[owner.state.id] = &owner.state
	}
	return query_result(query_cached_states, body, f64(now)), ""
}
