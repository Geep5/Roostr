package glon

// The daemon side of docs/state-sync.md: bases on disk, state from the
// current base plus live deltas, change sidecars (.b / .local), compaction,
// retention + prune into the folded index, rebase of orphans, and the guards
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

/** In the object's folded index (left the working set here). */
@(private = "file")
in_index :: proc(object_id, hex_id: string) -> bool {
	raw, ok := hash_raw(hex_id)
	folded, _ := folded_lookup(object_id, raw)
	return ok && folded
}

/** The rebased id the folded index maps an orphan to, "" when none. */
@(private = "file")
rebased_to :: proc(object_id, hex_id: string) -> string {
	raw, _ := hash_raw(hex_id)
	_, to := folded_lookup(object_id, raw)
	return to == [32]byte{} ? "" : core.hex_id(to[:], context.temp_allocator)
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
	stale_changes_folded(t)
	own_until_folded(t)
}

/**
 * A change written on a base this device never held (only a later base came
 * in) is Stale: never replayed, never rebased. Loading moves it to the
 * folded index like a folded change, and the object reads the same - it no
 * longer piles up in changes/ on an object compacted often.
 */
@(private = "file")
stale_changes_folded :: proc(t: ^testing.T) {
	OBJ :: "obj-stale"
	d0, _ := remote_change(OBJ, "first", nil, create = true)
	plan1, _ := core.base_compact_plan(nil, []core.Delta{{change = d0}}, nil, nil, unix_ms(), true, context.temp_allocator)
	d1, _ := remote_change(OBJ, "second", plan1.base.head_ids[:])
	plan2, _ := core.base_compact_plan([]core.Checkpoint{plan1.base}, []core.Delta{{change = d1, b = plan1.base.base_hash, tagged = true}}, nil, nil, unix_ms(), true, context.temp_allocator)
	d2, _ := remote_change(OBJ, "third", plan2.base.head_ids[:])
	plan3, ok3 := core.base_compact_plan([]core.Checkpoint{plan1.base, plan2.base}, []core.Delta{{change = d2, b = plan2.base.base_hash, tagged = true}}, nil, nil, unix_ms(), true, context.temp_allocator)
	testing.expect(t, ok3 && plan3.base.epoch == 3, "epoch-3 plan")
	// Only epoch 3 reaches this device.
	r := bases_import(obj({"bases", str_array(base64.encode(plan3.bytes, allocator = context.temp_allocator))}))
	testing.expect_value(t, r.error, "")
	// A change written on epoch 1, which this device never held: it may or may not be folded.
	e1_hex := core.hex_id(plan1.base.base_hash[:], context.temp_allocator)
	late, late_b64 := remote_change(OBJ, "late on epoch 1", plan1.base.head_ids[:])
	late_hex := core.hex_id(late.id, context.temp_allocator)
	r = changes_import(obj({"changes", tagged_import(late_b64, e1_hex)}))
	testing.expect_value(t, r.error, "")
	imported, _ := core.json_int(r.out, "imported")
	testing.expect_value(t, imported, 1)

	// Loading the object classifies it Stale and folds it out of changes/; the object reads the same.
	name, _ := object_name(OBJ)
	testing.expect_value(t, name, "third")
	testing.expect(t, !os.exists(change_file(OBJ, late_hex, ".pb")) && !os.exists(change_file(OBJ, late_hex, ".b")), "stale change leaves changes/")
	testing.expect(t, in_index(OBJ, late_hex), "stale change in the folded index")
	testing.expect(t, row_for(changes_rows(OBJ), late_hex) == nil, "no longer a held change")
	store_mark_dirty(OBJ)
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "third")
	// The same event from a slower relay is refused by the index.
	r = changes_import(obj({"changes", tagged_import(late_b64, e1_hex)}))
	skipped, _ := core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, late_hex, ".pb")), "a stale change is never re-imported")
}

