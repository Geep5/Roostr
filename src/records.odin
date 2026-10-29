package glon

// Record store mode (docs/state-objects.md "Record mode"), on with
// GLON_RECORDS=1 and off by default. The store keeps one state record per
// object instead of replaying its DAG:
//
//   <data>/records/<bucket hex>/<objectId>.pb   canonical Record bytes
//   <data>/journal/<stamp hex>-<objectId>.pb    one Patch per local write, until sent
//   <data>/hlc                                  the hybrid clock's last stamp time
//   <data>/devices.json                         author / device key -> stamp device index
//   <data>/records/.converted                   conversion from the DAG is done
//
// Every mutation still plans a core.Change; commit_change turns it into a
// Patch of the entries it wrote (core.record_patch_for_change), merges it into
// the record and writes journal entry, clock and record, each atomically.
// Reads are record views. The first start converts every object from its
// DAG once (record_convert_object, shared with the vault dry run); the DAG
// files are never touched. The old sync routes refuse (records_sync_refused);
// records sync through /api/records/* (records_sync.odin), which the
// harness's recordsync.ts drives: journal out, patches and packs in.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:slice"
import "core:strconv"
import "core:sync"
import "core:strings"
import "core:mem/virtual"
import "../core"

RECORDS_CONVERTED_MARKER :: ".converted"

/** Record-mode state beside g_store; guarded by g_store.mu. */
Records_State :: struct {
	opened:  bool,
	hlc:     core.Hlc,
	devices: map[string]u32, // heap; keys cloned
	local:   u32, // this device's index (key: device_id())
}

g_records: Records_State

records_env :: proc() -> bool {
	return os.get_env("GLON_RECORDS", context.temp_allocator) == "1"
}

/** Forget the previous data root's record state (store_init). */
records_reset :: proc() {
	for k in g_records.devices do delete(k)
	delete(g_records.devices)
	g_records = {}
}

records_root :: proc() -> string {
	path, _ := filepath.join({g_store.data_root, "records"}, context.temp_allocator)
	return path
}

journal_root :: proc() -> string {
	path, _ := filepath.join({g_store.data_root, "journal"}, context.temp_allocator)
	return path
}

record_path :: proc(object_id: string) -> string {
	shard := fmt.tprintf("%02x", core.record_bucket(object_id))
	name := strings.concatenate({object_id, ".pb"}, context.temp_allocator)
	path, _ := filepath.join({records_root(), shard, name}, context.temp_allocator)
	return path
}

@(private = "file")
data_file :: proc(name: string) -> string {
	path, _ := filepath.join({g_store.data_root, name}, context.temp_allocator)
	return path
}

// ── Device table and clock ──────────────────────────────────────────

@(private = "file")
devices_load :: proc() {
	g_records.devices = make(map[string]u32)
	data, err := os.read_entire_file(data_file("devices.json"), context.temp_allocator)
	if err != nil do return
	parsed, perr := json.parse(data, parse_integers = true, allocator = context.temp_allocator)
	obj, ok := parsed.(json.Object)
	if perr != nil || !ok {
		fmt.eprintfln("[records] devices.json unreadable; starting an empty device table")
		return
	}
	for key, value in obj {
		if n, is_int := value.(json.Integer); is_int && n > 0 do g_records.devices[strings.clone(key)] = u32(n)
	}
}

@(private = "file")
devices_save :: proc() -> bool {
	obj := core.jobj()
	for key, index in g_records.devices do obj[key] = json.Integer(i64(index))
	out, err := json.marshal(json.Object(obj), json.Marshal_Options{pretty = true, sort_maps_by_key = true}, context.temp_allocator)
	if err != nil do return false
	return write_file_durable(data_file("devices.json"), out)
}

/** The index of `key`, assigned (len + 1, as record_devices_assign) when new. */
@(private = "file")
device_index :: proc(key: string) -> u32 {
	if index, ok := g_records.devices[key]; ok do return index
	index := u32(len(g_records.devices)) + 1
	g_records.devices[strings.clone(key)] = index
	return index
}

