#+build !js
package core

import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:testing"

// Shared with roostr-engine's record tests. Inputs are hand-written; with
// RECORD_VECTORS_WRITE=1 the test fills every case's `expected` from this
// engine instead of checking it (review the diff before keeping it).
RECORD_VECTORS_DIR :: #directory + "/testdata/record_vectors/"

@(private = "file")
hexs :: proc(b: []byte) -> string {
	return string(hex.encode(b, context.temp_allocator))
}

@(private = "file")
vectors_writing :: proc() -> bool {
	return os.get_env("RECORD_VECTORS_WRITE", context.temp_allocator) == "1"
}

@(private = "file")
vectors_parse :: proc(t: ^testing.T, data: []byte, name: string) -> (json.Value, bool) {
	value, err := json.parse(data, parse_integers = true)
	testing.expectf(t, err == nil, "%s parses", name)
	return value, err == nil
}

@(private = "file")
vectors_save :: proc(t: ^testing.T, name: string, value: json.Value) {
	out, err := json.marshal(value, json.Marshal_Options{pretty = true, use_spaces = true, spaces = 1, sort_maps_by_key = true}, context.temp_allocator)
	testing.expect(t, err == nil)
	body := strings.concatenate({string(out), "\n"}, context.temp_allocator)
	testing.expectf(t, os.write_entire_file(strings.concatenate({RECORD_VECTORS_DIR, name}, context.temp_allocator), transmute([]byte)body) == nil, "write %s", name)
}

/** Compare (or, writing, record) a case's expected value. */
@(private = "file")
vectors_check :: proc(t: ^testing.T, item: json.Value, actual: json.Value, label: string) {
	if vectors_writing() {
		if obj, ok := item.(json.Object); ok do obj["expected"] = actual
		return
	}
	expected, _ := json_field(item, "expected")
	testing.expectf(t, string(marshal(actual)) == string(marshal(expected)), "%s\n got: %s\nwant: %s", label, string(marshal(actual)), string(marshal(expected)))
}

@(private = "file")
record_result_json :: proc(r: Record) -> json.Value {
	bytes := record_encode(r, context.temp_allocator)
	hash := sha256(bytes)
	o := jobj()
	o["record"] = record_to_json(r)
	o["canonical"] = json.String(hexs(bytes))
	o["hash"] = json.String(hexs(hash[:]))
	return json.Object(o)
}

@(private = "file")
merge_case :: proc(records: []Record, patches: []Patch) -> (Record, bool) {
	acc: Record
	for r in records {
		ok: bool
		if acc, ok = record_merge(acc, r); !ok do return {}, false
	}
	for p in patches {
		ok: bool
		if acc, ok = record_apply_patch(acc, p); !ok do return {}, false
	}
	return acc, true
}

