#+build !js
package core

// Directories (directory.odin): kept in step by every mutation, rebuilt by
// directories_repair, merged when two devices create the same one. Device
// records (device.odin), which the personal directory lists.

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

/** Link a planned change to its object's heads and content-address it, as a host does. */
@(private = "file")
commit :: proc(v: ^Vault, item: json.Value) -> bool {
	change, ok := change_from_json(item, context.temp_allocator)
	if !ok do return false
	if state, seen := v.states[change.object_id]; seen {
		parents := make([dynamic][]byte, context.temp_allocator)
		for head in state.heads {
			id, decoded := hex.decode(transmute([]byte)head, context.temp_allocator)
			if !decoded do return false
			append(&parents, id)
		}
		change.parent_ids = parents
	}
	digest := sha256(encode_change(change, true, context.temp_allocator))
	id := make([]byte, len(digest), context.temp_allocator)
	copy(id, digest[:])
	change.id = id
	append(&v.changes, change)
	// Later changes in one plan chain onto this one.
	return replay(v)
}

/** Run one mutation over the vault and commit its result, vanishing as the daemon does (the objects' history goes, the ledger records them). */
@(private = "file")
apply :: proc(v: ^Vault, action: string, request: map[string]json.Value, device := "dev-a") -> (json.Value, int, string) {
	v.clock += 1000
	v.seq += 1
	payload := jobj()
	payload["action"] = json.String(action)
	payload["params"] = json.Object(request)
	payload["timestamp"] = json.Integer(v.clock)
	payload["author"] = json.String("alice")
	payload["device"] = json.String(device)
	payload["id_seed"] = json.String(fmt.tprintf("%s-%d", device, v.seq))
	objects := make([dynamic]json.Value, context.temp_allocator)
	for _, state in v.states {
		parsed, err := json.parse(object_to_json(state, context.temp_allocator), allocator = context.temp_allocator, parse_integers = true)
		if err != nil do return nil, 0, "state did not round trip"
		append(&objects, parsed)
	}
	payload["objects"] = json.Array(objects)
	out, mutation_error := mutation_dispatch(json.Object(payload))
	if mutation_error != "" do return nil, 0, mutation_error
	changes := json_array(out, "changes")
	for item in changes do if !commit(v, item) do return nil, 0, "commit failed"
	vanished := json_array(out, "vanish_ids")
	if len(vanished) > 0 {
		gone := make(map[string]bool, context.temp_allocator)
		for id in vanished do gone[string(id.(json.String))] = true
		kept := make([dynamic]Change, context.temp_allocator)
		for c in v.changes do if c.object_id not_in gone do append(&kept, c)
		v.changes = kept
		if !replay(v) do return nil, 0, "replay failed"
		for item in json_array(out, "vanish_changes") do if json_str(item, "objectId") == VANISH_LOG_ID {
			if !commit(v, item) do return nil, 0, "commit failed"
		}
	}
	result, _ := json_field(out, "result")
	return result, len(changes), ""
}

@(private = "file")
params :: proc(pairs: ..[2]string) -> map[string]json.Value {
	out := jobj()
	for p in pairs do out[p[0]] = json.String(p[1])
	return out
}

@(private = "file")
str_json :: proc(s: string) -> json.Value {
	o := jobj()
	o["stringValue"] = json.String(s)
	return json.Object(o)
}

@(private = "file")
bool_json :: proc(b: bool) -> json.Value {
	o := jobj()
	o["boolValue"] = json.Boolean(b)
	return json.Object(o)
}

@(private = "file")
must :: proc(t: ^testing.T, v: ^Vault, action: string, request: map[string]json.Value, device := "dev-a", loc := #caller_location) -> json.Value {
	result, _, err := apply(v, action, request, device)
	testing.expect(t, err == "", fmt.tprintf("%s: %s", action, err), loc = loc)
	return result
}

@(private = "file")
set :: proc(t: ^testing.T, v: ^Vault, object_id, key: string, value: json.Value, device := "dev-a", loc := #caller_location) {
	request := params({"object_id", object_id}, {"key", key})
	request["value"] = value
	must(t, v, "set_field", request, device, loc)
}