@(private = "file")
hlc_load :: proc() {
	data, err := os.read_entire_file(data_file("hlc"), context.temp_allocator)
	if err != nil do return
	if v, ok := strconv.parse_u64(strings.trim_space(string(data))); ok do g_records.hlc.last = max(g_records.hlc.last, v)
}

hlc_save :: proc() -> bool {
	return write_file_durable(data_file("hlc"), transmute([]byte)fmt.tprintf("%d\n", g_records.hlc.last))
}

/** Local data is trusted: the clock moves past every stamp held, future ones included. */
hlc_observe_record :: proc(r: core.Record) {
	see :: proc(e: core.Record_Entry) {
		if e.key != "" && e.stamp.time > g_records.hlc.last do g_records.hlc.last = e.stamp.time
	}
	see(r.type)
	see(r.deleted)
	for list in ([][dynamic]core.Record_Entry{r.fields, r.blocks, r.messages}) do for e in list do see(e)
}

// ── Disk ────────────────────────────────────────────────────────────

record_read :: proc(path: string, object_id: string, alloc := context.allocator) -> (core.Record, bool) {
	data, err := os.read_entire_file(path, alloc)
	if err != nil do return {}, false
	r, ok := core.record_decode(data, alloc)
	return r, ok && (object_id == "" || r.object_id == object_id)
}

@(private = "file")
record_quarantine :: proc(path: string, reason: string) {
	dir, _ := filepath.join({records_root(), ".quarantine"}, context.temp_allocator)
	os.make_directory(dir)
	dest, _ := filepath.join({dir, filepath.base(path)}, context.temp_allocator)
	moved := os.rename(path, dest) == nil
	g_store.quarantined += 1
	fmt.eprintfln("[records] %s record quarantined (%s)%s", reason, filepath.base(path), moved ? "" : " - COULD NOT MOVE, still in place")
}

record_write :: proc(r: core.Record) -> bool {
	path := record_path(r.object_id)
	os.make_directory(records_root())
	os.make_directory(os.dir(path))
	return write_file_durable(path, core.record_encode(r, context.temp_allocator))
}

/** Load one record into g_store.records / states. Caller holds the lock. */
records_load_one :: proc(object_id: string, alloc := context.allocator) {
	if !object_id_safe(object_id) do return
	path := record_path(object_id)
	if !os.exists(path) do return
	r, ok := record_read(path, object_id, alloc)
	if !ok {
		record_quarantine(path, "undecodable")
		return
	}
	hlc_observe_record(r)
	sp := new(core.Object_State, alloc)
	sp^ = core.record_view(r, alloc)
	g_store.records[r.object_id] = r
	g_store.states[r.object_id] = sp
}

/** Every record on disk. Caller holds the lock. */
records_load_all :: proc(alloc := context.allocator) {
	root, rerr := os.open(records_root())
	if rerr != nil do return
	shards, serr := os.read_dir(root, -1, context.temp_allocator)
	os.close(root)
	if serr != nil do return
	for shard in shards {
		if shard.type != .Directory || strings.has_prefix(shard.name, ".") do continue
		dir, derr := os.open(shard.fullpath)
		if derr != nil do continue
		files, ferr := os.read_dir(dir, -1, context.temp_allocator)
		os.close(dir)
		if ferr != nil do continue
		for f in files {
			if !strings.has_suffix(f.name, ".pb") do continue
			records_load_one(f.name[:len(f.name) - len(".pb")], alloc)
		}
	}
}

/**
 * Remove a vanished object's record and its unsent patches (the ledger's
 * own patch carries the vanish); its DAG files stay.
 */
records_purge :: proc(object_id: string) -> int {
	if !object_id_safe(object_id) do return 0
	removed := os.remove(record_path(object_id)) == nil ? 1 : 0
	suffix := strings.concatenate({"-", object_id, ".pb"}, context.temp_allocator)
	if dir, err := os.open(journal_root()); err == nil {
		files, ferr := os.read_dir(dir, -1, context.temp_allocator)
		os.close(dir)
		if ferr == nil {
			for f in files do if strings.has_suffix(f.name, suffix) && os.remove(f.fullpath) == nil do removed += 1
		}
	}
	return removed
}

// ── Journal ─────────────────────────────────────────────────────────

