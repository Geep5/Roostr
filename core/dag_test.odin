#+build !js
package core

import "core:testing"

dag_test_block :: proc(id: string, children: ..string, allocator := context.allocator) -> Block {
	b: Block
	b.id = id
	b.children_ids = make([dynamic]string, allocator)
	for c in children do append(&b.children_ids, c)
	return b
}

// ROOSTR-DAG-001: repeated child refs used to re-emit a subtree per
// reference, expanding 2^N on chained duplicates and looping forever on
// self-references. Every block id is emitted at most once.
@(test)
tree_serialize_dedupes_duplicate_child_refs :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	blocks := []Block{
		dag_test_block("r", "a", "a"),
		dag_test_block("a", "b", "b"),
		dag_test_block("b", "c", "c"),
		dag_test_block("c"),
	}
	tree := tree_build(blocks, context.temp_allocator)
	out := tree_serialize(&tree, context.temp_allocator)
	testing.expect(t, len(out) == 4, "diamond of duplicates must emit N entries, not 2^N")
	seen := make(map[string]bool, context.temp_allocator)
	for b in out {
		testing.expect(t, b.id not_in seen, b.id)
		seen[b.id] = true
	}
}

@(test)
tree_serialize_terminates_on_self_reference :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// s must stay reachable from a root; an orphaned self-loop is simply
	// unreachable and never serialized at all.
	blocks := []Block{
		dag_test_block("r", "s"),
		dag_test_block("s", "s"),
	}
	tree := tree_build(blocks, context.temp_allocator)
	out := tree_serialize(&tree, context.temp_allocator)
	testing.expect(t, len(out) == 2, "self-referencing block emitted once")
}

// ROOSTR-DAG-002b: tree_unlink stopped at the first matching child ref,
// leaving a moved block linked through its old parent.
@(test)
tree_unlink_removes_every_duplicate_ref :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	blocks := []Block{
		dag_test_block("p", "m", "m", "k"),
		dag_test_block("m"),
		dag_test_block("k"),
	}
	tree := tree_build(blocks, context.temp_allocator)
	tree_unlink(&tree, "m")
	p := tree.by_id["p"]
	testing.expect(t, len(p.children_ids) == 1, "both duplicate refs must be removed")
	for cid in p.children_ids do testing.expect(t, cid != "m", cid)
}

// ROOSTR-DAG-002: the POS_REPLACE absorb shape from the finding — the
// parent lists the moved block twice; absorbing the parent's children
// after a first-only unlink made the block its own child.
@(test)
move_replace_absorb_stays_acyclic :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	blocks := []Block{
		dag_test_block("p", "m", "m"),
		dag_test_block("m"),
	}
	tree := tree_build(blocks, context.temp_allocator)
	op := Operation{kind = .Block_Move, block_id = "m", target_id = "p", position = POS_REPLACE}
	apply_block_move(&tree, op, "test-key", context.temp_allocator)
	testing.expect(t, replay_tree_valid(&tree), "move must not make a block its own child")
	m := tree.by_id["m"]
	for cid in m.children_ids do testing.expect(t, cid != "m", cid)
}

// ROOSTR-DAG-002a: compute_state validated the tree after Block_Add but
// not after Block_Move. A move that closes a cycle (a -> b while b is
// also listed under c, hiding the a -> b edge from the parent map) must
// now be rejected exactly like a corrupting add.
@(test)
compute_state_rejects_cyclic_move :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	id1 := make([]byte, 32, context.temp_allocator)
	id1[31] = 1
	id2 := make([]byte, 32, context.temp_allocator)
	id2[31] = 2

	c1: Change
	c1.id = id1
	c1.object_id = "obj"
	c1.timestamp = 1
	c1.has_snapshot = true
	c1.snapshot.blocks = make([dynamic]Block, context.temp_allocator)
	// b is a child of both a and c: a valid repeated reference, but the
	// parent map only records c, so the move's subtree guard cannot see
	// the a -> b edge it is about to close into a cycle.
	append(&c1.snapshot.blocks,
		dag_test_block("a", "b", allocator = context.temp_allocator),
		dag_test_block("b", allocator = context.temp_allocator),
		dag_test_block("c", "b", allocator = context.temp_allocator),
	)

	c2: Change
	c2.id = id2
	c2.object_id = "obj"
	c2.timestamp = 2
	c2.parent_ids = make([dynamic][]byte, context.temp_allocator)
	append(&c2.parent_ids, id1)
	c2.ops = make([dynamic]Operation, context.temp_allocator)
	append(&c2.ops, Operation{kind = .Block_Move, block_id = "a", target_id = "b", position = POS_INNER})

	changes := []Change{c1, c2}
	_, ok := compute_state(changes, context.temp_allocator)
	testing.expect(t, !ok, "a move that closes a cycle must be rejected like a corrupting add")
}
