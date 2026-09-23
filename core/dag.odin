package core

// DAG replay: Kahn toposort (lexicographic hex tie-break, matching the
// TS engine byte-for-byte in ordering semantics), Anytype-style block
// tree ops with deterministic layout ids, normalize pass, and state
// computation. Port of glon/src/dag/{dag,blocks}.ts.

import "core:slice"
import "core:strings"
import "core:encoding/hex"
import "core:fmt"

Object_State :: struct {
	id:         string,
	type_key:   string,
	fields:     [dynamic]Value_Entry, // insertion-ordered; set replaces in place
	blocks:     [dynamic]Block,       // DFS preorder from roots
	deleted:    bool,
	created_at: i64,
	updated_at: i64,
	heads:      [dynamic]string, // hex ids
}

fields_set :: proc(fields: ^[dynamic]Value_Entry, key: string, value: Value) {
	for &e in fields {
		if e.key == key {
			e.value = value
			return
		}
	}
	append(fields, Value_Entry{key = key, value = value})
}

fields_delete :: proc(fields: ^[dynamic]Value_Entry, key: string) {
	for e, i in fields {
		if e.key == key {
			ordered_remove(fields, i)
			return
		}
	}
}

fields_get :: proc(fields: [dynamic]Value_Entry, key: string) -> (Value, bool) {
	for e in fields {
		if e.key == key do return e.value, true
	}
	return Value{}, false
}

// ── Topological sort ─────────────────────────────────────────────────

hex_id :: proc(id: []byte, allocator := context.allocator) -> string {
	return string(hex.encode(id, allocator))
}

// Kahn with lexicographic hex tie-break. With `after`, `changes` is the tail
// beyond a checkpoint and the sort continues the full-history Kahn run:
// a tail change all of whose parents are covered was queued when its LAST
// covered parent was processed (its index in `covered_ids`, which is stored
// in replay order), so buckets by that step, each bucket sorted, reproduce
// the queue the full run had when the covered prefix was exhausted.
topo_sort :: proc(changes: []Change, allocator := context.allocator, after: ^Checkpoint = nil) -> [dynamic]^Change {
	by_hex := make(map[string]^Change, allocator = allocator)
	in_degree := make(map[string]int, allocator = allocator)
	children := make(map[string][dynamic]string, allocator = allocator)
	defer delete(by_hex)
	defer delete(in_degree)
	defer {
		for _, v in children do delete(v)
		delete(children)
	}

	hexes := make([]string, len(changes), allocator)
	for &c, i in changes {
		hexes[i] = hex_id(c.id, allocator)
		by_hex[hexes[i]] = &c
		in_degree[hexes[i]] = 0
	}
	for &c, i in changes {
		deg := 0
		for p in c.parent_ids {
			phex := hex_id(p, allocator)
			if phex in by_hex {
				deg += 1
				list, ok := &children[phex]
				if !ok {
					children[phex] = make([dynamic]string, allocator)
					list = &children[phex]
				}
				append(list, hexes[i])
			}
		}
		in_degree[hexes[i]] = deg
	}

	queue := make([dynamic]string, allocator)
	defer delete(queue)
	if after == nil {
		for h, deg in in_degree {
			if deg == 0 do append(&queue, h)
		}
		slice.sort(queue[:])
	} else {
		covered_index := make(map[string]int, allocator = context.temp_allocator)
		defer delete(covered_index)
		for id, i in after.covered_ids do covered_index[string(id)] = i
		// release step per free tail change: -1 = genuine root, else the
		// index of its last covered parent.
		buckets := make(map[int][dynamic]string, allocator = context.temp_allocator)
		defer {
			for _, v in buckets do delete(v)
			delete(buckets)
		}
		for &c, i in changes {
			if in_degree[hexes[i]] != 0 do continue
			release := -1
			for p in c.parent_ids do if idx, ok := covered_index[string(p)]; ok && idx > release do release = idx
			list, ok := &buckets[release]
			if !ok {
				buckets[release] = make([dynamic]string, context.temp_allocator)
				list = &buckets[release]
			}
			append(list, hexes[i])
		}
		steps := make([dynamic]int, context.temp_allocator)
		defer delete(steps)
		for step in buckets do append(&steps, step)
		slice.sort(steps[:])
		for step in steps {
			bucket := buckets[step]
			slice.sort(bucket[:])
			append(&queue, ..bucket[:])
		}
	}

	result := make([dynamic]^Change, allocator)
	for len(queue) > 0 {
		h := queue[0]
		ordered_remove(&queue, 0)
		append(&result, by_hex[h])
		deps, ok := children[h]
		if !ok do continue
		freed := make([dynamic]string, context.temp_allocator)
		for child in deps {
			d := in_degree[child] - 1
			in_degree[child] = d
			if d == 0 do append(&freed, child)
		}
		slice.sort(freed[:])
		for f in freed do append(&queue, f)
	}
	return result
}

