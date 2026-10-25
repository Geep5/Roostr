#+build !js
#+feature dynamic-literals
package core

import "core:encoding/base64"
import "core:encoding/json"
import "core:fmt"
import "core:slice"
import "core:strings"
import "core:testing"

// docs/state-sync.md, rule by rule. Changes are built as content-addressed
// protobuf changes exactly like any writer's; bases come from the planner.

@(private = "file")
OBJ :: "obj-1"
@(private = "file")
PK :: "abababababababababababababababababababababababababababababababab"
@(private = "file")
OTHER :: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"
@(private = "file")
SECRET :: "0101010101010101010101010101010101010101010101010101010101010101"
@(private = "file")
CONV :: "0202020202020202020202020202020202020202020202020202020202020202"
@(private = "file")
SPACE_KEY :: "0303030303030303030303030303030303030303030303030303030303030303"
@(private = "file")
HOUR :: 60 * 60 * 1000

@(private = "file")
mk :: proc(parents: []Change, ts: i64, ops: ..Operation) -> Change {
	c := Change{object_id = OBJ, timestamp = ts, author = "t"}
	c.parent_ids = make([dynamic][]byte, context.temp_allocator)
	for p in parents do append(&c.parent_ids, p.id)
	c.ops = make([dynamic]Operation, context.temp_allocator)
	append(&c.ops, ..ops)
	digest := sha256(encode_change(c, true, context.temp_allocator))
	c.id = slice.clone(digest[:], context.temp_allocator)
	return c
}

@(private = "file")
create :: proc() -> Operation { return Operation{kind = .Object_Create, type_key = "page"} }

@(private = "file")
set :: proc(key, value: string) -> Operation { return Operation{kind = .Field_Set, key = key, value = string_value(value)} }

@(private = "file")
add :: proc(id, target: string, position: i64 = POS_BOTTOM) -> Operation {
	b := Block{id = id, children_ids = make([dynamic]string, context.temp_allocator)}
	return Operation{kind = .Block_Add, block = b, target_id = target, position = target == "" ? POS_NONE : position}
}

@(private = "file")
remove :: proc(id: string) -> Operation { return Operation{kind = .Block_Remove, block_id = id} }

@(private = "file")
on :: proc(c: Change, base: Checkpoint) -> Delta { return Delta{change = c, b = base.base_hash, tagged = true} }

@(private = "file")
pre :: proc(c: Change) -> Delta { return Delta{change = c} }

/** Raw ids of changes this device wrote (the host's own markers). */
@(private = "file")
owned :: proc(cs: ..Change) -> map[string]bool {
	out := make(map[string]bool, allocator = context.temp_allocator)
	for c in cs do out[string(c.id)] = true
	return out
}

@(private = "file")
fold :: proc(t: ^testing.T, bases: []Checkpoint, deltas: []Delta, now: i64) -> Checkpoint {
	plan, ok := base_compact_plan(bases, deltas, nil, nil, now, true, context.temp_allocator)
	testing.expect(t, ok && plan.compact, "forced compaction builds a base")
	// What a receiver decodes is what the planner built.
	decoded, dok := decode_checkpoint(plan.bytes, context.temp_allocator)
	testing.expect(t, dok && decoded.base_hash == plan.base.base_hash, "decoded base keeps its hash")
	return decoded
}

@(private = "file")
class_of :: proc(cls: Classification, deltas: []Delta, c: Change) -> Delta_Class {
	for d, i in deltas do if string(d.change.id) == string(c.id) do return cls.classes[i]
	return .Stale
}

@(private = "file")
render :: proc(t: ^testing.T, bases: []Checkpoint, deltas: []Delta) -> string {
	state, has, ok := base_replay(bases, deltas, nil, nil, context.temp_allocator)
	testing.expect(t, has && ok, "replay from base")
	return string(object_to_json(&state, context.temp_allocator))
}

@(private = "file")
field :: proc(state: Object_State, key: string) -> string {
	v, _ := fields_get(state.fields, key)
	return v.str
}

@(private = "file")
history :: proc() -> (c1, c2, c3: Change) {
	c1 = mk(nil, 1000, create())
	c2 = mk({c1}, 2000, set("title", "A"), add("a", ""))
	c3 = mk({c2}, 3000, add("t", "a"))
	return
}

@(test)
base_encode_decode_round_trip :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	testing.expect_value(t, b1.epoch, 1)
	testing.expect_value(t, len(b1.prev_base), 0)
	testing.expect_value(t, len(b1.covered_ids), 3)

	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {pre(c1), pre(c2), pre(c3), on(d1, b1)}, 20_000)
	bytes := encode_checkpoint(b2)
	again, ok := decode_checkpoint(bytes)
	testing.expect(t, ok)
	testing.expect_value(t, again.epoch, 2)
	testing.expect(t, string(again.prev_base) == string(b1.base_hash[:]), "prev_base names the previous base")
	testing.expect(t, again.base_hash == sha256(bytes), "base_hash = sha256 of the encoding")
	testing.expect(t, string(encode_checkpoint(again)) == string(bytes), "encode/decode round-trips byte for byte")

	// Field 8 is never part of the identity, even when a writer sends it.
	with_hash := make([dynamic]byte)
	append(&with_hash, ..bytes)
	append(&with_hash, 0x42, 0x20)
	append(&with_hash, ..b2.base_hash[:])
	stamped, sok := decode_checkpoint(with_hash[:])
	testing.expect(t, sok && stamped.base_hash == again.base_hash, "field 8 is stripped before hashing")

	// A legacy 1079 checkpoint: no field 6/7 on the wire, decodes as epoch 0.
	state, _ := compute_state({c1, c2, c3})
	legacy := checkpoint_build(&state, {c1, c2, c3}, 5)
	legacy_bytes := encode_checkpoint(legacy)
	for i := 0; i < len(legacy_bytes); {
		r := Reader{data = legacy_bytes, pos = i}
		tag := read_varint(&r)
		testing.expect(t, tag >> 3 <= 5, "legacy checkpoints keep their old encoding")
		skip_field(&r, tag & 7)
		i = r.pos
	}
	old, lok := decode_checkpoint(legacy_bytes)
	testing.expect(t, lok && old.epoch == 0 && len(old.prev_base) == 0, "legacy checkpoint decodes as epoch 0")
	testing.expect_value(t, base_current({old}), -1)
}

