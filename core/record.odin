package core

// State records (docs/state-objects.md): an object stored as its current
// state, every property, block and chat message stamped with a hybrid clock
// time and a device. Two copies merge entry by entry - the larger stamp
// wins - so order and repetition never matter. Lives beside the DAG until
// the switch; nothing reads records yet. The Rust engine
// (roostr-engine/src/record.rs) implements the same contract, checked by the
// shared vectors in testdata/record_vectors/.

import "base:runtime"
import "core:encoding/hex"
import "core:encoding/json"
import "core:slice"
import "core:strings"

// ── Model ────────────────────────────────────────────────────────────

/** `time` = unix ms << 16 | counter; `device` = index in the space's device table. */
Stamp :: struct {
	time:   u64,
	device: u32,
}

Entry_Kind :: enum u8 {
	None,
	Value,   // a property, or the "type" / "deleted" slots
	Block,   // a page block
	Message, // a chat message (custom block "chat")
}

/** BlockBody and MessageBody: one shape, a block minus its id and children. */
Entry_Body :: struct {
	parent:           string, // "" = top level
	position:         string, // fractional key (pin_key_between), sorts siblings
	content:          Block_Content,
	fields:           [dynamic]Value_Entry,
	align:            i64,
	background_color: string,
}

Record_Entry :: struct {
	key:   string,
	stamp: Stamp,
	gone:  bool, // tombstone: removed at `stamp`
	kind:  Entry_Kind,
	value: Value,      // .Value
	body:  Entry_Body, // .Block / .Message
}

/** `type` / `deleted` are absent while their key is "". */
Record :: struct {
	object_id:  string,
	type:       Record_Entry,
	deleted:    Record_Entry,
	fields:     [dynamic]Record_Entry,
	blocks:     [dynamic]Record_Entry,
	messages:   [dynamic]Record_Entry,
	created_at: i64,
}

Patch :: struct {
	object_id: string,
	entries:   [dynamic]Record_Entry,
}

RECORD_TYPE_KEY :: "type"
RECORD_DELETED_KEY :: "deleted"
/** Custom content type of a chat message block (conversation.odin). */
RECORD_MESSAGE_CONTENT :: "chat"

stamp_ms :: proc(time: u64) -> i64 {
	return i64(time >> 16)
}

stamp_from_ms :: proc(ms: i64, device: u32) -> Stamp {
	return Stamp{time = u64(max(ms, 0)) << 16, device = device}
}

stamp_compare :: proc(a, b: Stamp) -> int {
	if a.time != b.time do return a.time < b.time ? -1 : 1
	if a.device != b.device do return a.device < b.device ? -1 : 1
	return 0
}

// ── Hybrid logical clock ─────────────────────────────────────────────

/** Stamps further ahead of the local wall clock than this are refused. */
HLC_MAX_FUTURE_MS :: 24 * 60 * 60 * 1000

/** The highest stamp time this device issued or saw. */
Hlc :: struct {
	last: u64,
}

/** Next local stamp time: the wall clock, or one past anything seen, whichever is larger. */
hlc_now :: proc(clock: ^Hlc, wall_ms: i64) -> u64 {
	wall := u64(max(wall_ms, 0)) << 16
	clock.last = wall > clock.last ? wall : clock.last + 1
	return clock.last
}

/**
 * Advance past a received stamp so the next local stamp is newer. False (and
 * the clock untouched) when the stamp is more than 24 h ahead of `wall_ms`:
 * the caller refuses it and reports it on the device record's Error.
 */
hlc_observe :: proc(clock: ^Hlc, stamp: Stamp, wall_ms: i64) -> bool {
	if stamp_ms(stamp.time) > wall_ms + HLC_MAX_FUTURE_MS do return false
	if stamp.time > clock.last do clock.last = stamp.time
	return true
}

// ── Canonical encoding ───────────────────────────────────────────────
//
// Proto3 rules (defaults omitted, fields in number order) plus: entries
// sorted by key, every map (Value maps, block fields, custom meta) sorted by
// key with duplicate keys last-wins, a tombstone's body encoded empty, and
// Entry.stamp always present.

@(private = "file")
sorted_value_entries :: proc(entries: []Value_Entry, allocator := context.temp_allocator) -> []Value_Entry {
	out := slice.clone(entries, allocator)
	slice.stable_sort_by(out, proc(a, b: Value_Entry) -> bool {return a.key < b.key})
	n := 0
	for e, i in out {
		if i + 1 < len(out) && out[i + 1].key == e.key do continue // last wins
		out[n] = e
		n += 1
	}
	return out[:n]
}

@(private = "file")
sorted_meta :: proc(pairs: []Str_Pair, allocator := context.temp_allocator) -> [dynamic]Str_Pair {
	sorted := slice.clone(pairs, allocator)
	slice.stable_sort_by(sorted, proc(a, b: Str_Pair) -> bool {return a.key < b.key})
	out := make([dynamic]Str_Pair, allocator)
	for p, i in sorted {
		if i + 1 < len(sorted) && sorted[i + 1].key == p.key do continue
		append(&out, p)
	}
	return out
}