find_heads :: proc(changes: []Change, allocator := context.allocator) -> [dynamic]string {
	referenced := make(map[string]bool, allocator = context.temp_allocator)
	for c in changes {
		for p in c.parent_ids do referenced[hex_id(p, context.temp_allocator)] = true
	}
	heads := make([dynamic]string, allocator)
	for c in changes {
		h := hex_id(c.id, allocator)
		if !referenced[h] do append(&heads, h)
	}
	slice.sort(heads[:])
	return heads
}

// ── Checkpoints ──────────────────────────────────────────────────────
//
// A checkpoint is a replay cache, never the history: it names every change
// it folded in (covered_ids, in replay order) so a peer can tell "already
// applied" from "concurrent, replay me" and continue the Kahn run where the
// publisher's stopped (topo_sort `after`). The original changes stay
// canonical; every replica keeps them and reconciles them in full.
//
// Kahn order is not stable under extension: a concurrent change arriving
// later with a smaller id sorts BEFORE already-covered changes in a full
// replay. A full-history peer detects that (checkpoint_is_prefix) and replays
// from genesis. A peer still missing covered originals may only continue
// from the checkpoint when the tail provably queues after the whole covered
// prefix (checkpoint_tail_continues); otherwise it shows the checkpoint
// state alone until the originals arrive.

/** Changes not folded into the checkpoint; input order preserved. */
checkpoint_tail :: proc(changes: []Change, cp: ^Checkpoint, allocator := context.allocator) -> []Change {
	covered := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(covered)
	for id in cp.covered_ids do covered[string(id)] = true
	tail := make([dynamic]Change, 0, len(changes), allocator)
	for c in changes do if string(c.id) not_in covered do append(&tail, c)
	return tail[:]
}

/** True when the checkpoint's covered ids are exactly the first entries of the full replay order. */
checkpoint_is_prefix :: proc(changes: []Change, cp: ^Checkpoint) -> bool {
	if len(cp.covered_ids) > len(changes) do return false
	sorted := topo_sort(changes, context.temp_allocator)
	defer delete(sorted)
	if len(sorted) != len(changes) do return false
	for id, i in cp.covered_ids do if string(sorted[i].id) != string(id) do return false
	return true
}

/**
 * Pick how a stored checkpoint takes part in an object's replay:
 *   - every covered change present and the checkpoint is a prefix of the
 *     full Kahn order → seed from it (same answer, shorter replay);
 *   - every covered change present but the order diverged (a concurrent
 *     change with a smaller id arrived after the checkpoint) → nil: replay
 *     from genesis;
 *   - covered changes missing, but the held changes form a closed history
 *     the checkpoint neither prefixes nor continues → nil: that is another
 *     branch (or a forgery); what this replica holds is real history;
 *   - covered changes missing otherwise → the checkpoint stands in for them
 *     until they arrive; compute_state decides whether the tail may extend it.
 * Every host replays through compute_state, so the rule has one definition.
 */
checkpoint_for_replay :: proc(changes: []Change, cp: ^Checkpoint) -> ^Checkpoint {
	if cp == nil do return nil
	if checkpoint_covers_all(changes, cp) do return checkpoint_is_prefix(changes, cp) ? cp : nil
	if dag_closed(changes) && !checkpoint_tail_continues(checkpoint_tail(changes, cp, context.temp_allocator), cp) do return nil
	return cp
}

/** True when every covered id is among `changes`. */
checkpoint_covers_all :: proc(changes: []Change, cp: ^Checkpoint) -> bool {
	present := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(present)
	for c in changes do present[string(c.id)] = true
	for id in cp.covered_ids do if string(id) not_in present do return false
	return true
}

