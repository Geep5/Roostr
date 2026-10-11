package glon

// The daemon side of docs/state-sync.md: bases on disk, state from the
// current base plus live deltas, change sidecars (.b / .local), compaction,
// retention + prune into the archive, rebase of orphans, and the guards
// that keep pruned or rebased changes from coming back. Handlers are driven
// through the procs behind them. Runs inside store_durability_contract:
// the store is one global.

import "core:encoding/base64"
import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:testing"
import "../core"

@(private = "file")
object_name :: proc(object_id: string) -> (name: string, found: bool) {
	Probe :: struct {
		id:    string,
		name:  string,
		found: bool,
	}
	probe := Probe{id = object_id}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		p := cast(^Probe)user
		state, ok := states[p.id]
		if !ok do return
		value, _ := core.fields_get(state.fields, "name")
		p.name = strings.clone(value.str, context.temp_allocator)
		p.found = true
	}, &probe)
	return probe.name, probe.found
}

/** Commit a name change on the object's current heads; returns its hex id. */
@(private = "file")
commit_name :: proc(t: ^testing.T, object_id, value: string, create := false) -> string {
	c: core.Change
	c.object_id = object_id
	c.timestamp = unix_ms()
	c.author = "t"
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	if create do append(&c.ops, core.Operation{kind = .Object_Create, type_key = "note"})
	append(&c.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value(value)})
	c.parent_ids = object_heads(object_id)
	id, ok := commit_change(&c)
	testing.expectf(t, ok, "commit %s=%s", object_id, value)
	return id
}

/** A change built in memory (as another device would have), with its wire bytes. */
@(private = "file")
remote_change :: proc(object_id, value: string, parents: [][]byte, create := false) -> (core.Change, string) {
	c: core.Change
	c.object_id = object_id
	c.timestamp = 1_700_000_000_000
	c.author = "remote"
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	if create do append(&c.ops, core.Operation{kind = .Object_Create, type_key = "note"})
	append(&c.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value(value)})
	c.parent_ids = make([dynamic][]byte, context.temp_allocator)
	append(&c.parent_ids, ..parents)
	digest := core.sha256(core.encode_change(c, for_hashing = true, allocator = context.temp_allocator))
	c.id = make([]byte, 32, context.temp_allocator)
	copy(c.id, digest[:])
	return c, base64.encode(core.encode_change(c, allocator = context.temp_allocator), allocator = context.temp_allocator)
}

@(private = "file")
obj :: proc(pairs: ..struct {
		key:   string,
		value: json.Value,
	}) -> json.Value {
	o := core.jobj()
	for p in pairs do o[p.key] = p.value
	return json.Object(o)
}

@(private = "file")
str_array :: proc(items: ..string) -> json.Value {
	arr := make([dynamic]json.Value, context.temp_allocator)
	for s in items do append(&arr, json.String(s))
	return json.Array(arr)
}

/** POST /api/changes items: one {b64, b}. */
@(private = "file")
tagged_import :: proc(b64, b: string) -> json.Value {
	arr := make([dynamic]json.Value, context.temp_allocator)
	append(&arr, obj({"b64", json.String(b64)}, {"b", json.String(b)}))
	return json.Array(arr)
}

@(private = "file")
read_text :: proc(path: string) -> string {
	data, err := os.read_entire_file(path, context.temp_allocator)
	return err == nil ? string(data) : ""
}

@(private = "file")
row_for :: proc(rows: json.Value, id: string) -> json.Value {
	for row in core.json_array(rows, "changes") do if core.json_str(row, "id") == id do return row
	return nil
}

@(private = "file")
build :: proc(t: ^testing.T, object_id: string, force: bool) -> json.Value {
	r := bases_build(obj({"objectId", json.String(object_id)}, {"force", json.Boolean(force)}))
	testing.expectf(t, r.error == "", "build %s: %s", object_id, r.error)
	return r.out
}

bases_contract :: proc(t: ^testing.T) {
	root := fmt.aprintf("%s/glon-bases-%d", os.temp_directory(context.temp_allocator), unix_ms())
	os.make_directory(root)
	defer os.remove_all(root)
	store_init(root)
	store_invalidate()

	base_import_and_state(t)
	build_prune_rebase(t)
}