@(private = "file")
encode_value_map_entries :: proc(entries: []Value_Entry, w: ^Writer) {
	for e in sorted_value_entries(entries) {
		entry: Writer
		write_len_prefixed(&entry, 1, transmute([]byte)e.key)
		vw: Writer
		encode_value_canonical(e.value, &vw)
		write_len_prefixed(&entry, 2, vw.buf[:])
		delete(vw.buf)
		write_len_prefixed(w, 1, entry.buf[:])
		delete(entry.buf)
	}
}

/** encode_value with map entries sorted by key at every depth. */
encode_value_canonical :: proc(v: Value, w: ^Writer) {
	#partial switch v.kind {
	case .Map:
		sub: Writer
		encode_value_map_entries(v.entries[:], &sub)
		write_len_prefixed(w, 7, sub.buf[:])
		delete(sub.buf)
	case .List:
		sub: Writer
		for item in v.items {
			iw: Writer
			encode_value_canonical(item, &iw)
			write_len_prefixed(&sub, 1, iw.buf[:])
			delete(iw.buf)
		}
		write_len_prefixed(w, 8, sub.buf[:])
		delete(sub.buf)
	case:
		encode_value(v, w)
	}
}

@(private = "file")
encode_body :: proc(b: Entry_Body, w: ^Writer) {
	write_string_field(w, 1, b.parent)
	write_string_field(w, 2, b.position)
	if b.content.kind != .None {
		content := b.content
		if content.kind == .Custom do content.custom.meta = sorted_meta(content.custom.meta[:])
		cw: Writer
		encode_block_content(content, &cw)
		write_len_prefixed(w, 3, cw.buf[:])
		delete(cw.buf)
	}
	if len(b.fields) > 0 {
		fw: Writer
		encode_value_map_entries(b.fields[:], &fw)
		write_len_prefixed(w, 4, fw.buf[:])
		delete(fw.buf)
	}
	write_i64_field(w, 5, b.align)
	write_string_field(w, 6, b.background_color)
}

/** One Entry message body (no outer tag). */
encode_entry :: proc(e: Record_Entry, w: ^Writer) {
	write_string_field(w, 1, e.key)
	sw: Writer
	if e.stamp.time != 0 {
		write_tag(&sw, 1, 0)
		write_varint(&sw, e.stamp.time)
	}
	if e.stamp.device != 0 {
		write_tag(&sw, 2, 0)
		write_varint(&sw, u64(e.stamp.device))
	}
	write_len_prefixed(w, 2, sw.buf[:])
	delete(sw.buf)
	write_bool_field(w, 3, e.gone)
	field: u64
	switch e.kind {
	case .None:
		return
	case .Value:
		field = 4
	case .Block:
		field = 5
	case .Message:
		field = 6
	}
	bw: Writer
	if !e.gone {
		if e.kind == .Value do encode_value_canonical(e.value, &bw)
		else do encode_body(e.body, &bw)
	}
	write_len_prefixed(w, field, bw.buf[:])
	delete(bw.buf)
}

entry_bytes :: proc(e: Record_Entry, allocator := context.temp_allocator) -> []byte {
	w: Writer
	w.buf = make([dynamic]byte, allocator)
	encode_entry(e, &w)
	return w.buf[:]
}

@(private = "file")
sorted_entries :: proc(entries: []Record_Entry, allocator := context.temp_allocator) -> []Record_Entry {
	out := slice.clone(entries, allocator)
	slice.sort_by(out, proc(a, b: Record_Entry) -> bool {return a.key < b.key})
	return out
}

@(private = "file")
write_entry_field :: proc(w: ^Writer, field: u64, e: Record_Entry) {
	ew: Writer
	encode_entry(e, &ew)
	write_len_prefixed(w, field, ew.buf[:])
	delete(ew.buf)
}

/** The canonical Record protobuf: what record_hash hashes and packs carry. */
record_encode :: proc(r: Record, allocator := context.allocator) -> []byte {
	w: Writer
	w.buf = make([dynamic]byte, allocator)
	write_string_field(&w, 1, r.object_id)
	if r.type.key != "" do write_entry_field(&w, 2, r.type)
	if r.deleted.key != "" do write_entry_field(&w, 3, r.deleted)
	for e in sorted_entries(r.fields[:]) do write_entry_field(&w, 4, e)
	for e in sorted_entries(r.blocks[:]) do write_entry_field(&w, 5, e)
	for e in sorted_entries(r.messages[:]) do write_entry_field(&w, 6, e)
	write_i64_field(&w, 7, r.created_at)
	return w.buf[:]
}

patch_encode :: proc(p: Patch, allocator := context.allocator) -> []byte {
	w: Writer
	w.buf = make([dynamic]byte, allocator)
	write_string_field(&w, 1, p.object_id)
	for e in sorted_entries(p.entries[:]) do write_entry_field(&w, 2, e)
	return w.buf[:]
}

record_hash :: proc(r: Record) -> [32]byte {
	bytes := record_encode(r, context.temp_allocator)
	return sha256(bytes)
}

// ── Merge ────────────────────────────────────────────────────────────

/** True when `a` beats `b`: larger stamp, then larger canonical bytes (equal stamps never happen in practice). */
entry_wins :: proc(a, b: Record_Entry) -> bool {
	if c := stamp_compare(a.stamp, b.stamp); c != 0 do return c > 0
	return strings.compare(string(entry_bytes(a)), string(entry_bytes(b))) > 0
}