@(test)
base_current_order :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	mkbase :: proc(epoch, created: i64, hash_byte: byte) -> Checkpoint {
		cp := Checkpoint{object_id = OBJ, epoch = epoch, created_at = created}
		cp.base_hash[0] = hash_byte
		return cp
	}
	testing.expect_value(t, base_current({mkbase(1, 9, 9), mkbase(2, 1, 1)}), 1)
	testing.expect_value(t, base_current({mkbase(2, 1, 1), mkbase(2, 5, 0)}), 1)
	testing.expect_value(t, base_current({mkbase(2, 5, 7), mkbase(2, 5, 3)}), 0)
	testing.expect_value(t, base_current({mkbase(0, 99, 9), mkbase(1, 1, 1)}), 1)
	testing.expect_value(t, base_current({}), -1)
}

@(test)
classify_live_covered_orphan_stale :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	// d2: an old client, no b tag, writing on the heads it sees → live.
	live_tagged := mk({d1}, 21_000, set("x", "1"))
	live_untagged := mk({live_tagged}, 22_000, set("y", "1"))
	orphan := mk({c3}, 12_000, set("late", "1")) // on b1, never folded by b2
	deltas := []Delta{pre(c1), pre(c2), pre(c3), on(d1, b1), on(live_tagged, b2), pre(live_untagged), on(orphan, b1)}
	cls := base_classify({b1, b2}, deltas, nil, nil)
	testing.expect_value(t, cls.current, 1)
	testing.expect_value(t, class_of(cls, deltas, c1), Delta_Class.Premigration_Covered)
	testing.expect_value(t, class_of(cls, deltas, c3), Delta_Class.Premigration_Covered)
	testing.expect_value(t, class_of(cls, deltas, d1), Delta_Class.Covered)
	testing.expect_value(t, class_of(cls, deltas, live_tagged), Delta_Class.Live)
	testing.expect_value(t, class_of(cls, deltas, live_untagged), Delta_Class.Live)
	testing.expect_value(t, class_of(cls, deltas, orphan), Delta_Class.Orphan)

	// Without b1 the device still knows b2's prev_base is epoch 1: an orphan
	// on it is decidable; a pre-migration change b1 might have folded is not.
	stray := mk({c2}, 2500, set("old", "1"))
	gap := []Delta{on(orphan, b1), pre(stray)}
	cls = base_classify({b2}, gap, nil, nil)
	testing.expect_value(t, cls.classes[0], Delta_Class.Orphan)
	testing.expect_value(t, cls.classes[1], Delta_Class.Stale)

	// Two compactions this device never saw: a delta on b1 may be folded.
	b3 := fold(t, {b2}, {on(live_tagged, b2)}, 30_000)
	cls = base_classify({b1, b3}, gap, nil, nil)
	testing.expect_value(t, cls.classes[0], Delta_Class.Stale)
	// ... unless this device never published it.
	pending := map[string]bool{string(orphan.id) = true}
	cls = base_classify({b1, b3}, gap, pending, nil)
	testing.expect_value(t, cls.classes[0], Delta_Class.Orphan)

	// No base: everything replays as today.
	cls = base_classify(nil, deltas, nil, nil)
	testing.expect_value(t, cls.current, -1)
	for class in cls.classes do testing.expect_value(t, class, Delta_Class.Live)
}

@(test)
replay_from_base_matches_full_replay :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	d2 := mk({d1}, 12_000, add("b", "a", POS_BOTTOM), remove("t"))
	full, ok := compute_state({c1, c2, c3, d1, d2})
	testing.expect(t, ok)
	want := string(object_to_json(&full))

	// Pre-migration changes the epoch-1 base covers are skipped, not replayed.
	testing.expect_value(t, render(t, {b1}, {pre(c1), pre(c2), pre(c3), on(d1, b1), on(d2, b1)}), want)
	// A new device holding only the base and the live deltas agrees.
	testing.expect_value(t, render(t, {b1}, {on(d2, b1), on(d1, b1)}), want)
	// After the next compaction the base alone renders the same object.
	b2 := fold(t, {b1}, {on(d1, b1), on(d2, b1)}, 20_000)
	testing.expect_value(t, render(t, {b1, b2}, {pre(c1), pre(c2), pre(c3), on(d1, b1), on(d2, b1)}), want)
	testing.expect_value(t, render(t, {b2}, nil), want)
	// No base: identical to today's replay.
	testing.expect_value(t, render(t, nil, {pre(c1), pre(c2), pre(c3), pre(d1), pre(d2)}), want)
}

@(test)
rebase_is_deterministic :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	live := mk({d1}, 21_000, set("x", "1"))
	o1 := mk({c3}, 12_000, set("late", "1"))
	o2 := mk({o1}, 12_500, set("later", "1"))
	deltas := []Delta{on(d1, b1), on(live, b2), on(o2, b1), on(o1, b1)}
	cls := base_classify({b1, b2}, deltas, nil, owned(o1, o2))
	first := base_rebase(&b2, deltas, cls, nil)
	second := base_rebase(&b2, deltas, cls, nil)
	testing.expect_value(t, len(first), 2)
	for r, i in first {
		a := encode_change(r.change)
		b := encode_change(second[i].change)
		testing.expect(t, string(a) == string(b), "two rebases are byte-identical")
		testing.expect(t, r.change.id[0] == sha256(encode_change(r.change, true))[0], "content addressed")
	}
	r1, r2 := first[0].change, first[1].change
	testing.expect(t, string(first[0].orphan) == string(o1.id), "orphans rebase in Kahn order")
	testing.expect(t, r1.timestamp == o1.timestamp && r1.author == o1.author && len(r1.ops) == len(o1.ops), "same ops, author, timestamp")
	// parents = base heads ∪ live heads, sorted; the orphan chain stays a chain.
	testing.expect_value(t, len(r1.parent_ids), 2)
	testing.expect(t, string(r1.parent_ids[0]) < string(r1.parent_ids[1]), "parents sorted")
	has :: proc(c: Change, id: []byte) -> bool {
		for p in c.parent_ids do if string(p) == string(id) do return true
		return false
	}
	testing.expect(t, has(r1, d1.id) && has(r1, live.id), "rebased onto base heads and live heads")
	testing.expect(t, has(r2, r1.id), "a rebased child keeps its rebased parent")

	// Rebased deltas are live on the current base and never replay twice.
	after := []Delta{on(d1, b1), on(live, b2), on(o2, b1), on(o1, b1), on(r1, b2), on(r2, b2)}
	cls = base_classify({b1, b2}, after, nil, nil)
	testing.expect_value(t, class_of(cls, after, r1), Delta_Class.Live)
	testing.expect_value(t, class_of(cls, after, r2), Delta_Class.Live)
	state, _, _ := base_replay({b1, b2}, after, nil, nil)
	testing.expect_value(t, field(state, "late"), "1")
	testing.expect_value(t, field(state, "later"), "1")
	testing.expect_value(t, field(state, "x"), "1")
}

