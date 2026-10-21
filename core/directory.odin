package core

// Directories: what a device that holds only part of the vault (a "lite"
// replica) needs to draw the vault before it has downloaded it. One personal
// directory (`__directory__`, no channel: the personal stream) lists the
// spaces; one per space (`__directory__:<spaceId>`, channel = the space, so
// it routes and encrypts with it) lists the space's pins, types and
// properties and how many objects of each type the space holds.
//
// Entries, each one field of the directory object:
//   space:<spaceId>  Map{name, icon, created}           (personal)
//   device:<deviceRecordId>  Map{name, kind}            (personal; device.odin)
//   pin:<objectId>   Map{name, icon, type, order, collapsed}
//   type:<objectId>  Map{key, name, icon, layout, builtin}
//   rel:<objectId>   Map{key, name, icon, format, hidden, builtin}
//   count:<typeKey>:<device>  Int
// plus `name` and `version` (1 once the builder has completed it - a
// directory without `version` is not ready).
//
// Counts are summed over devices. Each device writes only its own
// `count:*:<device>` fields, so concurrent edits on different devices never
// collide in the DAG: every mutation adds its deltas to its device's field,
// and the builder (on a device that holds everything) writes its own field
// as the exact total minus the other devices' fields.
//
// Every mutation keeps the directories in step in the same plan
// (directory_maintain, from mutation_plan); `directories_repair` and
// bootstrap_space_defaults rebuild them from the whole vault.

import "core:fmt"
import "core:slice"
import "core:strings"

DIRECTORY_TYPE :: "directory"
DIRECTORY_ID :: "__directory__"
DIRECTORY_SPACE_PREFIX :: "__directory__:"
DIRECTORY_VERSION :: 1

// Bookkeeping and engine internals, never counted (and so never drawn as
// objects): the Rust SYSTEM_TYPE_KEYS list, the directories themselves and
// spaces and device records, which are the personal directory's entries.
DIRECTORY_UNCOUNTED_TYPES :: []string{DIRECTORY_TYPE, VANISH_LOG_TYPE, DEVICE_TYPE, "user_prefs", "channel", "typescript", "program", "json", "proto", "peer", "pinned_fact", "milestone", "descriptor", "install", "set"}

directory_space_id :: proc(space_id: string, allocator := context.temp_allocator) -> string {
	return strings.concatenate({DIRECTORY_SPACE_PREFIX, space_id}, allocator)
}

is_directory_id :: proc(id: string) -> bool {
	return id == DIRECTORY_ID || strings.has_prefix(id, DIRECTORY_SPACE_PREFIX)
}

/** The writing device's count suffix: the payload's `device`, else the author. Never holds ':' (the type key is split off at the last one). */
directory_device :: proc(input: Mutation_Input) -> string {
	device := input.device != "" ? input.device : input.author
	out, _ := strings.replace_all(device, ":", "_", context.temp_allocator)
	return out
}

directory_counted :: proc(type_key: string) -> bool {
	return type_key != "" && !slice.contains(DIRECTORY_UNCOUNTED_TYPES, type_key)
}

// Projected entries, keyed "<directory id>\x00<field key>"; counts keyed
// "<directory id>\x00<type key>". Every string is temp-cloned: plans outlive
// the native store generation the states come from.
Directory_Projection :: struct {
	entries: map[string]Value,
	counts:  map[string]i64,
}

@(private = "file")
projection_make :: proc() -> Directory_Projection {
	return Directory_Projection{entries = make(map[string]Value, context.temp_allocator), counts = make(map[string]i64, context.temp_allocator)}
}

@(private = "file")
pair_key :: proc(dir, key: string) -> string {
	return strings.concatenate({dir, "\x00", key}, context.temp_allocator)
}

@(private = "file")
pair_split :: proc(pair: string) -> (dir, key: string) {
	i := strings.index_byte(pair, 0)
	return pair[:i], pair[i + 1:]
}

@(private = "file")
cloned :: proc(fields: [dynamic]Value_Entry, key: string) -> string {
	return strings.clone(field_string(fields, key), context.temp_allocator)
}

