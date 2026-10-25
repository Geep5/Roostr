package glon

// State-sync bases on disk (docs/state-sync.md): GLON_DATA/bases/<objectId>/<hashhex>.pb,
// change sidecars (changes/<objectId>/<hex>.b = base hash hex the change was
// written on, <hex>.local = written here and not yet confirmed published) and
// the append-only local archive (archive/<objectId>/<hex>.pb, <hex>.rebased).
//
//   GET  /api/bases               → {objectId: {hash, epoch, createdAt, prevBase, bases, changes, live,
//                                    liveBytes, oldestMs, covered, premigrationCovered, orphan, stale,
//                                    pending, compact, reason}}
//   GET  /api/bases/<objectId>    → {objectId, current, bases: [{hash, epoch, createdAt, prevBase, current, b64}]}
//   POST /api/bases               → service-only {bases: [b64…], provenance?} → {ok, imported, skipped,
//                                    rejected, dropped, items: [{objectId, hash, epoch, prevBase, stored, current}]}
//   POST /api/bases/build         → service-only {objectId, force?} → compaction plan (+ the stored base);
//                                    409 when GLON_STATE_SYNC_COMPACT=0 (the supervisor's environment)
//   POST /api/bases/seal          → service-only {base, conversationKey, space?} → core seal_base output
//   POST /api/bases/rebase        → service-only {objectId, orphans?} → {objectId, base, changes: [{orphan, id, b64}]}
//   POST /api/bases/covered       → service-only {objectId, ids} → {premigration: [hex], covered: [hex]}
//   POST /api/changes/published   → service-only {published: {objectId: [hex]}} → {ok, cleared}
//
// A base file is valid only when it decodes, names its directory's object,
// has epoch >= 1 and its file name is the hex of its base_hash; anything else
// is parked under bases/.quarantine (loud). The archive is never published
// and never read for sync: it only keeps imports from resurrecting a change
// this computer already pruned or rebased.

import "../core"
import "core:encoding/base64"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:slice"
import "core:strings"
import "core:sync"

/** Ancestors of the current base kept through prev_base (plus siblings and epoch-1 bases). */
BASE_KEEP_ANCESTORS :: 3

/** Per-object summary cached alongside g_store.states (strings in the store arena). */
Base_Info :: struct {
	hash:                 string, // current base hex, "" when none
	epoch:                i64,
	created_at:           i64,
	prev_base:            string,
	bases:                int,
	changes:              int,
	live:                 int,
	live_bytes:           int,
	oldest_ms:            i64,
	covered:              int,
	premigration_covered: int,
	orphan:               int,
	stale:                int,
	pending:              int,
}

Held_Base :: struct {
	cp:    core.Checkpoint,
	bytes: []byte,
}

/** Everything this computer holds for one object, as the core takes it. */
Holdings :: struct {
	bases:   [dynamic]Held_Base,
	cps:     []core.Checkpoint, // parallel to bases
	deltas:  [dynamic]core.Delta,
	raw:     [dynamic][]byte, // file bytes, parallel to deltas
	pending: map[string]bool, // raw ids with a .local marker
	legacy:  ^core.Checkpoint,
}

data_dir :: proc(kind: string, object_id: string, allocator := context.temp_allocator) -> string {
	path, _ := filepath.join({g_store.data_root, kind, object_id}, allocator)
	return path
}

@(private = "file")
file_in :: proc(dir: string, name: string, suffix: string) -> string {
	path, _ := filepath.join({dir, strings.concatenate({name, suffix}, context.temp_allocator)}, context.temp_allocator)
	return path
}

base_path :: proc(object_id: string, hash_hex: string) -> string {
	return file_in(data_dir("bases", object_id), hash_hex, ".pb")
}

change_file :: proc(object_id: string, hex_id: string, suffix: string) -> string {
	return file_in(data_dir("changes", object_id), hex_id, suffix)
}

archive_file :: proc(object_id: string, hex_id: string, suffix: string) -> string {
	return file_in(data_dir("archive", object_id), hex_id, suffix)
}

@(private = "file")
make_data_dirs :: proc(kind: string, object_id: string) {
	os.make_directory(g_store.data_root)
	os.make_directory(data_dir(kind, ""))
	os.make_directory(data_dir(kind, object_id))
}