@(test)
record_vectors_conformance :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator

	// merge.json: fold record_merge over `records`, then apply `patches`.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/merge.json"), "merge.json"); ok {
		for item in root.(json.Array) {
			name := json_str(item, "name")
			records := make([dynamic]Record)
			for rv in json_array(item, "records") {
				r, rok := record_from_json(rv)
				testing.expect(t, rok, name)
				append(&records, r)
			}
			patches := make([dynamic]Patch)
			for pv in json_array(item, "patches") {
				p, pok := patch_from_json(pv)
				testing.expect(t, pok, name)
				append(&patches, p)
			}
			merged, mok := merge_case(records[:], patches[:])
			testing.expect(t, mok, name)
			vectors_check(t, item, record_result_json(merged), name)
			// Order never matters: reversed input reaches the same bytes.
			reversed_records := make([dynamic]Record)
			for i := len(records) - 1; i >= 0; i -= 1 do append(&reversed_records, records[i])
			reversed_patches := make([dynamic]Patch)
			for i := len(patches) - 1; i >= 0; i -= 1 do append(&reversed_patches, patches[i])
			again, _ := merge_case(reversed_records[:], reversed_patches[:])
			testing.expectf(t, string(record_encode(again)) == string(record_encode(merged)), "%s: reversed order", name)
		}
		if vectors_writing() do vectors_save(t, "merge.json", root)
	}

	// view.json: record → lossless state JSON.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/view.json"), "view.json"); ok {
		for item in root.(json.Array) {
			name := json_str(item, "name")
			rv, _ := json_field(item, "record")
			r, rok := record_from_json(rv)
			testing.expect(t, rok, name)
			state := record_view(r)
			vectors_check(t, item, record_state_to_json(&state), name)
		}
		if vectors_writing() do vectors_save(t, "view.json", root)
	}

	// fingerprint.json: per-record hashes, non-empty buckets, empty bucket, root.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/fingerprint.json"), "fingerprint.json"); ok {
		records := make([dynamic]Record)
		hashes := jobj()
		for rv in json_array(root, "records") {
			r, rok := record_from_json(rv)
			testing.expect(t, rok)
			append(&records, r)
			h := record_hash(r)
			hashes[r.object_id] = json.String(hexs(h[:]))
		}
		fp := records_fingerprint(records[:])
		empty := sha256(nil)
		buckets := jobj()
		for &h, i in fp.buckets {
			if h != empty do buckets[fmt.tprintf("%d", i)] = json.String(hexs(h[:]))
		}
		o := jobj()
		o["hashes"] = json.Object(hashes)
		o["buckets"] = json.Object(buckets)
		o["emptyBucket"] = json.String(hexs(empty[:]))
		o["root"] = json.String(hexs(fp.root[:]))
		vectors_check(t, root, json.Object(o), "fingerprint")
		if vectors_writing() do vectors_save(t, "fingerprint.json", root)
	}

	// positions.json: record_positions(n) for each count.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/positions.json"), "positions.json"); ok {
		o := jobj()
		for cv in json_array(root, "counts") {
			n := int(cv.(json.Integer))
			keys := make([dynamic]json.Value)
			for k in record_positions(n) do append(&keys, json.String(k))
			o[fmt.tprintf("%d", n)] = json.Array(keys)
		}
		vectors_check(t, root, json.Object(o), "positions")
		if vectors_writing() do vectors_save(t, "positions.json", root)
	}

	// hlc.json: a clock driven through now/observe steps.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/hlc.json"), "hlc.json"); ok {
		for item in root.(json.Array) {
			clock: Hlc
			results := make([dynamic]json.Value)
			for step in json_array(item, "steps") {
				wall, _ := json_int(step, "wall")
				o := jobj()
				if json_str(step, "op") == "now" {
					o["time"] = json.Integer(i64(hlc_now(&clock, wall)))
				} else {
					time, _ := json_int(step, "time")
					device, _ := json_int(step, "device")
					o["ok"] = json.Boolean(hlc_observe(&clock, Stamp{u64(time), u32(device)}, wall))
					o["last"] = json.Integer(i64(clock.last))
				}
				append(&results, json.Object(o))
			}
			vectors_check(t, item, json.Array(results), json_str(item, "name"))
		}
		if vectors_writing() do vectors_save(t, "hlc.json", root)
	}

	// conversion.json: a change list → the converted record, through the ABI.
	if root, ok := vectors_parse(t, #load("testdata/record_vectors/conversion.json"), "conversion.json"); ok {
		for item in root.(json.Array) {
			name := json_str(item, "name")
			payload := jobj()
			payload["action"] = json.String("from_changes")
			payload["changes"], _ = json_field(item, "changes")
			payload["devices"], _ = json_field(item, "devices")
			result, err := dispatch("record", json.Object(payload))
			testing.expectf(t, err == "", "%s: %s", name, err)
			if err != "" do continue
			vectors_check(t, item, result, name)
		}
		if vectors_writing() do vectors_save(t, "conversion.json", root)
	}
}

// ── Merge laws ───────────────────────────────────────────────────────

@(private = "file")
Rng :: struct {
	state: u64,
}

@(private = "file")
rng_next :: proc(r: ^Rng) -> u64 {
	// splitmix64: fixed seed, same sequence on every run.
	r.state += 0x9E3779B97F4A7C15
	z := r.state
	z = (z ~ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ~ (z >> 27)) * 0x94D049BB133111EB
	return z ~ (z >> 31)
}

@(private = "file")
rng_int :: proc(r: ^Rng, n: int) -> int {
	return int(rng_next(r) % u64(n))
}