@(private = "file")
merge_slot :: proc(a, b: Record_Entry) -> Record_Entry {
	if a.key == "" do return b
	if b.key == "" do return a
	return entry_wins(b, a) ? b : a
}

@(private = "file")
merge_entries :: proc(a, b: []Record_Entry, allocator := context.allocator) -> [dynamic]Record_Entry {
	winners := make(map[string]Record_Entry, allocator = context.temp_allocator)
	for list in ([][]Record_Entry{a, b}) {
		for e in list {
			if current, ok := winners[e.key]; ok && !entry_wins(e, current) do continue
			winners[e.key] = e
		}
	}
	out := make([dynamic]Record_Entry, 0, len(winners), allocator)
	for _, e in winners do append(&out, e)
	slice.sort_by(out[:], proc(x, y: Record_Entry) -> bool {return x.key < y.key})
	return out
}

/**
 * Entry by entry, the larger stamp wins. Commutative, associative,
 * idempotent. False when the records describe different objects.
 */
record_merge :: proc(a, b: Record, allocator := context.allocator) -> (Record, bool) {
	if a.object_id != "" && b.object_id != "" && a.object_id != b.object_id do return {}, false
	out: Record
	out.object_id = a.object_id != "" ? a.object_id : b.object_id
	out.type = merge_slot(a.type, b.type)
	out.deleted = merge_slot(a.deleted, b.deleted)
	out.fields = merge_entries(a.fields[:], b.fields[:], allocator)
	out.blocks = merge_entries(a.blocks[:], b.blocks[:], allocator)
	out.messages = merge_entries(a.messages[:], b.messages[:], allocator)
	out.created_at = a.created_at
	if b.created_at != 0 && (out.created_at == 0 || b.created_at < out.created_at) do out.created_at = b.created_at
	return out, true
}

/** A patch as a record: "type"/"deleted" to their slots, else by body kind. */
patch_to_record :: proc(p: Patch, allocator := context.allocator) -> (Record, bool) {
	r: Record
	r.object_id = p.object_id
	r.fields = make([dynamic]Record_Entry, allocator)
	r.blocks = make([dynamic]Record_Entry, allocator)
	r.messages = make([dynamic]Record_Entry, allocator)
	for e in p.entries {
		switch {
		case e.key == RECORD_TYPE_KEY:
			if e.kind != .Value do return {}, false
			r.type = merge_slot(r.type, e)
		case e.key == RECORD_DELETED_KEY:
			if e.kind != .Value do return {}, false
			r.deleted = merge_slot(r.deleted, e)
		case:
			switch e.kind {
			case .None:
				return {}, false
			case .Value:
				append(&r.fields, e)
			case .Block:
				append(&r.blocks, e)
			case .Message:
				append(&r.messages, e)
			}
		}
	}
	// Duplicate keys inside one patch resolve like any merge.
	empty: Record
	return record_merge(r, empty, allocator)
}

record_apply_patch :: proc(r: Record, p: Patch, allocator := context.allocator) -> (Record, bool) {
	as_record, ok := patch_to_record(p, context.temp_allocator)
	if !ok do return {}, false
	return record_merge(r, as_record, allocator)
}

// ── Fingerprints ─────────────────────────────────────────────────────

record_bucket :: proc(object_id: string) -> u8 {
	return sha256(transmute([]byte)object_id)[0]
}

Fingerprint :: struct {
	buckets: [256][32]byte,
	root:    [32]byte,
}

/** Bucket hash = sha256 of its record hashes in object id order; root = sha256 of the 256 bucket hashes. */
records_fingerprint :: proc(records: []Record) -> Fingerprint {
	ids := make([]string, len(records), context.temp_allocator)
	hashes := make([][32]byte, len(records), context.temp_allocator)
	for r, i in records {
		ids[i] = r.object_id
		hashes[i] = record_hash(r)
	}
	return records_fingerprint_hashes(ids, hashes)
}

/** records_fingerprint from record hashes already taken (`ids[i]` names `hashes[i]`; any order). */
records_fingerprint_hashes :: proc(ids: []string, hashes: [][32]byte) -> Fingerprint {
	Keyed :: struct {
		id:    string,
		index: int,
	}
	keyed := make([]Keyed, len(ids), context.temp_allocator)
	for id, i in ids do keyed[i] = {id, i}
	slice.sort_by(keyed, proc(a, b: Keyed) -> bool {return a.id < b.id})

	per_bucket: [256][dynamic]byte
	for k in keyed {
		bucket := record_bucket(k.id)
		if per_bucket[bucket] == nil do per_bucket[bucket] = make([dynamic]byte, context.temp_allocator)
		append(&per_bucket[bucket], ..hashes[k.index][:])
	}
	fp: Fingerprint
	all := make([dynamic]byte, 0, 256 * 32, context.temp_allocator)
	for i in 0 ..< 256 {
		fp.buckets[i] = sha256(per_bucket[i][:])
		append(&all, ..fp.buckets[i][:])
	}
	fp.root = sha256(all[:])
	return fp
}

// ── View: record → Object_State ──────────────────────────────────────