/** POST /api/bases, an object known only by its bases, live deltas, sidecars on import and commit. */
@(private = "file")
base_import_and_state :: proc(t: ^testing.T) {
	OBJ :: "obj-imp"
	d0, d0_b64 := remote_change(OBJ, "first", nil, create = true)
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

	// What the strict ancestor folded is in the index, held here or not: a
	// slow relay delivering it later is refused, never written.
	d0_hex := core.hex_id(d0.id, context.temp_allocator)
	testing.expect(t, in_index(OBJ, d0_hex), "an ancestor's fold is indexed though never held")
	r = changes_import(obj({"changes", str_array(d0_b64)}))
	skipped, _ = core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)

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
	testing.expect(t, !in_index(OBJ, local) && !os.exists(data_dir("archive", OBJ)), "a commit is not indexed, nor archived")
	rows := changes_rows(OBJ)
	row := row_for(rows, local)
	pending, _ := core.json_bool(row, "pending")
	testing.expect(t, pending && core.json_str(row, "class") == "live" && core.json_str(row, "b") == e2_hex, "local row: pending live on e2")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "fourth")
}

/** /api/bases/build, prune into the folded index, /api/bases/rebase, published, covered, retention. */
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
	c1_b64 := base64.encode(read_bytes(change_file(OBJ, c1, ".pb")), allocator = context.temp_allocator)

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
	c3_b64 := base64.encode(read_bytes(change_file(OBJ, c3, ".pb")), allocator = context.temp_allocator)

	// Epoch 2 chains to epoch 1 and prunes what epoch 1 folded.
	out = build(t, OBJ, true)
	e2_hex := core.json_str(out, "hash")
	epoch, _ = core.json_int(out, "epoch")
	testing.expect_value(t, epoch, 2)
	testing.expect_value(t, core.json_str(out, "prevBase"), e1_hex)
	for id in ([]string{c1, c2}) {
		testing.expect(t, !os.exists(change_file(OBJ, id, ".pb")) && !os.exists(change_file(OBJ, id, ".local")), "epoch-1 fold pruned from changes/")
		testing.expect(t, in_index(OBJ, id), "in the folded index")
	}
	testing.expect(t, os.exists(change_file(OBJ, c3, ".pb")) && !in_index(OBJ, c3), "the current base's fold stays (a sibling could win)")
	name, _ := object_name(OBJ)
	testing.expect_value(t, name, "three")

	// Pruned changes never come back through import.
	r = changes_import(obj({"changes", str_array(c1_b64)}))
	skipped, _ := core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, c1, ".pb")), "import never resurrects")

	cov := bases_covered(obj({"objectId", json.String(OBJ)}, {"ids", str_array(c1, c3, strings.repeat("ab", 32, context.temp_allocator))}))
	testing.expect_value(t, cov.error, "")
	testing.expect_value(t, len(core.json_array(cov.out, "premigration")), 1)
	testing.expect_value(t, len(core.json_array(cov.out, "covered")), 2)

	// Another device wrote on epoch 1 after this computer compacted: an
	// orphan that is not ours - discarded on load, never rebased here.
	c2_raw, _ := core.hex_bytes(c2)
	parents := [][]byte{c2_raw}
	orphan, orphan_b64 := remote_change(OBJ, "late", parents)
	orphan_hex := core.hex_id(orphan.id, context.temp_allocator)
	r = changes_import(obj({"changes", tagged_import(orphan_b64, e1_hex)}))
	imported, _ := core.json_int(r.out, "imported")
	testing.expect_value(t, imported, 1)
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "three")
	testing.expect(t, !os.exists(change_file(OBJ, orphan_hex, ".pb")) && !os.exists(change_file(OBJ, orphan_hex, ".b")), "another device's orphan leaves changes/")
	testing.expect(t, in_index(OBJ, orphan_hex) && rebased_to(OBJ, orphan_hex) == "", "discarded: indexed, no replacement")
	testing.expect_value(t, core.json_str(row_for(changes_rows(OBJ), c3), "class"), "covered")
	reb := bases_rebase(obj({"objectId", json.String(OBJ)}))
	testing.expect_value(t, reb.error, "")
	testing.expect_value(t, core.json_str(reb.out, "base"), e2_hex)
	testing.expect_value(t, len(core.json_array(reb.out, "changes")), 0)
	r = changes_import(obj({"changes", tagged_import(orphan_b64, e1_hex)}))
	skipped, _ = core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, orphan_hex, ".pb")), "a discarded orphan is never re-imported")

	// Published: `.published` joins `.local`; the marker stays until a base proves it folded.
	pub := core.jobj()
	pub[OBJ] = str_array(c3, orphan_hex)
	r = changes_published(obj({"published", json.Object(pub)}))
	marked, _ := core.json_int(r.out, "marked")
	testing.expect_value(t, marked, 1)
	testing.expect(t, os.exists(change_file(OBJ, c3, ".local")) && os.exists(change_file(OBJ, c3, ".published")), "published keeps .local")
	c3_row := row_for(changes_rows(OBJ), c3)
	_, has_pending := core.json_field(c3_row, "pending")
	c3_own, _ := core.json_bool(c3_row, "own")
	testing.expect(t, !has_pending && c3_own, "row: own, no longer pending")

	// Retention: current + 1 ancestor + every epoch-1 base (the pre-migration sweep reads it).
	for i in 3 ..= 6 {
		commit_name(t, OBJ, fmt.tprintf("v%d", i))
		out = build(t, OBJ, true)
		epoch, _ = core.json_int(out, "epoch")
		testing.expect_value(t, epoch, i64(i))
	}
	held := load_bases(OBJ, context.temp_allocator)
	epochs: bit_set[0 ..< 8]
	for h in held do epochs += {int(h.cp.epoch)}
	testing.expect_value(t, epochs, bit_set[0 ..< 8]{1, 5, 6})
	testing.expect(t, !os.exists(base_path(OBJ, e2_hex)), "epoch 2 dropped")
	testing.expect(t, !os.exists(change_file(OBJ, c3, ".pb")), "epoch-2 fold pruned once epoch 3 is current")
	testing.expect(t, !os.exists(change_file(OBJ, c3, ".local")) && !os.exists(change_file(OBJ, c3, ".published")), "proven folded: the own markers go with it")
	// A dropped ancestor's fold from a slow relay: refused by the index, never written back.
	testing.expect(t, in_index(OBJ, c3), "a dropped ancestor's fold stays indexed")
	r = changes_import(obj({"changes", tagged_import(c3_b64, e1_hex)}))
	skipped, _ = core.json_int(r.out, "skipped")
	testing.expect_value(t, skipped, 1)
	testing.expect(t, !os.exists(change_file(OBJ, c3, ".pb")) && !os.exists(change_file(OBJ, c3, ".b")), "never written back to changes/")
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "v6")
	list := bases_list()
	info, _ := core.json_field(list, OBJ)
	epoch, _ = core.json_int(info, "epoch")
	testing.expect_value(t, epoch, 6)
	bases, _ := core.json_int(info, "bases")
	testing.expect_value(t, bases, 3)
	live, _ := core.json_int(info, "live")
	testing.expect_value(t, live, 0)

	// Vanish takes bases and the folded index too.
	removed := purge_object_files(OBJ)
	testing.expect(t, removed > 0, "purged")
	testing.expect(t, !os.exists(data_dir("bases", OBJ)) && !os.exists(folded_path(OBJ)), "bases/ and folded/ purged")
	testing.expect(t, !in_index(OBJ, c1), "index forgotten")
}