@(private = "file")
random_entry :: proc(r: ^Rng, kind: Entry_Kind) -> Record_Entry {
	KEYS := []string{"a", "b", "c", "d"}
	TEXTS := []string{"x", "y", "z", ""}
	e: Record_Entry
	e.key = KEYS[rng_int(r, len(KEYS))]
	// Few distinct times and devices so equal stamps happen.
	e.stamp = Stamp{time = u64(rng_int(r, 4)) << 16 | u64(rng_int(r, 2)), device = u32(rng_int(r, 2))}
	e.gone = rng_int(r, 4) == 0
	e.kind = kind
	text := TEXTS[rng_int(r, len(TEXTS))]
	switch kind {
	case .None:
	case .Value:
		e.value = Value{kind = .String, str = text}
	case .Block, .Message:
		e.body.parent = KEYS[rng_int(r, len(KEYS))]
		e.body.position = TEXTS[rng_int(r, len(TEXTS))]
		e.body.content.kind = .Text
		e.body.content.text.text = text
	}
	return e
}

@(private = "file")
random_record :: proc(r: ^Rng) -> Record {
	rec: Record
	rec.object_id = "law-object"
	rec.created_at = i64(rng_int(r, 3))
	if rng_int(r, 2) == 0 {
		rec.type = random_entry(r, .Value)
		rec.type.key = RECORD_TYPE_KEY
	}
	if rng_int(r, 2) == 0 {
		rec.deleted = random_entry(r, .Value)
		rec.deleted.key = RECORD_DELETED_KEY
		rec.deleted.value = Value{kind = .Bool, b = rng_int(r, 2) == 0}
	}
	for _ in 0 ..< rng_int(r, 5) do append(&rec.fields, random_entry(r, .Value))
	for _ in 0 ..< rng_int(r, 4) do append(&rec.blocks, random_entry(r, .Block))
	for _ in 0 ..< rng_int(r, 3) do append(&rec.messages, random_entry(r, .Message))
	return rec
}

@(private = "file")
merged_bytes :: proc(a, b: Record) -> string {
	m, ok := record_merge(a, b)
	if !ok do return "<mismatch>"
	return string(record_encode(m))
}

@(test)
record_merge_laws :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	rng := Rng{state = 0x5EED}
	empty: Record
	for iteration in 0 ..< 500 {
		a := random_record(&rng)
		b := random_record(&rng)
		c := random_record(&rng)
		ab, _ := record_merge(a, b)
		bc, _ := record_merge(b, c)
		testing.expectf(t, merged_bytes(a, b) == merged_bytes(b, a), "commutative (%d)", iteration)
		testing.expectf(t, merged_bytes(ab, c) == merged_bytes(a, bc), "associative (%d)", iteration)
		testing.expectf(t, merged_bytes(ab, ab) == string(record_encode(ab)), "idempotent (%d)", iteration)
		testing.expectf(t, merged_bytes(ab, a) == string(record_encode(ab)), "absorbs a part (%d)", iteration)
		testing.expectf(t, merged_bytes(merged_bytes_record(a, empty), empty) == merged_bytes(a, empty), "empty is identity (%d)", iteration)

		// The same patches, shuffled and repeated, land on the same record.
		patches := make([dynamic]Patch)
		for _ in 0 ..< 6 {
			p := Patch{object_id = "law-object"}
			for _ in 0 ..< 1 + rng_int(&rng, 3) {
				kind := Entry_Kind(1 + rng_int(&rng, 3))
				e := random_entry(&rng, kind)
				switch rng_int(&rng, 6) {
				case 0:
					e.key = RECORD_TYPE_KEY
					e.kind = .Value
				case 1:
					e.key = RECORD_DELETED_KEY
					e.kind = .Value
					e.value = Value{kind = .Bool, b = true}
				}
				append(&p.entries, e)
			}
			append(&patches, p)
		}
		in_order: Record
		for p in patches do in_order, _ = record_apply_patch(in_order, p)
		want := string(record_encode(in_order))
		for _ in 0 ..< 4 {
			shuffled := make([dynamic]Patch)
			append(&shuffled, ..patches[:])
			for _ in 0 ..< 1 + rng_int(&rng, len(patches)) do append(&shuffled, patches[rng_int(&rng, len(patches))])
			for i := len(shuffled) - 1; i > 0; i -= 1 {
				j := rng_int(&rng, i + 1)
				shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
			}
			out: Record
			for p in shuffled do out, _ = record_apply_patch(out, p)
			testing.expectf(t, string(record_encode(out)) == want, "shuffled + repeated patches converge (%d)", iteration)
		}
		free_all(context.temp_allocator)
	}
}