@(private = "file")
flag :: proc(fields: [dynamic]Value_Entry, key: string) -> bool {
	v, ok := fields_get(fields, key)
	return ok && v.kind == .Bool && v.b
}

@(private = "file")
map_value :: proc(entries: ..Value_Entry) -> Value {
	v := Value{kind = .Map}
	v.entries = make([dynamic]Value_Entry, context.temp_allocator)
	append(&v.entries, ..entries)
	return v
}

/** Whether `s` shows in the directories: live, not vanished, not bookkeeping. */
directory_live :: proc(s: ^Object_State, vanished: map[string]Vanish_Entry) -> bool {
	if s == nil || s.type_key == "" || s.deleted do return false
	if s.type_key == DIRECTORY_TYPE || s.type_key == VANISH_LOG_TYPE || is_directory_id(s.id) do return false
	_, gone := state_vanished(vanished, s)
	return !gone
}

/** A live object with no `channel` that counts in the default space: everything but spaces and device records (personal entries). */
@(private = "file")
directory_needs_space :: proc(s: ^Object_State) -> bool {
	return s.type_key != "channel" && s.type_key != DEVICE_TYPE && field_string(s.fields, "channel") == ""
}

/** Add what one live object contributes: its entries, and `sign` to its type's count. */
directory_project :: proc(p: ^Directory_Projection, s: ^Object_State, default_space: string, sign: i64) {
	if s.type_key == "channel" {
		icon := cloned(s.fields, "iconImage")
		if icon == "" do icon = cloned(s.fields, "iconEmoji")
		p.entries[pair_key(DIRECTORY_ID, fmt.tprintf("space:%s", s.id))] = map_value(
			Value_Entry{"name", string_value(cloned(s.fields, "name"))},
			Value_Entry{"icon", string_value(icon)},
			Value_Entry{"created", int_value(s.created_at)},
		)
		return
	}
	// A lite replica learns the account's device records from here (their
	// ids are per install); last_seen stays out so the directory is written
	// only when a device appears, goes or is renamed.
	if s.type_key == DEVICE_TYPE {
		p.entries[pair_key(DIRECTORY_ID, fmt.tprintf("device:%s", s.id))] = map_value(
			Value_Entry{"name", string_value(cloned(s.fields, "name"))},
			Value_Entry{"kind", string_value(cloned(s.fields, "kind"))},
		)
		return
	}
	space := field_string(s.fields, "channel")
	if space == "" do space = default_space
	if space == "" do return
	dir := directory_space_id(space)
	if order := cloned(s.fields, PIN_KEY); order != "" {
		p.entries[pair_key(dir, fmt.tprintf("pin:%s", s.id))] = map_value(
			Value_Entry{"name", string_value(cloned(s.fields, "name"))},
			Value_Entry{"icon", string_value(cloned(s.fields, "iconEmoji"))},
			Value_Entry{"type", string_value(strings.clone(s.type_key, context.temp_allocator))},
			Value_Entry{"order", string_value(order)},
			Value_Entry{"collapsed", bool_value(flag(s.fields, "pin_collapsed"))},
		)
	}
	builtin := flag(s.fields, "bundled") || flag(s.fields, "system")
	switch s.type_key {
	case "type":
		p.entries[pair_key(dir, fmt.tprintf("type:%s", s.id))] = map_value(
			Value_Entry{"key", string_value(cloned(s.fields, "key"))},
			Value_Entry{"name", string_value(cloned(s.fields, "name"))},
			Value_Entry{"icon", string_value(cloned(s.fields, "iconEmoji"))},
			Value_Entry{"layout", string_value(cloned(s.fields, "layout"))},
			Value_Entry{"builtin", bool_value(builtin)},
		)
	case "relation":
		p.entries[pair_key(dir, fmt.tprintf("rel:%s", s.id))] = map_value(
			Value_Entry{"key", string_value(cloned(s.fields, "key"))},
			Value_Entry{"name", string_value(cloned(s.fields, "name"))},
			Value_Entry{"icon", string_value(cloned(s.fields, "iconEmoji"))},
			Value_Entry{"format", string_value(cloned(s.fields, "format"))},
			Value_Entry{"hidden", bool_value(flag(s.fields, "hidden"))},
			Value_Entry{"builtin", bool_value(builtin)},
		)
	}
	if directory_counted(s.type_key) do p.counts[pair_key(dir, s.type_key)] += sign
}