@(test)
late_orphan_converges_two_devices :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	d2 := mk({d1}, 21_000, set("title", "C"))
	late := mk({c3}, 15_000, set("note", "offline edit"))

	// Device A and device C hold the same things, received in other orders.
	a := []Delta{on(d1, b1), on(late, b1), on(d2, b2)}
	c := []Delta{on(d2, b2), on(late, b1), on(d1, b1)}
	ra := base_rebase(&b2, a, base_classify({b1, b2}, a, nil, owned(late)), nil)
	rc := base_rebase(&b2, c, base_classify({b2, b1}, c, nil, owned(late)), nil)
	testing.expect(t, len(ra) == 1 && len(rc) == 1, "one orphan each")
	testing.expect(t, string(ra[0].change.id) == string(rc[0].change.id), "both devices rebase to the same change id")

	// Each imports the other's publish too (a duplicate dedupes by id).
	final_a := []Delta{on(d1, b1), on(late, b1), on(d2, b2), on(ra[0].change, b2)}
	final_c := []Delta{on(rc[0].change, b2), on(d2, b2), on(late, b1), on(d1, b1)}
	sa := render(t, {b1, b2}, final_a)
	sc := render(t, {b2, b1}, final_c)
	testing.expect_value(t, sa, sc)
	state, _, _ := base_replay({b1, b2}, final_a, nil, nil)
	testing.expect_value(t, field(state, "note"), "offline edit")
	testing.expect_value(t, field(state, "title"), "C")
}

// Two devices rebase the same late edit while holding different live
// deltas, so their copies get different ids. The compactor folds one copy;
// the other arrives afterwards. It is the same edit (same author, timestamp
// and ops), already in the state: rebasing it again made a fresh copy that
// the next compaction orphaned in turn - 26k copies of one block_add on a
// busy agent object.
@(test)
rebased_copy_of_a_folded_edit_is_not_rebased_again :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	late := mk({c3}, 15_000, set("note", "offline edit"))
	x := mk({d1}, 21_000, set("x", "1"))

	// Device A rebases with no live deltas; device B already holds x.
	ra := base_rebase(&b2, {on(d1, b1), on(late, b1)}, base_classify({b1, b2}, {on(d1, b1), on(late, b1)}, nil, owned(late)), nil)
	rb_in := []Delta{on(d1, b1), on(late, b1), on(x, b2)}
	rb := base_rebase(&b2, rb_in, base_classify({b1, b2}, rb_in, nil, owned(late)), nil)
	testing.expect(t, len(ra) == 1 && len(rb) == 1, "each device rebases the late edit")
	testing.expect(t, string(ra[0].change.id) != string(rb[0].change.id), "different live heads, different copies")

	// The compactor holds A's copy and x, not yet B's copy, and folds them.
	b3 := fold(t, {b1, b2}, {on(d1, b1), on(x, b2), on(ra[0].change, b2)}, 30_000)

	// B's copy lands after b3: same edit, already folded - covered, never rebased.
	after := []Delta{on(d1, b1), on(late, b1), on(x, b2), on(ra[0].change, b2), on(rb[0].change, b2)}
	cls := base_classify({b1, b2, b3}, after, nil, owned(late, rb[0].change))
	testing.expect_value(t, class_of(cls, after, rb[0].change), Delta_Class.Covered)
	testing.expect_value(t, class_of(cls, after, late), Delta_Class.Covered)
	testing.expect_value(t, len(base_rebase(&b3, after, cls, nil)), 0)
	state, _, _ := base_replay({b1, b2, b3}, after, nil, nil)
	testing.expect_value(t, field(state, "note"), "offline edit")
}

// Several orphan copies of one edit (each device's) rebase to a single change.
@(test)
orphan_copies_of_one_edit_rebase_once :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	// Two copies of the same edit written on b1 with different parents, then a child of one.
	copy_a := mk({c3}, 15_000, set("note", "n"))
	copy_b := mk({c2}, 15_000, set("note", "n"))
	child := mk({copy_b}, 16_000, set("more", "m"))
	deltas := []Delta{on(d1, b1), on(copy_a, b1), on(copy_b, b1), on(child, b1)}
	cls := base_classify({b1, b2}, deltas, nil, owned(copy_a, copy_b, child))
	testing.expect_value(t, class_of(cls, deltas, copy_a), Delta_Class.Orphan)
	testing.expect_value(t, class_of(cls, deltas, copy_b), Delta_Class.Orphan)
	out := base_rebase(&b2, deltas, cls, nil)
	testing.expect_value(t, len(out), 2)
	kept := out[0].change
	testing.expect(t, string(out[1].change.ops[0].key) == "more", "the child rebases too")
	has_parent := false
	for p in out[1].change.parent_ids do if string(p) == string(kept.id) do has_parent = true
	testing.expect(t, has_parent, "the child of the dropped copy hangs off the one kept")
}

// "Own changes until a base proves them; everyone else's leftovers are
// discarded": only the device that wrote an orphan rebases it, every other
// device drops it; a published own change this device cannot decide is kept.
@(test)
own_orphans_rebase_others_are_discarded :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	mine := mk({c3}, 12_000, set("mine", "1")) // published here; the compactor missed it
	theirs := mk({c3}, 12_500, set("theirs", "1")) // another device's, missed too
	deltas := []Delta{on(d1, b1), on(mine, b1), on(theirs, b1)}
	cls := base_classify({b1, b2}, deltas, nil, owned(mine))
	testing.expect_value(t, cls.classes[1], Delta_Class.Orphan)
	testing.expect_value(t, cls.classes[2], Delta_Class.Orphan)
	testing.expect(t, cls.own[1] && !cls.discard[1], "an own orphan is kept")
	testing.expect(t, !cls.own[2] && cls.discard[2], "another device's orphan is discarded")
	testing.expect(t, !cls.discard[0] && !cls.proven[0], "covered by the current base: neither")
	rebased := base_rebase(&b2, deltas, cls, nil)
	testing.expect(t, len(rebased) == 1 && string(rebased[0].orphan) == string(mine.id), "only the own orphan rebases")
	testing.expect_value(t, len(base_rebase(&b2, deltas, cls, owned(theirs))), 0)
	// Never published counts as own without an own marker.
	cls = base_classify({b1, b2}, deltas, owned(theirs), nil)
	testing.expect(t, cls.own[2] && !cls.discard[2] && cls.discard[1], "pending is own")

	// A device that missed b2 (holds b1 and b3) cannot tell whether b2
	// folded either: its own published change stays held, never rebased;
	// another device's is discarded.
	b3 := fold(t, {b1, b2}, {on(d1, b1), on(rebased[0].change, b2)}, 30_000)
	gap := []Delta{on(mine, b1), on(theirs, b1)}
	cls = base_classify({b1, b3}, gap, nil, owned(mine))
	testing.expect_value(t, cls.classes[0], Delta_Class.Stale)
	testing.expect(t, !cls.discard[0] && len(base_rebase(&b3, gap, cls, nil)) == 0, "own stale: kept, not rebased")
	testing.expect(t, cls.classes[1] == .Stale && cls.discard[1], "another device's stale change is discarded")
}