/**
 * True when replaying `tail` after the checkpoint provably reproduces the
 * order a full replay would use, without the covered originals at hand.
 *
 * topo_sort is Kahn with a FIFO queue whose newly freed batch is sorted: a
 * change enters the queue when its LAST parent is processed, behind
 * everything already queued and sorted among the batch freed at that step.
 * Inserting a tail root therefore never reorders covered changes among
 * themselves; the one hazard is a covered change freed at the same step with
 * the larger id, which the full run would place after the root while the
 * checkpoint folded it in. Without the covered originals' parents that step's
 * batch is unknowable, so the root's last covered parent must be a checkpoint
 * head: nothing covered was freed by processing it. A parent that is neither
 * covered nor in the tail is unknown history: not continuable.
 */
checkpoint_tail_continues :: proc(tail: []Change, cp: ^Checkpoint) -> bool {
	covered_index := make(map[string]int, allocator = context.temp_allocator)
	defer delete(covered_index)
	for id, i in cp.covered_ids do covered_index[string(id)] = i
	in_tail := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(in_tail)
	for c in tail do in_tail[string(c.id)] = true
	for c in tail {
		release := -1
		root := true
		for p in c.parent_ids {
			if in_tail[string(p)] {
				root = false
				continue
			}
			idx, covered := covered_index[string(p)]
			if !covered do return false
			if idx > release do release = idx
		}
		if !root do continue
		if release < 0 do return len(cp.covered_ids) == 0
		last := cp.covered_ids[release]
		is_head := false
		for h in cp.head_ids do if string(h) == string(last) {
			is_head = true
			break
		}
		if !is_head do return false
	}
	return true
}

/** True when every parent of every change is itself among `changes`. */
dag_closed :: proc(changes: []Change) -> bool {
	present := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(present)
	for c in changes do present[string(c.id)] = true
	for c in changes {
		for p in c.parent_ids do if string(p) not_in present do return false
	}
	return true
}

/** Tail heads plus checkpoint heads no tail change has built on; sorted hex. */
checkpoint_heads :: proc(tail: []Change, cp: ^Checkpoint, allocator := context.allocator) -> [dynamic]string {
	referenced := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(referenced)
	for c in tail {
		for p in c.parent_ids do referenced[hex_id(p, context.temp_allocator)] = true
	}
	heads := make([dynamic]string, allocator)
	for c in tail {
		h := hex_id(c.id, allocator)
		if !referenced[h] do append(&heads, h)
	}
	for id in cp.head_ids {
		h := hex_id(id, allocator)
		if !referenced[h] && !slice.contains(heads[:], h) do append(&heads, h)
	}
	slice.sort(heads[:])
	return heads
}

/**
 * Fold a state replayed from genesis and the complete changes that produced
 * it into a checkpoint. `changes` must be exactly the closed set `state` was
 * computed from (dag_closed, no checkpoint seed); anything else makes
 * covered_ids lie and every consumer drift.
 */
checkpoint_build :: proc(state: ^Object_State, changes: []Change, now_ms: i64, allocator := context.allocator) -> Checkpoint {
	cp: Checkpoint
	cp.object_id = strings.clone(state.id, allocator)
	cp.created_at = now_ms
	cp.head_ids = make([dynamic][]byte, 0, len(state.heads), allocator)
	for h in state.heads {
		raw, ok := hex.decode(transmute([]byte)h, allocator)
		if ok do append(&cp.head_ids, raw)
	}
	sorted := topo_sort(changes, context.temp_allocator)
	defer delete(sorted)
	cp.covered_ids = make([dynamic][]byte, 0, len(sorted), allocator)
	for c in sorted do append(&cp.covered_ids, slice.clone(c.id, allocator))
	cp.state = Snapshot{
		id         = cp.object_id,
		type_key   = strings.clone(state.type_key, allocator),
		fields     = slice.clone_to_dynamic(state.fields[:], allocator),
		blocks     = slice.clone_to_dynamic(state.blocks[:], allocator),
		deleted    = state.deleted,
		created_at = state.created_at,
		updated_at = state.updated_at,
	}
	return cp
}