/** POST /api/bases, an object known only by its bases, live deltas, sidecars on import and commit. */
@(private = "file")
base_import_and_state :: proc(t: ^testing.T) {
	OBJ :: "obj-imp"
	d0, _ := remote_change(OBJ, "first", nil, create = true)
	deltas := []core.Delta{{change = d0}}
	plan1, ok1 := core.base_compact_plan(nil, deltas, nil, nil, unix_ms(), true, context.temp_allocator)
	testing.expect(t, ok1 && plan1.compact && plan1.base.epoch == 1, "epoch-1 plan")
	e1 := base64.encode(plan1.bytes, allocator = context.temp_allocator)
	e1_hex := core.hex_id(plan1.base.base_hash[:], context.temp_allocator)

	r := bases_import(obj({"bases", str_array(e1)}))
	testing.expect_value(t, r.error, "")
	imported, _ := core.json_int(r.out, "imported")
	testing.expect_value(t, imported, 1)
	item := core.json_array(r.out, "items")[0]
	stored, _ := core.json_bool(item, "stored")
	current, _ := core.json_bool(item, "current")
	testing.expect(t, stored && current, "a first base is stored and current")
	testing.expect(t, os.exists(base_path(OBJ, e1_hex)), "bases/<obj>/<hash>.pb")

	// Epoch 2 over a remote delta folded on epoch 1.
	d1, _ := remote_change(OBJ, "second", plan1.base.head_ids[:])
	held1 := []core.Checkpoint{plan1.base}
	plan2, ok2 := core.base_compact_plan(held1, []core.Delta{{change = d1, b = plan1.base.base_hash, tagged = true}}, nil, nil, unix_ms(), true, context.temp_allocator)
	testing.expect(t, ok2 && plan2.compact && plan2.base.epoch == 2, "epoch-2 plan")
	e2 := base64.encode(plan2.bytes, allocator = context.temp_allocator)
	e2_hex := core.hex_id(plan2.base.base_hash[:], context.temp_allocator)

	// Duplicate, epoch 0 and an unsafe id are refused; `current` reflects the whole batch.
	empty := core.Object_State{id = OBJ}
	legacy := core.checkpoint_build(&empty, nil, 1, context.temp_allocator)
	legacy_b64 := base64.encode(core.encode_checkpoint(legacy, context.temp_allocator), allocator = context.temp_allocator)
	bad, _ := remote_change("bad/id", "x", nil, create = true)
	bad_plan, _ := core.base_compact_plan(nil, []core.Delta{{change = bad}}, nil, nil, unix_ms(), true, context.temp_allocator)
	bad_b64 := base64.encode(bad_plan.bytes, allocator = context.temp_allocator)
	r = bases_import(obj({"bases", str_array(e1, e2, legacy_b64, bad_b64)}))
	testing.expect_value(t, r.error, "")
	imported, _ = core.json_int(r.out, "imported")
	skipped, _ := core.json_int(r.out, "skipped")
	rejected, _ := core.json_int(r.out, "rejected")
	testing.expect_value(t, imported, 1)
	testing.expect_value(t, skipped, 1)
	testing.expect_value(t, rejected, 2)
	items := core.json_array(r.out, "items")
	testing.expect_value(t, len(items), 2)
	for it in items {
		cur, _ := core.json_bool(it, "current")
		testing.expect_value(t, cur, core.json_str(it, "hash") == e2_hex)
		if core.json_str(it, "hash") == e2_hex do testing.expect_value(t, core.json_str(it, "prevBase"), e1_hex)
	}

	// Loaded from bases alone: no change directory at all.
	testing.expect(t, !os.exists(data_dir("changes", OBJ)), "no change dir")
	name, found := object_name(OBJ)
	testing.expect(t, found, "a base-only object loads")
	testing.expect_value(t, name, "second")
	testing.expect_value(t, current_base_hex(OBJ), e2_hex)
	got := bases_get(OBJ)
	testing.expect_value(t, core.json_str(got.out, "current"), e2_hex)
	testing.expect_value(t, core.json_str(core.json_array(got.out, "bases")[0], "hash"), e2_hex)

	// A live delta imported as {b64, b}: sidecar written, replayed on the base.
	d2, d2_b64 := remote_change(OBJ, "third", plan2.base.head_ids[:])
	d2_hex := core.hex_id(d2.id, context.temp_allocator)
	r = changes_import(obj({"changes", tagged_import(d2_b64, e2_hex)}))
	imported, _ = core.json_int(r.out, "imported")
	testing.expect_value(t, imported, 1)
	testing.expect_value(t, read_text(change_file(OBJ, d2_hex, ".b")), e2_hex)
	testing.expect(t, !os.exists(change_file(OBJ, d2_hex, ".local")), "imports are not pending")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "third")

	// A local commit carries the current base and is pending.
	local := commit_name(t, OBJ, "fourth")
	testing.expect_value(t, read_text(change_file(OBJ, local, ".b")), e2_hex)
	testing.expect(t, os.exists(change_file(OBJ, local, ".local")), ".local marker")
	testing.expect(t, os.exists(archive_file(OBJ, local, ".pb")), "linked into the archive")
	rows := changes_rows(OBJ)
	row := row_for(rows, local)
	pending, _ := core.json_bool(row, "pending")
	testing.expect(t, pending && core.json_str(row, "class") == "live" && core.json_str(row, "b") == e2_hex, "local row: pending live on e2")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "fourth")
}