/**
 * The record as today's Object_State: live fields; blocks and messages as
 * one tree (children ordered by position then id, preorder from the roots;
 * entries whose parent is gone are not shown); created_at the record's,
 * else the oldest stamp; updated_at the newest stamp.
 */
record_view :: proc(r: Record, allocator := context.allocator) -> Object_State {
	s: Object_State
	s.id = r.object_id
	s.fields = make([dynamic]Value_Entry, allocator)
	s.blocks = make([dynamic]Block, allocator)
	s.heads = make([dynamic]string, allocator)
	if r.type.key != "" && !r.type.gone && r.type.value.kind == .String do s.type_key = r.type.value.str
	if r.deleted.key != "" && !r.deleted.gone && r.deleted.value.kind == .Bool do s.deleted = r.deleted.value.b

	oldest: u64 = max(u64)
	newest: u64 = 0
	seen := false
	observe :: proc(e: Record_Entry, oldest, newest: ^u64, seen: ^bool) {
		seen^ = true
		oldest^ = min(oldest^, e.stamp.time)
		newest^ = max(newest^, e.stamp.time)
	}
	if r.type.key != "" do observe(r.type, &oldest, &newest, &seen)
	if r.deleted.key != "" do observe(r.deleted, &oldest, &newest, &seen)
	for list in ([][dynamic]Record_Entry{r.fields, r.blocks, r.messages}) {
		for e in list do observe(e, &oldest, &newest, &seen)
	}
	if seen {
		s.created_at = stamp_ms(oldest)
		s.updated_at = stamp_ms(newest)
	}
	if r.created_at != 0 do s.created_at = r.created_at

	for e in sorted_entries(r.fields[:]) {
		if !e.gone && e.kind == .Value do append(&s.fields, Value_Entry{key = e.key, value = e.value})
	}

	nodes := make([dynamic]Record_Entry, context.temp_allocator)
	for list in ([][dynamic]Record_Entry{r.blocks, r.messages}) {
		for e in list {
			if !e.gone && (e.kind == .Block || e.kind == .Message) do append(&nodes, e)
		}
	}
	slice.sort_by(nodes[:], proc(a, b: Record_Entry) -> bool {
		if a.body.parent != b.body.parent do return a.body.parent < b.body.parent
		if a.body.position != b.body.position do return a.body.position < b.body.position
		return a.key < b.key
	})
	// A key in both lists (never written that way) shows once: the first in sort order.
	children := make(map[string][dynamic]string, allocator = context.temp_allocator)
	by_key := make(map[string]Record_Entry, allocator = context.temp_allocator)
	for e in nodes {
		if e.key in by_key do continue
		by_key[e.key] = e
		list := children[e.body.parent] or_else make([dynamic]string, context.temp_allocator)
		append(&list, e.key)
		children[e.body.parent] = list
	}
	stack := make([dynamic]string, context.temp_allocator)
	roots := children[""] or_else nil
	for i := len(roots) - 1; i >= 0; i -= 1 do append(&stack, roots[i])
	emitted := make(map[string]bool, allocator = context.temp_allocator)
	for len(stack) > 0 {
		id := pop(&stack)
		if id in emitted || id == "" do continue
		emitted[id] = true
		e := by_key[id]
		b: Block
		b.id = e.key
		b.children_ids = make([dynamic]string, allocator)
		if kids, ok := children[id]; ok do append(&b.children_ids, ..kids[:])
		b.content = e.body.content
		b.fields = make([dynamic]Value_Entry, allocator)
		append(&b.fields, ..e.body.fields[:])
		b.align = e.body.align
		b.background_color = e.body.background_color
		b.has_content = b.content.kind != .None
		b.has_fields = len(b.fields) > 0
		append(&s.blocks, b)
		for i := len(b.children_ids) - 1; i >= 0; i -= 1 do append(&stack, b.children_ids[i])
	}
	return s
}

/**
 * A record gives every block one place, so a legacy graph that lists a
 * block under a parent AND emits it elsewhere (tree_serialize prints it
 * once, the parent keeps the dangling reference) loses that extra
 * reference. Drops it from a replayed state the way conversion does - a
 * child reference to a block already placed earlier in preorder - so the
 * state compares equal to record_view. True when something was dropped.
 */
state_drop_repeated_refs :: proc(s: ^Object_State, allocator := context.allocator) -> bool {
	exists := make(map[string]bool, allocator = context.temp_allocator)
	for b in s.blocks do exists[b.id] = true
	placed := make(map[string]bool, allocator = context.temp_allocator)
	changed := false
	for &b in s.blocks {
		placed[b.id] = true
		kept := make([dynamic]string, allocator)
		for c in b.children_ids {
			if c in exists && c in placed {
				changed = true
				continue
			}
			placed[c] = true
			append(&kept, c)
		}
		b.children_ids = kept
	}
	return changed
}

// ── Conversion: replayed DAG state → record ──────────────────────────

/** Who last wrote an entry: that change's timestamp (ms) and author. */
Record_Writer :: struct {
	time:    i64,
	author:  string,
	seed:    bool, // written by the replay's seed (checkpoint / legacy snapshot): no author, device 0
	message: bool, // blocks: last seen as a chat message
	alive:   bool, // blocks: in the tree after the last change seen
}