/** 64-char lowercase hex: the only form a `b` sidecar or base hash takes. */
hash_hex_valid :: proc(text: string) -> bool {
	return core.is_hex_pubkey(text) // same shape: 32 bytes, lowercase hex
}

@(private = "file")
hash_raw :: proc(text: string) -> (out: [32]byte, ok: bool) {
	if !hash_hex_valid(text) do return {}, false
	raw, hok := hex.decode(transmute([]byte)text, context.temp_allocator)
	if !hok || len(raw) != 32 do return {}, false
	copy(out[:], raw)
	return out, true
}

// ── Bases on disk ────────────────────────────────────────────────────

@(private = "file")
quarantine_base :: proc(path: string, object_id: string, reason: string) {
	root_dir := data_dir("bases", ".quarantine")
	dest_dir, _ := filepath.join({root_dir, object_id}, context.temp_allocator)
	os.make_directory(root_dir)
	os.make_directory(dest_dir)
	dest, _ := filepath.join({dest_dir, filepath.base(path)}, context.temp_allocator)
	moved := os.rename(path, dest) == nil
	fmt.eprintfln("[store] %s base quarantined (%s/%s)%s", reason, object_id, filepath.base(path), moved ? "" : " - COULD NOT MOVE, still in place")
}

/** Valid bases held for `object_id` (bytes and decode in `alloc`); damage is quarantined. */
load_bases :: proc(object_id: string, alloc := context.allocator) -> [dynamic]Held_Base {
	out := make([dynamic]Held_Base, alloc)
	if !object_id_safe(object_id) do return out
	dir, derr := os.open(data_dir("bases", object_id))
	if derr != nil do return out
	defer os.close(dir)
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	if ferr != nil do return out
	for f in files {
		if f.type == .Directory || !strings.has_suffix(f.name, ".pb") do continue
		data, rerr := os.read_entire_file(f.fullpath, alloc)
		if rerr != nil {
			quarantine_base(f.fullpath, object_id, "unreadable")
			continue
		}
		cp, ok := core.decode_checkpoint(data, alloc)
		reason := ""
		switch {
		case !ok: reason = "undecodable"
		case cp.object_id != object_id: reason = "object id mismatch"
		case cp.epoch < 1: reason = "epoch 0"
		case f.name[:len(f.name) - 3] != core.hex_id(cp.base_hash[:], context.temp_allocator): reason = "address mismatch"
		}
		if reason != "" {
			quarantine_base(f.fullpath, object_id, reason)
			continue
		}
		append(&out, Held_Base{cp = cp, bytes = data})
	}
	return out
}

held_checkpoints :: proc(held: []Held_Base, allocator := context.temp_allocator) -> []core.Checkpoint {
	cps := make([]core.Checkpoint, len(held), allocator)
	for h, i in held do cps[i] = h.cp
	return cps
}

/** Object ids with a bases/ directory. */
based_object_ids :: proc(allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	dir, derr := os.open(data_dir("bases", ""))
	if derr != nil do return out
	defer os.close(dir)
	entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
	if eerr != nil do return out
	for e in entries do if e.type == .Directory && !strings.has_prefix(e.name, ".") do append(&out, strings.clone(e.name, allocator))
	return out
}

/** Persist a base under its hash. stored=false with ok=true: already held. */
store_base :: proc(cp: ^core.Checkpoint, bytes: []byte) -> (stored: bool, ok: bool) {
	if !object_id_safe(cp.object_id) || cp.object_id == VANISH_LOG_ID || cp.epoch < 1 do return false, false
	path := base_path(cp.object_id, core.hex_id(cp.base_hash[:], context.temp_allocator))
	if os.exists(path) do return false, true
	make_data_dirs("bases", cp.object_id)
	if !write_file_durable(path, bytes) do return false, false
	store_mark_dirty(cp.object_id)
	return true, true
}

/** Hex of the current base held on disk for `object_id`, "" when none. */
disk_current_base :: proc(object_id: string) -> string {
	held := load_bases(object_id, context.temp_allocator)
	cps := held_checkpoints(held[:])
	cur := core.base_current(cps)
	return cur < 0 ? "" : core.hex_id(cps[cur].base_hash[:], context.temp_allocator)
}