/** Create an object of `type_key` in `space` with extra string fields; returns its id. */
@(private = "file")
make_object :: proc(t: ^testing.T, v: ^Vault, space, type_key, name: string, extra: ..[2]string, device := "dev-a", loc := #caller_location) -> string {
	request := params({"type_key", type_key}, {"name", name})
	fields := jobj()
	fields["channel"] = str_json(space)
	for e in extra do fields[e[0]] = str_json(e[1])
	request["fields"] = json.Object(fields)
	return json_str(must(t, v, "create", request, device, loc), "id")
}

@(private = "file")
entry :: proc(v: ^Vault, dir, key: string) -> (Value, bool) {
	d := v.states[dir]
	if d == nil do return {}, false
	return fields_get(d.fields, key)
}

@(private = "file")
entry_str :: proc(v: ^Vault, dir, key, inner: string) -> string {
	e, ok := entry(v, dir, key)
	if !ok || e.kind != .Map do return "<absent>"
	return field_string(e.entries, inner)
}

/** Objects of `type_key` the space's directory counts, over every device. */
@(private = "file")
count :: proc(v: ^Vault, space, type_key: string) -> i64 {
	d := v.states[directory_space_id(space)]
	if d == nil do return -1
	prefix := fmt.tprintf("count:%s:", type_key)
	n: i64 = 0
	for e in d.fields do if strings.has_prefix(e.key, prefix) && !strings.contains(e.key[len(prefix):], ":") do n += e.value.i
	return n
}

/** Live objects of `type_key` in the space, as the directory should count them. */
@(private = "file")
truth :: proc(v: ^Vault, space, type_key: string) -> i64 {
	n: i64 = 0
	for _, s in v.states do if !s.deleted && s.type_key == type_key && field_string(s.fields, "channel") == space do n += 1
	return n
}

/** A vault with one space and its directories built. */
@(private = "file")
setup :: proc(t: ^testing.T, v: ^Vault) -> string {
	space := json_str(must(t, v, "channel_create", params({"name", "Home"}, {"icon", "🏠"})), "id")
	must(t, v, "bootstrap_space_defaults", jobj())
	return space
}

@(test)
directory_built_by_bootstrap_and_channel_create :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := json_str(must(t, &v, "channel_create", params({"name", "Home"}, {"icon", "🏠"})), "id")
	dir := directory_space_id(space)
	d := v.states[dir]
	testing.expect(t, d != nil && d.type_key == DIRECTORY_TYPE, "a new space gets its directory in the same plan")
	if d == nil do return
	testing.expect_value(t, field_string(d.fields, "channel"), space)
	version, _ := fields_get(d.fields, "version")
	testing.expect_value(t, version.i, i64(DIRECTORY_VERSION))
	testing.expect_value(t, count(&v, space, "type"), truth(&v, space, "type"))
	testing.expect_value(t, count(&v, space, "relation"), truth(&v, space, "relation"))
	testing.expect_value(t, count(&v, space, "query"), 1)
	all := all_objects_id(space)
	_, pinned := entry(&v, dir, fmt.tprintf("pin:%s", all))
	testing.expect(t, !pinned, "All Objects is not pinned")
	testing.expect_value(t, entry_str(&v, dir, "type:bundled-type-page-dev-a-1", "key"), "page")
	testing.expect(t, v.states[DIRECTORY_ID] == nil, "the personal directory waits for the builder")

	must(t, &v, "bootstrap_space_defaults", jobj())
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, fmt.tprintf("space:%s", space), "name"), "Home")
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, fmt.tprintf("space:%s", space), "icon"), "🏠")
	_, _, err := apply(&v, "bootstrap_space_defaults", jobj())
	testing.expect_value(t, err, "")
	_, again, _ := apply(&v, "bootstrap_space_defaults", jobj())
	testing.expect_value(t, again, 0)

	// Untyped queries and lists never show them; asking by type does.
	rows := run_query(v.states, json.Object(jobj()), 0)
	for s in rows do testing.expect(t, s.type_key != DIRECTORY_TYPE, "untyped query hides directories")
	typed := jobj()
	typed["type"] = json.String(DIRECTORY_TYPE)
	testing.expect_value(t, len(run_query(v.states, json.Object(typed), 0)), 2)
}