/** Per entry key, the last change that wrote it, collected by a replay hook. */
Record_Writers :: struct {
	has_seed:   bool,
	seed:       Record_Writer, // the seed's updated_at
	slots:      map[string]Record_Writer, // "type", "deleted"
	fields:     map[string]Record_Writer,
	blocks:     map[string]Record_Writer, // blocks and messages
	stored:     int, // Block_Tree.storage length at the last call
	live_count: int, // Block_Tree.by_id size at the last call
}

record_block_is_message :: proc(content: Block_Content) -> bool {
	return content.kind == .Custom && content.custom.content_type == RECORD_MESSAGE_CONTENT
}

@(private = "file")
writers_stamp_block :: proc(w: ^Record_Writers, id: string, by: Record_Writer, t: ^Block_Tree) {
	if id == "" do return
	entry := w.blocks[id] or_else Record_Writer{}
	entry.time = by.time
	entry.author = by.author
	entry.seed = false
	if b, ok := t.by_id[id]; ok {
		entry.alive = true
		entry.message = record_block_is_message(b.content)
	} else {
		entry.alive = false
	}
	w.blocks[id] = entry
}

/** Replay_Hook.on_change for Record_Writers. */
record_writers_on_change :: proc(data: rawptr, change: ^Change, seed: ^Snapshot, seed_ms: i64, t: ^Block_Tree) {
	w := (^Record_Writers)(data)
	if change == nil {
		if seed != nil {
			w.has_seed = true
			w.seed = Record_Writer{time = seed_ms, seed = true}
			for id, b in t.by_id {
				w.blocks[id] = Record_Writer{time = seed_ms, seed = true, alive = true, message = record_block_is_message(b.content)}
			}
		}
		w.stored = len(t.storage)
		w.live_count = len(t.by_id)
		return
	}
	by := Record_Writer{time = change.timestamp, author = change.author}
	for op in change.ops {
		switch op.kind {
		case .None:
		case .Object_Create:
			w.slots[RECORD_TYPE_KEY] = by
			w.slots[RECORD_DELETED_KEY] = by
		case .Object_Delete:
			w.slots[RECORD_DELETED_KEY] = by
		case .Field_Set, .Field_Delete:
			w.fields[op.key] = by
		case .Block_Add, .Block_Move:
			writers_stamp_block(w, op.kind == .Block_Add ? op.block.id : op.block_id, by, t)
			// Side and replace placement rewraps or removes the target.
			if op.position == POS_LEFT || op.position == POS_RIGHT || op.position == POS_REPLACE {
				writers_stamp_block(w, op.target_id, by, t)
			}
		case .Block_Remove, .Block_Update, .Block_Set_Align, .Block_Set_Background:
			writers_stamp_block(w, op.block_id, by, t)
		}
	}
	// Blocks the change created (its own and deterministic layout blocks).
	for b in t.storage[w.stored:] do writers_stamp_block(w, b.id, by, t)
	created := len(t.storage) - w.stored
	// Something left the tree (a removed subtree, an unwrapped layout): its
	// removal is this change's write. Plain appends skip the scan.
	if len(t.by_id) < w.live_count + created {
		for id, &entry in w.blocks {
			if entry.alive && id not_in t.by_id {
				entry.time = by.time
				entry.author = by.author
				entry.seed = false
				entry.alive = false
			}
		}
	}
	w.stored = len(t.storage)
	w.live_count = len(t.by_id)
}

@(private = "file")
record_writers_make :: proc(allocator: runtime.Allocator) -> Record_Writers {
	w: Record_Writers
	w.slots = make(map[string]Record_Writer, allocator = allocator)
	w.fields = make(map[string]Record_Writer, allocator = allocator)
	w.blocks = make(map[string]Record_Writer, allocator = allocator)
	return w
}

/** Replay once, as compute_state does, recording who last wrote each entry. */
record_writers_replay :: proc(changes: []Change, checkpoint: ^Checkpoint = nil, allocator := context.allocator) -> (Object_State, Record_Writers, bool) {
	w := record_writers_make(allocator)
	hook := Replay_Hook{data = &w, on_change = record_writers_on_change}
	state, ok := compute_state(changes, allocator, checkpoint, &hook)
	return state, w, ok
}

/** The same for a device holding a base: state_from_base over its live deltas, the base as seed. */
record_writers_replay_base :: proc(base: ^Checkpoint, live: []Change, allocator := context.allocator) -> (Object_State, Record_Writers, bool) {
	w := record_writers_make(allocator)
	hook := Replay_Hook{data = &w, on_change = record_writers_on_change}
	state, ok := state_from_base(base, live, allocator, &hook)
	return state, w, ok
}

/**
 * Fractional positions for `n` siblings in order: bisection with
 * pin_key_between, so keys stay short (about log62 n characters).
 */
record_positions :: proc(n: int, allocator := context.allocator) -> []string {
	out := make([]string, n, allocator)
	assign :: proc(out: []string, lo, hi: int, a, b: string, has_b: bool, allocator: runtime.Allocator) {
		if lo > hi do return
		m := (lo + hi) / 2
		k := pin_key_between(a, b, has_b, allocator)
		out[m] = k
		assign(out, lo, m - 1, a, k, true, allocator)
		assign(out, m + 1, hi, k, b, has_b, allocator)
	}
	assign(out, 0, n - 1, "", "", false, allocator)
	return out
}

