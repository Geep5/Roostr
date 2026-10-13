package core

// State sync (docs/state-sync.md): per-object bases (Checkpoint with epoch
// >= 1, kind 31078), live deltas (kind 1078 tagged ["b", base_hash]),
// classification of held changes against the current base, replay from a
// base, deterministic rebase of orphans and the compaction planner. Every
// host (WASM web app, iOS xcframework, native daemon) reaches this through
// sync_dispatch; the JSON contract is documented on state_sync_dispatch.

import "core:encoding/base64"
import "core:encoding/json"
import "core:slice"
import "core:strings"

// Compaction thresholds: a base is due once its live deltas reach any one.
COMPACT_MIN_DELTAS :: 20
COMPACT_MIN_BYTES :: 48 * 1024
COMPACT_MAX_AGE_MS :: 24 * 60 * 60 * 1000

/** A held change plus the base it names in its event's `b` tag (none = pre-migration). */
Delta :: struct {
	change: Change,
	b:      [32]byte,
	tagged: bool,
}

/**
 * How a held change takes part given the current base:
 *   Live                 - replayed on top of the base;
 *   Covered              - folded into the base chain (never replayed again);
 *   Premigration_Covered - an untagged change folded by the epoch-1 base
 *                          (the pre-migration sweep may delete it);
 *   Orphan               - neither, and provably never folded: rebase it;
 *   Stale                - neither, but a base this device never held may
 *                          have folded it: never replayed, never rebased.
 */
Delta_Class :: enum u8 {
	Live,
	Covered,
	Premigration_Covered,
	Orphan,
	Stale,
}

Classification :: struct {
	current: int, // index into the bases; -1 = no base (everything is Live)
	classes: []Delta_Class,
}

/** Encode `cp` and stamp its base_hash (sha256 of the encoding: field 8 is never written). */
base_finalize :: proc(cp: ^Checkpoint, allocator := context.allocator) -> []byte {
	bytes := encode_checkpoint(cp^, allocator)
	cp.base_hash = sha256(bytes)
	return bytes
}

/** Current-base order: higher epoch, then later created_at, then the lexicographically higher hash. */
base_newer :: proc(a, b: ^Checkpoint) -> bool {
	if a.epoch != b.epoch do return a.epoch > b.epoch
	if a.created_at != b.created_at do return a.created_at > b.created_at
	return string(a.base_hash[:]) > string(b.base_hash[:])
}

/** Index of the current base among `bases` (epoch >= 1 only), -1 when there is none. */
base_current :: proc(bases: []Checkpoint) -> int {
	best := -1
	for &b, i in bases {
		if b.epoch < 1 do continue
		if best < 0 || base_newer(&b, &bases[best]) do best = i
	}
	return best
}

/**
 * Classify every held change of one object against its current base.
 *
 * Live: not covered, and either tagged with the current base or, in Kahn
 * order, built only on live deltas and the base's heads (a pre-migration
 * client writing on the heads it sees, or a delta on a sibling base whose
 * heads the winner shares, needs no rebase).
 *
 * Covered: in covered_ids of the current base or of any held ancestor
 * reached through prev_base (covered_ids only lists what one compaction
 * folded since the previous base).
 *
 * Everything else is an Orphan when the device can prove no base folded it,
 * otherwise Stale. Proof needs every chain base newer than the one the
 * change was written on (`floor` = lowest epoch of the contiguous held
 * chain): written on chain epoch e → floor <= e + 1; on a held sibling base
 * of epoch e → floor <= e; pre-migration or on an unknown base → floor == 1.
 * `pending` (raw id bytes) are changes this device never published: no
 * compactor can have folded them, so they are always decidable.
 */