/** sha256 of the encoded bytes: dedup and tie-break key, never a trust anchor. */
checkpoint_hash :: proc(bytes: []byte, allocator := context.allocator) -> string {
	digest := sha256(bytes)
	return hex_id(digest[:], allocator)
}

/**
 * Store rule when two checkpoints describe one object: the candidate must
 * cover everything the existing one covers (a strict superset wins, an
 * incomparable branch never displaces what it does not contain); for the
 * same covered set the larger hash wins so every replica converges.
 */
checkpoint_supersedes :: proc(candidate: ^Checkpoint, candidate_hash: string, existing: ^Checkpoint, existing_hash: string) -> bool {
	if candidate.object_id != existing.object_id do return false
	covered := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(covered)
	for id in candidate.covered_ids do covered[string(id)] = true
	for id in existing.covered_ids do if string(id) not_in covered do return false
	if len(covered) > len(existing.covered_ids) do return true
	return candidate_hash > existing_hash
}

// ── Block tree ───────────────────────────────────────────────────────

Block_Tree :: struct {
	by_id:    map[string]^Block,
	parent:   map[string]string,
	root_ids: [dynamic]string,
	storage:  [dynamic]^Block, // owns allocations
}

clone_block :: proc(b: Block, allocator := context.allocator) -> ^Block {
	nb := new(Block, allocator)
	nb^ = b
	nb.children_ids = make([dynamic]string, allocator)
	append(&nb.children_ids, ..b.children_ids[:])
	nb.fields = make([dynamic]Value_Entry, allocator)
	append(&nb.fields, ..b.fields[:])
	return nb
}

tree_build :: proc(blocks: []Block, allocator := context.allocator) -> Block_Tree {
	t: Block_Tree
	t.by_id = make(map[string]^Block, allocator = allocator)
	t.parent = make(map[string]string, allocator = allocator)
	t.root_ids = make([dynamic]string, allocator)
	t.storage = make([dynamic]^Block, allocator)
	for b in blocks {
		if b.id in t.by_id do continue
		nb := clone_block(b, allocator)
		t.by_id[b.id] = nb
		append(&t.storage, nb)
	}
	for b in t.storage {
		for cid in b.children_ids {
			if cid in t.by_id do t.parent[cid] = b.id
		}
	}
	for b in blocks {
		if b.id not_in t.parent && !slice.contains(t.root_ids[:], b.id) {
			append(&t.root_ids, b.id)
		}
	}
	return t
}

tree_serialize :: proc(t: ^Block_Tree, allocator := context.allocator) -> [dynamic]Block {
	out := make([dynamic]Block, allocator)
	stack := make([dynamic]string, context.temp_allocator)
	defer delete(stack)
	// A block id reachable twice (duplicated child refs, diamonds, or a
	// self-reference from a corrupted tree) is emitted once: revisiting
	// would expand the output exponentially and wedge boot replay.
	emitted := make(map[string]bool, allocator = context.temp_allocator)
	defer delete(emitted)
	for i := len(t.root_ids) - 1; i >= 0; i -= 1 do append(&stack, t.root_ids[i])
	for len(stack) > 0 {
		id := pop(&stack)
		if id in emitted do continue
		emitted[id] = true
		b, ok := t.by_id[id]
		if !ok do continue
		append(&out, b^)
		for i := len(b.children_ids) - 1; i >= 0; i -= 1 do append(&stack, b.children_ids[i])
	}
	return out
}

is_layout :: proc(b: ^Block, style: i64 = -1) -> bool {
	if b == nil || b.content.kind != .Layout do return false
	return style < 0 || b.content.layout_style == style
}

LAYOUT_ROW :: 0
LAYOUT_COLUMN :: 1
LAYOUT_DIV :: 2
LAYOUT_TABLE_ROWS :: 4
LAYOUT_TABLE_COLUMNS :: 5

POS_NONE :: 0
POS_TOP :: 1
POS_BOTTOM :: 2
POS_LEFT :: 3
POS_RIGHT :: 4
POS_INNER :: 5
POS_REPLACE :: 6
POS_INNER_FIRST :: 7