/**
 * The record for a replayed state. Every entry is stamped (time of the change
 * that last wrote it, devices[its author]); keys a change removed become
 * tombstones. Error text when a writer's author has no device index or an
 * entry has no writer at all.
 */
record_from_object_state :: proc(state: ^Object_State, writers: ^Record_Writers, devices: map[string]u32, allocator := context.allocator) -> (Record, string) {
	r: Record
	r.object_id = state.id
	r.created_at = state.created_at
	r.fields = make([dynamic]Record_Entry, allocator)
	r.blocks = make([dynamic]Record_Entry, allocator)
	r.messages = make([dynamic]Record_Entry, allocator)

	stamp_for :: proc(found: bool, by: Record_Writer, writers: ^Record_Writers, devices: map[string]u32) -> (Stamp, string) {
		w := by
		if !found {
			if !writers.has_seed do return {}, "entry has no writer"
			w = writers.seed
		}
		if w.seed do return stamp_from_ms(w.time, 0), ""
		device, known := devices[w.author]
		if !known do return {}, strings.concatenate({"author has no device index: ", w.author}, context.temp_allocator)
		return stamp_from_ms(w.time, device), ""
	}

	slot_by, slot_found := writers.slots[RECORD_TYPE_KEY]
	if slot_found || state.type_key != "" {
		stamp, err := stamp_for(slot_found, slot_by, writers, devices)
		if err != "" do return {}, err
		r.type = Record_Entry{key = RECORD_TYPE_KEY, stamp = stamp, kind = .Value, value = Value{kind = .String, str = state.type_key}}
	}
	slot_by, slot_found = writers.slots[RECORD_DELETED_KEY]
	if slot_found || state.deleted {
		stamp, err := stamp_for(slot_found, slot_by, writers, devices)
		if err != "" do return {}, err
		r.deleted = Record_Entry{key = RECORD_DELETED_KEY, stamp = stamp, kind = .Value, value = Value{kind = .Bool, b = state.deleted}}
	}

	live_fields := make(map[string]bool, allocator = context.temp_allocator)
	for f in state.fields {
		live_fields[f.key] = true
		by, found := writers.fields[f.key]
		stamp, err := stamp_for(found, by, writers, devices)
		if err != "" do return {}, err
		append(&r.fields, Record_Entry{key = f.key, stamp = stamp, kind = .Value, value = f.value})
	}
	for key, by in writers.fields {
		if key in live_fields do continue
		stamp, err := stamp_for(true, by, writers, devices)
		if err != "" do return {}, err
		append(&r.fields, Record_Entry{key = key, stamp = stamp, gone = true, kind = .Value})
	}

	// Tree: a block not yet placed is a root; its listed children not yet
	// placed are its children, in list order. state.blocks is preorder.
	exists := make(map[string]bool, allocator = context.temp_allocator)
	for b in state.blocks do exists[b.id] = true
	parent := make(map[string]string, allocator = context.temp_allocator)
	placed := make(map[string]bool, allocator = context.temp_allocator)
	siblings := make(map[string][dynamic]string, allocator = context.temp_allocator)
	roots := make([dynamic]string, context.temp_allocator)
	for b in state.blocks {
		if b.id not_in placed {
			placed[b.id] = true
			parent[b.id] = ""
			append(&roots, b.id)
		}
		for c in b.children_ids {
			if c not_in exists || c in placed do continue
			placed[c] = true
			parent[c] = b.id
			list := siblings[b.id] or_else make([dynamic]string, context.temp_allocator)
			append(&list, c)
			siblings[b.id] = list
		}
	}
	siblings[""] = roots
	position := make(map[string]string, allocator = context.temp_allocator)
	for _, list in siblings {
		keys := record_positions(len(list), allocator)
		for id, i in list do position[id] = keys[i]
	}
	for b in state.blocks {
		if !placed[b.id] do continue
		placed[b.id] = false // first occurrence only
		by, found := writers.blocks[b.id]
		stamp, err := stamp_for(found, by, writers, devices)
		if err != "" do return {}, err
		e := Record_Entry{key = b.id, stamp = stamp}
		e.body = Entry_Body{parent = parent[b.id], position = position[b.id], content = b.content, fields = b.fields, align = b.align, background_color = b.background_color}
		if record_block_is_message(b.content) {
			e.kind = .Message
			append(&r.messages, e)
		} else {
			e.kind = .Block
			append(&r.blocks, e)
		}
	}
	for id, by in writers.blocks {
		if id in exists do continue
		stamp, err := stamp_for(true, by, writers, devices)
		if err != "" do return {}, err
		e := Record_Entry{key = id, stamp = stamp, gone = true}
		if by.message {
			e.kind = .Message
			append(&r.messages, e)
		} else {
			e.kind = .Block
			append(&r.blocks, e)
		}
	}
	slice.sort_by(r.fields[:], proc(a, b: Record_Entry) -> bool {return a.key < b.key})
	slice.sort_by(r.blocks[:], proc(a, b: Record_Entry) -> bool {return a.key < b.key})
	slice.sort_by(r.messages[:], proc(a, b: Record_Entry) -> bool {return a.key < b.key})
	return r, ""
}