base_classify :: proc(bases: []Checkpoint, deltas: []Delta, pending: map[string]bool, allocator := context.allocator) -> Classification {
	out := Classification{current = base_current(bases), classes = make([]Delta_Class, len(deltas), allocator)}
	if out.current < 0 do return out
	cur := &bases[out.current]

	by_hash := make(map[[32]byte]int, allocator = context.temp_allocator)
	for b, i in bases do if b.epoch >= 1 do by_hash[b.base_hash] = i
	chain_epoch := make(map[[32]byte]i64, allocator = context.temp_allocator)
	covered := make(map[string]bool, allocator = context.temp_allocator)
	first := make(map[string]bool, allocator = context.temp_allocator)
	floor := cur.epoch
	for link := cur; link != nil; {
		chain_epoch[link.base_hash] = link.epoch
		floor = link.epoch
		for id in link.covered_ids {
			covered[string(id)] = true
			if link.epoch == 1 do first[string(id)] = true
		}
		next: ^Checkpoint
		if link.epoch > 1 && len(link.prev_base) == 32 {
			prev: [32]byte
			copy(prev[:], link.prev_base)
			chain_epoch[prev] = link.epoch - 1
			if i, ok := by_hash[prev]; ok && bases[i].epoch == link.epoch - 1 do next = &bases[i]
		}
		link = next
	}

	heads := make(map[string]bool, allocator = context.temp_allocator)
	for h in cur.head_ids do heads[string(h)] = true
	changes := make([]Change, len(deltas), context.temp_allocator)
	index := make(map[string]int, allocator = context.temp_allocator)
	for d, i in deltas {
		changes[i] = d.change
		index[string(d.change.id)] = i
	}
	live := make(map[string]bool, allocator = context.temp_allocator)
	for c in topo_sort(changes, context.temp_allocator) {
		id := string(c.id)
		if id in covered do continue
		d := &deltas[index[id]]
		if d.tagged && d.b == cur.base_hash {
			live[id] = true
			continue
		}
		if len(c.parent_ids) == 0 do continue
		built_on_base := true
		for p in c.parent_ids do if string(p) not_in live && string(p) not_in heads {
			built_on_base = false
			break
		}
		if built_on_base do live[id] = true
	}

	for &d, i in deltas {
		id := string(d.change.id)
		switch {
		case id in live:
			out.classes[i] = .Live
		case id in covered:
			out.classes[i] = !d.tagged && id in first ? .Premigration_Covered : .Covered
		case:
			decidable := floor <= 1 || id in pending
			if !decidable && d.tagged {
				if e, known := chain_epoch[d.b]; known {
					decidable = floor <= e + 1
				} else if j, held := by_hash[d.b]; held {
					decidable = floor <= bases[j].epoch
				}
			}
			out.classes[i] = decidable ? .Orphan : .Stale
		}
	}

	// An orphan whose edit is already live or folded here - another device's
	// rebased copy of it, or the original of a copy - is applied: Covered.
	// Rebasing it again made a new copy each time; a busy object compacting
	// between those copies orphaned every one in turn, without end.
	orphans := 0
	for c in out.classes do if c == .Orphan do orphans += 1
	if orphans == 0 do return out
	applied := make(map[[32]byte]bool, allocator = context.temp_allocator)
	for &d, i in deltas do if out.classes[i] == .Live || out.classes[i] == .Covered || out.classes[i] == .Premigration_Covered {
		applied[edit_key(d.change)] = true
	}
	for &d, i in deltas do if out.classes[i] == .Orphan && edit_key(d.change) in applied {
		out.classes[i] = .Covered
	}
	return out
}

/**
 * One edit across every rebased copy of it: object, author, timestamp and
 * ops. A rebase keeps those and replaces only the parents (hence the id) and
 * drops a legacy in-DAG snapshot, so copies share this key and nothing else does.
 */
edit_key :: proc(c: Change) -> [32]byte {
	bare := Change{object_id = c.object_id, ops = c.ops, timestamp = c.timestamp, author = c.author}
	return sha256(encode_change(bare, true, context.temp_allocator))
}

/** The changes of `deltas` classified `class`, input order kept. */
deltas_of :: proc(deltas: []Delta, cls: Classification, class: Delta_Class, allocator := context.allocator) -> []Change {
	out := make([dynamic]Change, 0, len(deltas), allocator)
	for d, i in deltas do if cls.classes[i] == class do append(&out, d.change)
	return out[:]
}