/**
 * Retention then prune for one object: keep the current base, up to
 * BASE_KEEP_ANCESTORS ancestors reached through prev_base, every base of the
 * current epoch (siblings) and every epoch-1 base (the pre-migration sweep
 * reads its covered_ids); delete the rest. Then changes folded by a held
 * STRICT ancestor leave changes/ for the archive - never those folded only by
 * the current base, which a concurrent sibling could still lose to. Stale
 * changes go to the archive too: written on a base this device no longer
 * holds, they are never replayed nor rebased (core.base_classify), so the
 * object's state does not depend on them - left in changes/ they only pile
 * up (thousands on an object compacted often) and slow every load.
 */
retain_bases :: proc(object_id: string) -> (removed: int, pruned: int) {
	held := load_bases(object_id, context.temp_allocator)
	cps := held_checkpoints(held[:])
	cur := core.base_current(cps)
	if cur < 0 do return 0, 0
	keep := make(map[[32]byte]bool, allocator = context.temp_allocator)
	keep[cps[cur].base_hash] = true
	for b in cps do if b.epoch == cps[cur].epoch || b.epoch == 1 do keep[b.base_hash] = true
	ancestors := make([dynamic]int, context.temp_allocator)
	link := cur
	for _ in 0 ..< BASE_KEEP_ANCESTORS {
		l := &cps[link]
		if l.epoch <= 1 || len(l.prev_base) != 32 do break
		next := -1
		for &b, j in cps do if b.epoch == l.epoch - 1 && string(b.base_hash[:]) == string(l.prev_base) {
			next = j
			break
		}
		if next < 0 do break
		keep[cps[next].base_hash] = true
		append(&ancestors, next)
		link = next
	}
	for &b in cps {
		if b.base_hash in keep do continue
		if os.remove(base_path(object_id, core.hex_id(b.base_hash[:], context.temp_allocator))) == nil do removed += 1
	}
	for j in ancestors {
		for id in cps[j].covered_ids do if archive_change(object_id, core.hex_id(id, context.temp_allocator)) do pruned += 1
	}
	h := read_holdings(object_id, context.temp_allocator)
	cls := core.base_classify(h.cps, h.deltas[:], h.pending, context.temp_allocator)
	for class, i in cls.classes {
		if class != .Stale do continue
		if archive_change(object_id, core.hex_id(h.deltas[i].change.id, context.temp_allocator)) do pruned += 1
	}
	if removed + pruned > 0 do store_mark_dirty(object_id)
	return removed, pruned
}

// ── Change sidecars and the archive ─────────────────────────────────

/**
 * Write a change's markers ahead of its .pb: `.b` durably (its content is
 * the base hash), `.local` as an empty file whose name the .pb's directory
 * fsync makes durable.
 */
write_change_markers :: proc(object_id: string, hex_id: string, base_hex: string, local: bool) -> bool {
	make_data_dirs("changes", object_id)
	if base_hex != "" && !write_file_durable(change_file(object_id, hex_id, ".b"), transmute([]byte)base_hex) do return false
	if local && os.write_entire_file(change_file(object_id, hex_id, ".local"), nil) != nil do return false
	return true
}

/** Hard-link a change file into the archive (copy when linking fails). */
archive_link :: proc(object_id: string, hex_id: string, src: string) {
	dst := archive_file(object_id, hex_id, ".pb")
	if os.exists(dst) do return
	make_data_dirs("archive", object_id)
	if os.link(src, dst) == nil do return
	if os.copy_file(dst, src) != nil do fmt.eprintfln("[store] could not archive change %s/%s", object_id, hex_id)
}

/** Move a change out of changes/ into the archive (with its sidecars). False when it was not there. */
archive_change :: proc(object_id: string, hex_id: string) -> bool {
	src := change_file(object_id, hex_id, ".pb")
	if !os.exists(src) do return false
	dst := archive_file(object_id, hex_id, ".pb")
	if os.exists(dst) {
		os.remove(src)
	} else {
		make_data_dirs("archive", object_id)
		if os.rename(src, dst) != nil {
			if os.copy_file(dst, src) != nil {
				fmt.eprintfln("[store] could not archive change %s/%s - left in place", object_id, hex_id)
				return false
			}
			os.remove(src)
		}
	}
	os.remove(change_file(object_id, hex_id, ".b"))
	os.remove(change_file(object_id, hex_id, ".local"))
	return true
}