// ── JSON (vectors and the "record" ABI method) ───────────────────────

stamp_to_json :: proc(s: Stamp, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["time"] = json.Integer(i64(s.time))
	o["device"] = json.Integer(i64(s.device))
	return json.Object(o)
}

@(private = "file")
content_to_json :: proc(c: Block_Content, allocator := context.temp_allocator) -> json.Value {
	wrapped := block_to_json(Block{content = c, has_content = true}, allocator, wire = true)
	content, _ := json_field(wrapped, "content")
	return content
}

@(private = "file")
body_to_json :: proc(b: Entry_Body, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["parent"] = json.String(b.parent)
	o["position"] = json.String(b.position)
	if b.content.kind != .None do o["content"] = content_to_json(b.content, allocator)
	if len(b.fields) > 0 do o["fields"] = fields_to_json(b.fields, allocator)
	if b.align != 0 do o["align"] = json.Integer(b.align)
	if b.background_color != "" do o["backgroundColor"] = json.String(b.background_color)
	return json.Object(o)
}

entry_to_json :: proc(e: Record_Entry, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["key"] = json.String(e.key)
	o["stamp"] = stamp_to_json(e.stamp, allocator)
	if e.gone do o["gone"] = json.Boolean(true)
	switch e.kind {
	case .None:
	case .Value:
		o["value"] = e.gone ? json.Value(json.Object(jobj(allocator))) : value_to_json(e.value, allocator)
	case .Block:
		o["block"] = e.gone ? json.Value(json.Object(jobj(allocator))) : body_to_json(e.body, allocator)
	case .Message:
		o["message"] = e.gone ? json.Value(json.Object(jobj(allocator))) : body_to_json(e.body, allocator)
	}
	return json.Object(o)
}

@(private = "file")
entries_to_json :: proc(entries: []Record_Entry, allocator := context.temp_allocator) -> json.Value {
	out := make([dynamic]json.Value, allocator)
	for e in sorted_entries(entries, allocator) do append(&out, entry_to_json(e, allocator))
	return json.Array(out)
}

record_to_json :: proc(r: Record, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["objectId"] = json.String(r.object_id)
	if r.type.key != "" do o["type"] = entry_to_json(r.type, allocator)
	if r.deleted.key != "" do o["deleted"] = entry_to_json(r.deleted, allocator)
	o["fields"] = entries_to_json(r.fields[:], allocator)
	o["blocks"] = entries_to_json(r.blocks[:], allocator)
	o["messages"] = entries_to_json(r.messages[:], allocator)
	o["createdAt"] = json.Integer(r.created_at)
	return json.Object(o)
}

patch_to_json :: proc(p: Patch, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["objectId"] = json.String(p.object_id)
	o["entries"] = entries_to_json(p.entries[:], allocator)
	return json.Object(o)
}

@(private = "file")
body_from_json :: proc(v: json.Value, allocator := context.allocator) -> Entry_Body {
	b: Entry_Body
	b.parent = json_str(v, "parent")
	b.position = json_str(v, "position")
	if content, ok := json_field(v, "content"); ok do b.content = content_from_json(content, allocator)
	b.fields = make([dynamic]Value_Entry, allocator)
	if fields, ok := json_field(v, "fields"); ok do b.fields = fields_from_json(fields, allocator)
	b.align, _ = json_int(v, "align")
	b.background_color = json_str(v, "backgroundColor")
	return b
}

entry_from_json :: proc(v: json.Value, allocator := context.allocator) -> (Record_Entry, bool) {
	if _, ok := v.(json.Object); !ok do return {}, false
	e: Record_Entry
	e.key = json_str(v, "key")
	stamp, has_stamp := json_field(v, "stamp")
	if !has_stamp do return {}, false
	time, _ := json_int(stamp, "time")
	device, _ := json_int(stamp, "device")
	if time < 0 || device < 0 || device > i64(max(u32)) do return {}, false
	e.stamp = Stamp{time = u64(time), device = u32(device)}
	e.gone, _ = json_bool(v, "gone")
	if value, ok := json_field(v, "value"); ok {
		e.kind = .Value
		if !e.gone do e.value = value_from_json(value, allocator)
	} else if body, bok := json_field(v, "block"); bok {
		e.kind = .Block
		if !e.gone do e.body = body_from_json(body, allocator)
	} else if body, mok := json_field(v, "message"); mok {
		e.kind = .Message
		if !e.gone do e.body = body_from_json(body, allocator)
	}
	return e, true
}

@(private = "file")
entries_from_json :: proc(v: json.Value, key: string, allocator := context.allocator) -> ([dynamic]Record_Entry, bool) {
	out := make([dynamic]Record_Entry, allocator)
	field, present := json_field(v, key)
	if !present || field == nil do return out, true
	items, ok := field.(json.Array)
	if !ok do return out, false
	for item in items {
		e, eok := entry_from_json(item, allocator)
		if !eok do return out, false
		append(&out, e)
	}
	return out, true
}