// An own change is proven only by a held strict ancestor of the current
// base: a concurrent sibling of the current base could still win without it.
@(test)
own_change_proven_by_a_strict_ancestor :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	mine := mk({c3}, 11_000, set("title", "B")) // written and published here
	b2 := fold(t, {b1}, {on(mine, b1)}, 20_000)
	deltas := []Delta{on(mine, b1)}
	cls := base_classify({b1, b2}, deltas, nil, owned(mine))
	testing.expect(t, cls.classes[0] == .Covered && cls.own[0] && !cls.proven[0] && !cls.discard[0], "kept while only the current base folds it")
	x := mk({mine}, 21_000, set("x", "1"))
	b3 := fold(t, {b1, b2}, {on(mine, b1), on(x, b2)}, 30_000)
	cls = base_classify({b2, b3}, deltas, nil, owned(mine))
	testing.expect(t, cls.classes[0] == .Covered && cls.proven[0], "proven once a held ancestor folded it")
	cls = base_classify({b2, b3}, deltas, nil, nil)
	testing.expect(t, !cls.proven[0] && !cls.discard[0], "not own: nothing to prove")

	// An older device rebased this device's late edit; that copy was folded.
	late := mk({mine}, 22_000, set("note", "offline"))
	theirs_in := []Delta{on(mine, b1), on(x, b2), on(late, b1)}
	copy_of := base_rebase(&b3, theirs_in, base_classify({b2, b3}, theirs_in, nil, owned(late)), nil)
	testing.expect_value(t, len(copy_of), 1)
	b4 := fold(t, {b2, b3}, {on(x, b2), on(copy_of[0].change, b3)}, 40_000)
	y := mk({copy_of[0].change}, 41_000, set("y", "1"))
	b5 := fold(t, {b3, b4}, {on(copy_of[0].change, b3), on(y, b4)}, 50_000)
	held := []Delta{on(late, b1), on(copy_of[0].change, b3)}
	cls = base_classify({b2, b3, b4}, held, nil, owned(late))
	testing.expect(t, cls.classes[0] == .Covered && !cls.proven[0], "its copy is folded by the current base only")
	cls = base_classify({b2, b3, b4, b5}, held, nil, owned(late))
	testing.expect(t, cls.classes[0] == .Covered && cls.proven[0], "proven by edit once an ancestor folded the copy")
}

// A change on a base (or parent) this device cannot place, written after its
// current base was created, is waiting for it - never discarded; one written
// before the current base existed is a leftover.
@(test)
discard_waits_for_a_base_on_its_way :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	y := mk({d1}, 21_000, set("y", "1"))
	b3 := fold(t, {b1, b2}, {on(d1, b1), on(y, b2)}, 30_000)
	on_b3 := mk({y}, 31_000, set("z", "1"))
	old := mk({mk(nil, 1, set("q", "q"))}, 15_000, set("old", "1"))
	deltas := []Delta{on(d1, b1), on(on_b3, b3), on(old, b3)}
	cls := base_classify({b1, b2}, deltas, nil, nil)
	testing.expect(t, cls.classes[1] != .Live && !cls.discard[1], "b3 not here yet: waiting")
	testing.expect(t, cls.classes[2] != .Live && cls.discard[2], "written before b2 existed: discarded")
	cls = base_classify({b1, b2, b3}, deltas, nil, nil)
	testing.expect_value(t, cls.classes[1], Delta_Class.Live)
}

@(test)
concurrent_compaction_converges :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	// Concurrent with d1; only the losing compactor had received it.
	d2 := mk({c3}, 11_500, set("body", "folded by the loser only"))
	winner := fold(t, {b1}, {on(d1, b1)}, 20_000)
	loser := fold(t, {b1}, {on(d1, b1), on(d2, b1)}, 19_000)
	testing.expect(t, winner.epoch == loser.epoch, "same epoch")
	// Written on the losing base (its heads: d1, d2) before the device saw the winner.
	d3 := mk({d1, d2}, 21_000, set("title", "D"))
	// Written on the losing base but only on what the winner also holds: its
	// parents are the winner's heads, so it is live without a rebase.
	e := mk({d1}, 21_500, set("e", "1"))

	// This device wrote d2 and d3: it rebases them.
	deltas := []Delta{on(d1, b1), on(d2, b1), on(d3, loser), on(e, loser)}
	x := base_classify({b1, winner, loser}, deltas, nil, owned(d2, d3))
	y := base_classify({loser, b1, winner}, deltas, nil, owned(d2, d3))
	testing.expect(t, ([]Checkpoint{b1, winner, loser})[x.current].base_hash == winner.base_hash, "device X picks the winner")
	testing.expect(t, ([]Checkpoint{loser, b1, winner})[y.current].base_hash == winner.base_hash, "device Y picks the same winner")
	testing.expect(t, slice.equal(x.classes, y.classes), "both devices classify alike")
	testing.expect_value(t, x.classes[0], Delta_Class.Covered)
	testing.expect_value(t, x.classes[1], Delta_Class.Orphan) // folded only by the loser
	testing.expect_value(t, x.classes[2], Delta_Class.Orphan)
	testing.expect_value(t, x.classes[3], Delta_Class.Live)

	rebased := base_rebase(&winner, deltas, x, nil)
	testing.expect_value(t, len(rebased), 2)
	all := make([dynamic]Delta)
	append(&all, ..deltas)
	for r in rebased do append(&all, on(r.change, winner))
	state, _, ok := base_replay({b1, winner, loser}, all[:], nil, nil)
	testing.expect(t, ok)
	testing.expect_value(t, field(state, "body"), "folded by the loser only")
	testing.expect_value(t, field(state, "title"), "D")
	testing.expect_value(t, field(state, "e"), "1")
	other := render(t, {loser, winner}, all[:])
	testing.expect_value(t, render(t, {winner, b1, loser}, all[:]), other)
}