/**
 * Bases, working-set changes (with `b` from their sidecar), `.local`
 * markers and the legacy checkpoint of one object. Change bytes and bases
 * live in `alloc`; bookkeeping in the temp allocator. `quarantine` parks
 * damaged change files (the load path); other readers skip them.
 */
read_holdings :: proc(object_id: string, alloc := context.allocator, quarantine := false) -> Holdings {
	h: Holdings
	h.deltas = make([dynamic]core.Delta, context.temp_allocator)
	h.raw = make([dynamic][]byte, context.temp_allocator)
	h.pending = make(map[string]bool, allocator = context.temp_allocator)
	h.bases = load_bases(object_id, alloc)
	h.cps = held_checkpoints(h.bases[:])
	if cp, ok := load_checkpoint(object_id, alloc); ok do h.legacy = new_clone(cp, alloc)
	if !object_id_safe(object_id) do return h

	dir, derr := os.open(data_dir("changes", object_id))
	if derr != nil do return h
	defer os.close(dir)
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	if ferr != nil do return h
	tags := make(map[string][32]byte, allocator = context.temp_allocator)
	for f in files {
		switch {
		case strings.has_suffix(f.name, ".local"):
			if raw, ok := hash_raw(f.name[:len(f.name) - 6]); ok do h.pending[strings.clone(string(raw[:]), context.temp_allocator)] = true
		case strings.has_suffix(f.name, ".b"):
			data, rerr := os.read_entire_file(f.fullpath, context.temp_allocator)
			if rerr != nil do continue
			if raw, ok := hash_raw(strings.trim_space(string(data))); ok do tags[f.name[:len(f.name) - 2]] = raw
		}
	}
	for f in files {
		if !strings.has_suffix(f.name, ".pb") do continue
		// The filename IS the hash: a torn or foreign file is never replayed.
		data, rerr := os.read_entire_file(f.fullpath, alloc)
		if rerr != nil {
			if quarantine do quarantine_change(f.fullpath, object_id, "unreadable")
			continue
		}
		c, cok := core.decode_change(data, alloc)
		if !cok {
			if quarantine do quarantine_change(f.fullpath, object_id, "undecodable")
			continue
		}
		if !change_matches_name(c, f.name) {
			if quarantine do quarantine_change(f.fullpath, object_id, "address mismatch")
			continue
		}
		d := core.Delta{change = c}
		d.b, d.tagged = tags[f.name[:len(f.name) - 3]]
		append(&h.deltas, d)
		append(&h.raw, data)
	}
	return h
}

holdings_changes :: proc(h: ^Holdings) -> []core.Change {
	out := make([]core.Change, len(h.deltas), context.temp_allocator)
	for d, i in h.deltas do out[i] = d.change
	return out
}

/** Hex of the object's current base from the cache ("" when none). Takes the lock. */
current_base_hex :: proc(object_id: string) -> string {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	return strings.clone(g_store.bases[object_id].hash, context.temp_allocator)
}

/** Core thresholds, never "forced". */
base_compact_due :: proc(info: Base_Info, now_ms: i64) -> (bool, string) {
	switch {
	case info.live == 0: return false, ""
	case info.live >= core.COMPACT_MIN_DELTAS: return true, "deltas"
	case info.live_bytes >= core.COMPACT_MIN_BYTES: return true, "bytes"
	case now_ms - info.oldest_ms > core.COMPACT_MAX_AGE_MS: return true, "age"
	}
	return false, ""
}

// ── Operations (handlers are thin wrappers; tests call these) ────────

Op_Result :: struct {
	out:    json.Value,
	error:  string,
	status: string,
}

@(private = "file")
fail :: proc(message: string, status := "400 Bad Request") -> Op_Result {
	return {error = message, status = status}
}

@(private = "file")
base_row :: proc(cp: ^core.Checkpoint) -> map[string]json.Value {
	row := core.jobj()
	row["hash"] = json.String(core.hex_id(cp.base_hash[:], context.temp_allocator))
	row["epoch"] = json.Integer(cp.epoch)
	row["createdAt"] = json.Integer(cp.created_at)
	row["prevBase"] = json.String(core.hex_id(cp.prev_base, context.temp_allocator))
	return row
}