@(test)
directory_follows_pins :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	dir := directory_space_id(space)
	note := make_object(t, &v, space, "note", "Plans", {"iconEmoji", "📝"})
	pin := fmt.tprintf("pin:%s", note)
	_, present := entry(&v, dir, pin)
	testing.expect(t, !present, "not pinned yet")

	set(t, &v, note, PIN_KEY, str_json("V"))
	testing.expect_value(t, entry_str(&v, dir, pin, "order"), "V")
	testing.expect_value(t, entry_str(&v, dir, pin, "name"), "Plans")
	testing.expect_value(t, entry_str(&v, dir, pin, "icon"), "📝")
	testing.expect_value(t, entry_str(&v, dir, pin, "type"), "note")

	set(t, &v, note, PIN_KEY, str_json("k")) // reorder
	testing.expect_value(t, entry_str(&v, dir, pin, "order"), "k")
	set(t, &v, note, "pin_collapsed", bool_json(true))
	e, _ := entry(&v, dir, pin)
	collapsed, _ := fields_get(e.entries, "collapsed")
	testing.expect(t, collapsed.b, "collapse shows")
	set(t, &v, note, "name", str_json("Big plans"))
	testing.expect_value(t, entry_str(&v, dir, pin, "name"), "Big plans")
	set(t, &v, note, "iconEmoji", str_json("🚀"))
	testing.expect_value(t, entry_str(&v, dir, pin, "icon"), "🚀")

	// A body edit leaves the directory alone.
	before := len(v.changes)
	block := jobj()
	content := jobj()
	text := jobj()
	text["text"] = json.String("hello")
	content["text"] = json.Object(text)
	block["content"] = json.Object(content)
	block["childrenIds"] = json.Array(make([dynamic]json.Value, context.temp_allocator))
	add := params({"object_id", note})
	add["block"] = json.Object(block)
	must(t, &v, "block_add", add)
	testing.expect_value(t, len(v.changes), before + 1)

	must(t, &v, "delete_field", params({"object_id", note}, {"key", PIN_KEY}))
	_, present = entry(&v, dir, pin)
	testing.expect(t, !present, "unpinned: entry gone")

	// The space itself: rename, icon.
	set(t, &v, space, "name", str_json("House"))
	set(t, &v, space, "iconImage", str_json("file-1"))
	key := fmt.tprintf("space:%s", space)
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "name"), "House")
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "icon"), "file-1")
}

@(test)
directory_follows_spaces_types_relations :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	dir := directory_space_id(space)
	// Types and properties.
	recipe := make_object(t, &v, space, "type", "Recipe", {"key", "recipe"}, {"layout", "basic"})
	testing.expect_value(t, entry_str(&v, dir, fmt.tprintf("type:%s", recipe), "key"), "recipe")
	testing.expect_value(t, entry_str(&v, dir, fmt.tprintf("type:%s", recipe), "layout"), "basic")
	servings := make_object(t, &v, space, "relation", "Servings", {"key", "servings"}, {"format", "number"})
	testing.expect_value(t, entry_str(&v, dir, fmt.tprintf("rel:%s", servings), "format"), "number")
	types := count(&v, space, "type")
	testing.expect_value(t, types, truth(&v, space, "type"))
	must(t, &v, "delete", params({"object_id", recipe}))
	_, present := entry(&v, dir, fmt.tprintf("type:%s", recipe))
	testing.expect(t, !present, "deleted type leaves")
	testing.expect_value(t, count(&v, space, "type"), types - 1)
	must(t, &v, "vanish", params({"object_id", servings}))
	_, present = entry(&v, dir, fmt.tprintf("rel:%s", servings))
	testing.expect(t, !present, "vanished property leaves")
	testing.expect_value(t, count(&v, space, "relation"), truth(&v, space, "relation"))

	// A second space: listed, then binned, then a third vanished.
	other := json_str(must(t, &v, "channel_create", params({"name", "Work"})), "id")
	key := fmt.tprintf("space:%s", other)
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "name"), "Work")
	testing.expect(t, v.states[directory_space_id(other)] != nil, "and has its own directory")
	must(t, &v, "delete", params({"object_id", other}))
	_, present = entry(&v, DIRECTORY_ID, key)
	testing.expect(t, !present, "a deleted space leaves the personal directory")
	third := json_str(must(t, &v, "channel_create", params({"name", "Gone"})), "id")
	must(t, &v, "vanish", params({"object_id", third}))
	_, present = entry(&v, DIRECTORY_ID, fmt.tprintf("space:%s", third))
	testing.expect(t, !present, "a vanished space leaves the personal directory")
	_, _, err := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, err, "")
	_, again, _ := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, again, 0)
}

