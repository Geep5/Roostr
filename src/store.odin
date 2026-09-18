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
import "../core"

// Full rebuilds are expensive (every .pb decoded + replayed); they run at
// startup, every COMPACT_INTERVAL_MS, and whenever incremental reloads have
// parked more than the byte budget below. Commits mark their object dirty;
// ensure_loaded re-reads just those directories.
//
// The budget matters more than the timer: an incremental reload re-replays
// the whole object, and the hot objects are the biggest ones (an agent's
// chat is thousands of changes / megabytes), so one write can park tens of
// megabytes of arena garbage. Time alone let the footprint reach 2 GB
// between compactions under ordinary harness traffic.
COMPACT_INTERVAL_MS :: 10 * 60 * 1000
COMPACT_SLACK_FACTOR :: 3               // garbage tolerated as a multiple of the live set
COMPACT_SLACK_BYTES :: 32 * 1024 * 1024 // …plus this, so small corpora still batch writes

Store :: struct {
	root:      string, // <data>/changes
	data_root: string, // <data>
	mu:        sync.Mutex,
	arena:     virtual.Arena, // owns everything reachable from `states`
	states:    map[string]^core.Object_State,
	dirty:     map[string]bool, // object ids needing an incremental reload
	live_used: uint, // arena.total_used right after the last full rebuild
	loaded_at: i64,
	valid:     bool,
	/** Changes parked as damaged since boot - surfaced, never silent. */
	quarantined: int,
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

	// Incremental path: reload only dirty objects. Replaced states are parked
	// in the arena — taken only while the parked bytes stay inside the budget,
	// so a hot object cannot balloon the footprint between timed compactions.
	budget := g_store.live_used * COMPACT_SLACK_FACTOR + COMPACT_SLACK_BYTES
	if g_store.valid && now - g_store.loaded_at < COMPACT_INTERVAL_MS && g_store.arena.total_used < budget {
		if len(g_store.dirty) == 0 do return
		alloc := virtual.arena_allocator(&g_store.arena)
		touched := make([dynamic]string, 0, len(g_store.dirty), context.temp_allocator)
		for object_id in g_store.dirty {
			dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
			delete_key(&g_store.states, object_id)
			load_object_dir(dir_path, object_id, alloc)
			append(&touched, strings.clone(object_id, context.temp_allocator))
		}
		for k in g_store.dirty do delete(k)
		clear(&g_store.dirty)
		// A relay copy of a vanished object can race in ahead of the ledger,
		// and a ledger reload can vanish objects that are already on disk.
		// The ledger wins either way.
		vanished := vanished_locked()
		if len(vanished) > 0 {
			ledger_reloaded := false
			for id in touched do if id == VANISH_LOG_ID do ledger_reloaded = true
			if ledger_reloaded {
				enforce_vanished_locked()
			} else {
				for id in touched do if id in vanished {
					purge_object_files(id)
					delete_key(&g_store.states, id)
				}
			}
		}
		return
	}

	// Full rebuild: drop the previous generation entirely.
	if g_store.states != nil {
		delete(g_store.states)
		virtual.arena_destroy(&g_store.arena)
	}
	_ = virtual.arena_init_growing(&g_store.arena)
	alloc := virtual.arena_allocator(&g_store.arena)
	g_store.states = make(map[string]^core.Object_State)
	if g_store.dirty != nil {
		for k in g_store.dirty do delete(k)
		clear(&g_store.dirty)
	}

	g_store.quarantined = 0
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
	// Damage is a standing fact, not a boot event: report everything parked,
	// so a restart cannot make missing changes look healed.
	g_store.quarantined += count_quarantined()
	enforce_vanished_locked()
	g_store.live_used = g_store.arena.total_used
	g_store.loaded_at = now
	g_store.valid = true
}


/** Changes currently parked under changes/.quarantine, across all objects. */
count_quarantined :: proc() -> int {
	root, _ := filepath.join({g_store.root, ".quarantine"}, context.temp_allocator)
	dir, derr := os.open(root)
	if derr != nil do return 0
	defer os.close(dir)
	per_object, eerr := os.read_dir(dir, -1, context.temp_allocator)
	if eerr != nil do return 0
	total := 0
	for entry in per_object {
		if entry.type != .Directory do continue
		sub, serr := os.open(entry.fullpath)
		if serr != nil do continue
		files, ferr := os.read_dir(sub, -1, context.temp_allocator)
		if ferr == nil {
			for f in files do if strings.has_suffix(f.name, ".pb") do total += 1
		}
		os.close(sub)
	}
	return total
}
load_object_dir :: proc(dir_path: string, object_id: string, alloc := context.allocator) {
	dir, derr := os.open(dir_path)
	if derr != nil do return
	defer os.close(dir)
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	if ferr != nil do return

	changes := make([dynamic]core.Change, alloc)
	for f in files {
		if !strings.has_suffix(f.name, ".pb") do continue
		// A crash used to be able to leave a torn file at a final,
		// content-addressed name, and nothing here compared the name with
		// the bytes: the truncated change was replayed as genuine, and an
		// undecodable one vanished in silence. The filename IS the hash, so
		// check it, and quarantine whatever fails instead of guessing.
		data, rerr := os.read_entire_file(f.fullpath, alloc)
		if rerr != nil {
			quarantine_change(f.fullpath, object_id, "unreadable")
			continue
		}
		c, cok := core.decode_change(data, alloc)
		if !cok {
			quarantine_change(f.fullpath, object_id, "undecodable")
			continue
		}
		if !change_matches_name(c, f.name) {
			quarantine_change(f.fullpath, object_id, "address mismatch")
			continue
		}
		append(&changes, c)
	}
	if len(changes) == 0 do return

	context.allocator = alloc
	state, ok := core.compute_state(changes[:], alloc)
	if !ok do return
	sp := new(core.Object_State, alloc)
	sp^ = state
	// Keys of the map live in the arena too (object_id is arena-allocated via decode).
	g_store.states[state.id] = sp
}