tree_unlink :: proc(t: ^Block_Tree, block_id: string) {
	pid, has_parent := t.parent[block_id]
	if has_parent {
		if p, ok := t.by_id[pid]; ok {
			// Every occurrence: a duplicated child ref left behind would
			// keep the block linked through the parent it was moved from.
			for i := len(p.children_ids) - 1; i >= 0; i -= 1 {
				if p.children_ids[i] == block_id do ordered_remove(&p.children_ids, i)
			}
		}
		delete_key(&t.parent, block_id)
	} else {
		for i := len(t.root_ids) - 1; i >= 0; i -= 1 {
			if t.root_ids[i] == block_id do ordered_remove(&t.root_ids, i)
		}
	}
}

tree_link_child :: proc(t: ^Block_Tree, parent: ^Block, child_id: string, index: int) {
	idx := clamp(index, 0, len(parent.children_ids))
	inject_at(&parent.children_ids, idx, child_id)
	t.parent[child_id] = parent.id
}

in_subtree :: proc(t: ^Block_Tree, root_id: string, candidate: string) -> bool {
	cur := candidate
	for {
		if cur == root_id do return true
		next, ok := t.parent[cur]
		if !ok do return false
		cur = next
	}
}

index_of :: proc(list: [dynamic]string, v: string) -> int {
	for x, i in list do if x == v do return i
	return -1
}

make_layout_block :: proc(t: ^Block_Tree, id: string, style: i64, allocator := context.allocator) -> ^Block {
	b := new(Block, allocator)
	b.id = id
	b.children_ids = make([dynamic]string, allocator)
	b.content.kind = .Layout
	b.content.layout_style = style
	t.by_id[id] = b
	append(&t.storage, b)
	return b
}

replace_slot :: proc(t: ^Block_Tree, target_id: string, new_id: string) {
	pid, has_parent := t.parent[target_id]
	if has_parent {
		p := t.by_id[pid]
		for cid, i in p.children_ids {
			if cid == target_id {
				p.children_ids[i] = new_id
				break
			}
		}
		delete_key(&t.parent, target_id)
		t.parent[new_id] = pid
	} else {
		idx := index_of(t.root_ids, target_id)
		if idx >= 0 {
			t.root_ids[idx] = new_id
		} else {
			append(&t.root_ids, new_id)
		}
	}
}

remove_subtree :: proc(t: ^Block_Tree, block_id: string) {
	if block_id not_in t.by_id do return
	tree_unlink(t, block_id)
	stack := make([dynamic]string, context.temp_allocator)
	append(&stack, block_id)
	for len(stack) > 0 {
		id := stack[len(stack) - 1]
		pop(&stack)
		b, ok := t.by_id[id]
		if !ok do continue
		for cid in b.children_ids do append(&stack, cid)
		delete_key(&t.parent, id)
		delete_key(&t.by_id, id)
	}
}

move_from_side :: proc(t: ^Block_Tree, target: ^Block, block: ^Block, left: bool, op_key: string, allocator := context.allocator) {
	column: ^Block
	row: ^Block

	pid, has_parent := t.parent[target.id]
	parent_block: ^Block
	if has_parent do parent_block = t.by_id[pid]

	if is_layout(target, LAYOUT_COLUMN) && is_layout(parent_block, LAYOUT_ROW) {
		column = target
		row = parent_block
	} else if is_layout(parent_block, LAYOUT_COLUMN) {
		gpid, has_gp := t.parent[parent_block.id]
		if has_gp {
			gp := t.by_id[gpid]
			if is_layout(gp, LAYOUT_ROW) {
				column = parent_block
				row = gp
			}
		}
	}

	if row == nil || column == nil {
		row_id := unique_id(t, strings.concatenate({"r-", op_key}, allocator), allocator)
		col_id := unique_id(t, strings.concatenate({"ct-", op_key}, allocator), allocator)
		row_block := make_layout_block(t, row_id, LAYOUT_ROW, allocator)
		col_block := make_layout_block(t, col_id, LAYOUT_COLUMN, allocator)
		replace_slot(t, target.id, row_id)
		tree_link_child(t, row_block, col_id, 0)
		tree_link_child(t, col_block, target.id, 0)
		row = row_block
		column = col_block
	}

	new_col_id := unique_id(t, strings.concatenate({"cd-", op_key}, allocator), allocator)
	new_col := make_layout_block(t, new_col_id, LAYOUT_COLUMN, allocator)
	tree_link_child(t, new_col, block.id, 0)

	col_pos := index_of(row.children_ids, column.id)
	tree_link_child(t, row, new_col_id, left ? col_pos : col_pos + 1)
}