@(test)
directory_counts :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	dir := directory_space_id(space)
	testing.expect_value(t, count(&v, space, "note"), 0)
	a := make_object(t, &v, space, "note", "A")
	b := make_object(t, &v, space, "note", "B", device = "dev-b")
	testing.expect_value(t, count(&v, space, "note"), 2)
	own, _ := entry(&v, dir, "count:note:dev-a")
	theirs, _ := entry(&v, dir, "count:note:dev-b")
	testing.expect(t, own.i == 1 && theirs.i == 1, "each device writes its own count")
	must(t, &v, "delete", params({"object_id", a}))
	testing.expect_value(t, count(&v, space, "note"), 1)
	_, present := entry(&v, dir, "count:note:dev-a")
	testing.expect(t, !present, "a count back at zero goes")
	must(t, &v, "restore", params({"object_id", a}))
	testing.expect_value(t, count(&v, space, "note"), 2)
	must(t, &v, "set_type", params({"object_id", a}, {"type_key", "task"}))
	testing.expect_value(t, count(&v, space, "note"), 1)
	testing.expect_value(t, count(&v, space, "task"), 1)
	must(t, &v, "vanish", params({"object_id", b}))
	testing.expect_value(t, count(&v, space, "note"), 0)
	// Moving between spaces.
	other := json_str(must(t, &v, "channel_create", params({"name", "Work"})), "id")
	set(t, &v, a, "channel", str_json(other))
	testing.expect_value(t, count(&v, space, "task"), 0)
	testing.expect_value(t, count(&v, other, "task"), 1)
	// Bookkeeping is never counted.
	testing.expect_value(t, count(&v, space, DIRECTORY_TYPE), 0)
}

@(test)
directory_repair_builds_and_converges :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	make_object(t, &v, space, "note", "A", {PIN_KEY, "V"})
	make_object(t, &v, space, "note", "B")
	// Lose the directories (an older vault), then build them from scratch.
	kept := make([dynamic]Change, context.temp_allocator)
	for c in v.changes do if !is_directory_id(c.object_id) do append(&kept, c)
	v.changes = kept
	testing.expect(t, replay(&v), "replays")
	_, built, err := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, err, "")
	testing.expect(t, built > 0, "built")
	dir := directory_space_id(space)
	testing.expect_value(t, count(&v, space, "note"), 2)
	testing.expect_value(t, count(&v, space, "type"), truth(&v, space, "type"))
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, fmt.tprintf("space:%s", space), "name"), "Home")
	pins := 0
	for e in v.states[dir].fields do if strings.has_prefix(e.key, "pin:") do pins += 1
	testing.expect_value(t, pins, 1)
	_, again, _ := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, again, 0)

	// Drift: a stale entry, and another device's count that overshoots.
	set(t, &v, dir, "pin:nothing", str_json("x"))
	o := jobj()
	o["intValue"] = json.Integer(5)
	set(t, &v, dir, "count:note:dev-z", json.Object(o))
	testing.expect_value(t, count(&v, space, "note"), 7)
	must(t, &v, "directories_repair", jobj())
	_, stale := entry(&v, dir, "pin:nothing")
	testing.expect(t, !stale, "stale entry deleted")
	testing.expect_value(t, count(&v, space, "note"), 2)
	own, _ := entry(&v, dir, "count:note:dev-a")
	testing.expect_value(t, own.i, -3)
	_, again, _ = apply(&v, "directories_repair", jobj())
	testing.expect_value(t, again, 0)
}