@(test)
rebased_block_add_with_missing_target_appends :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history() // blocks: a, t
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	gone := mk({c3}, 11_000, remove("t"))
	b2 := fold(t, {b1}, {on(gone, b1)}, 20_000)
	orphan := mk({c3}, 12_000, add("n", "t", POS_BOTTOM))
	deltas := []Delta{on(gone, b1), on(orphan, b1)}
	cls := base_classify({b1, b2}, deltas, nil, owned(orphan))
	rebased := base_rebase(&b2, deltas, cls, nil)
	testing.expect_value(t, len(rebased), 1)
	state, _, ok := base_replay({b1, b2}, {on(gone, b1), on(orphan, b1), on(rebased[0].change, b2)}, nil, nil)
	testing.expect(t, ok)
	ids := make([dynamic]string)
	for b in state.blocks do append(&ids, b.id)
	testing.expect(t, slice.equal(ids[:], []string{"a", "n"}), fmt.tprint("target gone: the block appends, got", ids))
}

@(test)
compaction_planner_thresholds :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	now: i64 = 100 * HOUR
	// Epoch 1 folds every held change; a young object waits.
	young := []Delta{pre(mk(nil, now - 1000, create()))}
	plan, ok := base_compact_plan(nil, young, nil, nil, now, false)
	testing.expect(t, ok && !plan.compact, "young object with one delta waits")
	plan, ok = base_compact_plan(nil, {pre(c1), pre(c2), pre(c3)}, nil, nil, now, false)
	testing.expect(t, ok && plan.compact && plan.reason == "age", "pre-migration history is old: epoch 1 is due")
	testing.expect_value(t, plan.base.epoch, 1)
	testing.expect_value(t, len(plan.base.covered_ids), 3)
	testing.expect_value(t, len(plan.base.prev_base), 0)
	testing.expect(t, len(plan.base.head_ids) == 1 && string(plan.base.head_ids[0]) == string(c3.id), "heads of the folded history")
	b1 := plan.base

	chain := make([dynamic]Delta)
	parent := c3
	for i in 0 ..< COMPACT_MIN_DELTAS {
		c := mk({parent}, now - 1000 + i64(i), set("n", fmt.tprint(i)))
		append(&chain, on(c, b1))
		parent = c
	}
	plan, _ = base_compact_plan({b1}, chain[:COMPACT_MIN_DELTAS - 1], nil, nil, now, false)
	testing.expect(t, !plan.compact && plan.live == COMPACT_MIN_DELTAS - 1, "19 small young deltas wait")
	plan, _ = base_compact_plan({b1}, chain[:], nil, nil, now, false)
	testing.expect(t, plan.compact && plan.reason == "deltas", "20 deltas compact")
	testing.expect_value(t, plan.base.epoch, 2)
	testing.expect(t, string(plan.base.prev_base) == string(b1.base_hash[:]), "prev_base = current base")
	testing.expect_value(t, len(plan.base.covered_ids), COMPACT_MIN_DELTAS)
	testing.expect(t, string(plan.base.head_ids[0]) == string(parent.id), "heads of the live deltas")
	testing.expect_value(t, field(Object_State{fields = plan.base.state.fields}, "n"), "19")

	big := mk({c3}, now - 1000, set("body", strings.repeat("x", COMPACT_MIN_BYTES)))
	plan, _ = base_compact_plan({b1}, {on(big, b1)}, nil, nil, now, false)
	testing.expect(t, plan.compact && plan.reason == "bytes", "48 KiB of deltas compact")
	old := mk({c3}, now - COMPACT_MAX_AGE_MS - 1, set("n", "old"))
	plan, _ = base_compact_plan({b1}, {on(old, b1)}, nil, nil, now, false)
	testing.expect(t, plan.compact && plan.reason == "age", "a delta older than 24 h compacts")
	plan, _ = base_compact_plan({b1}, {on(chain[0].change, b1)}, nil, nil, now, true)
	testing.expect(t, plan.compact && plan.reason == "forced", "force")
	plan, _ = base_compact_plan({b1}, nil, nil, nil, now, true)
	testing.expect(t, !plan.compact, "nothing live: nothing to fold")

	// Orphans are reported, never folded.
	orphan := mk({c2}, now - 10, set("o", "1"))
	b2 := fold(t, {b1}, {chain[0]}, now)
	plan, _ = base_compact_plan({b1, b2}, {chain[0], on(orphan, b1)}, nil, nil, now, true)
	testing.expect(t, plan.orphans == 1 && plan.live == 0 && !plan.compact, "orphans are left for rebase")

	// Epoch 1 over a legacy checkpoint folds what the checkpoint covered too.
	prefix, _ := compute_state({c1, c2})
	legacy := checkpoint_build(&prefix, {c1, c2}, 1)
	plan, ok = base_compact_plan(nil, {pre(c3)}, nil, &legacy, now, true)
	testing.expect(t, ok && plan.compact, "epoch 1 from a legacy checkpoint")
	testing.expect_value(t, len(plan.base.covered_ids), 3)
	full, _ := compute_state({c1, c2, c3})
	from_base := render(t, {plan.base}, nil)
	testing.expect_value(t, from_base, string(object_to_json(&full)))
}

// ── Wire and dispatch ────────────────────────────────────────────────

@(private = "file")
call :: proc(t: ^testing.T, action: string, fields: map[string]json.Value) -> json.Value {
	payload := jobj()
	payload["action"] = json.String(action)
	for k, v in fields do payload[k] = v
	result, err := sync_dispatch(json.Object(payload))
	testing.expectf(t, err == "", "%s: %s", action, err)
	return result
}

@(private = "file")
event_of :: proc(part: json.Value, kind: i64, created_at: i64) -> json.Value {
	event := jobj()
	event["pubkey"] = json.String(PK)
	event["created_at"] = json.Integer(created_at)
	event["kind"] = json.Integer(kind)
	event["tags"], _ = json_field(part, "tags")
	event["content"] = json.String(json_str(part, "content"))
	return json.Object(event)
}

@(private = "file")
tag_value :: proc(event: json.Value, name: string) -> (string, int) {
	count := 0
	value := ""
	for item in json_array(event, "tags") {
		arr := item.(json.Array)
		if tag_string(arr, 0) == name {
			if count == 0 do value = tag_string(arr, 1)
			count += 1
		}
	}
	return value, count
}