Journal_Item :: struct {
	name:  string,
	patch: core.Patch,
}

/** Unsent patches in write order (names sort by stamp). */
records_journal_list :: proc(allocator := context.temp_allocator) -> [dynamic]Journal_Item {
	out := make([dynamic]Journal_Item, allocator)
	dir, derr := os.open(journal_root())
	if derr != nil do return out
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	os.close(dir)
	if ferr != nil do return out
	slice.sort_by(files, proc(a, b: os.File_Info) -> bool {return a.name < b.name})
	for f in files {
		if !strings.has_suffix(f.name, ".pb") do continue
		data, err := os.read_entire_file(f.fullpath, allocator)
		if err != nil do continue
		p, ok := core.patch_decode(data, allocator)
		if !ok {
			fmt.eprintfln("[records] journal entry %s undecodable; left in place", f.name)
			continue
		}
		append(&out, Journal_Item{name = strings.clone(f.name, allocator), patch = p})
	}
	return out
}

/**
 * A crash between a journal write and its record write leaves the patch
 * only in the journal: merge every journal patch into its record (merging
 * is idempotent) and rewrite the records it changes. Runs once per open.
 */
@(private = "file")
journal_recover :: proc() {
	pending := make(map[string][dynamic]core.Patch, allocator = context.temp_allocator)
	for item in records_journal_list() {
		p := item.patch
		for e in p.entries do if e.stamp.time > g_records.hlc.last do g_records.hlc.last = e.stamp.time
		list := pending[p.object_id] or_else make([dynamic]core.Patch, context.temp_allocator)
		append(&list, p)
		pending[p.object_id] = list
	}
	for object_id, patches in pending {
		current, has := record_read(record_path(object_id), object_id, context.temp_allocator)
		if !has do current = core.Record{object_id = object_id}
		merged := current
		for p in patches do merged = core.record_apply_patch(merged, p, context.temp_allocator) or_else merged
		if has && core.record_hash(merged) == core.record_hash(current) do continue
		if record_write(merged) do fmt.eprintfln("[records] recovered %s from the journal", object_id)
	}
}

// ── Open and convert ────────────────────────────────────────────────

/**
 * Convert every object held as a DAG into a record, once. Objects that
 * fail to convert are listed in the marker and the log (they fail the DAG
 * load as well, so neither mode shows them).
 */
@(private = "file")
records_convert_all :: proc() {
	scratch: virtual.Arena
	if virtual.arena_init_growing(&scratch) != nil {
		fmt.eprintfln("[records] conversion: no memory")
		return
	}
	defer virtual.arena_destroy(&scratch)
	ids := make(map[string]bool, allocator = context.temp_allocator)
	if dir, derr := os.open(g_store.root); derr == nil {
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		os.close(dir)
		if eerr == nil {
			for e in entries do if e.type == .Directory && !strings.has_prefix(e.name, ".") do ids[e.name] = true
		}
	}
	for id in checkpointed_object_ids() do ids[id] = true
	for id in based_object_ids() do ids[id] = true
	sorted := make([dynamic]string, 0, len(ids), context.temp_allocator)
	for id in ids do append(&sorted, id)
	slice.sort(sorted[:])

	converted := 0
	failed := make([dynamic]json.Value, context.temp_allocator)
	{
		outer_temp := context.temp_allocator
		context.temp_allocator = virtual.arena_allocator(&scratch)
		for id in sorted {
			mark := virtual.arena_temp_begin(&scratch)
			r, err := record_convert_object(id, &g_records.devices, context.temp_allocator)
			switch {
			case err == "nothing held":
			case err != "":
				fmt.eprintfln("[records] %s not converted: %s", id, err)
				append(&failed, json.String(strings.clone(id, outer_temp)))
			case:
				hlc_observe_record(r)
				if record_write(r) {
					converted += 1
				} else {
					fmt.eprintfln("[records] %s: cannot write record", id)
					append(&failed, json.String(strings.clone(id, outer_temp)))
				}
			}
			virtual.arena_temp_end(mark)
		}
	}
	devices_save()
	hlc_save()
	marker := core.jobj()
	marker["at"] = json.Integer(unix_ms())
	marker["converted"] = json.Integer(i64(converted))
	marker["failed"] = json.Array(failed)
	out, _ := json.marshal(json.Object(marker), allocator = context.temp_allocator)
	marker_path, _ := filepath.join({records_root(), RECORDS_CONVERTED_MARKER}, context.temp_allocator)
	if !write_file_durable(marker_path, out) do fmt.eprintfln("[records] cannot write %s", marker_path)
	fmt.eprintfln("[records] converted %d object(s) from the DAG, %d failed", converted, len(failed))
}

