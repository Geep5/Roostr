package glon

// Query engine — port of glon/src/query.ts (Anytype database.Query
// semantics): 17 conditions, and/or nesting, date quickOptions,
// hierarchical sorts with emptyPlacement, text search, paging.

import "core:strings"
import "core:slice"
import "core:fmt"
import "core:encoding/json"

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
		if p.num == f64(i64(p.num)) do return fmt.tprintf("%d", i64(p.num))
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
	// Local-time day boundaries approximated as UTC days; acceptable for
	// personal notes filtering (documented deviation from the TS engine).
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
	return false
}

// ── Entry point ──────────────────────────────────────────────────────

Sort_Spec :: struct {
	key:             string,
	desc:            bool,
	empty_placement: string,
}

run_query :: proc(
	states: map[string]^Object_State,
	body: json.Value,
	extra_filter: json.Value = nil,
	allocator := context.temp_allocator,
) -> [dynamic]^Object_State {
	now := f64(unix_ms())
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
		for f in filters {
			if !matches_filter(s, f, now) do continue loop
		}
		if extra_filter != nil && !matches_filter(s, extra_filter, now) do continue
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
		g_sorts = sorts // queries are serialized under the store lock
		slice.sort_by(out[:], sort_less)
	}

	// Paging.
	offset, has_offset := json_int(body, "offset")
	limit, has_limit := json_int(body, "limit")
	start := has_offset ? int(offset) : 0
	if start > len(out) do start = len(out)
	end := has_limit ? start + int(limit) : len(out)
	if end > len(out) do end = len(out)
	paged := make([dynamic]^Object_State, allocator)
	append(&paged, ..out[start:end])
	return paged
}

g_sorts: [dynamic]Sort_Spec

sort_less :: proc(a, b: ^Object_State) -> bool {
	for s in g_sorts {
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