/**
 * state = base.state + Kahn replay of `live`, seeded with the base's heads
 * as already applied: a live delta whose parents are all outside `live` is a
 * root; roots and freed batches sort by hex id exactly like topo_sort.
 * Heads: live heads plus base heads no live delta built on.
 */
state_from_base :: proc(base: ^Checkpoint, live: []Change, allocator := context.allocator) -> (Object_State, bool) {
	state: Object_State
	state.id = base.object_id
	state.fields = make([dynamic]Value_Entry, allocator)
	state.heads = checkpoint_heads(live, base, allocator)
	sorted := topo_sort(live, context.temp_allocator)
	if len(sorted) != len(live) do return state, false
	ok := replay_apply(&state, &base.state, sorted[:], base.state.updated_at, allocator)
	return state, ok
}

/**
 * An object's state from what a device holds: from the current base and its
 * live deltas, or - with no base - every held change replayed exactly as
 * `replay` does (optionally over a legacy kind-1079 checkpoint). Covered,
 * orphan and stale changes are never replayed. has = false: nothing to show.
 */
base_replay :: proc(bases: []Checkpoint, deltas: []Delta, pending: map[string]bool, legacy: ^Checkpoint, allocator := context.allocator) -> (state: Object_State, has: bool, ok: bool) {
	cls := base_classify(bases, deltas, pending, context.temp_allocator)
	if cls.current >= 0 {
		state, ok = state_from_base(&bases[cls.current], deltas_of(deltas, cls, .Live, context.temp_allocator), allocator)
		return state, true, ok
	}
	changes := make([]Change, len(deltas), context.temp_allocator)
	for d, i in deltas do changes[i] = d.change
	if len(changes) == 0 && legacy == nil do return {}, false, true
	state, ok = compute_state(changes, allocator, legacy)
	return state, true, ok
}

/** Heads of the live set: live ids no live change names as a parent; raw bytes. */
live_heads :: proc(live: []Change, allocator := context.allocator) -> [dynamic][]byte {
	referenced := make(map[string]bool, allocator = context.temp_allocator)
	for c in live do for p in c.parent_ids do referenced[string(p)] = true
	out := make([dynamic][]byte, allocator)
	for c in live do if string(c.id) not_in referenced do append(&out, c.id)
	return out
}

Rebased :: struct {
	orphan: []byte,
	change: Change,
}

/**
 * Rebase the orphans among `deltas` (or only those in `only`, raw ids, when
 * non-empty) onto `base`. Each new change keeps object_id, ops, author and
 * timestamp; its parent_ids are the base heads ∪ the current live heads ∪ the
 * rebased ids of any orphan parents being rebased with it (so a chain of
 * orphans stays a chain), sorted and deduplicated. Orphans go in Kahn order;
 * the id is the content address. Same inputs → byte-identical changes on
 * every device. The host publishes each with ["b", base hash].
 */
base_rebase :: proc(base: ^Checkpoint, deltas: []Delta, cls: Classification, only: map[string]bool, allocator := context.allocator) -> [dynamic]Rebased {
	live := deltas_of(deltas, cls, .Live, context.temp_allocator)
	common := make(map[string]bool, allocator = context.temp_allocator)
	for h in base.head_ids do common[string(h)] = true
	for h in live_heads(live, context.temp_allocator) do common[string(h)] = true

	orphans := make([dynamic]Change, context.temp_allocator)
	for d, i in deltas {
		if cls.classes[i] != .Orphan do continue
		if len(only) > 0 && string(d.change.id) not_in only do continue
		append(&orphans, d.change)
	}
	renamed := make(map[string][]byte, allocator = context.temp_allocator)
	// Copies of one edit (each device's) rebase once; the rest map onto it.
	by_edit := make(map[[32]byte][]byte, allocator = context.temp_allocator)
	out := make([dynamic]Rebased, allocator)
	for o in topo_sort(orphans[:], context.temp_allocator) {
		key := edit_key(o^)
		if kept, dup := by_edit[key]; dup {
			renamed[string(o.id)] = kept
			continue
		}
		parents := make(map[string]bool, allocator = context.temp_allocator)
		for k in common do parents[k] = true
		for p in o.parent_ids do if id, ok := renamed[string(p)]; ok do parents[string(id)] = true
		keys := make([dynamic]string, 0, len(parents), context.temp_allocator)
		for k in parents do append(&keys, k)
		slice.sort(keys[:])
		c := Change{
			object_id = strings.clone(o.object_id, allocator),
			parent_ids = make([dynamic][]byte, 0, len(keys), allocator),
			ops = slice.clone_to_dynamic(o.ops[:], allocator),
			timestamp = o.timestamp,
			author = strings.clone(o.author, allocator),
		}
		for k in keys do append(&c.parent_ids, slice.clone(transmute([]byte)k, allocator))
		digest := sha256(encode_change(c, true, context.temp_allocator))
		c.id = slice.clone(digest[:], allocator)
		renamed[string(o.id)] = c.id
		by_edit[key] = c.id
		append(&out, Rebased{orphan = o.id, change = c})
	}
	return out
}

