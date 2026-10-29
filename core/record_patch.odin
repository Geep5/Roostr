package core

// The patch a local change writes on a record (docs/state-objects.md
// "Record mode"): shared by the daemon's record store (src/records.odin)
// and hosts without a native replay (ABI "record" action "patch", the Rust
// replica), so every writer stamps the same entries for the same change.

import "core:encoding/hex"
import "core:encoding/json"
import "core:strings"

@(private = "file")
value_bytes :: proc(v: Value) -> string {
	w := Writer{buf = make([dynamic]byte, context.temp_allocator)}
	encode_value_canonical(v, &w)
	return string(w.buf[:])
}

@(private = "file")
entry_shape :: proc(e: Record_Entry) -> string {
	bare := e
	bare.stamp = {}
	return string(entry_bytes(bare))
}

/** Fractional keys for `n` siblings strictly between `a` and `b` (has_b false: after `a`). */
@(private = "file")
positions_between :: proc(n: int, a, b: string, has_b: bool) -> []string {
	out := make([]string, n, context.temp_allocator)
	assign :: proc(out: []string, lo, hi: int, a, b: string, has_b: bool) {
		if lo > hi do return
		m := (lo + hi) / 2
		k := pin_key_between(a, b, has_b, context.temp_allocator)
		out[m] = k
		assign(out, lo, m - 1, a, k, true)
		assign(out, m + 1, hi, k, b, has_b)
	}
	assign(out, 0, n - 1, a, b, has_b)
	return out
}

/** Which `eligible` items keep their key: a longest strictly increasing run of `keys`. */
@(private = "file")
longest_increasing :: proc(keys: []string, eligible: []bool) -> []bool {
	n := len(keys)
	keep := make([]bool, n, context.temp_allocator)
	prev := make([]int, n, context.temp_allocator)
	tails := make([dynamic]int, context.temp_allocator)
	for i in 0 ..< n {
		prev[i] = -1
		if !eligible[i] do continue
		lo, hi := 0, len(tails)
		for lo < hi {
			mid := (lo + hi) / 2
			if keys[tails[mid]] < keys[i] do lo = mid + 1
			else do hi = mid
		}
		if lo > 0 do prev[i] = tails[lo - 1]
		if lo == len(tails) do append(&tails, i)
		else do tails[lo] = i
	}
	if len(tails) > 0 {
		for i := tails[len(tails) - 1]; i >= 0; i = prev[i] do keep[i] = true
	}
	return keep
}

/**
 * The patch a change writes on `r` (nil: no record yet), every entry at
 * `stamp`. The change is replayed on the record's view with core's writer
 * hook: what the change wrote is stamped even when the value did not change
 * (as a DAG change moves updated_at); what replay changed on the side
 * (normalization: unwrapped layouts, reset widths) is found by comparing
 * with the record. Unchanged siblings keep their positions (a longest
 * increasing run); new, moved and reordered blocks get keys between their
 * kept neighbours. Temp-allocated. False when the replay refuses the change.
 */