@(private = "file")
merged_bytes_record :: proc(a, b: Record) -> Record {
	m, _ := record_merge(a, b)
	return m
}

// ── Targeted behaviour ───────────────────────────────────────────────

@(private = "file")
field_entry :: proc(key: string, ms: i64, device: u32, text: string, gone := false) -> Record_Entry {
	return Record_Entry{key = key, stamp = stamp_from_ms(ms, device), gone = gone, kind = .Value, value = gone ? {} : Value{kind = .String, str = text}}
}

@(private = "file")
text_block :: proc(key: string, ms: i64, device: u32, parent, position, text: string, gone := false) -> Record_Entry {
	e := Record_Entry{key = key, stamp = stamp_from_ms(ms, device), gone = gone, kind = .Block}
	if !gone {
		e.body = Entry_Body{parent = parent, position = position}
		e.body.content.kind = .Text
		e.body.content.text.text = text
	}
	return e
}

@(test)
record_tombstone_vs_edit :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	edit := Patch{object_id = "o"}
	append(&edit.entries, field_entry("name", 1000, 1, "kept?"), text_block("p", 1000, 1, "", "V", "para"))
	removal := Patch{object_id = "o"}
	append(&removal.entries, field_entry("name", 2000, 2, "", gone = true), text_block("p", 2000, 2, "", "", "", gone = true))
	late_edit := Patch{object_id = "o"}
	append(&late_edit.entries, field_entry("name", 3000, 1, "revived"))

	// The older edit arriving after the removal cannot bring it back.
	r1, _ := record_apply_patch({}, removal)
	r1, _ = record_apply_patch(r1, edit)
	v1 := record_view(r1)
	testing.expect_value(t, len(v1.fields), 0)
	testing.expect_value(t, len(v1.blocks), 0)
	r2, _ := record_apply_patch({}, edit)
	r2, _ = record_apply_patch(r2, removal)
	testing.expect(t, string(record_encode(r1)) == string(record_encode(r2)), "removal then edit = edit then removal")

	// A newer edit beats the tombstone, whichever arrives first.
	r3, _ := record_apply_patch(r1, late_edit)
	r4, _ := record_apply_patch({}, late_edit)
	r4, _ = record_apply_patch(r4, removal)
	r4, _ = record_apply_patch(r4, edit)
	testing.expect(t, string(record_encode(r3)) == string(record_encode(r4)))
	v3 := record_view(r3)
	name, ok := fields_get(v3.fields, "name")
	testing.expect(t, ok && name.str == "revived")
	// Timestamps cover tombstones too: the removal is the newest write before the revival.
	testing.expect_value(t, record_view(r1).updated_at, 2000)
}

@(test)
record_concurrent_block_inserts :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// Both devices insert after "first" (position V) and before "last" (position l): same key.
	base := Record{object_id = "o"}
	append(&base.blocks, text_block("first", 1000, 1, "", "V", "first"), text_block("last", 1000, 1, "", "l", "last"))
	between := pin_key_between("V", "l", true)
	one := Patch{object_id = "o"}
	append(&one.entries, text_block("from-one", 2000, 1, "", between, "one"))
	two := Patch{object_id = "o"}
	append(&two.entries, text_block("from-two", 2000, 2, "", between, "two"))

	a, _ := record_apply_patch(base, one)
	a, _ = record_apply_patch(a, two)
	b, _ := record_apply_patch(base, two)
	b, _ = record_apply_patch(b, one)
	testing.expect(t, string(record_encode(a)) == string(record_encode(b)))
	view := record_view(a)
	ids := make([dynamic]string)
	for blk in view.blocks do append(&ids, blk.id)
	testing.expect_value(t, len(ids), 4)
	if len(ids) == 4 {
		testing.expect(t, ids[0] == "first" && ids[1] == "from-one" && ids[2] == "from-two" && ids[3] == "last", "both kept, ordered by position then id")
	}
}

