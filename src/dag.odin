package glon

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

topo_sort :: proc(changes: []Change, allocator := context.allocator) -> [dynamic]^Change {
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
	for h, deg in in_degree {
		if deg == 0 do append(&queue, h)
	}
	slice.sort(queue[:])

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
	for _, b in t.by_id {
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
	visit :: proc(t: ^Block_Tree, id: string, out: ^[dynamic]Block) {
		b, ok := t.by_id[id]
		if !ok do return
		append(out, b^)
		for cid in b.children_ids do visit(t, cid, out)
	}
	for id in t.root_ids do visit(t, id, &out)
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
			for cid, i in p.children_ids {
				if cid == block_id {
					ordered_remove(&p.children_ids, i)
					break
				}
			}
		}
		delete_key(&t.parent, block_id)
	} else {
		for id, i in t.root_ids {
			if id == block_id {
				ordered_remove(&t.root_ids, i)
				break
			}
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
		for id, b in t.by_id {
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
		for id, b in t.by_id {
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

compute_state :: proc(changes: []Change, allocator := context.allocator) -> (Object_State, bool) {
	state: Object_State
	if len(changes) == 0 do return state, false
	state.id = changes[0].object_id
	state.fields = make([dynamic]Value_Entry, allocator)
	state.heads = find_heads(changes, allocator)

	sorted := topo_sort(changes, context.temp_allocator)
	defer delete(sorted)

	// Most recent snapshot (by timestamp) skips the replay prefix.
	snapshot_idx := -1
	snapshot_ts: i64 = -1
	for c, i in sorted {
		if c.has_snapshot && c.timestamp > snapshot_ts {
			snapshot_idx = i
			snapshot_ts = c.timestamp
		}
	}

	initial_blocks: []Block
	start_idx := 0
	if snapshot_idx >= 0 {
		snap := sorted[snapshot_idx].snapshot
		state.type_key = snap.type_key
		state.deleted = snap.deleted
		state.created_at = snap.created_at
		state.updated_at = snap.updated_at
		for e in snap.fields do fields_set(&state.fields, e.key, e.value)
		initial_blocks = snap.blocks[:]
		start_idx = snapshot_idx + 1
		// Deprecated snap.content → __content__ block handled below via tree.
	}

	t := tree_build(initial_blocks, allocator)
	if snapshot_idx >= 0 {
		snap := sorted[snapshot_idx].snapshot
		if len(snap.content) > 0 && "__content__" not_in t.by_id {
			b := new(Block, allocator)
			b.id = "__content__"
			b.children_ids = make([dynamic]string, allocator)
			b.content.kind = .Custom
			b.content.custom.content_type = "glon/raw"
			b.content.custom.data = snap.content
			t.by_id[b.id] = b
			append(&t.storage, b)
			append(&t.root_ids, b.id)
		}
	}

	max_ts: i64 = 0
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
				touched = true
			case .Block_Remove:
				remove_subtree(&t, op.block_id)
				touched = true
			case .Block_Update:
				if b, ok := t.by_id[op.block_id]; ok do b.content = op.content
			case .Block_Move:
				apply_block_move(&t, op, op_key, allocator)
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