@(test)
directory_unpin_all_objects_once :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	dir := directory_space_id(space)
	all := all_objects_id(space)
	// An older vault: All Objects pinned, without the marker.
	must(t, &v, "delete_field", params({"object_id", all}, {"key", ALL_UNPINNED_KEY}))
	set(t, &v, all, PIN_KEY, str_json("0V"))
	testing.expect_value(t, entry_str(&v, dir, fmt.tprintf("pin:%s", all), "order"), "0V")

	request := jobj()
	ids := make([dynamic]json.Value, context.temp_allocator)
	append(&ids, json.String(all))
	request["object_ids"] = json.Array(ids)
	must(t, &v, "unpin_all_objects_once", request)
	testing.expect_value(t, field_string(v.states[all].fields, PIN_KEY), "")
	marker, _ := fields_get(v.states[all].fields, ALL_UNPINNED_KEY)
	testing.expect(t, marker.b, "marked")
	_, pinned := entry(&v, dir, fmt.tprintf("pin:%s", all))
	testing.expect(t, !pinned, "and off the directory")

	// Pinned again by a person: it stays, whatever runs the migration.
	set(t, &v, all, PIN_KEY, str_json("0V"))
	_, n, _ := apply(&v, "unpin_all_objects_once", jobj())
	testing.expect_value(t, n, 0)
	_, n, _ = apply(&v, "bootstrap_space_defaults", jobj())
	testing.expect_value(t, n, 0)
	testing.expect_value(t, field_string(v.states[all].fields, PIN_KEY), "0V")

	// Bootstrap migrates too.
	must(t, &v, "delete_field", params({"object_id", all}, {"key", ALL_UNPINNED_KEY}))
	must(t, &v, "bootstrap_space_defaults", jobj())
	testing.expect_value(t, field_string(v.states[all].fields, PIN_KEY), "")
}

// Two devices build the same space's directory before either hears of the
// other: one object, with both devices' entries and counts; the next repair
// brings the summed counts back to the truth.
@(test)
directory_concurrent_creates_merge :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	base: Vault
	space := json_str(must(t, &base, "channel_create", params({"name", "Home"})), "id")
	kept := make([dynamic]Change, context.temp_allocator)
	for c in base.changes do if !is_directory_id(c.object_id) do append(&kept, c)
	base.changes = kept
	testing.expect(t, replay(&base), "replays")
	shared := len(base.changes)

	fork :: proc(base: ^Vault, clock: i64) -> Vault {
		v := Vault{clock = clock, seq = base.seq}
		v.changes = make([dynamic]Change, context.temp_allocator)
		append(&v.changes, ..base.changes[:])
		replay(&v)
		return v
	}
	a := fork(&base, base.clock)
	b := fork(&base, base.clock + 500)
	note_a := make_object(t, &a, space, "note", "From A", {PIN_KEY, "V"})
	must(t, &a, "directories_repair", jobj())
	note_b := make_object(t, &b, space, "note", "From B", {PIN_KEY, "W"}, device = "dev-b")
	must(t, &b, "directories_repair", jobj(), device = "dev-b")

	merged: Vault
	merged.clock = b.clock + 1000
	merged.seq = 100
	merged.changes = make([dynamic]Change, context.temp_allocator)
	append(&merged.changes, ..base.changes[:])
	append(&merged.changes, ..a.changes[shared:])
	append(&merged.changes, ..b.changes[shared:])
	testing.expect(t, replay(&merged), "merged history replays")
	dirs := 0
	for _, s in merged.states do if s.type_key == DIRECTORY_TYPE && field_string(s.fields, "channel") == space do dirs += 1
	testing.expect_value(t, dirs, 1)
	dir := directory_space_id(space)
	testing.expect_value(t, entry_str(&merged, dir, fmt.tprintf("pin:%s", note_a), "name"), "From A")
	testing.expect_value(t, entry_str(&merged, dir, fmt.tprintf("pin:%s", note_b), "name"), "From B")
	_, has_a := entry(&merged, dir, "count:note:dev-a")
	_, has_b := entry(&merged, dir, "count:note:dev-b")
	testing.expect(t, has_a && has_b, "both devices' counters survive")
	testing.expect(t, v_count_over(&merged, space), "stale concurrent repairs overcount until the next repair")
	must(t, &merged, "directories_repair", jobj())
	testing.expect_value(t, count(&merged, space, "note"), 2)
	testing.expect_value(t, count(&merged, space, "type"), truth(&merged, space, "type"))
}