/**
 * An object's state after this plan: its stored fields with the plan's
 * field and lifecycle ops applied (blocks do not matter here), nil when it
 * does not exist. `changes` are the plan's change indices for the object.
 */
@(private = "file")
directory_after :: proc(input: Mutation_Input, plan: ^Mutation_Plan, id: string, changes: []int) -> ^Object_State {
	out := new(Object_State, context.temp_allocator)
	out.id = id
	out.fields = make([dynamic]Value_Entry, context.temp_allocator)
	if stored := input.states[id]; stored != nil {
		out.type_key = stored.type_key
		out.deleted = stored.deleted
		out.created_at = stored.created_at
		append(&out.fields, ..stored.fields[:])
	}
	for index in changes {
		change := &plan.changes[index]
		for op in change.ops {
			#partial switch op.kind {
			case .Object_Create:
				// As replay: a later create retypes or revives.
				out.type_key = op.type_key
				out.created_at = change.timestamp
				out.deleted = false
			case .Object_Delete: out.deleted = true
			case .Field_Set: fields_set(&out.fields, op.key, op.value)
			case .Field_Delete: fields_delete(&out.fields, op.key)
			}
		}
	}
	if out.type_key == "" do return nil
	return out
}

@(private = "file")
plan_index :: proc(plan: ^Mutation_Plan) -> map[string][dynamic]int {
	index := make(map[string][dynamic]int, context.temp_allocator)
	for change, i in plan.changes {
		list, seen := index[change.object_id]
		if !seen do list = make([dynamic]int, context.temp_allocator)
		append(&list, i)
		index[change.object_id] = list
	}
	return index
}

/** The ledger after this plan, with the ids it vanishes. */
@(private = "file")
vanished_after :: proc(input: Mutation_Input, plan: ^Mutation_Plan, index: map[string][dynamic]int) -> map[string]Vanish_Entry {
	ledger := input.states[VANISH_LOG_ID]
	if changes, touched := index[VANISH_LOG_ID]; touched do ledger = directory_after(input, plan, VANISH_LOG_ID, changes[:])
	vanished := vanished_from_ledger(ledger)
	for id in plan.vanish_ids do if id not_in vanished do vanished[strings.clone(id, context.temp_allocator)] = Vanish_Entry{at = input.timestamp}
	return vanished
}

/** A directory that may be written: it exists, is live, and its space is not gone. */
@(private = "file")
directory_writable :: proc(dir: ^Object_State, dir_id: string, vanished: map[string]Vanish_Entry) -> bool {
	if dir == nil || dir.deleted || dir.type_key != DIRECTORY_TYPE do return false
	if dir_id in vanished do return false
	if strings.has_prefix(dir_id, DIRECTORY_SPACE_PREFIX) && dir_id[len(DIRECTORY_SPACE_PREFIX):] in vanished do return false
	return true
}

/** The directory's own count field for a type on this device. */
@(private = "file")
count_key :: proc(type_key, device: string) -> string {
	return fmt.tprintf("count:%s:%s", type_key, device)
}

/** Append `ops` on `dir_id`, split so every change fits one relay part. */
@(private = "file")
directory_emit :: proc(plan: ^Mutation_Plan, input: Mutation_Input, dir_id: string, ops: []Operation) {
	if len(ops) == 0 do return
	base := Change{object_id = dir_id, timestamp = input.timestamp, author = input.author}
	base_size := len(encode_change(base, false, context.temp_allocator))
	start := 0
	size := base_size
	for op, i in ops {
		one := base
		one.ops = make([dynamic]Operation, context.temp_allocator)
		append(&one.ops, op)
		op_size := len(encode_change(one, false, context.temp_allocator)) - base_size
		if i > start && size + op_size > MUTATION_CHANGE_MAX_BYTES {
			mutation_add(plan, input, dir_id, ops[start:i])
			start = i
			size = base_size
		}
		size += op_size
	}
	mutation_add(plan, input, dir_id, ops[start:])
}