record_from_json :: proc(v: json.Value, allocator := context.allocator) -> (Record, bool) {
	if _, ok := v.(json.Object); !ok do return {}, false
	r: Record
	r.object_id = json_str(v, "objectId")
	for slot in ([]string{RECORD_TYPE_KEY, RECORD_DELETED_KEY}) {
		value, present := json_field(v, slot)
		if !present || value == nil do continue
		if _, null := value.(json.Null); null do continue
		e, ok := entry_from_json(value, allocator)
		if !ok || e.kind != .Value do return {}, false
		e.key = slot
		if slot == RECORD_TYPE_KEY do r.type = e
		else do r.deleted = e
	}
	ok: bool
	if r.fields, ok = entries_from_json(v, "fields", allocator); !ok do return {}, false
	if r.blocks, ok = entries_from_json(v, "blocks", allocator); !ok do return {}, false
	if r.messages, ok = entries_from_json(v, "messages", allocator); !ok do return {}, false
	r.created_at, _ = json_int(v, "createdAt")
	return r, true
}

patch_from_json :: proc(v: json.Value, allocator := context.allocator) -> (Patch, bool) {
	if _, ok := v.(json.Object); !ok do return {}, false
	p: Patch
	p.object_id = json_str(v, "objectId")
	ok: bool
	if p.entries, ok = entries_from_json(v, "entries", allocator); !ok do return {}, false
	return p, true
}

@(private = "file")
writer_to_json :: proc(w: Record_Writer, block: bool, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["time"] = json.Integer(w.time)
	o["author"] = json.String(w.author)
	if w.seed do o["seed"] = json.Boolean(true)
	if block do o["message"] = json.Boolean(w.message)
	return json.Object(o)
}

/** {type?, deleted?, fields: {key: W}, blocks: {id: W}}, W = {time, author, message?}. */
writers_to_json :: proc(w: ^Record_Writers, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	for slot in ([]string{RECORD_TYPE_KEY, RECORD_DELETED_KEY}) {
		if by, ok := w.slots[slot]; ok do o[slot] = writer_to_json(by, false, allocator)
	}
	fields := jobj(allocator)
	for key, by in w.fields do fields[key] = writer_to_json(by, false, allocator)
	o["fields"] = json.Object(fields)
	blocks := jobj(allocator)
	for key, by in w.blocks do blocks[key] = writer_to_json(by, true, allocator)
	o["blocks"] = json.Object(blocks)
	return json.Object(o)
}

/**
 * The replayed state, lossless, for converting outside this engine: every
 * block (including "__content__") in wire form (custom data always base64).
 * No derived projections (conversations, mailbox).
 */
record_state_to_json :: proc(s: ^Object_State, allocator := context.temp_allocator) -> json.Value {
	o := jobj(allocator)
	o["id"] = json.String(s.id)
	o["typeKey"] = json.String(s.type_key)
	o["fields"] = fields_to_json(s.fields, allocator)
	blocks := make([dynamic]json.Value, allocator)
	for b in s.blocks do append(&blocks, block_to_json(b, allocator, wire = true))
	o["blocks"] = json.Array(blocks)
	o["deleted"] = json.Boolean(s.deleted)
	o["createdAt"] = json.Integer(s.created_at)
	o["updatedAt"] = json.Integer(s.updated_at)
	return json.Object(o)
}

/**
 * ABI method "record" (hosts without a native DAG replay, i.e. the Rust
 * engine, convert through this):
 *   {action: "writers", changes, checkpoint?} → {state, writers, seed?}
 *   {action: "from_changes", changes, checkpoint?, devices: {author: u32}}
 *     → {record, canonical: hex, hash: hex}
 */
record_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	if action != "writers" && action != "from_changes" do return nil, "unknown record action"
	items_value, present := json_field(payload, "changes")
	if !present do return nil, "record requires changes"
	items, items_ok := items_value.(json.Array)
	if !items_ok do return nil, "record changes must be an array"
	checkpoint, checkpoint_error := optional_checkpoint(payload)
	if checkpoint_error != "" do return nil, checkpoint_error
	changes := make([]Change, len(items))
	for item, i in items {
		change, ok := change_from_json(item)
		if !ok do return nil, "invalid record change"
		if i > 0 && change.object_id != changes[0].object_id do return nil, "record changes must belong to one object"
		changes[i] = change
	}
	state, writers, ok := record_writers_replay(changes, checkpoint)
	if !ok do return nil, "record changes do not replay"

	out := jobj()
	if action == "writers" {
		out["state"] = record_state_to_json(&state)
		out["writers"] = writers_to_json(&writers)
		if writers.has_seed do out["seed"] = writer_to_json(writers.seed, false)
		return json.Object(out), ""
	}
	devices := make(map[string]u32, allocator = context.temp_allocator)
	if table, has := json_field(payload, "devices"); has {
		for pair in json_map_pairs(table, context.temp_allocator) {
			n, is_int := pair.value.(json.Integer)
			if !is_int || n < 0 || i64(n) > i64(max(u32)) do return nil, "record device index must be a u32"
			devices[pair.key] = u32(n)
		}
	}
	record, err := record_from_object_state(&state, &writers, devices)
	if err != "" do return nil, err
	bytes := record_encode(record, context.temp_allocator)
	hash := sha256(bytes)
	out["record"] = record_to_json(record)
	out["canonical"] = json.String(string(hex.encode(bytes, context.temp_allocator)))
	out["hash"] = json.String(string(hex.encode(hash[:], context.temp_allocator)))
	return json.Object(out), ""
}