/** Deterministic id, suffixed on the (rare) replayed-twice collision. */
unique_id :: proc(t: ^Block_Tree, base: string, allocator := context.allocator) -> string {
	id := base
	for {
		if id not_in t.by_id do return id
		id = strings.concatenate({id, "x"}, allocator)
	}
}

insert_to :: proc(t: ^Block_Tree, block: ^Block, target_id: string, position: i64, op_key: string, allocator := context.allocator) {
	target: ^Block
	if target_id != "" {
		target = t.by_id[target_id] or_else nil
	}
	if target == nil {
		append(&t.root_ids, block.id) // degraded: content is never lost
		return
	}

	switch position {
	case POS_INNER:
		tree_link_child(t, target, block.id, len(target.children_ids))
	case POS_INNER_FIRST:
		tree_link_child(t, target, block.id, 0)
	case POS_TOP, POS_BOTTOM:
		before := position == POS_TOP
		pid, has_parent := t.parent[target.id]
		if !has_parent {
			idx := index_of(t.root_ids, target.id)
			inject_at(&t.root_ids, before ? idx : idx + 1, block.id)
		} else {
			p := t.by_id[pid]
			idx := index_of(p.children_ids, target.id)
			tree_link_child(t, p, block.id, before ? idx : idx + 1)
		}
	case POS_REPLACE:
		replace_slot(t, target.id, block.id)
		if len(block.children_ids) == 0 {
			append(&block.children_ids, ..target.children_ids[:])
			for cid in block.children_ids do t.parent[cid] = block.id
			clear(&target.children_ids)
			delete_key(&t.by_id, target.id)
		} else {
			remove_subtree(t, target.id)
		}
	case POS_LEFT, POS_RIGHT:
		move_from_side(t, target, block, position == POS_LEFT, op_key, allocator)
	case:
		insert_to(t, block, target_id, POS_BOTTOM, op_key, allocator)
	}
}

apply_block_add :: proc(t: ^Block_Tree, op: Operation, op_key: string, allocator := context.allocator) {
	if op.block.id == "" || op.block.id in t.by_id do return
	block := clone_block(op.block, allocator)
	t.by_id[block.id] = block
	append(&t.storage, block)

	if op.position == POS_NONE && op.target_id == "" {
		// Legacy semantics: append; parent_id nests, after_id ignored.
		if op.parent_id != "" {
			if parent, ok := t.by_id[op.parent_id]; ok {
				tree_link_child(t, parent, block.id, len(parent.children_ids))
				return
			}
		}
		append(&t.root_ids, block.id)
		return
	}
	insert_to(t, block, op.target_id, op.position, op_key, allocator)
}

apply_block_move :: proc(t: ^Block_Tree, op: Operation, op_key: string, allocator := context.allocator) {
	block, ok := t.by_id[op.block_id]
	if !ok do return

	if op.position == POS_NONE && op.target_id == "" {
		parent_id := op.parent_id
		if parent_id != "" && (parent_id == op.block_id || in_subtree(t, op.block_id, parent_id)) do return
		tree_unlink(t, op.block_id)
		if parent_id == "" {
			if op.after_id != "" {
				idx := index_of(t.root_ids, op.after_id)
				if idx >= 0 do inject_at(&t.root_ids, idx + 1, op.block_id)
				else do append(&t.root_ids, op.block_id)
			} else {
				inject_at(&t.root_ids, 0, op.block_id)
			}
		} else {
			parent, pok := t.by_id[parent_id]
			if !pok {
				append(&t.root_ids, op.block_id) // degraded: keep reachable
				return
			}
			idx := op.after_id != "" ? index_of(parent.children_ids, op.after_id) : -1
			tree_link_child(t, parent, op.block_id, idx < 0 ? 0 : idx + 1)
		}
		return
	}

	if op.target_id == "" || op.target_id not_in t.by_id do return
	if in_subtree(t, op.block_id, op.target_id) do return // cycle guard

	tree_unlink(t, op.block_id)
	insert_to(t, block, op.target_id, op.position, op_key, allocator)
}