// Runs inside sync_session_contract: the receive session is process-global.
state_sync_base_wire_scenario :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1 := mk(nil, 1000, create(), set("body", strings.repeat("y", 70_000)))
	big := fold(t, nil, {pre(c1)}, 5000)
	bytes := encode_checkpoint(big)
	text := base64.encode(bytes)
	testing.expect(t, len(text) > WIRE_CHUNK_CHARS, "fixture exceeds one part")

	seal := jobj()
	seal["base"] = json.String(text)
	seal["conversationKey"] = json.String(CONV)
	seal["secret"] = json.String(SECRET)
	sealed := call(t, "seal_base", seal)
	event, _ := json_field(sealed, "event")
	parts := json_array(sealed, "parts")
	testing.expect_value(t, json_str(sealed, "hash"), hex_id(big.base_hash[:]))
	testing.expect_value(t, len(parts), 2)
	kind, _ := json_int(event, "kind")
	testing.expect_value(t, kind, SYNC_BASE_KIND)
	secret, _ := hex_bytes(SECRET)
	d, _ := tag_value(event, "d")
	testing.expect_value(t, d, wire_blind(secret, "base:" + OBJ))
	h, _ := tag_value(event, "h")
	testing.expect_value(t, h, wire_blind(secret, OBJ))
	epoch, _ := tag_value(event, "epoch")
	testing.expect_value(t, epoch, "1")
	gid, _ := tag_value(event, "c")
	testing.expect_value(t, gid, json_str(sealed, "gid"))
	part_kind, _ := json_int(parts[0], "kind")
	testing.expect_value(t, part_kind, SYNC_BASE_PART_KIND)
	part_gid, _ := tag_value(parts[0], "c")
	testing.expect_value(t, part_gid, gid)
	_, part_d := tag_value(parts[0], "d")
	testing.expect_value(t, part_d, 0)

	session := jobj()
	session["pk"] = json.String(PK)
	session["conversationKey"] = json.String(CONV)
	session["secret"] = json.String(SECRET)
	call(t, "session", session)
	defer sync_session_close()
	ingest := proc(t: ^testing.T, event: json.Value) -> json.Value {
		fields := jobj()
		fields["event"] = event
		fields["nowMs"] = json.Integer(1)
		return call(t, "ingest", fields)
	}
	// Parts are published first (in any order); the base completes the group.
	for i := len(parts) - 1; i >= 0; i -= 1 {
		early := ingest(t, event_of(parts[i], SYNC_BASE_PART_KIND, 50 + i64(i)))
		_, has_early := json_field(early, "item")
		testing.expect(t, !has_early, "a lone part is not an item")
	}
	done := ingest(t, event_of(event, SYNC_BASE_KIND, 60))
	item, has_item := json_field(done, "item")
	testing.expect(t, has_item, "the base reassembles")
	summary, _ := json_field(item, "base")
	testing.expect_value(t, json_str(summary, "hash"), hex_id(big.base_hash[:]))
	got_epoch, _ := json_int(summary, "epoch")
	testing.expect_value(t, got_epoch, 1)
	testing.expect_value(t, json_str(item, "bytes"), text)
	testing.expect(t, sync_key_is_checkpoint(json_str(item, "chunkKey")), "base groups retire like checkpoint groups")

	// A small base is one addressable event; a 1080 without c is dropped.
	small := fold(t, nil, {pre(mk(nil, 1000, create()))}, 6000)
	seal["base"] = json.String(base64.encode(encode_checkpoint(small)))
	single := call(t, "seal_base", seal)
	testing.expect_value(t, len(json_array(single, "parts")), 0)
	single_event, _ := json_field(single, "event")
	_, chunked := tag_value(single_event, "c")
	testing.expect_value(t, chunked, 0)
	one := ingest(t, event_of(single_event, SYNC_BASE_KIND, 60))
	one_item, one_ok := json_field(one, "item")
	one_summary, _ := json_field(one_item, "base")
	testing.expect(t, one_ok && json_str(one_summary, "hash") == hex_id(small.base_hash[:]), "single-part base ingests")
	stray := ingest(t, event_of(single_event, SYNC_BASE_PART_KIND, 61))
	_, stray_item := json_field(stray, "item")
	testing.expect(t, !stray_item, "a 1080 without a chunk tag is not a base")

	// A delta sealed on a base carries ["b", hash] and ingests with it.
	delta := mk(nil, 7000, create())
	seal_delta := jobj()
	seal_delta["action"] = json.String("seal")
	seal_delta["change"] = json.String(base64.encode(encode_change(delta)))
	seal_delta["objectId"] = json.String(OBJ)
	seal_delta["conversationKey"] = json.String(CONV)
	seal_delta["secret"] = json.String(SECRET)
	seal_delta["base"] = json.String(hex_id(small.base_hash[:]))
	delta_sealed, derr := wire_dispatch(json.Object(seal_delta))
	testing.expect(t, derr == "", derr)
	delta_part := json_array(delta_sealed, "parts")[0]
	b, _ := tag_value(delta_part, "b")
	testing.expect_value(t, b, hex_id(small.base_hash[:]))
	got := ingest(t, event_of(delta_part, SYNC_CHANGE_KIND, 70))
	got_item, _ := json_field(got, "item")
	testing.expect_value(t, json_str(got_item, "b"), hex_id(small.base_hash[:]))

	// The outbox seals a queued delta with its base.
	pending := jobj()
	pending["key"] = json.String("k1")
	pending["objectId"] = json.String(OBJ)
	pending["changeId"] = json.String(hex_id(delta.id))
	pending["bytes"] = json.String(base64.encode(encode_change(delta)))
	pending["base"] = json.String(hex_id(small.base_hash[:]))
	call(t, "outbox_enqueue", map[string]json.Value{"pending" = json.Object(pending)})
	next := call(t, "outbox_next", map[string]json.Value{"nowMs" = json.Integer(1)})
	queued, _ := json_field(next, "item")
	sealed_item, _ := json_field(queued, "sealed")
	queued_b, _ := tag_value(json_array(sealed_item, "parts")[0], "b")
	testing.expect_value(t, queued_b, hex_id(small.base_hash[:]))
}