/** GET /api/bases: Base_Info of every non-vanished loaded object. */
bases_list :: proc() -> json.Value {
	vanished := vanished_ids()
	rows := make(map[string]Base_Info, allocator = context.temp_allocator)
	{
		sync.lock(&g_store.mu)
		defer sync.unlock(&g_store.mu)
		ensure_loaded()
		for id in g_store.states {
			if id in vanished do continue
			info := g_store.bases[id]
			info.hash = strings.clone(info.hash, context.temp_allocator)
			info.prev_base = strings.clone(info.prev_base, context.temp_allocator)
			rows[strings.clone(id, context.temp_allocator)] = info
		}
	}
	now := unix_ms()
	out := core.jobj()
	for id, info in rows {
		o := core.jobj()
		o["hash"] = json.String(info.hash)
		o["epoch"] = json.Integer(info.epoch)
		o["createdAt"] = json.Integer(info.created_at)
		o["prevBase"] = json.String(info.prev_base)
		o["bases"] = json.Integer(i64(info.bases))
		o["changes"] = json.Integer(i64(info.changes))
		o["live"] = json.Integer(i64(info.live))
		o["liveBytes"] = json.Integer(i64(info.live_bytes))
		o["oldestMs"] = json.Integer(info.oldest_ms)
		o["covered"] = json.Integer(i64(info.covered))
		o["premigrationCovered"] = json.Integer(i64(info.premigration_covered))
		o["orphan"] = json.Integer(i64(info.orphan))
		o["stale"] = json.Integer(i64(info.stale))
		o["pending"] = json.Integer(i64(info.pending))
		compact, reason := base_compact_due(info, now)
		o["compact"] = json.Boolean(compact)
		o["reason"] = json.String(reason)
		out[id] = json.Object(o)
	}
	return json.Object(out)
}

/** GET /api/bases/<objectId>: held bases, newest first. */
bases_get :: proc(object_id: string) -> Op_Result {
	if !object_id_safe(object_id) do return fail("bad object id")
	out := core.jobj()
	out["objectId"] = json.String(object_id)
	rows := make([dynamic]json.Value, context.temp_allocator)
	current := ""
	if object_id not_in vanished_ids() {
		held := load_bases(object_id, context.temp_allocator)
		slice.sort_by(held[:], proc(a, b: Held_Base) -> bool {
			a, b := a, b
			return core.base_newer(&a.cp, &b.cp)
		})
		if len(held) > 0 do current = core.hex_id(held[0].cp.base_hash[:], context.temp_allocator)
		for &h in held {
			row := base_row(&h.cp)
			row["current"] = json.Boolean(row["hash"].(json.String) == json.String(current))
			row["b64"] = json.String(base64.encode(h.bytes, allocator = context.temp_allocator))
			append(&rows, json.Object(row))
		}
	}
	out["current"] = json.String(current)
	out["bases"] = json.Array(rows)
	return {out = json.Object(out)}
}

/** Base counterpart of shared_checkpoint_allowed: owner-only, scope-checked. */
shared_base_allowed :: proc(cp: ^core.Checkpoint, p: Shared_Provenance) -> bool {
	space, valid := shared_space_resolve(p)
	if !valid do return false
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	ok, _ := core.authorize_shared_checkpoint(cp, p, space, g_store.states[p.space_id], g_store.states[cp.object_id], what = "base")
	return ok
}

/**
 * POST /api/bases. Mirrors the checkpoint import. `stored` = written by this
 * import and still held after retention (a base older than what retention
 * keeps is not kept); `imported` counts those, `skipped` the other accepted.
 */