Compact_Plan :: struct {
	compact:    bool,
	reason:     string, // "deltas" | "bytes" | "age" | "forced" | ""
	live:       int,
	live_bytes: int,
	oldest_ms:  i64, // timestamp of the oldest live delta, 0 when none
	orphans:    int,
	stale:      int,
	base:       Checkpoint, // set when compact
	bytes:      []byte,     // encoded base, set when compact
}

/**
 * Decide whether an object's live deltas are due for a new base and, if so,
 * build it: epoch + 1, prev_base = current base hash, covered_ids = the live
 * deltas folded (Kahn order), head_ids = the replayed heads, state = current
 * base + live deltas. With no base this is the epoch-1 migration: every held
 * change is folded - over a legacy checkpoint when one seeds the replay, whose
 * covered ids are then folded too. Orphans are never folded: the host rebases
 * them first (the plan reports how many remain).
 */
base_compact_plan :: proc(bases: []Checkpoint, deltas: []Delta, pending: map[string]bool, legacy: ^Checkpoint, now_ms: i64, force: bool, allocator := context.allocator) -> (plan: Compact_Plan, ok: bool) {
	cls := base_classify(bases, deltas, pending, context.temp_allocator)
	for class in cls.classes {
		#partial switch class {
		case .Orphan: plan.orphans += 1
		case .Stale: plan.stale += 1
		}
	}
	live := deltas_of(deltas, cls, .Live, context.temp_allocator)
	plan.live = len(live)
	for c in live {
		plan.live_bytes += len(encode_change(c, false, context.temp_allocator))
		if plan.oldest_ms == 0 || c.timestamp < plan.oldest_ms do plan.oldest_ms = c.timestamp
	}
	switch {
	case plan.live == 0:
	case plan.live >= COMPACT_MIN_DELTAS: plan.reason = "deltas"
	case plan.live_bytes >= COMPACT_MIN_BYTES: plan.reason = "bytes"
	case now_ms - plan.oldest_ms > COMPACT_MAX_AGE_MS: plan.reason = "age"
	case force: plan.reason = "forced"
	}
	if plan.reason == "" do return plan, true
	plan.compact = true

	state: Object_State
	covered := make([dynamic][]byte, context.temp_allocator)
	next: Checkpoint
	if cls.current >= 0 {
		cur := &bases[cls.current]
		state, ok = state_from_base(cur, live, context.temp_allocator)
		if !ok do return plan, false
		for c in topo_sort(live, context.temp_allocator) do append(&covered, c.id)
		next.epoch = cur.epoch + 1
		next.prev_base = slice.clone(cur.base_hash[:], allocator)
	} else {
		seed := checkpoint_for_replay(live, legacy)
		state, ok = compute_state(live, context.temp_allocator, legacy)
		if !ok do return plan, false
		// Fold exactly what compute_state applied: the legacy prefix, then the
		// tail unless the missing originals forbade continuing it.
		tail := live
		if seed != nil {
			append(&covered, ..seed.covered_ids[:])
			tail = checkpoint_tail(live, seed, context.temp_allocator)
			if !checkpoint_covers_all(live, seed) && !checkpoint_tail_continues(tail, seed) do tail = nil
		}
		for c in topo_sort(tail, context.temp_allocator, seed) do append(&covered, c.id)
		next.epoch = 1
	}
	built := checkpoint_build(&state, nil, now_ms, allocator)
	next.object_id = built.object_id
	next.head_ids = built.head_ids
	next.state = built.state
	next.created_at = now_ms
	next.covered_ids = make([dynamic][]byte, 0, len(covered), allocator)
	for id in covered do append(&next.covered_ids, slice.clone(id, allocator))
	plan.bytes = base_finalize(&next, allocator)
	plan.base = next
	return plan, true
}