capture_row_counts :: proc(t: ^Block_Tree, allocator := context.temp_allocator) -> map[string]int {
	counts := make(map[string]int, allocator = allocator)
	for id, b in t.by_id {
		if is_layout(b, LAYOUT_ROW) do counts[id] = len(b.children_ids)
	}
	return counts
}

normalize :: proc(t: ^Block_Tree, before_counts: map[string]int) {
	dirty := true
	for dirty {
		dirty = false

		// 1. Empty structural layouts removed.
		empties := make([dynamic]string, context.temp_allocator)
		for b in t.storage {
			id := b.id
			if t.by_id[id] != b do continue
			if b.content.kind != .Layout do continue
			style := b.content.layout_style
			if style != LAYOUT_ROW && style != LAYOUT_COLUMN && style != LAYOUT_DIV do continue
			if len(b.children_ids) == 0 do append(&empties, id)
		}
		for id in empties {
			tree_unlink(t, id)
			delete_key(&t.by_id, id)
			dirty = true
		}

		// 2. Single-column rows unwrap.
		single_rows := make([dynamic]string, context.temp_allocator)
		for b in t.storage {
			id := b.id
			if t.by_id[id] != b do continue
			if !is_layout(b, LAYOUT_ROW) || len(b.children_ids) != 1 do continue
			col, ok := t.by_id[b.children_ids[0]]
			if ok && is_layout(col, LAYOUT_COLUMN) do append(&single_rows, id)
		}
		for row_id in single_rows {
			row, rok := t.by_id[row_id]
			if !rok || len(row.children_ids) != 1 do continue
			col := t.by_id[row.children_ids[0]]
			hoisted := make([dynamic]string, context.temp_allocator)
			append(&hoisted, ..col.children_ids[:])

			pid, has_parent := t.parent[row_id]
			if has_parent {
				p := t.by_id[pid]
				idx := index_of(p.children_ids, row_id)
				ordered_remove(&p.children_ids, idx)
				for cid, i in hoisted {
					inject_at(&p.children_ids, idx + i, cid)
					t.parent[cid] = pid
				}
				delete_key(&t.parent, row_id)
			} else {
				idx := index_of(t.root_ids, row_id)
				if idx < 0 do idx = len(t.root_ids)
				else do ordered_remove(&t.root_ids, idx)
				for cid, i in hoisted {
					inject_at(&t.root_ids, idx + i, cid)
					delete_key(&t.parent, cid)
				}
			}
			delete_key(&t.parent, col.id)
			delete_key(&t.by_id, row_id)
			delete_key(&t.by_id, col.id)
			dirty = true
		}
	}

	// 3. Width reset on rows whose column count changed.
	for id, b in t.by_id {
		if !is_layout(b, LAYOUT_ROW) do continue
		if before, ok := before_counts[id]; ok && before == len(b.children_ids) do continue
		for cid in b.children_ids {
			col, ok := t.by_id[cid]
			if ok do fields_delete(&col.fields, "width")
		}
	}
}

// ── State computation ────────────────────────────────────────────────