record_patch_for_change :: proc(r: ^Record, c: ^Change, stamp: Stamp) -> (Patch, bool) {
	context.allocator = context.temp_allocator
	p := Patch{object_id = c.object_id, entries = make([dynamic]Record_Entry)}
	base: Record
	if r != nil do base = r^

	seed: Snapshot
	seed_ptr: ^Snapshot
	max_ts: i64
	if r != nil {
		s0 := record_view(base)
		seed = Snapshot{id = s0.id, type_key = s0.type_key, fields = s0.fields, blocks = s0.blocks, deleted = s0.deleted, created_at = s0.created_at, updated_at = s0.updated_at}
		seed_ptr = &seed
		max_ts = s0.updated_at
	}
	state := Object_State{id = c.object_id, fields = make([dynamic]Value_Entry), heads = make([dynamic]string)}
	w := Record_Writers{slots = make(map[string]Record_Writer), fields = make(map[string]Record_Writer), blocks = make(map[string]Record_Writer)}
	hook := Replay_Hook{data = &w, on_change = record_writers_on_change}
	if !replay_apply(&state, seed_ptr, []^Change{c}, max_ts, context.temp_allocator, &hook) do return p, false

	wrote :: proc(m: map[string]Record_Writer, key: string) -> bool {
		by, ok := m[key]
		return ok && !by.seed
	}

	// Object slots.
	if wrote(w.slots, RECORD_TYPE_KEY) {
		append(&p.entries, Record_Entry{key = RECORD_TYPE_KEY, stamp = stamp, kind = .Value, value = Value{kind = .String, str = state.type_key}})
	}
	if wrote(w.slots, RECORD_DELETED_KEY) {
		append(&p.entries, Record_Entry{key = RECORD_DELETED_KEY, stamp = stamp, kind = .Value, value = Value{kind = .Bool, b = state.deleted}})
	}

	// Properties (participant entries are handled with their discussions).
	old_fields := make(map[string]Record_Entry)
	for e in base.fields do old_fields[e.key] = e
	new_fields := make(map[string]Value)
	for f in state.fields do new_fields[f.key] = f.value
	keys := make(map[string]bool)
	for k, by in w.fields do if !by.seed do keys[k] = true
	for k in new_fields do keys[k] = true
	for k, e in old_fields do if !e.gone do keys[k] = true
	for key in keys {
		if strings.has_prefix(key, RECORD_PARTICIPANT_PREFIX) do continue
		old, had := old_fields[key]
		old_live := had && !old.gone
		touched := wrote(w.fields, key)
		if value, live := new_fields[key]; live {
			if touched || !old_live || value_bytes(old.value) != value_bytes(value) {
				append(&p.entries, Record_Entry{key = key, stamp = stamp, kind = .Value, value = value})
			}
		} else if touched || old_live {
			append(&p.entries, Record_Entry{key = key, stamp = stamp, gone = true, kind = .Value})
		}
	}

	// Blocks and messages: the replayed tree, placed as conversion places it.
	old_blocks := make(map[string]Record_Entry)
	for list in ([][dynamic]Record_Entry{base.blocks, base.messages}) {
		for e in list {
			if prior, ok := old_blocks[e.key]; ok && !prior.gone do continue
			old_blocks[e.key] = e
		}
	}
	exists := make(map[string]^Block)
	for &b in state.blocks do if b.id not_in exists do exists[b.id] = &b
	parent := make(map[string]string)
	placed := make(map[string]bool)
	siblings := make(map[string][dynamic]string)
	order := make([dynamic]string) // first occurrences, preorder
	roots := make([dynamic]string)
	for b in state.blocks {
		if b.id not_in placed {
			placed[b.id] = true
			parent[b.id] = ""
			append(&roots, b.id)
		}
		for child in b.children_ids {
			if child not_in exists || child in placed do continue
			placed[child] = true
			parent[child] = b.id
			list := siblings[b.id] or_else make([dynamic]string)
			append(&list, child)
			siblings[b.id] = list
		}
	}
	siblings[""] = roots
	emitted := make(map[string]bool)
	for b in state.blocks do if b.id not_in emitted {emitted[b.id] = true; append(&order, b.id)}

	Plan :: struct {
		entry:    Record_Entry, // body without position until placed
		old:      Record_Entry,
		old_live: bool,
		write:    bool,
		touched:  bool, // the change wrote it, though its stored shape may be the same
		place:    bool,
		parts:    []string,
		split:    bool,
	}
	plans := make(map[string]Plan)
	for id in order {
		b := exists[id]
		content, parts, split := record_participants_split(b.content)
		kind: Entry_Kind = record_block_is_message(b.content) ? .Message : .Block
		e := Record_Entry{key = id, stamp = stamp, kind = kind}
		e.body = Entry_Body{parent = parent[id], content = content, fields = b.fields, align = b.align, background_color = b.background_color}
		old, had := old_blocks[id]
		pl := Plan{entry = e, old = old, old_live = had && !old.gone, parts = parts, split = split}
		pl.place = !pl.old_live || old.body.parent != parent[id]
		if !pl.place {
			shaped := e
			shaped.body.position = old.body.position
			pl.write = old.kind != kind || entry_shape(shaped) != entry_shape(Record_Entry{key = old.key, kind = old.kind, body = old.body})
			pl.touched = wrote(w.blocks, id)
		}
		plans[id] = pl
	}
	// Siblings: keep the longest increasing run of old positions, place the rest between.
	for _, list in siblings {
		if len(list) == 0 do continue
		keys := make([]string, len(list))
		eligible := make([]bool, len(list))
		for id, i in list {
			pl := plans[id]
			keys[i] = pl.old.body.position
			eligible[i] = !pl.place
		}
		keep := longest_increasing(keys, eligible)
		i := 0
		for i < len(list) {
			if keep[i] {
				pl := plans[list[i]]
				pl.entry.body.position = pl.old.body.position
				plans[list[i]] = pl
				i += 1
				continue
			}
			j := i
			for j < len(list) && !keep[j] do j += 1
			lo := i > 0 ? keys[i - 1] : ""
			hi := j < len(list) ? keys[j] : ""
			fresh := positions_between(j - i, lo, hi, j < len(list))
			for k in i ..< j {
				pl := plans[list[k]]
				pl.entry.body.position = fresh[k - i]
				pl.place = true
				plans[list[k]] = pl
			}
			i = j
		}
	}
	for id in order {
		pl := plans[id]
		if pl.place || pl.write {
			append(&p.entries, pl.entry)
			if pl.old_live && pl.old.kind != pl.entry.kind {
				append(&p.entries, Record_Entry{key = id, stamp = stamp, gone = true, kind = pl.old.kind})
			}
		}
		// Participants: desired list against the live entries for this discussion.
		if pl.entry.body.content.kind != .Custom || pl.entry.body.content.custom.content_type != RECORD_DISCUSSION_CONTENT do continue
		prefix := record_participant_prefix(id)
		held := make(map[string]i64)
		for e in base.fields {
			if !e.gone && strings.has_prefix(e.key, prefix) && e.value.kind == .Int do held[e.key[len(prefix):]] = e.value.i
		}
		want := make(map[string]bool)
		if pl.split {
			for part, index in pl.parts {
				want[part] = true
				if at, ok := held[part]; ok && at == i64(index) do continue
				key := strings.concatenate({prefix, part})
				append(&p.entries, Record_Entry{key = key, stamp = stamp, kind = .Value, value = Value{kind = .Int, i = i64(index)}})
			}
		}
		for part in held {
			if part in want do continue
			append(&p.entries, Record_Entry{key = strings.concatenate({prefix, part}), stamp = stamp, gone = true, kind = .Value})
		}
	}
	// Removed: what the change took out of the tree, and anything shown before that is gone now.
	gone_ids := make(map[string]bool)
	for id, by in w.blocks do if !by.seed && id not_in exists do gone_ids[id] = true
	for b in seed.blocks do if b.id not_in exists do gone_ids[b.id] = true
	for id in gone_ids {
		kind: Entry_Kind = .Block
		if old, ok := old_blocks[id]; ok do kind = old.kind
		else if by, ok := w.blocks[id]; ok && by.message do kind = .Message
		append(&p.entries, Record_Entry{key = id, stamp = stamp, gone = true, kind = kind})
	}
	// A block the change wrote with the shape it already had (chat_post's
	// idempotent root add, a no-op move) is left alone, so it cannot
	// overwrite another device's newer edit of it - unless nothing else
	// changed: then the write is the patch, as a DAG change still moves
	// updated_at.
	if len(p.entries) == 0 {
		for id in order {
			pl := plans[id]
			if pl.touched do append(&p.entries, pl.entry)
		}
	}
	return p, true
}