bases_import :: proc(parsed: json.Value) -> Op_Result {
	list, present := core.json_field(parsed, "bases")
	arr, aok := list.(json.Array)
	if !present || !aok do return fail("bases array required")
	provenance, shared, valid_provenance := shared_provenance_parse(parsed)
	if !valid_provenance do return fail("invalid shared provenance", "403 Forbidden")

	rejected, dropped := 0, 0
	vanished := vanished_ids()
	touched := make(map[string]bool, allocator = context.temp_allocator)
	Accepted :: struct {
		cp:      core.Checkpoint,
		written: bool,
	}
	accepted := make([dynamic]Accepted, context.temp_allocator)
	for item in arr {
		s, sok := item.(json.String)
		if !sok {
			rejected += 1
			continue
		}
		data, derr := base64.decode(string(s), allocator = context.temp_allocator)
		if derr != nil {
			rejected += 1
			continue
		}
		cp, cok := core.decode_checkpoint(data, context.temp_allocator)
		if !cok || cp.epoch < 1 || !object_id_safe(cp.object_id) || cp.object_id == VANISH_LOG_ID {
			rejected += 1
			continue
		}
		if shared && !shared_base_allowed(&cp, provenance) {
			rejected += 1
			continue
		}
		// A base is a whole state: the space rule reads its channel.
		if entry, gone := core.object_vanished(vanished, cp.object_id, core.field_string(cp.state.fields, "channel")); gone {
			if cp.object_id not_in vanished {
				object_id := strings.clone(cp.object_id, context.temp_allocator)
				vanished[object_id] = entry
				sync.lock(&g_store.mu)
				note_space_vanished_locked(object_id, entry)
				sync.unlock(&g_store.mu)
			}
			dropped += 1
			continue
		}
		stored, wok := store_base(&cp, data)
		if !wok {
			rejected += 1
			continue
		}
		if stored do touched[strings.clone(cp.object_id, context.temp_allocator)] = true
		append(&accepted, Accepted{cp = cp, written = stored})
	}
	for object_id in touched do retain_bases(object_id)

	// Rows describe the store after the whole import, not mid-batch.
	imported := 0
	currents := make(map[string]string, allocator = context.temp_allocator)
	items := make([dynamic]json.Value, 0, len(accepted), context.temp_allocator)
	for &a in accepted {
		hash := core.hex_id(a.cp.base_hash[:], context.temp_allocator)
		current, known := currents[a.cp.object_id]
		if !known {
			current = disk_current_base(a.cp.object_id)
			currents[a.cp.object_id] = current
		}
		stored := a.written && os.exists(base_path(a.cp.object_id, hash))
		if stored do imported += 1
		row := base_row(&a.cp)
		row["objectId"] = json.String(a.cp.object_id)
		row["stored"] = json.Boolean(stored)
		row["current"] = json.Boolean(hash == current)
		append(&items, json.Object(row))
	}
	for object_id in touched do sse_broadcast(object_id)

	out := core.jobj()
	out["ok"] = json.Boolean(true)
	out["imported"] = json.Integer(i64(imported))
	out["skipped"] = json.Integer(i64(len(accepted) - imported))
	out["rejected"] = json.Integer(i64(rejected))
	out["dropped"] = json.Integer(i64(dropped))
	out["items"] = json.Array(items)
	return {out = json.Object(out)}
}

/**
 * POST /api/bases/build: core compaction planner over what is held. The
 * vanish ledger is never compacted (no daemon imports its base, so folding
 * its deltas would lose it): it answers 400 like a bad id. Refused (409)
 * when compaction is off here (GLON_STATE_SYNC_COMPACT=0, the environment
 * the supervisor gives the daemon and sync alike): a base built where sync
 * never publishes it would hold the changes it folded only locally.
 */
bases_build :: proc(parsed: json.Value) -> Op_Result {
	if os.get_env_alloc("GLON_STATE_SYNC_COMPACT", context.temp_allocator) == "0" do return fail("compaction is off on this computer", "409 Conflict")
	object_id := core.json_str(parsed, "objectId")
	force, _ := core.json_bool(parsed, "force")
	if !object_id_safe(object_id) || object_id == VANISH_LOG_ID do return fail("bad object id")
	if object_id in vanished_ids() do return fail("object vanished", "410 Gone")
	h := read_holdings(object_id, context.temp_allocator)
	if len(h.deltas) == 0 && len(h.cps) == 0 && h.legacy == nil do return fail("unknown object", "404 Not Found")
	// With nothing to start from, an epoch-1 base must fold the whole history.
	if len(h.cps) == 0 && h.legacy == nil && !core.dag_closed(holdings_changes(&h)) do return fail("history incomplete", "409 Conflict")
	plan, ok := core.base_compact_plan(h.cps, h.deltas[:], h.pending, h.legacy, unix_ms(), force, context.temp_allocator)
	if !ok do return fail("object does not replay", "409 Conflict")
	if plan.compact {
		if _, wok := store_base(&plan.base, plan.bytes); !wok do return fail("cannot write base", "500 Internal Server Error")
		retain_bases(object_id)
		sse_broadcast(object_id)
	}
	out := core.jobj()
	out["objectId"] = json.String(object_id)
	out["compact"] = json.Boolean(plan.compact)
	out["reason"] = json.String(plan.reason)
	out["live"] = json.Integer(i64(plan.live))
	out["liveBytes"] = json.Integer(i64(plan.live_bytes))
	out["oldestMs"] = json.Integer(plan.oldest_ms)
	out["orphans"] = json.Integer(i64(plan.orphans))
	out["stale"] = json.Integer(i64(plan.stale))
	if plan.compact {
		out["b64"] = json.String(base64.encode(plan.bytes, allocator = context.temp_allocator))
		out["hash"] = json.String(core.hex_id(plan.base.base_hash[:], context.temp_allocator))
		out["epoch"] = json.Integer(plan.base.epoch)
		out["prevBase"] = json.String(core.hex_id(plan.base.prev_base, context.temp_allocator))
		folded := make([dynamic]json.Value, 0, len(plan.base.covered_ids), context.temp_allocator)
		for id in plan.base.covered_ids do append(&folded, json.String(core.hex_id(id, context.temp_allocator)))
		out["folded"] = json.Array(folded)
	}
	return {out = json.Object(out)}
}