// Replays `changes` from genesis, or - given a checkpoint - replays only the
// tail (changes not in `covered_ids`) on top of the checkpoint's state. A
// full-history peer and a checkpoint-only peer reach the same state and the
// same heads from the same checkpoint; replay_test.odin pins that. A
// full-history peer whose Kahn order diverged from the checkpoint's ignores
// it (checkpoint_for_replay); a peer missing covered originals applies the
// tail only when checkpoint_tail_continues proves the order, so the state
// never depends on download order.
compute_state :: proc(changes: []Change, allocator := context.allocator, checkpoint: ^Checkpoint = nil) -> (Object_State, bool) {
	state: Object_State
	checkpoint := checkpoint_for_replay(changes, checkpoint)
	if len(changes) == 0 && checkpoint == nil do return state, false
	state.fields = make([dynamic]Value_Entry, allocator)

	tail := changes
	if checkpoint != nil {
		state.id = checkpoint.object_id
		tail = checkpoint_tail(changes, checkpoint, context.temp_allocator)
		// With every covered original present checkpoint_for_replay already
		// proved the prefix; only a peer still missing them needs the gate.
		if !checkpoint_covers_all(changes, checkpoint) && !checkpoint_tail_continues(tail, checkpoint) do tail = nil
		state.heads = checkpoint_heads(tail, checkpoint, allocator)
	} else {
		state.id = changes[0].object_id
		state.heads = find_heads(changes, allocator)
	}

	sorted := topo_sort(tail, context.temp_allocator, checkpoint)
	defer delete(sorted)
	if len(sorted) != len(tail) do return state, false

	seed: ^Snapshot
	start_idx := 0
	max_ts: i64 = 0
	if checkpoint != nil {
		seed = &checkpoint.state
		max_ts = checkpoint.state.updated_at
	} else {
		// Legacy in-DAG snapshot (Change.snapshot): most recent by timestamp
		// skips the replay prefix. Nothing produces these; fixtures pin them.
		snapshot_idx := -1
		snapshot_ts: i64 = -1
		for c, i in sorted {
			if c.has_snapshot && c.timestamp > snapshot_ts {
				snapshot_idx = i
				snapshot_ts = c.timestamp
			}
		}
		if snapshot_idx >= 0 {
			seed = &sorted[snapshot_idx].snapshot
			start_idx = snapshot_idx + 1
		}
	}

	initial_blocks: []Block
	if seed != nil {
		state.type_key = seed.type_key
		state.deleted = seed.deleted
		state.created_at = seed.created_at
		state.updated_at = seed.updated_at
		for e in seed.fields do fields_set(&state.fields, e.key, e.value)
		initial_blocks = seed.blocks[:]
	}

	t := tree_build(initial_blocks, allocator)
	if !replay_tree_valid(&t) do return state, false
	// Deprecated Snapshot.content → __content__ block.
	if seed != nil && len(seed.content) > 0 && "__content__" not_in t.by_id {
		b := new(Block, allocator)
		b.id = "__content__"
		b.children_ids = make([dynamic]string, allocator)
		b.content.kind = .Custom
		b.content.custom.content_type = "glon/raw"
		b.content.custom.data = seed.content
		t.by_id[b.id] = b
		append(&t.storage, b)
		append(&t.root_ids, b.id)
	}

	for i in start_idx ..< len(sorted) {
		change := sorted[i]
		if change.timestamp > max_ts do max_ts = change.timestamp

		row_counts := capture_row_counts(&t)
		change_hex := hex_id(change.id, context.temp_allocator)
		prefix := len(change_hex) >= 16 ? change_hex[:16] : change_hex
		touched := false

		for op, op_idx in change.ops {
			op_key := fmt.aprintf("%s-%d", prefix, op_idx, allocator = allocator)
			switch op.kind {
			case .None:
			case .Object_Create:
				state.type_key = op.type_key
				state.created_at = change.timestamp
				// A create AFTER a delete is a revival: restore-from-bin
				// commits exactly this. Histories always open with a create,
				// so pre-existing replays are unchanged.
				state.deleted = false
			case .Field_Set:
				fields_set(&state.fields, op.key, op.value)
			case .Field_Delete:
				fields_delete(&state.fields, op.key)
			case .Object_Delete:
				state.deleted = true
			case .Block_Add:
				apply_block_add(&t, op, op_key, allocator)
				if !replay_tree_valid(&t) do return state, false
				touched = true
			case .Block_Remove:
				remove_subtree(&t, op.block_id)
				touched = true
			case .Block_Update:
				if b, ok := t.by_id[op.block_id]; ok do b.content = op.content
			case .Block_Move:
				apply_block_move(&t, op, op_key, allocator)
				// Same post-op cycle check as Block_Add: a move can also
				// corrupt the tree (e.g. duplicated child refs), and boot
				// replay must reject it instead of serializing a cycle.
				if !replay_tree_valid(&t) do return state, false
				touched = true
			case .Block_Set_Align:
				if b, ok := t.by_id[op.block_id]; ok do b.align = op.align
			case .Block_Set_Background:
				if b, ok := t.by_id[op.block_id]; ok do b.background_color = op.color
			}
		}

		if touched do normalize(&t, row_counts)
	}

	state.blocks = tree_serialize(&t, allocator)
	state.updated_at = max_ts
	return state, true
}