/** True when `<hex>.pb` is the content address of the change it holds. */
change_matches_name :: proc(c: core.Change, file_name: string) -> bool {
	name := strings.trim_suffix(file_name, ".pb")
	if len(name) != 64 do return false
	hashed := core.encode_change(c, for_hashing = true, allocator = context.temp_allocator)
	digest := core.sha256(hashed)
	return strings.equal_fold(name, string(hex.encode(digest[:], context.temp_allocator)))
}

/**
 * Park a damaged change where an operator can find it and sync can replace
 * it. Changes are content-addressed, so any relay or peer still holding the
 * good copy heals the object on the next scan - but the loss must be loud,
 * never a silently skipped file.
 */
quarantine_change :: proc(path: string, object_id: string, reason: string) {
	// No counter here: the census in ensure_loaded counts what is parked on
	// disk, so incrementing on the move as well would double-count.
	root_dir, _ := filepath.join({g_store.root, ".quarantine"}, context.temp_allocator)
	dest_dir, _ := filepath.join({root_dir, object_id}, context.temp_allocator)
	os.make_directory(root_dir)
	os.make_directory(dest_dir)
	base := filepath.base(path)
	dest, _ := filepath.join({dest_dir, base}, context.temp_allocator)
	moved := os.rename(path, dest) == nil
	fmt.eprintfln(
		"[store] %s change quarantined (%s/%s)%s",
		reason,
		object_id,
		base,
		moved ? "" : " - COULD NOT MOVE, still in place",
	)
}

/** Snapshot accessor: runs `fn` with the states map under the lock. */
with_states :: proc(fn: proc(states: map[string]^core.Object_State, user: rawptr), user: rawptr = nil) {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	fn(g_store.states, user)
}

// ── Writing changes ──────────────────────────────────────────────────

/**
 * Content-address, persist, and invalidate. Returns hex id.
 *
 * Durable by the same rules the relay's log follows: a change is written to
 * a temporary file, fsynced, then renamed into its content-addressed name,
 * and the directory is fsynced so the name itself survives. Writing
 * straight to the final path (as this did) could leave a torn file sitting
 * at a name that claims to be the hash of its contents, and an
 * unacknowledged write could still be lost in the page cache after the
 * caller was told the commit succeeded.
 */
commit_change :: proc(c: ^core.Change) -> (string, bool) {
	hashed := core.encode_change(c^, for_hashing = true, allocator = context.temp_allocator)
	digest := core.sha256(hashed)
	c.id = make([]byte, 32, context.temp_allocator)
	copy(c.id, digest[:])

	full := core.encode_change(c^, allocator = context.temp_allocator)
	hex_str := string(hex.encode(c.id, context.temp_allocator))

	dir, _ := filepath.join({g_store.root, c.object_id}, context.temp_allocator)
	os.make_directory(g_store.data_root)
	os.make_directory(g_store.root)
	os.make_directory(dir)
	path, _ := filepath.join({dir, strings.concatenate({hex_str, ".pb"}, context.temp_allocator)}, context.temp_allocator)
	if !write_file_durable(path, full) do return "", false

	store_mark_dirty(c.object_id)
	return strings.clone(hex_str), true
}

/** fsync a directory so a rename into it is durable, not just visible. */
sync_directory :: proc(dir: string) -> bool {
	fd, err := os.open(dir, {.Read}, os.Permissions_Default_File)
	if err != nil do return false
	ok := os.sync(fd) == nil
	return os.close(fd) == nil && ok
}

/** Write bytes to `path` atomically: temp file, fsync, rename, fsync dir. */
write_file_durable :: proc(path: string, data: []byte) -> bool {
	tmp := strings.concatenate({path, ".tmp"}, context.temp_allocator)
	fd, err := os.open(tmp, {.Write, .Create, .Trunc}, os.Permissions_Default_File)
	if err != nil do return false
	ok := true
	off := 0
	for off < len(data) {
		n, werr := os.write(fd, data[off:])
		if werr != nil || n <= 0 { ok = false; break }
		off += n
	}
	if ok do ok = os.sync(fd) == nil
	if os.close(fd) != nil do ok = false
	if !ok {
		_ = os.remove(tmp)
		return false
	}
	if os.rename(tmp, path) != nil {
		_ = os.remove(tmp)
		return false
	}
	return sync_directory(os.dir(path))
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