@(private = "file")
v_count_over :: proc(v: ^Vault, space: string) -> bool {
	return count(v, space, "type") == 2 * truth(v, space, "type")
}

@(private = "file")
all_objects_id :: proc(space: string) -> string {
	return fmt.tprintf("%s%s", ALL_OBJECTS_PREFIX, space[:min(8, len(space))])
}

// ── Device records (device.odin) ──

@(private = "file")
seen :: proc(t: ^testing.T, v: ^Vault, device, name, holding: string, percent: i64, loc := #caller_location) -> int {
	request := params({"object_id", fmt.tprintf("%s%s", DEVICE_ID_PREFIX, device)}, {"name", name}, {"kind", "browser"}, {"holding", holding})
	request["percent"] = json.Integer(percent)
	_, n, err := apply(v, "device_seen", request, device)
	testing.expect(t, err == "", fmt.tprintf("device_seen: %s", err), loc = loc)
	return n
}

@(private = "file")
int_field :: proc(v: ^Vault, id, key: string) -> i64 {
	s := v.states[id]
	if s == nil do return -1
	value, ok := fields_get(s.fields, key)
	return ok && value.kind == .Int ? value.i : -1
}

@(test)
device_records_written_listed_and_hidden :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	space := setup(t, &v)
	id := fmt.tprintf("%sdev-a", DEVICE_ID_PREFIX)
	testing.expect(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12) > 0, "the first start writes the record")
	s := v.states[id]
	testing.expect(t, s != nil && s.type_key == DEVICE_TYPE, "a device record")
	if s == nil do return
	testing.expect_value(t, field_string(s.fields, "channel"), "")
	_, has_channel := fields_get(s.fields, "channel")
	testing.expect(t, !has_channel, "personal: no channel field")
	testing.expect_value(t, field_string(s.fields, "name"), "Chrome at roostr.space")
	testing.expect_value(t, field_string(s.fields, "kind"), "browser")
	testing.expect_value(t, field_string(s.fields, "holding"), "lite")
	testing.expect_value(t, int_field(&v, id, "percent"), 12)
	testing.expect_value(t, int_field(&v, id, "last_seen"), v.clock)
	custom, _ := fields_get(s.fields, "name_custom")
	testing.expect(t, custom.kind == .Bool && !custom.b, "not renamed")

	// The personal directory lists it (lite replicas learn the ids there); no space counts it.
	key := fmt.tprintf("device:%s", id)
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "name"), "Chrome at roostr.space")
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "kind"), "browser")
	testing.expect_value(t, count(&v, space, DEVICE_TYPE), 0)
	_, _, err := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, err, "")
	_, again, _ := apply(&v, "directories_repair", jobj())
	testing.expect_value(t, again, 0)
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "name"), "Chrome at roostr.space")

	// Hidden from untyped queries; asked by type, every device answers.
	seen(t, &v, "dev-b", "Desktop app on studio", "full", 100)
	for row in run_query(v.states, json.Object(jobj()), 0) do testing.expect(t, row.type_key != DEVICE_TYPE, "untyped query hides device records")
	typed := jobj()
	typed["type"] = json.String(DEVICE_TYPE)
	testing.expect_value(t, len(run_query(v.states, json.Object(typed), 0)), 2)
}

