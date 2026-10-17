package core

// Pins. Each pinned object carries its own position in its space's sidebar
// (`pin_order`, a sortable text key): pinning, unpinning or moving one
// object writes only that object, so edits from different devices to
// different pins all survive. A space's pin list is its live objects with a
// position, in key order (id breaks ties). Spaces used to hold the whole
// ordered list as one value (`pinnedIds`) that every edit rewrote and
// concurrent edits overwrote; pins_from_list converts it.

import "core:slice"
import "core:strings"

PIN_KEY :: "pin_order"
// Retired: a space's whole pin list as one value. Converted by pins_from_list.
PIN_LIST_KEY :: "pinnedIds"

PIN_DIGITS :: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

pin_digit :: proc(c: u8) -> int {
	return strings.index_byte(PIN_DIGITS, c)
}

/**
 * A key strictly between `a` and `b` ("" for a = before everything; has_b
 * false = after everything). Keys never end in '0', so there is always room
 * between two of them. The website's lib/pins.ts is the same algorithm.
 */
pin_key_between :: proc(a: string, b: string, has_b: bool, allocator := context.temp_allocator) -> string {
	if has_b {
		n := 0
		for n < len(b) && (n < len(a) ? a[n] : '0') == b[n] do n += 1
		if n > 0 {
			rest := pin_key_between(n < len(a) ? a[n:] : "", b[n:], true, allocator)
			return strings.concatenate({b[:n], rest}, allocator)
		}
	}
	digits := PIN_DIGITS
	lo := len(a) > 0 ? pin_digit(a[0]) : 0
	hi := has_b && len(b) > 0 ? pin_digit(b[0]) : len(PIN_DIGITS)
	if hi - lo > 1 {
		mid := (lo + hi + 1) / 2
		return strings.clone(digits[mid:mid + 1], allocator)
	}
	if has_b && len(b) > 1 do return strings.clone(b[:1], allocator)
	rest := pin_key_between(len(a) > 1 ? a[1:] : "", "", false, allocator)
	return strings.concatenate({digits[lo:lo + 1], rest}, allocator)
}

Pin_Entry :: struct {
	id:  string,
	key: string,
}

/**
 * Pinned objects per space, in sidebar order. An object with no space
 * belongs to `default_space` (the oldest), as everywhere else.
 */
pins_by_space :: proc(states: map[string]^Object_State, default_space: string, allocator := context.temp_allocator) -> map[string][dynamic]string {
	entries := make(map[string][dynamic]Pin_Entry, allocator = context.temp_allocator)
	for id, s in states {
		if s.deleted do continue
		key := field_string(s.fields, PIN_KEY)
		if key == "" do continue
		space := field_string(s.fields, "channel")
		if space == "" do space = default_space
		list, ok := &entries[space]
		if !ok {
			entries[space] = make([dynamic]Pin_Entry, context.temp_allocator)
			list = &entries[space]
		}
		append(list, Pin_Entry{id, key})
	}
	out := make(map[string][dynamic]string, allocator = allocator)
	for space, list in entries {
		slice.sort_by(list[:], proc(x, y: Pin_Entry) -> bool { return x.key != y.key ? x.key < y.key : x.id < y.id })
		ids := make([dynamic]string, allocator)
		for e in list do append(&ids, e.id)
		out[space] = ids
	}
	return out
}

/** The highest position in a space (or "" when none is pinned). */
pins_last_key :: proc(states: map[string]^Object_State, space: string, default_space: string) -> string {
	last := ""
	for _, s in states {
		if s.deleted do continue
		key := field_string(s.fields, PIN_KEY)
		if key == "" do continue
		owner := field_string(s.fields, "channel")
		if owner == "" do owner = default_space
		if owner == space && key > last do last = key
	}
	return last
}

/** The lowest position in a space, and whether any object there is pinned. */
pins_first_key :: proc(states: map[string]^Object_State, space: string, default_space: string) -> (string, bool) {
	first := ""
	found := false
	for _, s in states {
		if s.deleted do continue
		key := field_string(s.fields, PIN_KEY)
		if key == "" do continue
		owner := field_string(s.fields, "channel")
		if owner == "" do owner = default_space
		if owner == space && (!found || key < first) {
			first = key
			found = true
		}
	}
	return first, found
}

/** The oldest live space: owner of objects with no space. */
pins_default_space :: proc(states: map[string]^Object_State) -> string {
	best := ""
	best_at: i64 = 0
	for id, s in states {
		if s.deleted || s.type_key != "channel" do continue
		if best == "" || s.created_at < best_at || (s.created_at == best_at && id < best) {
			best = id
			best_at = s.created_at
		}
	}
	return best
}

/**
 * Convert a space's retired pin list into positions: each listed object
 * without one gets the next position after the space's last, in list order,
 * and the list goes. Objects already positioned keep theirs, so a list an
 * older client writes again later only adds what it newly pinned.
 * Deterministic: devices converting at once write the same values.
 */
pins_from_list :: proc(plan: ^Mutation_Plan, input: Mutation_Input, space_id: string, default_space: string) {
	space, ok := input.states[space_id]
	if !ok || space.deleted do return
	list, has := fields_get(space.fields, PIN_LIST_KEY)
	if !has do return
	last := pins_last_key(input.states, space_id, default_space)
	if list.kind == .List {
		for item in list.items {
			if item.kind != .String || item.str == "" do continue
			obj, live := input.states[item.str]
			if !live || obj.deleted || field_string(obj.fields, PIN_KEY) != "" do continue
			last = pin_key_between(last, "", false)
			mutation_add(plan, input, item.str, {Operation{kind = .Field_Set, key = PIN_KEY, value = string_value(last)}})
		}
	}
	mutation_add(plan, input, space_id, {Operation{kind = .Field_Delete, key = PIN_LIST_KEY}})
}