@(test)
record_hlc_monotonic :: proc(t: ^testing.T) {
	clock: Hlc
	last: u64
	// Wall clock jumps backwards an hour, stalls, then crawls forward.
	walls := []i64{1_700_000_000_000, 1_700_000_000_005, 1_699_999_996_400, 1_699_999_996_400, 1_699_999_996_401, 1_700_000_000_005, 1_700_000_000_006}
	for wall, i in walls {
		now := hlc_now(&clock, wall)
		testing.expectf(t, now > last, "step %d strictly increases", i)
		last = now
	}
	// A stamp seen from another device pushes the next local stamp past it.
	seen := Stamp{time = u64(1_700_000_050_000) << 16 | 3, device = 9}
	testing.expect(t, hlc_observe(&clock, seen, 1_700_000_000_000))
	next := hlc_now(&clock, 1_700_000_000_000)
	testing.expect(t, next > seen.time)
	testing.expect(t, stamp_compare(Stamp{time = next, device = 0}, seen) > 0, "local write after seeing a stamp wins over it")
}

@(test)
record_hlc_refuses_future :: proc(t: ^testing.T) {
	clock: Hlc
	wall: i64 = 1_700_000_000_000
	hlc_now(&clock, wall)
	before := clock.last
	too_far := Stamp{time = u64(wall + HLC_MAX_FUTURE_MS + 1) << 16, device = 1}
	testing.expect(t, !hlc_observe(&clock, too_far, wall), "more than 24h ahead is refused")
	testing.expect_value(t, clock.last, before)
	at_limit := Stamp{time = u64(wall + HLC_MAX_FUTURE_MS) << 16, device = 1}
	testing.expect(t, hlc_observe(&clock, at_limit, wall), "exactly 24h ahead is accepted")
	testing.expect_value(t, clock.last, at_limit.time)
}

@(test)
record_patch_routing_rejects_bad_input :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	no_body := Patch{object_id = "o"}
	append(&no_body.entries, Record_Entry{key = "x", stamp = stamp_from_ms(1, 1)})
	_, ok := record_apply_patch({}, no_body)
	testing.expect(t, !ok, "an entry without a body cannot be routed")
	bad_type := Patch{object_id = "o"}
	append(&bad_type.entries, text_block(RECORD_TYPE_KEY, 1, 1, "", "V", "x"))
	_, ok = record_apply_patch({}, bad_type)
	testing.expect(t, !ok, "type must be a value")
	other := Patch{object_id = "other"}
	append(&other.entries, field_entry("a", 1, 1, "x"))
	_, ok = record_apply_patch(Record{object_id = "o"}, other)
	testing.expect(t, !ok, "a patch for another object is refused")
}

// ── Conversion: view(from_object_state(replay)) == replay ────────────

@(private = "file")
fixture_devices :: proc() -> map[string]u32 {
	devices := make(map[string]u32)
	devices["fixture-author"] = 1
	devices["fixture"] = 2
	devices[""] = 0
	return devices
}

@(test)
record_view_equals_replay :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	fixtures_value, parse_err := json.parse(#load("replay_fixtures.json"), parse_integers = true)
	testing.expect(t, parse_err == nil)
	if parse_err != nil do return
	checked := 0
	for fixture in fixtures_value.(json.Array) {
		name := json_str(fixture, "name")
		items := json_array(fixture, "changes")
		if len(items) == 0 do continue
		changes := make([]Change, len(items))
		for item, i in items do changes[i], _ = change_from_json(item)
		replayed, ok := compute_state(changes)
		testing.expect(t, ok, name)
		state, writers, wok := record_writers_replay(changes)
		testing.expect(t, wok, name)
		testing.expect(t, string(marshal(object_to_json_value(&state))) == string(marshal(object_to_json_value(&replayed))), "the hook does not change replay")
		record, err := record_from_object_state(&state, &writers, fixture_devices())
		testing.expectf(t, err == "", "%s: %s", name, err)
		view := record_view(record)
		got := string(marshal(object_to_json_value(&view)))
		repeated := state_drop_repeated_refs(&replayed)
		testing.expectf(t, !repeated || name == "legacy child root serialized once even when repeated under later parent; UI hides custom binary data", "%s: only the legacy graph fixture repeats a block", name)
		want := string(marshal(object_to_json_value(&replayed)))
		testing.expectf(t, got == want, "%s\n got: %s\nwant: %s", name, got, want)
		checked += 1
	}
	testing.expect(t, checked >= 10)
}