@(private = "file")
sorted_keys :: proc(m: map[string]$V) -> [dynamic]string {
	keys := make([dynamic]string, 0, len(m), context.temp_allocator)
	for k in m do append(&keys, k)
	slice.sort(keys[:])
	return keys
}

/**
 * Keep the directories in step with one plan: every object the plan writes
 * (or vanishes) is projected before (stored) and after (stored + the plan),
 * and the difference lands on its directory in the same plan - entries set
 * or deleted, this device's counts moved by the delta. Only directories the
 * vault already holds (the builder makes missing ones), never one the plan
 * itself writes (a repair already wrote the truth), never one of a space
 * that is gone.
 */
directory_maintain :: proc(plan: ^Mutation_Plan, input: Mutation_Input) {
	index := plan_index(plan)
	touched := make([dynamic]string, context.temp_allocator)
	skip := make(map[string]bool, context.temp_allocator)
	for id in plan.directories_built do skip[id] = true
	for id, changes in index {
		if is_directory_id(id) {
			skip[id] = true
			continue
		}
		if id == VANISH_LOG_ID do continue
		// Body edits (chat posts, typing) change nothing a directory lists.
		fields := false
		for i in changes do for op in plan.changes[i].ops {
			#partial switch op.kind {
			case .Object_Create, .Object_Delete, .Field_Set, .Field_Delete: fields = true
			}
		}
		if fields do append(&touched, id)
	}
	before_vanished := vanished_from_ledger(input.states[VANISH_LOG_ID])
	after_vanished := before_vanished
	if VANISH_LOG_ID in index || len(plan.vanish_ids) > 0 {
		after_vanished = vanished_after(input, plan, index)
		// Vanished ids, and spaces left or vanished: their entries go.
		for id in after_vanished do if id not_in before_vanished && id not_in index do if _, held := input.states[id]; held do append(&touched, id)
	}
	if len(touched) == 0 do return
	slice.sort(touched[:])

	default_space := ""
	default_known := false
	before := projection_make()
	after := projection_make()
	for id in touched {
		stored := input.states[id]
		now: ^Object_State
		if _, gone := after_vanished[id]; !gone {
			if changes, ok := index[id]; ok do now = directory_after(input, plan, id, changes[:])
			else do now = stored
		}
		was_live := directory_live(stored, before_vanished)
		is_live := directory_live(now, after_vanished)
		if !was_live && !is_live do continue
		needs_default := (was_live && directory_needs_space(stored)) || (is_live && directory_needs_space(now))
		if needs_default && !default_known {
			default_space = strings.clone(pins_default_space(input.states), context.temp_allocator)
			default_known = true
		}
		if was_live do directory_project(&before, stored, default_space, -1)
		if is_live do directory_project(&after, now, default_space, 1)
	}

	ops_by_dir := make(map[string][dynamic]Operation, context.temp_allocator)
	add_op :: proc(ops_by_dir: ^map[string][dynamic]Operation, dir: string, op: Operation) {
		list, seen := ops_by_dir[dir]
		if !seen do list = make([dynamic]Operation, context.temp_allocator)
		append(&list, op)
		ops_by_dir[dir] = list
	}
	writable :: proc(input: Mutation_Input, skip: map[string]bool, vanished: map[string]Vanish_Entry, dir: string) -> ^Object_State {
		if dir in skip do return nil
		d := input.states[dir]
		if !directory_writable(d, dir, vanished) do return nil
		return d
	}
	keys := make(map[string]bool, context.temp_allocator)
	for k in before.entries do keys[k] = true
	for k in after.entries do keys[k] = true
	for pair in sorted_keys(keys) {
		old, had := before.entries[pair]
		new_value, has := after.entries[pair]
		if had == has && (!has || values_equal(old, new_value)) do continue
		dir, key := pair_split(pair)
		d := writable(input, skip, after_vanished, dir)
		if d == nil do continue
		current, present := fields_get(d.fields, key)
		if has {
			if !present || !values_equal(current, new_value) do add_op(&ops_by_dir, dir, Operation{kind = .Field_Set, key = key, value = new_value})
		} else if present {
			add_op(&ops_by_dir, dir, Operation{kind = .Field_Delete, key = key})
		}
	}
	deltas := make(map[string]i64, context.temp_allocator)
	for k, n in before.counts do deltas[k] += n
	for k, n in after.counts do deltas[k] += n
	device := directory_device(input)
	for pair in sorted_keys(deltas) {
		delta := deltas[pair]
		if delta == 0 do continue
		dir, type_key := pair_split(pair)
		d := writable(input, skip, after_vanished, dir)
		if d == nil do continue
		key := count_key(type_key, device)
		current: i64 = 0
		v, present := fields_get(d.fields, key)
		if present && v.kind == .Int do current = v.i
		if current + delta == 0 {
			if present do add_op(&ops_by_dir, dir, Operation{kind = .Field_Delete, key = key})
		} else {
			add_op(&ops_by_dir, dir, Operation{kind = .Field_Set, key = key, value = int_value(current + delta)})
		}
	}
	for dir in sorted_keys(ops_by_dir) do directory_emit(plan, input, dir, ops_by_dir[dir][:])
}