// ── JSON boundary ────────────────────────────────────────────────────

/** Summary of a base for ingest items and base_decode. */
base_summary_json :: proc(cp: ^Checkpoint) -> json.Value {
	out := jobj()
	out["objectId"] = json.String(cp.object_id)
	out["hash"] = json.String(hex_id(cp.base_hash[:], context.temp_allocator))
	out["epoch"] = json.Integer(cp.epoch)
	out["prevBase"] = json.String(hex_id(cp.prev_base, context.temp_allocator))
	out["createdAt"] = json.Integer(cp.created_at)
	out["headIds"] = hex_list(cp.head_ids[:])
	out["covered"] = json.Integer(i64(len(cp.covered_ids)))
	return json.Object(out)
}

@(private = "file")
hex_list :: proc(ids: [][]byte) -> json.Value {
	out := make([dynamic]json.Value, 0, len(ids), context.temp_allocator)
	for id in ids do append(&out, json.String(hex_id(id, context.temp_allocator)))
	return json.Array(out)
}

@(private = "file")
State_Input :: struct {
	bases:   [dynamic]Checkpoint,
	deltas:  [dynamic]Delta,
	pending: map[string]bool,
	legacy:  ^Checkpoint,
}

// {bases?: [base64], changes?: [ChangeJSON & {b?: hex}], pending?: [hex], checkpoint?: base64}
@(private = "file")
state_input :: proc(payload: json.Value) -> (input: State_Input, err: string) {
	input.bases = make([dynamic]Checkpoint, context.temp_allocator)
	input.deltas = make([dynamic]Delta, context.temp_allocator)
	input.pending = make(map[string]bool, allocator = context.temp_allocator)
	object_id := ""
	same_object :: proc(object_id: ^string, id: string) -> bool {
		if object_id^ == "" do object_id^ = id
		return object_id^ == id
	}
	for item in json_array(payload, "bases") {
		text, is_text := item.(json.String)
		if !is_text do return input, "bases must be base64 strings"
		bytes, ok := bytes_from_base64(string(text), context.temp_allocator)
		if !ok do return input, "invalid base64 base"
		base, dok := decode_checkpoint(bytes, context.temp_allocator)
		if !dok do return input, "invalid protobuf base"
		if base.epoch < 1 do return input, "a base has epoch >= 1 (pass a legacy checkpoint as checkpoint)"
		if !same_object(&object_id, base.object_id) do return input, "bases and changes must belong to one object"
		append(&input.bases, base)
	}
	ids := make(map[string]bool, allocator = context.temp_allocator)
	for item in json_array(payload, "changes") {
		change, ok := change_from_json(item, context.temp_allocator)
		if !ok do return input, "invalid change JSON"
		if len(change.id) != 32 do return input, "change requires a 32-byte id"
		if change.object_id == "" || !same_object(&object_id, change.object_id) do return input, "bases and changes must belong to one object"
		if string(change.id) in ids do return input, "duplicate change id"
		ids[string(change.id)] = true
		d := Delta{change = change}
		if b := json_str(item, "b"); b != "" {
			raw, hok := hex_bytes(b)
			if !hok || len(raw) != 32 do return input, "change b must be a 32-byte hex base hash"
			copy(d.b[:], raw)
			d.tagged = true
		}
		append(&input.deltas, d)
	}
	for item in json_array(payload, "pending") {
		text, _ := item.(json.String)
		raw, ok := hex_bytes(string(text))
		if !ok || len(raw) != 32 do return input, "pending entries are 32-byte hex change ids"
		input.pending[string(raw)] = true
	}
	legacy, lerr := optional_checkpoint(payload)
	if lerr != "" do return input, lerr
	if legacy != nil && object_id != "" && legacy.object_id != object_id do return input, "checkpoint describes another object"
	input.legacy = legacy
	return input, ""
}