/** The same equality for the hand-written conversion vectors and for replays seeded by a checkpoint. */
@(test)
record_view_equals_replay_conversion_and_checkpoints :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	devices := make(map[string]u32)
	devices["fixture-author"] = 1
	devices["fixture"] = 2
	devices["alice"] = 3
	devices["bob"] = 4
	sources := [][]byte{#load("replay_fixtures.json"), #load("testdata/record_vectors/conversion.json")}
	seeded := 0
	for source in sources {
		root, _ := json.parse(source, parse_integers = true)
		for fixture in root.(json.Array) {
			name := json_str(fixture, "name")
			items := json_array(fixture, "changes")
			if len(items) == 0 do continue
			changes := make([]Change, len(items))
			legacy_snapshot := false
			for item, i in items {
				changes[i], _ = change_from_json(item)
				legacy_snapshot ||= changes[i].has_snapshot
			}
			check :: proc(t: ^testing.T, name: string, changes: []Change, cp: ^Checkpoint, devices: map[string]u32) {
				replayed, ok := compute_state(changes, checkpoint = cp)
				testing.expect(t, ok, name)
				state, writers, _ := record_writers_replay(changes, cp)
				record, err := record_from_object_state(&state, &writers, devices)
				testing.expectf(t, err == "", "%s: %s", name, err)
				view := record_view(record)
				state_drop_repeated_refs(&replayed)
				got := string(marshal(object_to_json_value(&view)))
				want := string(marshal(object_to_json_value(&replayed)))
				testing.expectf(t, got == want, "%s\n got: %s\nwant: %s", name, got, want)
			}
			check(t, name, changes, nil, devices)
			// Seeded: a checkpoint of the first change, then the rest.
			if legacy_snapshot || len(changes) < 2 do continue
			sorted := topo_sort(changes)
			prefix := []Change{sorted[0]^}
			partial, pok := compute_state(prefix)
			if !pok do continue
			cp := checkpoint_build(&partial, prefix, 1)
			tail := make([dynamic]Change)
			for c in sorted[1:] do append(&tail, c^)
			check(t, name, tail[:], &cp, devices)
			seeded += 1
		}
	}
	testing.expect(t, seeded >= 3, "checkpoint-seeded conversions ran")
}

@(test)
record_conversion_stamps_last_writer :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	id :: proc(n: u8) -> []byte {
		out := make([]byte, 32)
		for &b in out do b = n
		return out
	}
	op_create := Operation{kind = .Object_Create, type_key = "page"}
	set :: proc(key, text: string) -> Operation {
		return Operation{kind = .Field_Set, key = key, value = Value{kind = .String, str = text}}
	}
	add_chat := Operation{kind = .Block_Add, block = Block{id = "m1", content = Block_Content{kind = .Custom, custom = Custom_Content{content_type = "chat"}}}}
	c1 := Change{id = id(1), object_id = "o", timestamp = 1000, author = "alice"}
	append(&c1.ops, op_create, set("name", "A"), set("tmp", "t"), add_chat)
	c2 := Change{id = id(2), object_id = "o", timestamp = 2000, author = "bob"}
	append(&c2.parent_ids, id(1))
	append(&c2.ops, set("name", "B"), Operation{kind = .Field_Delete, key = "tmp"}, Operation{kind = .Block_Remove, block_id = "m1"})
	changes := []Change{c1, c2}
	state, writers, ok := record_writers_replay(changes)
	testing.expect(t, ok)
	devices := make(map[string]u32)
	devices["alice"] = 1
	devices["bob"] = 2
	r, err := record_from_object_state(&state, &writers, devices)
	testing.expect_value(t, err, "")
	testing.expect(t, r.type.stamp == stamp_from_ms(1000, 1))
	testing.expect_value(t, len(r.fields), 2)
	for e in r.fields {
		testing.expect(t, e.stamp == stamp_from_ms(2000, 2), e.key)
		testing.expect(t, e.gone == (e.key == "tmp"), e.key)
	}
	testing.expect_value(t, len(r.messages), 1)
	if len(r.messages) == 1 do testing.expect(t, r.messages[0].gone && r.messages[0].stamp == stamp_from_ms(2000, 2), "removed chat message is a message tombstone")

	delete_key(&devices, "bob")
	_, err = record_from_object_state(&state, &writers, devices)
	testing.expect(t, err != "", "an author without a device index is an error")
}