// Runs inside sync_session_contract. docs/state-sync.md "Oversized bases".
state_sync_pointer_base_scenario :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1 := mk(nil, 1000, create(), set("body", strings.repeat("y", 2_000_000)))
	big := fold(t, nil, {pre(c1)}, 5000)
	text := base64.encode(encode_checkpoint(big))
	testing.expect(t, len(text) > WIRE_CHUNK_CHARS * WIRE_MAX_CHUNKS, "fixture exceeds the chunk limit")
	hash := hex_id(big.base_hash[:])

	// Too big for parts and no blob yet: the key to encrypt the blob with.
	seal := jobj()
	seal["base"] = json.String(text)
	seal["conversationKey"] = json.String(CONV)
	seal["secret"] = json.String(SECRET)
	first := call(t, "seal_base", seal)
	needs, _ := json_bool(first, "needsBlob")
	testing.expect(t, needs, "an oversized base asks for a blob")
	_, has_event := json_field(first, "event")
	testing.expect(t, !has_event, "no inline event for an oversized base")
	blob_key := json_str(first, "blobKey")
	testing.expect(t, is_hex_pubkey(blob_key), "blob key is 32 bytes hex")
	testing.expect_value(t, json_str(call(t, "seal_base", seal), "blobKey"), blob_key)
	testing.expect_value(t, json_str(first, "hash"), hash)

	// With the uploaded blob: a pointer 31078, no parts.
	sha := strings.repeat("ab", 32)
	blob := jobj()
	blob["sha256"] = json.String(sha)
	blob["size"] = json.Integer(1_500_016)
	url := strings.concatenate({"https://blossom.example/", sha})
	blob["url"] = json.String(url)
	seal["blob"] = json.Object(blob)
	sealed := call(t, "seal_base", seal)
	testing.expect_value(t, len(json_array(sealed, "parts")), 0)
	sealed_blob, _ := json_field(sealed, "blob")
	testing.expect_value(t, json_str(sealed_blob, "key"), blob_key)
	event, _ := json_field(sealed, "event")
	kind, _ := json_int(event, "kind")
	testing.expect_value(t, kind, SYNC_BASE_KIND)
	secret, _ := hex_bytes(SECRET)
	d, _ := tag_value(event, "d")
	testing.expect_value(t, d, wire_blind(secret, "base:" + OBJ))
	epoch, _ := tag_value(event, "epoch")
	testing.expect_value(t, epoch, "1")
	_, chunked := tag_value(event, "c")
	testing.expect_value(t, chunked, 0)
	tag_sha, tags := tag_value(event, "blob")
	testing.expect(t, tags == 1 && tag_sha == sha, "one blob tag naming the blob")
	conv, _ := hex_bytes(CONV)
	plain, dok := nip44_decrypt(json_str(event, "content"), conv)
	testing.expect(t, dok && !wire_part_ok(plain), "the pointer is not a base64 part: old readers drop it")
	pointer, pok := json.parse(transmute([]byte)plain, parse_integers = true)
	testing.expect(t, pok == nil && json_str(pointer, "hash") == hash && json_str(pointer, "key") == blob_key, "pointer names base and key")

	session := jobj()
	session["pk"] = json.String(PK)
	session["conversationKey"] = json.String(CONV)
	session["secret"] = json.String(SECRET)
	call(t, "session", session)
	defer sync_session_close()
	ingest := proc(t: ^testing.T, event: json.Value) -> json.Value {
		fields := jobj()
		fields["event"] = event
		fields["nowMs"] = json.Integer(1)
		return call(t, "ingest", fields)
	}
	got := ingest(t, event_of(event, SYNC_BASE_KIND, 80))
	item, has_item := json_field(got, "item")
	testing.expect(t, has_item, "a pointer base is an item")
	_, has_base := json_field(item, "base")
	testing.expect(t, !has_base && json_str(item, "bytes") == "", "the base itself comes from the blob")
	item_blob, _ := json_field(item, "blob")
	size, _ := json_int(item_blob, "size")
	testing.expect(t, json_str(item_blob, "hash") == hash && json_str(item_blob, "sha256") == sha && size == 1_500_016, "blob named")
	testing.expect_value(t, json_str(item_blob, "key"), blob_key)
	testing.expect_value(t, json_str(item_blob, "url"), url)
	cursor, _ := json_int(got, "cursor")
	testing.expect_value(t, cursor, 80)

	// The decrypted blob opens exactly like an inline base.
	open := jobj()
	open["hash"] = json.String(hash)
	open["bytes"] = json.String(text)
	opened := call(t, "base_open_blob", open)
	summary, _ := json_field(opened, "base")
	testing.expect_value(t, json_str(summary, "hash"), hash)
	testing.expect_value(t, json_str(opened, "bytes"), text)
	small := fold(t, nil, {pre(mk(nil, 1000, create()))}, 6000)
	open["bytes"] = json.String(base64.encode(encode_checkpoint(small)))
	open["action"] = json.String("base_open_blob")
	_, mismatch := sync_dispatch(json.Object(open))
	testing.expect_value(t, mismatch, "base blob does not match its pointer")

	// A blob tag naming other bytes than the pointer: not an item.
	forged := event_of(event, SYNC_BASE_KIND, 81).(json.Object)
	forged_tags := make([dynamic]json.Value)
	for entry in json_array(event, "tags") {
		arr := entry.(json.Array)
		append(&forged_tags, tag_string(arr, 0) == "blob" ? tag("blob", strings.repeat("cd", 32), "1500016") : entry)
	}
	forged["tags"] = json.Array(forged_tags)
	refused := ingest(t, json.Object(forged))
	_, forged_item := json_field(refused, "item")
	failed, _ := json_bool(refused, "decodeFailure")
	testing.expect(t, !forged_item && failed, "a pointer must match its blob tag")
	// Without the blob tag (how a reader that predates pointers sees it): dropped.
	untagged := event_of(event, SYNC_BASE_KIND, 82).(json.Object)
	plain_tags := make([dynamic]json.Value)
	for entry in json_array(event, "tags") do if tag_string(entry.(json.Array), 0) != "blob" do append(&plain_tags, entry)
	untagged["tags"] = json.Array(plain_tags)
	dropped := ingest(t, json.Object(untagged))
	_, untagged_item := json_field(dropped, "item")
	testing.expect(t, !untagged_item, "a pointer is never read as base64")

	// A bad blob description is refused at seal time.
	blob["sha256"] = json.String("AB")
	seal["action"] = json.String("seal_base")
	_, bad := sync_dispatch(json.Object(seal))
	testing.expect_value(t, bad, "blob sha256 must be 64-char lowercase hex")
}

@(test)
seal_base_shared_space_tags :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1 := mk(nil, 1000, create())
	base := fold(t, nil, {pre(c1)}, 5000)
	seal := jobj()
	seal["base"] = json.String(base64.encode(encode_checkpoint(base)))
	seal["conversationKey"] = json.String(SPACE_KEY)
	space := jobj()
	space["keyHex"] = json.String(SPACE_KEY)
	space["spaceId"] = json.String("space-1")
	space["owner"] = json.String(OTHER)
	seal["space"] = json.Object(space)
	sealed := call(t, "seal_base", seal)
	event, _ := json_field(sealed, "event")
	d, _ := tag_value(event, "d")
	testing.expect_value(t, d, wire_blind(transmute([]byte)string(SPACE_KEY), "base:" + OBJ))
	_, hs := tag_value(event, "h")
	testing.expect_value(t, hs, 2)
	owner, _ := tag_value(event, "owner")
	testing.expect_value(t, owner, OTHER)
}

