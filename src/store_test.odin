package glon

// The store's durability contract: a change is written atomically, and a
// change whose bytes do not match its content-addressed name is never
// replayed as genuine. Both were broken - writes went straight to the final
// path with no fsync, and loads never compared the hash with the filename,
// so a torn file was replayed as truth and an undecodable one vanished
// without a word.
//
// The store is global (`g_store`), and the test runner is threaded, so the
// stateful assertions live in ONE test rather than racing each other over
// the same struct.

import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:testing"
import "core:encoding/hex"
import "../core"

@(private = "file")
change_for :: proc(object_id: string, value: string) -> core.Change {
	c: core.Change
	c.object_id = object_id
	c.timestamp = 1
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&c.ops, core.Operation{kind = .Object_Create, type_key = "note"})
	append(&c.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value(value)})
	return c
}

/** Write half of a well-named change: what a crash mid-write leaves behind. */
@(private = "file")
plant_torn_change :: proc(root: string, object_id: string, value: string) -> string {
	torn := change_for(object_id, value)
	hashed := core.encode_change(torn, for_hashing = true, allocator = context.temp_allocator)
	digest := core.sha256(hashed)
	name := fmt.tprintf("%s.pb", string(hex.encode(digest[:], context.temp_allocator)))
	full := core.encode_change(torn, allocator = context.temp_allocator)
	path, _ := filepath.join({root, "changes", object_id, name}, context.temp_allocator)
	_ = os.write_entire_file(path, full[:len(full) / 2])
	return name
}

@(private = "file")
loaded_objects :: proc() -> int {
	count := 0
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		n := cast(^int)user
		n^ = len(states)
	}, &count)
	return count
}

@(test)
store_durability_contract :: proc(t: ^testing.T) {
	root := fmt.aprintf("%s/glon-store-%d", os.temp_directory(context.temp_allocator), unix_ms())
	os.make_directory(root)
	defer os.remove_all(root)
	store_init(root)
	store_invalidate()

	// ── An atomic write leaves exactly the final file ──────────────
	c := change_for("obj-1", "hello")
	id, ok := commit_change(&c)
	testing.expect(t, ok, "commit must succeed")
	testing.expect_value(t, len(id), 64)

	dir, _ := filepath.join({root, "changes", "obj-1"}, context.temp_allocator)
	handle, derr := os.open(dir)
	testing.expect(t, derr == nil, "object directory exists")
	pb, tmp := 0, 0
	if derr == nil {
		defer os.close(handle)
		files, _ := os.read_dir(handle, -1, context.temp_allocator)
		for f in files {
			if strings.has_suffix(f.name, ".pb") do pb += 1
			if strings.has_suffix(f.name, ".tmp") do tmp += 1
		}
	}
	testing.expect_value(t, pb, 1)
	// The temp file is renamed, never left for a loader to trip over.
	testing.expect_value(t, tmp, 0)

	// ── A torn change is parked, and its object still loads ────────
	name := plant_torn_change(root, "obj-1", "lost")
	store_invalidate()
	testing.expect(t, loaded_objects() > 0, "surviving changes still replay")
	testing.expect_value(t, g_store.quarantined, 1)
	moved, _ := filepath.join({root, "changes", ".quarantine", "obj-1", name}, context.temp_allocator)
	_, serr := os.stat(moved, context.temp_allocator)
	testing.expect(t, serr == nil, "the damaged change is parked under .quarantine")

	// ── Damage is a standing fact, not a boot event ────────────────
	// A counter that only counted this pass would read zero on the next
	// load and make the missing change look healed.
	store_invalidate()
	_ = loaded_objects()
	testing.expect_value(t, g_store.quarantined, 1)
}

@(test)
address_mismatch_is_rejected :: proc(t: ^testing.T) {
	c := change_for("obj-3", "value")
	hashed := core.encode_change(c, for_hashing = true, allocator = context.temp_allocator)
	digest := core.sha256(hashed)
	real_name := fmt.tprintf("%s.pb", string(hex.encode(digest[:], context.temp_allocator)))
	testing.expect(t, change_matches_name(c, real_name), "its own address matches")

	wrong := strings.concatenate({strings.repeat("a", 64, context.temp_allocator), ".pb"}, context.temp_allocator)
	testing.expect(t, !change_matches_name(c, wrong), "a foreign address is refused")
	testing.expect(t, !change_matches_name(c, "short.pb"), "a non-address name is refused")
}
