package glon

// Folded-id index (docs/state-sync.md, "Daemon"): GLON_DATA/folded/<objectId>
// lists the changes that left this computer's working set - folded by a
// strict ancestor of the current base, another device's orphan/stale
// leftovers, own changes proven folded, or rebased own orphans - so an
// import never writes one back into changes/ ("never resurrect"), plus each
// rebased orphan's replacement id. Never published, never read for sync.
//
// Append-only, fixed 64-byte records: [id 32][rebased 32], `rebased` all
// zero unless the id is a rebased orphan. An append is fsynced before the
// change files go. A torn last record (crash mid-append) is ignored on read
// and cut off by the next append; an all-zero id is no record.
//
// Replaces the archive of full change bytes (archive/<objectId>/<hex>.pb,
// <hex>.rebased), which migrate_archive folds in once at serve start.

import "base:runtime"
import "core:fmt"
import "core:os"
import "core:slice"
import "core:path/filepath"
import "core:strings"
import "core:sync"
import "../core"

FOLDED_RECORD_SIZE :: 64

Folded_Record :: struct {
	id:      [32]byte,
	rebased: [32]byte, // all zero: not a rebased orphan
}
#assert(size_of(Folded_Record) == FOLDED_RECORD_SIZE)

/** One object's index in memory: its ids (binary-searched once sorted) and rebased mappings. */
@(private = "file")
Folded_Index :: struct {
	ids:     [dynamic][32]byte,
	sorted:  bool,
	rebased: map[[32]byte][32]byte,
}

/** Indexes loaded on first use, heap-owned; the daemon is the only writer. */
@(private = "file")
g_folded: struct {
	mu:      sync.Mutex,
	objects: map[string]^Folded_Index,
}

folded_path :: proc(object_id: string) -> string {
	return data_dir("folded", object_id)
}

@(private = "file")
free_index :: proc(key: string, idx: ^Folded_Index) {
	context.allocator = runtime.heap_allocator()
	delete(key)
	delete(idx.ids)
	delete(idx.rebased)
	free(idx)
}

/** Forget every cached index (store_init: possibly another data root). */
folded_reset :: proc() {
	sync.lock(&g_folded.mu)
	defer sync.unlock(&g_folded.mu)
	for key, idx in g_folded.objects do free_index(key, idx)
	clear(&g_folded.objects)
}

@(private = "file")
id_less :: proc(a, b: [32]byte) -> bool {
	a, b := a, b
	return string(a[:]) < string(b[:])
}

@(private = "file")
index_locked :: proc(object_id: string) -> ^Folded_Index {
	if idx, ok := g_folded.objects[object_id]; ok do return idx
	heap := runtime.heap_allocator()
	idx := new(Folded_Index, heap)
	idx.ids = make([dynamic][32]byte, heap)
	idx.rebased = make(map[[32]byte][32]byte, allocator = heap)
	if data, err := os.read_entire_file(folded_path(object_id), context.temp_allocator); err == nil {
		// A torn tail is not a record.
		whole := data[:len(data) - len(data) % FOLDED_RECORD_SIZE]
		for r in slice.reinterpret([]Folded_Record, whole) {
			if r.id == {} do continue
			append(&idx.ids, r.id)
			if r.rebased != {} do idx.rebased[r.id] = r.rebased
		}
	}
	if g_folded.objects == nil do g_folded.objects = make(map[string]^Folded_Index, allocator = heap)
	g_folded.objects[strings.clone(object_id, heap)] = idx
	return idx
}