/** POST /api/bases/seal: core seal_base; personal bases are sealed with nostr.json's key. */
bases_seal :: proc(parsed: json.Value) -> Op_Result {
	payload, ok := parsed.(json.Object)
	if !ok do return fail("bad json")
	if _, space := payload["space"]; !space {
		sync.lock(&g_nostr_mu)
		identity := nostr_read()
		sync.unlock(&g_nostr_mu)
		if len(identity.privkey_hex) != 64 do return fail("no nostr key", "409 Conflict")
		payload["secret"] = json.String(identity.privkey_hex)
	}
	out, err := core.wire_seal_base(json.Object(payload))
	if err != "" do return fail(err)
	return {out = out}
}

/**
 * POST /api/bases/rebase: core rebase of the object's orphans (pending from
 * .local). Each rebased change is written durably with `.b` = the base and
 * `.local`, and linked into the archive; each orphan gets its `.rebased`
 * marker and leaves changes/. A rebased change already held (another device
 * published the same deterministic rebase) is left unmarked as pending.
 */
bases_rebase :: proc(parsed: json.Value) -> Op_Result {
	object_id := core.json_str(parsed, "objectId")
	if !object_id_safe(object_id) || object_id == VANISH_LOG_ID do return fail("bad object id")
	if object_id in vanished_ids() do return fail("object vanished", "410 Gone")
	only := make(map[string]bool, allocator = context.temp_allocator)
	for item in core.json_array(parsed, "orphans") {
		text, _ := item.(json.String)
		raw, ok := hash_raw(string(text))
		if !ok do return fail("orphans entries are 32-byte hex change ids")
		only[strings.clone(string(raw[:]), context.temp_allocator)] = true
	}
	h := read_holdings(object_id, context.temp_allocator)
	cls := core.base_classify(h.cps, h.deltas[:], h.pending, context.temp_allocator)
	if cls.current < 0 do return fail("rebase needs a base", "409 Conflict")
	base := &h.cps[cls.current]
	base_hex := core.hex_id(base.base_hash[:], context.temp_allocator)
	items := make([dynamic]json.Value, context.temp_allocator)
	rebased := core.base_rebase(base, h.deltas[:], cls, only, context.temp_allocator)
	for r in rebased {
		bytes := core.encode_change(r.change, false, context.temp_allocator)
		id_hex := core.hex_id(r.change.id, context.temp_allocator)
		orphan_hex := core.hex_id(r.orphan, context.temp_allocator)
		path := change_file(object_id, id_hex, ".pb")
		if !os.exists(path) {
			if !write_change_markers(object_id, id_hex, base_hex, true) || !write_file_durable(path, bytes) {
				store_mark_dirty(object_id)
				return fail("cannot write rebased change", "500 Internal Server Error")
			}
		} else if !os.exists(change_file(object_id, id_hex, ".b")) {
			write_change_markers(object_id, id_hex, base_hex, false)
		}
		archive_link(object_id, id_hex, path)
		make_data_dirs("archive", object_id)
		if !write_file_durable(archive_file(object_id, orphan_hex, ".rebased"), transmute([]byte)id_hex) {
			fmt.eprintfln("[store] could not mark %s/%s rebased", object_id, orphan_hex)
		}
		archive_change(object_id, orphan_hex)
		item := core.jobj()
		item["orphan"] = json.String(orphan_hex)
		item["id"] = json.String(id_hex)
		item["b64"] = json.String(base64.encode(bytes, allocator = context.temp_allocator))
		append(&items, json.Object(item))
	}
	if len(rebased) > 0 {
		store_mark_dirty(object_id)
		sse_broadcast(object_id)
	}
	out := core.jobj()
	out["objectId"] = json.String(object_id)
	out["base"] = json.String(base_hex)
	out["changes"] = json.Array(items)
	return {out = json.Object(out)}
}