/** /api/bases/build, prune into the archive, /api/bases/rebase, published, covered, retention. */
@(private = "file")
build_prune_rebase :: proc(t: ^testing.T) {
	// Compaction off on this computer: no base is built, forced or not - sync would never publish it.
	os.set_env("GLON_STATE_SYNC_COMPACT", "0")
	off := bases_build(obj({"objectId", json.String("obj-b")}, {"force", json.Boolean(true)}))
	testing.expect_value(t, off.status, "409 Conflict")
	testing.expect_value(t, off.error, "compaction is off on this computer")
	os.unset_env("GLON_STATE_SYNC_COMPACT")
	OBJ :: "obj-b"
	c1 := commit_name(t, OBJ, "one", create = true)
	c2 := commit_name(t, OBJ, "two")
	testing.expect(t, os.exists(change_file(OBJ, c1, ".local")) && !os.exists(change_file(OBJ, c1, ".b")), "no base: .local only")

	// A parent this computer never held: no epoch-1 base may be minted.
	gap: core.Change
	gap.object_id = "obj-gap"
	gap.timestamp = 1
	gap.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&gap.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value("gap")})
	gap.parent_ids = make([dynamic][]byte, context.temp_allocator)
	append(&gap.parent_ids, transmute([]byte)strings.repeat("x", 32, context.temp_allocator))
	_, gok := commit_change(&gap)
	testing.expect(t, gok, "gap commit")
	r := bases_build(obj({"objectId", json.String("obj-gap")}))
	testing.expect_value(t, r.status, "409 Conflict")
	testing.expect_value(t, r.error, "history incomplete")
	r = bases_build(obj({"objectId", json.String("nope")}))
	testing.expect_value(t, r.status, "404 Not Found")

	// Epoch 1 (forced: these changes are fresh) becomes current.
	out := build(t, OBJ, true)
	compact, _ := core.json_bool(out, "compact")
	testing.expect(t, compact, "forced build compacts")
	e1_hex := core.json_str(out, "hash")
	epoch, _ := core.json_int(out, "epoch")
	testing.expect_value(t, epoch, 1)
	testing.expect_value(t, len(core.json_array(out, "folded")), 2)
	testing.expect_value(t, current_base_hex(OBJ), e1_hex)
	// Nothing live: an unforced build declines.
	idle := build(t, OBJ, false)
	compact, _ = core.json_bool(idle, "compact")
	testing.expect(t, !compact, "no live deltas, no base")
	rows := changes_rows(OBJ)
	testing.expect_value(t, core.json_str(row_for(rows, c1), "class"), "premigrationCovered")

	c3 := commit_name(t, OBJ, "three")
	testing.expect_value(t, read_text(change_file(OBJ, c3, ".b")), e1_hex)

	// Epoch 2 chains to epoch 1 and prunes what epoch 1 folded.
	out = build(t, OBJ, true)
	e2_hex := core.json_str(out, "hash")
	epoch, _ = core.json_int(out, "epoch")
	testing.expect_value(t, epoch, 2)
	testing.expect_value(t, core.json_str(out, "prevBase"), e1_hex)
	for id in ([]string{c1, c2}) {
		testing.expect(t, !os.exists(change_file(OBJ, id, ".pb")) && !os.exists(change_file(OBJ, id, ".local")), "epoch-1 fold pruned from changes/")
		testing.expect(t, os.exists(archive_file(OBJ, id, ".pb")), "kept in the archive")
	}
	testing.expect(t, os.exists(change_file(OBJ, c3, ".pb")), "the current base's fold stays (a sibling could win)")
	name, _ := object_name(OBJ)
	testing.expect_value(t, name, "three")

	// Pruned changes never come back through import.
	c1_b64 := base64.encode(read_bytes(archive_file(OBJ, c1, ".pb")), allocator = context.temp_allocator)
	r = changes_import(obj({"changes", str_array(c1_b64)}))
	skipped, _ := core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, c1, ".pb")), "import never resurrects")

	cov := bases_covered(obj({"objectId", json.String(OBJ)}, {"ids", str_array(c1, c3, strings.repeat("ab", 32, context.temp_allocator))}))
	testing.expect_value(t, cov.error, "")
	testing.expect_value(t, len(core.json_array(cov.out, "premigration")), 1)
	testing.expect_value(t, len(core.json_array(cov.out, "covered")), 2)

	// Another device wrote on epoch 1 after this computer compacted: an orphan.
	c2_raw, _ := core.hex_bytes(c2)
	parents := [][]byte{c2_raw}
	orphan, orphan_b64 := remote_change(OBJ, "late", parents)
	orphan_hex := core.hex_id(orphan.id, context.temp_allocator)
	r = changes_import(obj({"changes", tagged_import(orphan_b64, e1_hex)}))
	imported, _ := core.json_int(r.out, "imported")
	testing.expect_value(t, imported, 1)
	rows = changes_rows(OBJ)
	testing.expect_value(t, core.json_str(row_for(rows, orphan_hex), "class"), "orphan")
	testing.expect_value(t, core.json_str(row_for(rows, c3), "class"), "covered")

	reb := bases_rebase(obj({"objectId", json.String(OBJ)}))
	testing.expect_value(t, reb.error, "")
	testing.expect_value(t, core.json_str(reb.out, "base"), e2_hex)
	rebased := core.json_array(reb.out, "changes")
	testing.expect_value(t, len(rebased), 1)
	new_hex := core.json_str(rebased[0], "id")
	testing.expect_value(t, core.json_str(rebased[0], "orphan"), orphan_hex)
	testing.expect_value(t, read_text(change_file(OBJ, new_hex, ".b")), e2_hex)
	testing.expect(t, os.exists(change_file(OBJ, new_hex, ".local")), "rebased change is pending")
	testing.expect(t, os.exists(archive_file(OBJ, new_hex, ".pb")), "rebased change archived")
	testing.expect(t, !os.exists(change_file(OBJ, orphan_hex, ".pb")) && !os.exists(change_file(OBJ, orphan_hex, ".b")), "orphan leaves changes/")
	testing.expect_value(t, read_text(archive_file(OBJ, orphan_hex, ".rebased")), new_hex)
	testing.expect(t, os.exists(archive_file(OBJ, orphan_hex, ".pb")), "orphan kept in the archive")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "late")
	r = changes_import(obj({"changes", tagged_import(orphan_b64, e1_hex)}))
	skipped, _ = core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, orphan_hex, ".pb")), "a rebased orphan is never re-imported")
	again := bases_rebase(obj({"objectId", json.String(OBJ)}))
	testing.expect_value(t, len(core.json_array(again.out, "changes")), 0)

	// Published: .local goes, the change stays.
	pub := core.jobj()
	pub[OBJ] = str_array(new_hex, c3)
	r = changes_published(obj({"published", json.Object(pub)}))
	cleared, _ := core.json_int(r.out, "cleared")
	testing.expect_value(t, cleared, 2)
	testing.expect(t, !os.exists(change_file(OBJ, new_hex, ".local")) && os.exists(change_file(OBJ, new_hex, ".pb")), "published clears .local only")
	_, has_pending := core.json_field(row_for(changes_rows(OBJ), new_hex), "pending")
	testing.expect(t, !has_pending, "row no longer pending")

	// Retention: current + 3 ancestors + every epoch-1 base; epoch 2 goes.
	for i in 3 ..= 6 {
		commit_name(t, OBJ, fmt.tprintf("v%d", i))
		out = build(t, OBJ, true)
		epoch, _ = core.json_int(out, "epoch")
		testing.expect_value(t, epoch, i64(i))
	}
	held := load_bases(OBJ, context.temp_allocator)
	epochs: bit_set[0 ..< 8]
	for h in held do epochs += {int(h.cp.epoch)}
	testing.expect_value(t, epochs, bit_set[0 ..< 8]{1, 3, 4, 5, 6})
	testing.expect(t, !os.exists(base_path(OBJ, e2_hex)), "epoch 2 dropped")
	testing.expect(t, !os.exists(change_file(OBJ, c3, ".pb")), "epoch-2 fold pruned once epoch 3 is current")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "v6")
	list := bases_list()
	info, _ := core.json_field(list, OBJ)
	epoch, _ = core.json_int(info, "epoch")
	testing.expect_value(t, epoch, 6)
	bases, _ := core.json_int(info, "bases")
	testing.expect_value(t, bases, 5)
	live, _ := core.json_int(info, "live")
	testing.expect_value(t, live, 0)

	// Vanish takes bases and archive too.
	removed := purge_object_files(OBJ)
	testing.expect(t, removed > 0, "purged")
	testing.expect(t, !os.exists(data_dir("bases", OBJ)) && !os.exists(data_dir("archive", OBJ)), "bases/ and archive/ purged")
}

@(private = "file")
read_bytes :: proc(path: string) -> []byte {
	data, _ := os.read_entire_file(path, context.temp_allocator)
	return data
}