/** ABI "record" action "patch" (see record_dispatch). */
record_patch_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	change_value, has_change := json_field(payload, "change")
	if !has_change do return nil, "record patch requires change"
	change, change_ok := change_from_json(change_value)
	if !change_ok do return nil, "invalid record patch change"
	stamp_value, has_stamp := json_field(payload, "stamp")
	if !has_stamp do return nil, "record patch requires stamp"
	time, time_ok := json_int(stamp_value, "time")
	device, device_ok := json_int(stamp_value, "device")
	if !time_ok || time < 0 || !device_ok || device < 0 || device > i64(max(u32)) do return nil, "invalid record patch stamp"
	stamp := Stamp{time = u64(time), device = u32(device)}
	current: Record
	has := false
	if text := json_str(payload, "record"); text != "" {
		bytes, hex_ok := hex_bytes(text)
		if !hex_ok do return nil, "invalid record hex"
		decoded, ok := record_decode(bytes, context.temp_allocator)
		if !ok do return nil, "invalid record bytes"
		if decoded.object_id != change.object_id do return nil, "record and change describe different objects"
		current, has = decoded, true
	}
	p, ok := record_patch_for_change(has ? &current : nil, &change, stamp)
	if !ok do return nil, "record patch: the change does not replay"
	merged := current
	if !has do merged = Record{object_id = change.object_id}
	if len(p.entries) > 0 {
		applied, aok := record_apply_patch(merged, p, context.temp_allocator)
		if !aok do return nil, "record patch does not apply"
		merged = applied
	}
	out := jobj()
	out["patch"] = json.String(string(hex.encode(patch_encode(p, context.temp_allocator), context.temp_allocator)))
	out["record"] = json.String(string(hex.encode(record_encode(merged, context.temp_allocator), context.temp_allocator)))
	return json.Object(out), ""
}