/**
 * POST /api/bases/covered: which of `ids` held bases folded. premigration:
 * in covered_ids of a held epoch-1 base; covered: in covered_ids of any held
 * base. Input order kept.
 */
bases_covered :: proc(parsed: json.Value) -> Op_Result {
	object_id := core.json_str(parsed, "objectId")
	if !object_id_safe(object_id) do return fail("bad object id")
	ids, present := core.json_field(parsed, "ids")
	arr, aok := ids.(json.Array)
	if !present || !aok do return fail("ids array required")
	first := make(map[string]bool, allocator = context.temp_allocator)
	folded := make(map[string]bool, allocator = context.temp_allocator)
	held := load_bases(object_id, context.temp_allocator)
	for &h in held {
		for id in h.cp.covered_ids {
			key := core.hex_id(id, context.temp_allocator)
			folded[key] = true
			if h.cp.epoch == 1 do first[key] = true
		}
	}
	premigration := make([dynamic]json.Value, context.temp_allocator)
	covered := make([dynamic]json.Value, context.temp_allocator)
	for item in arr {
		text, _ := item.(json.String)
		if !hash_hex_valid(string(text)) do return fail("ids entries are 32-byte hex change ids")
		if string(text) in first do append(&premigration, item)
		if string(text) in folded do append(&covered, item)
	}
	out := core.jobj()
	out["premigration"] = json.Array(premigration)
	out["covered"] = json.Array(covered)
	return {out = json.Object(out)}
}

/** POST /api/changes/published: the listed changes are on the relays - drop their `.local` markers. */
changes_published :: proc(parsed: json.Value) -> Op_Result {
	published, present := core.json_field(parsed, "published")
	objects, ook := published.(json.Object)
	if !present || !ook do return fail("published object required")
	cleared := 0
	for object_id, list in objects {
		if !object_id_safe(object_id) do continue
		arr, aok := list.(json.Array)
		if !aok do continue
		touched := false
		for item in arr {
			text, _ := item.(json.String)
			if !hash_hex_valid(string(text)) do continue
			if os.remove(change_file(object_id, string(text), ".local")) == nil {
				cleared += 1
				touched = true
			}
		}
		if touched do store_mark_dirty(object_id)
	}
	out := core.jobj()
	out["ok"] = json.Boolean(true)
	out["cleared"] = json.Integer(i64(cleared))
	return {out = json.Object(out)}
}

// ── HTTP ─────────────────────────────────────────────────────────────

@(private = "file")
respond_op :: proc(sock: net.TCP_Socket, result: Op_Result) {
	if result.error != "" {
		respond_error(sock, result.error, result.status)
		return
	}
	respond_json(sock, result.out)
}

@(private = "file")
respond_body_op :: proc(sock: net.TCP_Socket, body: []byte, op: proc(parsed: json.Value) -> Op_Result) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	respond_op(sock, op(parsed))
}

handle_bases_list :: proc(sock: net.TCP_Socket) {respond_json(sock, bases_list())}
handle_bases_get :: proc(sock: net.TCP_Socket, object_id: string) {respond_op(sock, bases_get(object_id))}
handle_bases_import :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, bases_import)}
handle_bases_build :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, bases_build)}
handle_bases_seal :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, bases_seal)}
handle_bases_rebase :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, bases_rebase)}
handle_bases_covered :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, bases_covered)}
handle_changes_published :: proc(sock: net.TCP_Socket, body: []byte) {respond_body_op(sock, body, changes_published)}