/**
 * State-sync actions of sync_dispatch. Bases travel as base64 Checkpoint
 * protobuf (epoch >= 1); changes as ChangeJSON plus `b` (hex hash of the base
 * named by the event's ["b", …] tag, absent = pre-migration); `pending` lists
 * change ids this device has never published. No session is required.
 *
 *   base_decode      {base} → {objectId, hash, epoch, prevBase, createdAt, headIds, covered, coveredIds, state: ObjectJSON}
 *   base_current     {bases} → {index, hash, epoch} | null
 *   classify         {bases, changes, pending?} → {base: {hash, epoch} | null, live, covered,
 *                    premigrationCovered, orphan, stale, liveHeads} (hex id lists)
 *   replay_from_base {bases, changes, pending?, checkpoint?} → ObjectJSON | null
 *                    (`checkpoint`: legacy 1079, only used when there is no base)
 *   rebase           {bases, changes, pending?, orphans?: [hex]} → {base: hex, changes:
 *                    [{orphan, id, change: ChangeJSON, bytes: base64}]} in publish order
 *   compact_plan     {bases, changes, nowMs, pending?, checkpoint?, force?} → {compact, reason,
 *                    live, liveBytes, oldestMs, orphans, stale, base?: base64, hash?, epoch?,
 *                    prevBase?, folded?: [hex]}
 *   seal_base        {base, conversationKey, secret? | space?: {keyHex, spaceId, owner?}, nonce?}
 *                    → {hash, objectId, epoch, d, gid, event: {kind: 31078, content, tags},
 *                    parts: [{kind: 1080, content, tags}]}
 */