@(private = "file")
has_locked :: proc(idx: ^Folded_Index, id: [32]byte) -> bool {
	if !idx.sorted {
		slice.sort_by(idx.ids[:], id_less)
		idx.sorted = true
	}
	lo, hi := 0, len(idx.ids)
	for lo < hi {
		mid := (lo + hi) / 2
		if id_less(idx.ids[mid], id) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo < len(idx.ids) && idx.ids[lo] == id
}

/** Append whole records to folded/<objectId>, first cutting a torn tail off; fsynced. */
@(private = "file")
append_records :: proc(object_id: string, data: []byte) -> bool {
	root := data_dir("folded", "")
	os.make_directory(g_store.data_root)
	os.make_directory(root)
	path := folded_path(object_id)
	created := !os.exists(path)
	f, err := os.open(path, {.Read, .Write, .Create}, os.Permissions_Default_File)
	if err != nil do return false
	size, serr := os.file_size(f)
	ok := serr == nil
	at := size - size % FOLDED_RECORD_SIZE
	if ok && at != size {
		ok = os.truncate(f, at) == nil
		fmt.eprintfln("[store] folded index %s: dropped a torn record (%d bytes)", object_id, size - at)
	}
	for off := 0; ok && off < len(data); {
		n, werr := os.write_at(f, data[off:], at + i64(off))
		if werr != nil || n <= 0 {
			ok = false
			break
		}
		off += n
	}
	if ok do ok = os.sync(f) == nil
	if os.close(f) != nil do ok = false
	if ok && created do ok = sync_directory(root)
	return ok
}

/**
 * Record `records` in the object's index: one fsynced append of those not
 * held yet (or bringing a new rebased id). ok=false when the append failed:
 * the caller must keep whatever it was about to drop.
 */
folded_add :: proc(object_id: string, records: []Folded_Record) -> (added: int, ok: bool) {
	if !object_id_safe(object_id) do return 0, false
	sync.lock(&g_folded.mu)
	defer sync.unlock(&g_folded.mu)
	idx := index_locked(object_id)
	fresh := make([dynamic]Folded_Record, 0, len(records), context.temp_allocator)
	at := make(map[[32]byte]int, len(records), context.temp_allocator) // position in fresh
	new_ids := make([dynamic][32]byte, 0, len(records), context.temp_allocator)
	for r in records {
		if r.id == {} do continue
		if i, seen := at[r.id]; seen {
			if r.rebased != {} do fresh[i].rebased = r.rebased
			continue
		}
		present := has_locked(idx, r.id)
		if present && (r.rebased == {} || idx.rebased[r.id] == r.rebased) do continue
		at[r.id] = len(fresh)
		append(&fresh, r)
		if !present do append(&new_ids, r.id)
	}
	if len(fresh) == 0 do return 0, true
	if !append_records(object_id, slice.to_bytes(fresh[:])) do return 0, false
	append(&idx.ids, ..new_ids[:])
	if len(new_ids) > 0 do idx.sorted = false
	for r in fresh do if r.rebased != {} do idx.rebased[r.id] = r.rebased
	return len(fresh), true
}

/** Whether change `id` left this object's working set here; `rebased` = its replacement (zero when none). */
folded_lookup :: proc(object_id: string, id: [32]byte) -> (folded: bool, rebased: [32]byte) {
	if !object_id_safe(object_id) do return false, {}
	sync.lock(&g_folded.mu)
	defer sync.unlock(&g_folded.mu)
	idx := index_locked(object_id)
	if !has_locked(idx, id) do return false, {}
	return true, idx.rebased[id]
}

/** Vanish: drop the object's index. True when a file was removed. */
folded_purge :: proc(object_id: string) -> bool {
	if !object_id_safe(object_id) do return false
	sync.lock(&g_folded.mu)
	defer sync.unlock(&g_folded.mu)
	if _, cached := g_folded.objects[object_id]; cached {
		key, idx := delete_key(&g_folded.objects, object_id)
		free_index(key, idx)
	}
	return os.remove(folded_path(object_id)) == nil
}

/**
 * Changes leaving the working set: record them in the index (durably), then
 * delete their .pb/.b/.local/.published from changes/. `removed` counts .pb files;
 * ok=false (nothing removed) when the index append failed.
 */
fold_changes :: proc(object_id: string, records: []Folded_Record) -> (removed: int, ok: bool) {
	if len(records) == 0 do return 0, true
	if _, aok := folded_add(object_id, records); !aok {
		fmt.eprintfln("[store] could not record %d folded changes of %s - left in changes/", len(records), object_id)
		return 0, false
	}
	dir, derr := os.open(data_dir("changes", object_id))
	if derr != nil do return 0, true
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	os.close(dir)
	if ferr != nil do return 0, true
	gone := make(map[string]bool, len(records), context.temp_allocator)
	for &r in records do gone[core.hex_id(r.id[:], context.temp_allocator)] = true
	for f in files {
		dot := strings.index_byte(f.name, '.')
		if dot != 64 || f.name[:dot] not_in gone do continue
		if os.remove(f.fullpath) == nil && f.name[dot:] == ".pb" do removed += 1
	}
	return removed, true
}

/** Adds the names in `dir` ending in `suffix`, suffix cut off, to `into` (nothing when unreadable). */
@(private = "file")
stems :: proc(dir: string, suffix: string, into: ^map[string]bool) {
	d, derr := os.open(dir)
	if derr != nil do return
	defer os.close(d)
	files, ferr := os.read_dir(d, -1, context.temp_allocator)
	if ferr != nil do return
	for f in files do if strings.has_suffix(f.name, suffix) do into[f.name[:len(f.name) - len(suffix)]] = true
}

/** Fold one archive/<objectId>/ into the index, then delete it. */
@(private = "file")
migrate_archive_object :: proc(object_id: string, path: string) -> (added: int, freed: i64, ok: bool) {
	dir, derr := os.open(path)
	if derr != nil do return
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	os.close(dir)
	if ferr != nil do return
	// Archived ids still held (working set, or quarantined awaiting a good copy) did not leave.
	held := make(map[string]bool, allocator = context.temp_allocator)
	stems(data_dir("changes", object_id), ".pb", &held)
	quarantine, _ := filepath.join({g_store.root, ".quarantine", object_id}, context.temp_allocator)
	stems(quarantine, ".pb", &held)
	mapped := make(map[[32]byte][32]byte, allocator = context.temp_allocator)
	for f in files {
		switch {
		case strings.has_suffix(f.name, ".pb"):
			stem := f.name[:len(f.name) - 3]
			if stem in held do continue // a hard link of a held change: nothing folds, nothing is freed
			id, iok := hash_raw(stem)
			if !iok do continue
			if id not_in mapped do mapped[id] = {}
			freed += f.size
		case strings.has_suffix(f.name, ".rebased"):
			id, iok := hash_raw(f.name[:len(f.name) - 8])
			data, rerr := os.read_entire_file(f.fullpath, context.temp_allocator)
			to, tok := hash_raw(strings.trim_space(string(data)))
			if iok && rerr == nil && tok do mapped[id] = to
			freed += f.size
		}
	}
	records := make([dynamic]Folded_Record, 0, len(mapped), context.temp_allocator)
	for id, to in mapped do append(&records, Folded_Record{id = id, rebased = to})
	n, aok := folded_add(object_id, records[:])
	if !aok do return 0, 0, false
	if os.remove_all(path) != nil do return n, 0, false
	return n, freed, true
}

/**
 * One-time, at serve start: the archive of full change bytes becomes the
 * folded index. Per object, every archived id no longer held in changes/
 * and every `.rebased` mapping is appended to folded/<objectId> (fsynced),
 * then archive/<objectId> is deleted. Idempotent and resumable: a crash
 * leaves directories still to fold, and folding an id twice is a no-op.
 */
migrate_archive :: proc() -> (objects: int, ids: int, freed: i64) {
	root := data_dir("archive", "")
	dir, derr := os.open(root)
	if derr != nil do return
	entries, eerr := os.read_dir(dir, -1, context.allocator)
	os.close(dir)
	if eerr != nil do return
	defer os.file_info_slice_delete(entries, context.allocator)
	fmt.printfln("[store] folding archive/ (%d entries) into folded/ - one-time", len(entries))
	failed := 0
	for e in entries {
		runtime.DEFAULT_TEMP_ALLOCATOR_TEMP_GUARD()
		if e.type != .Directory {
			os.remove(e.fullpath) // strays (.DS_Store): the whole archive goes
			continue
		}
		added, bytes, ok := migrate_archive_object(e.name, e.fullpath)
		ids += added
		if !ok {
			failed += 1
			fmt.eprintfln("[store] could not fold archive/%s - kept, retried next start", e.name)
			continue
		}
		objects += 1
		freed += bytes
	}
	os.remove(root) // succeeds once empty
	fmt.printfln("[store] archive/ folded: %d objects, %d ids, %.1f MB freed%s", objects, ids, f64(freed) / (1024 * 1024), failed > 0 ? fmt.tprintf(", %d objects left for next start", failed) : "")
	return
}