/**
 * "Own changes until a base proves them": a change written here keeps its
 * `.local` after publishing; a newer base (built elsewhere) that misses it
 * makes it an own orphan, rebased once into a pending copy; the copy's
 * marker goes once a held strict ancestor folded it. Another device's
 * orphan on the same base is discarded.
 */
@(private = "file")
own_until_folded :: proc(t: ^testing.T) {
	OBJ :: "obj-own"
	c1 := commit_name(t, OBJ, "one", create = true)
	e1 := build(t, OBJ, true)
	e1_hex := core.json_str(e1, "hash")
	testing.expect(t, os.exists(change_file(OBJ, c1, ".local")), "folded by the current base only: still own")

	mine := commit_name(t, OBJ, "mine")
	pub := core.jobj()
	pub[OBJ] = str_array(mine)
	changes_published(obj({"published", json.Object(pub)}))
	testing.expect(t, os.exists(change_file(OBJ, mine, ".local")) && os.exists(change_file(OBJ, mine, ".published")), "published, still own")

	// Another computer's epoch 2 folded a change of its own, not `mine`.
	c1_raw, _ := core.hex_bytes(c1)
	theirs, theirs_b64 := remote_change(OBJ, "theirs", [][]byte{c1_raw})
	stray, stray_b64 := remote_change(OBJ, "stray", [][]byte{c1_raw}, create = true)
	held := load_bases(OBJ, context.temp_allocator)
	plan2, ok2 := core.base_compact_plan(held_checkpoints(held[:]), []core.Delta{{change = theirs, b = held[0].cp.base_hash, tagged = true}}, nil, nil, unix_ms(), true, context.temp_allocator)
	testing.expect(t, ok2 && plan2.compact && plan2.base.epoch == 2, "epoch 2 built elsewhere")
	e2_hex := core.hex_id(plan2.base.base_hash[:], context.temp_allocator)
	r := bases_import(obj({"bases", str_array(base64.encode(plan2.bytes, allocator = context.temp_allocator))}))
	testing.expect_value(t, r.error, "")
	// Its delta, and another device's change on epoch 1 that epoch 2 missed.
	changes_import(obj({"changes", tagged_import(theirs_b64, e1_hex)}))
	changes_import(obj({"changes", tagged_import(stray_b64, e1_hex)}))
	name, _ := object_name(OBJ)
	testing.expect_value(t, name, "theirs")
	stray_hex := core.hex_id(stray.id, context.temp_allocator)
	testing.expect(t, !os.exists(change_file(OBJ, stray_hex, ".pb")) && in_index(OBJ, stray_hex), "another device's orphan is discarded")
	testing.expect(t, !os.exists(change_file(OBJ, c1, ".local")) && in_index(OBJ, c1), "c1: proven by a held ancestor, marker dropped")
	testing.expect_value(t, core.json_str(row_for(changes_rows(OBJ), mine), "class"), "orphan")
	info, _ := core.json_field(bases_list(), OBJ)
	rebase, _ := core.json_int(info, "rebase")
	own, _ := core.json_int(info, "own")
	testing.expect(t, rebase == 1 && own == 1, "one own orphan to rebase")

	reb := bases_rebase(obj({"objectId", json.String(OBJ)}))
	testing.expect_value(t, reb.error, "")
	rebased := core.json_array(reb.out, "changes")
	testing.expect_value(t, len(rebased), 1)
	copy_hex := core.json_str(rebased[0], "id")
	testing.expect_value(t, core.json_str(rebased[0], "orphan"), mine)
	testing.expect_value(t, read_text(change_file(OBJ, copy_hex, ".b")), e2_hex)
	testing.expect(t, os.exists(change_file(OBJ, copy_hex, ".local")) && !os.exists(change_file(OBJ, copy_hex, ".published")), "the copy is own and pending")
	testing.expect(t, !os.exists(change_file(OBJ, mine, ".pb")) && !os.exists(change_file(OBJ, mine, ".local")), "the original leaves changes/ with its markers")
	testing.expect_value(t, rebased_to(OBJ, mine), copy_hex)
	testing.expect_value(t, len(core.json_array(bases_rebase(obj({"objectId", json.String(OBJ)})).out, "changes")), 0)
	name, _ = object_name(OBJ)
	testing.expect_value(t, name, "mine")

	pub[OBJ] = str_array(copy_hex)
	changes_published(obj({"published", json.Object(pub)}))
	build(t, OBJ, true) // epoch 3 folds the copy: current only, marker kept
	testing.expect(t, os.exists(change_file(OBJ, copy_hex, ".local")), "folded by the current base only: kept")
	commit_name(t, OBJ, "after")
	build(t, OBJ, true) // epoch 4: epoch 3 is a held ancestor now
	testing.expect(t, !os.exists(change_file(OBJ, copy_hex, ".pb")) && !os.exists(change_file(OBJ, copy_hex, ".local")) && !os.exists(change_file(OBJ, copy_hex, ".published")), "proven: folded away with its markers")
	testing.expect(t, in_index(OBJ, copy_hex), "in the folded index")
}

@(private = "file")
read_bytes :: proc(path: string) -> []byte {
	data, _ := os.read_entire_file(path, context.temp_allocator)
	return data
}