/**
 * Build the directories from the vault as it stands after this plan:
 * create missing ones, set every entry that differs, delete stale ones,
 * write this device's counts as the truth minus the other devices' and set
 * `version`. Only right on a device that holds the whole vault (the daemon,
 * a full replica). A converged vault plans nothing. `only_space` limits it
 * to one space's directory (a space made in this same plan, whose objects
 * are all in it).
 */
directory_repair :: proc(plan: ^Mutation_Plan, input: Mutation_Input, only_space := "") {
	index := plan_index(plan)
	vanished := vanished_after(input, plan, index)
	afters := make(map[string]^Object_State, len(index), context.temp_allocator)
	for id, changes in index do afters[id] = directory_after(input, plan, id, changes[:])
	state_of :: proc(input: Mutation_Input, afters: map[string]^Object_State, id: string) -> ^Object_State {
		if s, ok := afters[id]; ok do return s
		return input.states[id]
	}

	// pins_default_space over the vault after the plan.
	default_space := ""
	default_at: i64 = 0
	consider :: proc(s: ^Object_State, best: ^string, best_at: ^i64) {
		if s == nil || s.deleted || s.type_key != "channel" do return
		if best^ == "" || s.created_at < best_at^ || (s.created_at == best_at^ && s.id < best^) {
			best^ = s.id
			best_at^ = s.created_at
		}
	}
	for id, s in input.states do if id not_in afters do consider(s, &default_space, &default_at)
	for _, s in afters do consider(s, &default_space, &default_at)
	default_space = strings.clone(default_space, context.temp_allocator)

	truth := projection_make()
	spaces := make([dynamic]string, context.temp_allocator)
	project :: proc(truth: ^Directory_Projection, spaces: ^[dynamic]string, s: ^Object_State, vanished: map[string]Vanish_Entry, default_space, only_space: string) {
		if !directory_live(s, vanished) do return
		if s.type_key == "channel" do append(spaces, strings.clone(s.id, context.temp_allocator))
		if only_space != "" {
			space := field_string(s.fields, "channel")
			if space == "" do space = default_space
			if space != only_space || s.type_key == "channel" do return
		}
		directory_project(truth, s, default_space, 1)
	}
	for id, s in input.states do if id not_in afters do project(&truth, &spaces, s, vanished, default_space, only_space)
	for _, s in afters do project(&truth, &spaces, s, vanished, default_space, only_space)
	slice.sort(spaces[:])

	dirs := make([dynamic]string, context.temp_allocator)
	if only_space == "" {
		append(&dirs, DIRECTORY_ID)
		for space in spaces do append(&dirs, directory_space_id(space))
	} else if slice.contains(spaces[:], only_space) {
		append(&dirs, directory_space_id(strings.clone(only_space, context.temp_allocator)))
	}
	// Desired entries and counts per directory.
	want := make(map[string]map[string]Value, context.temp_allocator)
	counts := make(map[string]map[string]i64, context.temp_allocator)
	for dir in dirs {
		want[dir] = make(map[string]Value, context.temp_allocator)
		counts[dir] = make(map[string]i64, context.temp_allocator)
	}
	for pair, value in truth.entries {
		dir, key := pair_split(pair)
		if m, ok := &want[dir]; ok do m^[key] = value
	}
	for pair, n in truth.counts {
		dir, type_key := pair_split(pair)
		if m, ok := &counts[dir]; ok do m^[type_key] = n
	}

	device := directory_device(input)
	own_suffix := fmt.tprintf(":%s", device)
	for dir in dirs {
		append(&plan.directories_built, dir)
		d := state_of(input, afters, dir)
		ops := make([dynamic]Operation, context.temp_allocator)
		current := make([dynamic]Value_Entry, context.temp_allocator)
		if d != nil && d.type_key == DIRECTORY_TYPE && !d.deleted {
			append(&current, ..d.fields[:])
		} else {
			if d != nil do append(&current, ..d.fields[:])
			append(&ops, Operation{kind = .Object_Create, type_key = DIRECTORY_TYPE})
			if field_string(current, "name") == "" do append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value("Directory")})
			if dir != DIRECTORY_ID && field_string(current, "channel") == "" {
				append(&ops, Operation{kind = .Field_Set, key = "channel", value = string_value(dir[len(DIRECTORY_SPACE_PREFIX):])})
			}
		}
		desired := want[dir]
		for key in sorted_keys(desired) {
			v, present := fields_get(current, key)
			if !present || !values_equal(v, desired[key]) do append(&ops, Operation{kind = .Field_Set, key = key, value = desired[key]})
		}
		// Stale entries, and the counts as they stand per type (own vs others').
		others := make(map[string]i64, context.temp_allocator)
		own := make(map[string]i64, context.temp_allocator)
		stale := make([dynamic]string, context.temp_allocator)
		for e in current {
			if strings.has_prefix(e.key, "space:") || strings.has_prefix(e.key, "device:") || strings.has_prefix(e.key, "pin:") || strings.has_prefix(e.key, "type:") || strings.has_prefix(e.key, "rel:") {
				if e.key not_in desired do append(&stale, strings.clone(e.key, context.temp_allocator))
				continue
			}
			if !strings.has_prefix(e.key, "count:") do continue
			rest := e.key[len("count:"):]
			cut := strings.last_index_byte(rest, ':')
			if cut <= 0 do continue
			type_key := strings.clone(rest[:cut], context.temp_allocator)
			n: i64 = e.value.kind == .Int ? e.value.i : 0
			if rest[cut:] == own_suffix {
				own[type_key] = n
			} else {
				others[type_key] += n
			}
		}
		slice.sort(stale[:])
		for key in stale do append(&ops, Operation{kind = .Field_Delete, key = key})
		types := make(map[string]bool, context.temp_allocator)
		for k in counts[dir] do types[k] = true
		for k in others do types[k] = true
		for k in own do types[k] = true
		for type_key in sorted_keys(types) {
			n := counts[dir][type_key] - others[type_key]
			had, present := own[type_key]
			key := count_key(type_key, device)
			if n == 0 {
				if present do append(&ops, Operation{kind = .Field_Delete, key = key})
			} else if !present || had != n {
				append(&ops, Operation{kind = .Field_Set, key = key, value = int_value(n)})
			}
		}
		if v, ok := fields_get(current, "version"); !ok || v.kind != .Int || v.i != DIRECTORY_VERSION {
			append(&ops, Operation{kind = .Field_Set, key = "version", value = int_value(DIRECTORY_VERSION)})
		}
		directory_emit(plan, input, dir, ops[:])
	}
}