@(test)
authorize_base_owner_only :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1 := mk(nil, 1000, create(), Operation{kind = .Field_Set, key = "channel", value = string_value("space-1")})
	base := fold(t, nil, {pre(c1)}, 5000)
	request :: proc(t: ^testing.T, bytes: []byte, signer: string) -> json.Value {
		fields := jobj()
		fields["base"] = json.String(base64.encode(bytes))
		prov := jobj()
		prov["spaceId"] = json.String("space-1")
		prov["keyId"] = json.Integer(1)
		prov["signer"] = json.String(signer)
		fields["provenance"] = json.Object(prov)
		space := jobj()
		space["spaceId"] = json.String("space-1")
		space["keyId"] = json.Integer(1)
		space["owner"] = json.String(PK)
		fields["space"] = json.Object(space)
		return call(t, "authorizeBase", fields)
	}
	bytes := encode_checkpoint(base)
	ok, _ := json_bool(request(t, bytes, PK), "ok")
	testing.expect(t, ok, "the owner may publish a base")
	denied := request(t, bytes, OTHER)
	refused, _ := json_bool(denied, "ok")
	testing.expect(t, !refused, "a member may not")
	testing.expect_value(t, json_str(denied, "reason"), "only the space owner may publish bases")

	legacy := base
	legacy.epoch = 0
	legacy.prev_base = nil
	payload := jobj()
	payload["action"] = json.String("authorizeBase")
	payload["base"] = json.String(base64.encode(encode_checkpoint(legacy)))
	_, err := sync_dispatch(json.Object(payload))
	testing.expect_value(t, err, "a base has epoch >= 1")
}

@(private = "file")
changes_json :: proc(deltas: []Delta) -> json.Value {
	out := make([dynamic]json.Value)
	for &d in deltas {
		item := change_to_json(d.change, ordered = true).(json.Object)
		if d.tagged do item["b"] = json.String(hex_id(d.b[:]))
		append(&out, json.Object(item))
	}
	return json.Array(out)
}

@(private = "file")
bases_json :: proc(bases: []Checkpoint) -> json.Value {
	out := make([dynamic]json.Value)
	for b in bases do append(&out, json.String(base64.encode(encode_checkpoint(b))))
	return json.Array(out)
}

@(test)
state_sync_dispatch_json :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	c1, c2, c3 := history()
	b1 := fold(t, nil, {pre(c1), pre(c2), pre(c3)}, 10_000)
	d1 := mk({c3}, 11_000, set("title", "B"))
	b2 := fold(t, {b1}, {on(d1, b1)}, 20_000)
	live := mk({d1}, 21_000, set("x", "1"))
	orphan := mk({c3}, 12_000, set("late", "1"))
	deltas := []Delta{pre(c1), pre(c2), pre(c3), on(d1, b1), on(live, b2), on(orphan, b1)}
	fields := jobj()
	fields["bases"] = bases_json({b1, b2})
	fields["changes"] = changes_json(deltas)

	current := call(t, "base_current", fields)
	index, _ := json_int(current, "index")
	testing.expect_value(t, index, 1)
	testing.expect_value(t, json_str(current, "hash"), hex_id(b2.base_hash[:]))

	cls := call(t, "classify", fields)
	list :: proc(v: json.Value, key: string) -> []string {
		out := make([dynamic]string)
		for item in json_array(v, key) do append(&out, string(item.(json.String)))
		return out[:]
	}
	testing.expect(t, slice.equal(list(cls, "live"), []string{hex_id(live.id)}), "live")
	testing.expect(t, slice.equal(list(cls, "covered"), []string{hex_id(d1.id)}), "covered")
	testing.expect_value(t, len(list(cls, "premigrationCovered")), 3)
	testing.expect(t, slice.equal(list(cls, "orphan"), []string{hex_id(orphan.id)}), "orphan")
	testing.expect(t, slice.equal(list(cls, "discard"), []string{hex_id(orphan.id)}), "another device's orphan: discard")
	testing.expect_value(t, len(list(cls, "rebase")), 0)
	none_rebased := call(t, "rebase", fields)
	testing.expect_value(t, len(json_array(none_rebased, "changes")), 0)

	// Written here: rebase it.
	fields["own"] = json.Array([dynamic]json.Value{json.String(hex_id(orphan.id))})
	cls = call(t, "classify", fields)
	testing.expect(t, slice.equal(list(cls, "rebase"), []string{hex_id(orphan.id)}), "own orphan: rebase")
	testing.expect_value(t, len(list(cls, "discard")), 0)
	testing.expect_value(t, len(list(cls, "proven")), 0)
	testing.expect(t, slice.equal(list(cls, "liveHeads"), []string{hex_id(live.id)}), "live heads")

	first := call(t, "rebase", fields)
	second := call(t, "rebase", fields)
	testing.expect_value(t, string(marshal(first)), string(marshal(second)))
	testing.expect_value(t, json_str(first, "base"), hex_id(b2.base_hash[:]))
	rebased := json_array(first, "changes")[0]
	verify := jobj()
	verify["bytes"] = json.String(json_str(rebased, "bytes"))
	verified, verr := wire_verify(json.Object(verify))
	testing.expect(t, verr == "", "rebased bytes carry their content address")
	testing.expect_value(t, json_str(verified, "id"), json_str(rebased, "id"))

	state := call(t, "replay_from_base", fields)
	want, _, _ := base_replay({b1, b2}, deltas, nil, nil)
	expected := object_to_json_value(&want).(json.Object)
	slice.sort(want.heads[:])
	heads := make([dynamic]json.Value)
	for head in want.heads do append(&heads, json.String(head))
	expected["heads"] = json.Array(heads)
	testing.expect(t, len(heads) > 0, "replay_from_base reports the heads it replayed to")
	testing.expect_value(t, string(marshal(state)), string(marshal(expected)))

	fields["nowMs"] = json.Integer(30_000)
	fields["force"] = json.Boolean(true)
	plan := call(t, "compact_plan", fields)
	compact, _ := json_bool(plan, "compact")
	epoch, _ := json_int(plan, "epoch")
	testing.expect(t, compact && epoch == 3, "compact_plan builds epoch 3")
	testing.expect(t, slice.equal(list(plan, "folded"), []string{hex_id(live.id)}), "folds the live deltas only")
	orphans, _ := json_int(plan, "orphans")
	testing.expect_value(t, orphans, 1)
	decoded := call(t, "base_decode", map[string]json.Value{"base" = json.String(json_str(plan, "base"))})
	testing.expect_value(t, json_str(decoded, "hash"), json_str(plan, "hash"))
	testing.expect_value(t, json_str(decoded, "prevBase"), hex_id(b2.base_hash[:]))

	empty := call(t, "replay_from_base", map[string]json.Value{})
	testing.expect(t, empty == nil, "nothing held: null")
	none := call(t, "base_current", map[string]json.Value{})
	_, is_null := none.(json.Null)
	testing.expect(t, is_null, "no base: null")
}