records_converted :: proc() -> bool {
	path, _ := filepath.join({records_root(), RECORDS_CONVERTED_MARKER}, context.temp_allocator)
	return os.exists(path)
}

/** Device table, clock, first conversion, journal recovery. Caller holds the lock. */
records_open :: proc() {
	if g_records.opened do return
	g_records.opened = true
	os.make_directory(g_store.data_root)
	os.make_directory(records_root())
	os.make_directory(journal_root())
	devices_load()
	hlc_load()
	if !records_converted() do records_convert_all()
	before := len(g_records.devices)
	g_records.local = device_index(device_id())
	if len(g_records.devices) != before && !devices_save() do fmt.eprintfln("[records] cannot write devices.json")
	journal_recover()
}

// ── Commit ──────────────────────────────────────────────────────────

/**
 * commit_change in record mode: the change's patch (stamped now on this
 * device) goes to the journal, then the clock, then the merged record -
 * each written atomically; a crash between journal and record is repaired
 * by journal_recover. Returns the change's content address, as DAG mode.
 */
records_commit_change :: proc(c: ^core.Change) -> (string, bool) {
	hashed := core.encode_change(c^, for_hashing = true, allocator = context.temp_allocator)
	digest := core.sha256(hashed)
	c.id = make([]byte, 32, context.temp_allocator)
	copy(c.id, digest[:])
	hex_str := core.hex_id(c.id, context.temp_allocator)
	if !object_id_safe(c.object_id) do return "", false

	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	current, has := g_store.records[c.object_id]
	wall := c.timestamp > 0 ? c.timestamp : unix_ms()
	stamp := core.Stamp{time = core.hlc_now(&g_records.hlc, wall), device = g_records.local}
	p, ok := core.record_patch_for_change(has ? &current : nil, c, stamp)
	if !ok do return "", false
	if len(p.entries) == 0 do return strings.clone(hex_str), true
	start := current
	if !has do start = core.Record{object_id = c.object_id}
	merged, mok := core.record_apply_patch(start, p, context.temp_allocator)
	if !mok do return "", false

	name := fmt.tprintf("%016x-%s.pb", stamp.time, c.object_id)
	journal, _ := filepath.join({journal_root(), name}, context.temp_allocator)
	os.make_directory(journal_root())
	if !write_file_durable(journal, core.patch_encode(p, context.temp_allocator)) do return "", false
	if !hlc_save() do return "", false
	if !record_write(merged) do return "", false
	if g_store.dirty == nil do g_store.dirty = make(map[string]bool)
	if c.object_id not_in g_store.dirty do g_store.dirty[strings.clone(c.object_id)] = true
	return strings.clone(hex_str), true
}

// ── Offline only ────────────────────────────────────────────────────

/** Record mode does not speak the old sync protocol (changes, bases, checkpoints, digest). */
records_sync_refused :: proc(path: string) -> bool {
	if !g_store.record_mode do return false
	for prefix in ([]string{"/api/changes", "/api/bases", "/api/checkpoints", "/api/sync/"}) {
		if strings.has_prefix(path, prefix) do return true
	}
	return false
}

/** `glon-odin journal`: one line per unsent patch, in write order. */
cli_journal :: proc() {
	if !g_store.record_mode {
		fmt.eprintln("journal: record mode only (GLON_RECORDS=1)")
		os.exit(1)
	}
	with_states(proc(_: map[string]^core.Object_State, _: rawptr) {}) // opens (on first start: converts) the records
	for item in records_journal_list() {
		fmt.printfln("%s %s entries=%d", item.name, item.patch.object_id, len(item.patch.entries))
	}
}