state_sync_dispatch :: proc(payload: json.Value) -> (json.Value, string) {
	action := json_str(payload, "action")
	switch action {
	case "seal_base":
		return wire_seal_base(payload)
	case "base_decode":
		bytes, ok := bytes_from_base64(json_str(payload, "base"), context.temp_allocator)
		if !ok do return nil, "invalid base64 base"
		base, dok := decode_checkpoint(bytes, context.temp_allocator)
		if !dok do return nil, "invalid protobuf base"
		out := base_summary_json(&base).(json.Object)
		out["coveredIds"] = hex_list(base.covered_ids[:])
		snap := &base.state
		state := Object_State{
			id = snap.id, type_key = snap.type_key, fields = snap.fields, blocks = snap.blocks,
			deleted = snap.deleted, created_at = snap.created_at, updated_at = snap.updated_at,
			heads = make([dynamic]string, context.temp_allocator),
		}
		for h in base.head_ids do append(&state.heads, hex_id(h, context.temp_allocator))
		out["state"] = object_to_json_value(&state)
		return json.Object(out), ""
	}

	input, err := state_input(payload)
	if err != "" do return nil, err
	bases, deltas := input.bases[:], input.deltas[:]
	switch action {
	case "base_current":
		i := base_current(bases)
		if i < 0 do return json.Null{}, ""
		out := jobj()
		out["index"] = json.Integer(i64(i))
		out["hash"] = json.String(hex_id(bases[i].base_hash[:], context.temp_allocator))
		out["epoch"] = json.Integer(bases[i].epoch)
		return json.Object(out), ""
	case "classify":
		cls := base_classify(bases, deltas, input.pending, context.temp_allocator)
		lists: [Delta_Class][dynamic]json.Value
		for &list in lists do list = make([dynamic]json.Value, context.temp_allocator)
		for d, i in deltas do append(&lists[cls.classes[i]], json.String(hex_id(d.change.id, context.temp_allocator)))
		out := jobj()
		out["base"] = json.Null{}
		if cls.current >= 0 {
			cur := jobj()
			cur["hash"] = json.String(hex_id(bases[cls.current].base_hash[:], context.temp_allocator))
			cur["epoch"] = json.Integer(bases[cls.current].epoch)
			out["base"] = json.Object(cur)
		}
		out["live"] = json.Array(lists[.Live])
		out["covered"] = json.Array(lists[.Covered])
		out["premigrationCovered"] = json.Array(lists[.Premigration_Covered])
		out["orphan"] = json.Array(lists[.Orphan])
		out["stale"] = json.Array(lists[.Stale])
		heads := live_heads(deltas_of(deltas, cls, .Live, context.temp_allocator), context.temp_allocator)
		slice.sort_by(heads[:], proc(a, b: []byte) -> bool { return string(a) < string(b) })
		out["liveHeads"] = hex_list(heads[:])
		return json.Object(out), ""
	case "replay_from_base":
		state, has, ok := base_replay(bases, deltas, input.pending, input.legacy, context.temp_allocator)
		if !has do return nil, ""
		if !ok do return nil, "replay changes and block references must be acyclic"
		// The heads the state was replayed to, sorted: a host's query upsert
		// carries them, and the cache applies a later local commit only on
		// exactly these (query_cache_apply).
		out := object_to_json_value(&state)
		heads := make([dynamic]json.Value, 0, len(state.heads), context.temp_allocator)
		slice.sort(state.heads[:])
		for head in state.heads do append(&heads, json.String(head))
		object := out.(json.Object)
		object["heads"] = json.Array(heads)
		return object, ""
	case "rebase":
		cls := base_classify(bases, deltas, input.pending, context.temp_allocator)
		if cls.current < 0 do return nil, "rebase needs a base"
		only := make(map[string]bool, allocator = context.temp_allocator)
		for item in json_array(payload, "orphans") {
			text, _ := item.(json.String)
			raw, ok := hex_bytes(string(text))
			if !ok || len(raw) != 32 do return nil, "orphans entries are 32-byte hex change ids"
			only[string(raw)] = true
		}
		base := &bases[cls.current]
		items := make([dynamic]json.Value, context.temp_allocator)
		for r in base_rebase(base, deltas, cls, only, context.temp_allocator) {
			item := jobj()
			item["orphan"] = json.String(hex_id(r.orphan, context.temp_allocator))
			item["id"] = json.String(hex_id(r.change.id, context.temp_allocator))
			item["change"] = change_to_json(r.change, ordered = true)
			item["bytes"] = json.String(base64.encode(encode_change(r.change, false, context.temp_allocator), allocator = context.temp_allocator))
			append(&items, json.Object(item))
		}
		out := jobj()
		out["base"] = json.String(hex_id(base.base_hash[:], context.temp_allocator))
		out["changes"] = json.Array(items)
		return json.Object(out), ""
	case "compact_plan":
		now, has_now := json_int(payload, "nowMs")
		if !has_now do return nil, "compact_plan needs nowMs"
		force, _ := json_bool(payload, "force")
		plan, ok := base_compact_plan(bases, deltas, input.pending, input.legacy, now, force, context.temp_allocator)
		if !ok do return nil, "replay changes and block references must be acyclic"
		out := jobj()
		out["compact"] = json.Boolean(plan.compact)
		out["reason"] = json.String(plan.reason)
		out["live"] = json.Integer(i64(plan.live))
		out["liveBytes"] = json.Integer(i64(plan.live_bytes))
		out["oldestMs"] = json.Integer(plan.oldest_ms)
		out["orphans"] = json.Integer(i64(plan.orphans))
		out["stale"] = json.Integer(i64(plan.stale))
		if plan.compact {
			out["base"] = json.String(base64.encode(plan.bytes, allocator = context.temp_allocator))
			out["hash"] = json.String(hex_id(plan.base.base_hash[:], context.temp_allocator))
			out["epoch"] = json.Integer(plan.base.epoch)
			out["prevBase"] = json.String(hex_id(plan.base.prev_base, context.temp_allocator))
			out["folded"] = hex_list(plan.base.covered_ids[:])
		}
		return json.Object(out), ""
	}
	return nil, "unknown sync action"
}
