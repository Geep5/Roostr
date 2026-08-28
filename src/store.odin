package glon

// Disk store: scans GLON_DATA/changes/<objectId>/<hex>.pb, computes
// states into a generation arena (freed wholesale on invalidation),
// and writes new changes as content-addressed .pb files — the same
// on-disk format as the TS implementation, so both stacks read each
// other's data.

import "core:os"
import "core:fmt"
import "core:sync"
import "core:time"
import "core:strings"
import "core:path/filepath"
import "core:mem/virtual"
import "core:encoding/hex"
import "core:crypto"

// Full rebuilds are expensive (every .pb decoded + replayed); they run only
// at startup and every COMPACT_INTERVAL_MS to reclaim arena garbage left by
// incremental reloads. Commits mark their object dirty; ensure_loaded
// re-reads just those directories.
COMPACT_INTERVAL_MS :: 10 * 60 * 1000

Store :: struct {
	root:      string, // <data>/changes
	data_root: string, // <data>
	mu:        sync.Mutex,
	arena:     virtual.Arena, // owns everything reachable from `states`
	states:    map[string]^Object_State,
	dirty:     map[string]bool, // object ids needing an incremental reload
	loaded_at: i64,
	valid:     bool,
}

g_store: Store

unix_ms :: proc() -> i64 {
	return time.now()._nsec / 1_000_000
}

store_init :: proc(data_root: string) {
	g_store.data_root = data_root
	g_store.root, _ = filepath.join({data_root, "changes"})
}

store_invalidate :: proc() {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	g_store.valid = false
}

/** Mark one object stale; ensure_loaded re-reads only its directory. */
store_mark_dirty :: proc(object_id: string) {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	if g_store.dirty == nil do g_store.dirty = make(map[string]bool)
	g_store.dirty[strings.clone(object_id)] = true
}

/** Rebuild the state cache when stale. Caller must hold the lock. */
ensure_loaded :: proc() {
	now := time.tick_now()._nsec / 1_000_000

	// Incremental path: reload only dirty objects. Replaced states leak in
	// the arena until the next periodic full rebuild compacts them.
	if g_store.valid && now - g_store.loaded_at < COMPACT_INTERVAL_MS {
		if len(g_store.dirty) == 0 do return
		alloc := virtual.arena_allocator(&g_store.arena)
		for object_id in g_store.dirty {
			dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
			delete_key(&g_store.states, object_id)
			load_object_dir(dir_path, object_id, alloc)
		}
		for k in g_store.dirty do delete(k)
		clear(&g_store.dirty)
		return
	}

	// Full rebuild: drop the previous generation entirely.
	if g_store.states != nil {
		delete(g_store.states)
		virtual.arena_destroy(&g_store.arena)
	}
	_ = virtual.arena_init_growing(&g_store.arena)
	alloc := virtual.arena_allocator(&g_store.arena)
	g_store.states = make(map[string]^Object_State)
	if g_store.dirty != nil {
		for k in g_store.dirty do delete(k)
		clear(&g_store.dirty)
	}

	dir, derr := os.open(g_store.root)
	if derr == nil {
		defer os.close(dir)
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		if eerr == nil {
			for entry in entries {
				if entry.type != .Directory || strings.has_prefix(entry.name, ".") do continue
				load_object_dir(entry.fullpath, entry.name, alloc)
			}
		}
	}
	g_store.loaded_at = now
	g_store.valid = true
}

load_object_dir :: proc(dir_path: string, object_id: string, alloc := context.allocator) {
	dir, derr := os.open(dir_path)
	if derr != nil do return
	defer os.close(dir)
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	if ferr != nil do return

	changes := make([dynamic]Change, alloc)
	for f in files {
		if !strings.has_suffix(f.name, ".pb") do continue
		data, rerr := os.read_entire_file(f.fullpath, alloc)
		if rerr != nil do continue
		c, cok := decode_change(data, alloc)
		if cok do append(&changes, c)
	}
	if len(changes) == 0 do return

	context.allocator = alloc
	state, ok := compute_state(changes[:], alloc)
	if !ok do return
	sp := new(Object_State, alloc)
	sp^ = state
	// Keys of the map live in the arena too (object_id is arena-allocated via decode).
	g_store.states[state.id] = sp
}

/** Snapshot accessor: runs `fn` with the states map under the lock. */
with_states :: proc(fn: proc(states: map[string]^Object_State, user: rawptr), user: rawptr = nil) {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	fn(g_store.states, user)
}

// ── Writing changes ──────────────────────────────────────────────────

/** Content-address, persist, and invalidate. Returns hex id. */
commit_change :: proc(c: ^Change) -> (string, bool) {
	hashed := encode_change(c^, for_hashing = true, allocator = context.temp_allocator)
	digest := sha256(hashed)
	c.id = make([]byte, 32, context.temp_allocator)
	copy(c.id, digest[:])

	full := encode_change(c^, allocator = context.temp_allocator)
	hex_str := string(hex.encode(c.id, context.temp_allocator))

	dir, _ := filepath.join({g_store.root, c.object_id}, context.temp_allocator)
	os.make_directory(g_store.data_root)
	os.make_directory(g_store.root)
	os.make_directory(dir)
	path, _ := filepath.join({dir, strings.concatenate({hex_str, ".pb"}, context.temp_allocator)}, context.temp_allocator)
	if os.write_entire_file(path, full) != nil do return "", false

	store_mark_dirty(c.object_id)
	return strings.clone(hex_str), true
}

/** Current heads of an object as raw 32-byte ids (temp-allocated). */
object_heads :: proc(object_id: string) -> [dynamic][]byte {
	out := make([dynamic][]byte, context.temp_allocator)
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	state, ok := g_store.states[object_id]
	if !ok do return out
	for h in state.heads {
		raw, hok := hex.decode(transmute([]byte)h, context.temp_allocator)
		if !hok do continue
		append(&out, raw)
	}
	return out
}

new_uuid :: proc(allocator := context.allocator) -> string {
	b: [16]byte
	crypto.rand_bytes(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.aprintf(
		"%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
		b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15],
		allocator = allocator,
	)
}