@(test)
device_record_cadence :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	setup(t, &v)
	id := fmt.tprintf("%sdev-a", DEVICE_ID_PREFIX)
	seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12)
	first := int_field(&v, id, "last_seen")
	dir_changes := 0
	for c in v.changes do if c.object_id == DIRECTORY_ID do dir_changes += 1

	// Nothing changed within DEVICE_SEEN_MS: no write.
	testing.expect_value(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12), 0)
	v.clock += DEVICE_SEEN_MS - 5000
	testing.expect_value(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12), 0)
	testing.expect_value(t, int_field(&v, id, "last_seen"), first)

	// Once it has passed: last_seen alone, and the directory stays as it was.
	v.clock += 5000
	before := len(v.changes)
	testing.expect_value(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12), 1)
	last := v.changes[len(v.changes) - 1]
	testing.expect_value(t, len(v.changes) - before, 1)
	testing.expect_value(t, len(last.ops), 1)
	testing.expect_value(t, last.ops[0].key, "last_seen")
	testing.expect_value(t, int_field(&v, id, "last_seen"), v.clock)
	after := 0
	for c in v.changes do if c.object_id == DIRECTORY_ID do after += 1
	testing.expect_value(t, after, dir_changes)

	// What it holds changing writes at once, with last_seen.
	testing.expect_value(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 40), 1)
	testing.expect_value(t, int_field(&v, id, "percent"), 40)
	testing.expect_value(t, int_field(&v, id, "last_seen"), v.clock)
	testing.expect_value(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "full", 100), 1)
	testing.expect_value(t, field_string(v.states[id].fields, "holding"), "full")

	// Invalid reports are refused.
	bad := params({"object_id", "note-1"}, {"name", "x"}, {"kind", "browser"}, {"holding", "lite"})
	bad["percent"] = json.Integer(1)
	_, _, err := apply(&v, "device_seen", bad)
	testing.expect(t, err != "", "only __device__: ids")
	bad["object_id"] = json.String(id)
	bad["percent"] = json.Integer(101)
	_, _, err = apply(&v, "device_seen", bad)
	testing.expect(t, err != "", "percent 0-100")
	bad["percent"] = json.Integer(1)
	bad["holding"] = json.String("some")
	_, _, err = apply(&v, "device_seen", bad)
	testing.expect(t, err != "", "holding full or lite")
}

@(test)
device_record_rename_and_remove :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	v: Vault
	setup(t, &v)
	id := fmt.tprintf("%sdev-a", DEVICE_ID_PREFIX)
	key := fmt.tprintf("device:%s", id)
	seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12)

	// A person's name sticks: the auto name never replaces it.
	must(t, &v, "device_rename", params({"object_id", id}, {"name", "  Work laptop  "}), device = "dev-b")
	testing.expect_value(t, field_string(v.states[id].fields, "name"), "Work laptop")
	custom, _ := fields_get(v.states[id].fields, "name_custom")
	testing.expect(t, custom.kind == .Bool && custom.b, "renamed")
	testing.expect_value(t, entry_str(&v, DIRECTORY_ID, key, "name"), "Work laptop")
	testing.expect_value(t, seen(t, &v, "dev-a", "Firefox at roostr.space", "lite", 12), 0)
	testing.expect_value(t, field_string(v.states[id].fields, "name"), "Work laptop")
	_, _, err := apply(&v, "device_rename", params({"object_id", id}, {"name", " "}))
	testing.expect(t, err != "", "a name is required")
	_, _, err = apply(&v, "device_rename", params({"object_id", "__device__:nobody"}, {"name", "x"}))
	testing.expect(t, err != "", "only an existing record")

	// Removed: gone from the list and the directory, never purged, back on the device's next run.
	must(t, &v, "delete", params({"object_id", id}), device = "dev-b")
	testing.expect(t, v.states[id].deleted, "removed")
	_, listed := entry(&v, DIRECTORY_ID, key)
	testing.expect(t, !listed, "the directory drops a removed record")
	typed := jobj()
	typed["type"] = json.String(DEVICE_TYPE)
	testing.expect_value(t, len(run_query(v.states, json.Object(typed), 0)), 0)
	purge := jobj()
	purge["confirm"] = json.Boolean(true)
	must(t, &v, "purge_deleted", purge)
	testing.expect(t, v.states[id] != nil, "purge leaves removed device records alone")
	testing.expect(t, seen(t, &v, "dev-a", "Chrome at roostr.space", "lite", 12) > 0, "the device writes it again")
	testing.expect(t, !v.states[id].deleted && v.states[id].type_key == DEVICE_TYPE, "revived")
	testing.expect_value(t, int_field(&v, id, "last_seen"), v.clock)
	_, listed = entry(&v, DIRECTORY_ID, key)
	testing.expect(t, listed, "listed again")
}
