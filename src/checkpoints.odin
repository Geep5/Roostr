package glon

// Checkpoints on disk: GLON_DATA/checkpoints/<objectId>.pb, one per object.
// See docs/checkpoint-sync.md.
//
//   GET  /api/checkpoints         → {objectId: {heads, checkpointHeads|null, checkpointHash, changes, covered}}
//   POST /api/checkpoints/build   → service-only {objectId} → {objectId, b64, hash, heads, covered}
//   POST /api/checkpoints         → service-only {checkpoints: [b64…], provenance?}
//
// The file is not content-addressed by name: the bytes are verified by
// decoding and by object_id matching the file name. A stored checkpoint is
// replaced only by one that covers more (then larger hash) - never by a
// newer created_at.

import "../core"
import "core:encoding/base64"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:sync"

checkpoints_root :: proc(allocator := context.temp_allocator) -> string {
	root, _ := filepath.join({g_store.data_root, "checkpoints"}, allocator)
	return root
}

checkpoint_path :: proc(object_id: string, allocator := context.temp_allocator) -> string {
	path, _ := filepath.join({checkpoints_root(allocator), strings.concatenate({object_id, ".pb"}, allocator)}, allocator)
	return path
}

object_id_safe :: proc(object_id: string) -> bool {
	return object_id != "" && !strings.contains(object_id, "/") && !strings.contains(object_id, "..") &&
		!strings.contains(object_id, "\\") && !strings.contains(object_id, "\x00")
}

/** Decoded checkpoint for `object_id`, or ok=false. Damage is loud, never silent. */
load_checkpoint :: proc(object_id: string, alloc := context.allocator) -> (cp: core.Checkpoint, ok: bool) {
	if !object_id_safe(object_id) do return {}, false
	path := checkpoint_path(object_id)
	data, rerr := os.read_entire_file(path, alloc)
	if rerr != nil do return {}, false
	cp, ok = core.decode_checkpoint(data, alloc)
	if !ok || cp.object_id != object_id {
		quarantine_checkpoint(path, object_id, ok ? "object id mismatch" : "undecodable")
		return {}, false
	}
	return cp, true
}

@(private = "file")
quarantine_checkpoint :: proc(path: string, object_id: string, reason: string) {
	root_dir, _ := filepath.join({checkpoints_root(), ".quarantine"}, context.temp_allocator)
	os.make_directory(root_dir)
	dest, _ := filepath.join({root_dir, filepath.base(path)}, context.temp_allocator)
	moved := os.rename(path, dest) == nil
	fmt.eprintfln("[store] %s checkpoint quarantined (%s)%s", reason, object_id, moved ? "" : " - COULD NOT MOVE, still in place")
}

/**
 * Persist `bytes` as the object's checkpoint when it beats the stored one.
 * Returns (stored, ok): stored=false with ok=true means the existing
 * checkpoint already covers at least as much.
 */
store_checkpoint :: proc(cp: ^core.Checkpoint, bytes: []byte) -> (stored: bool, ok: bool) {
	if !object_id_safe(cp.object_id) do return false, false
	path := checkpoint_path(cp.object_id)
	hash := core.checkpoint_hash(bytes, context.temp_allocator)
	if existing_bytes, rerr := os.read_entire_file(path, context.temp_allocator); rerr == nil {
		existing, eok := core.decode_checkpoint(existing_bytes, context.temp_allocator)
		if eok && existing.object_id == cp.object_id {
			if !core.checkpoint_supersedes(cp, hash, &existing, core.checkpoint_hash(existing_bytes, context.temp_allocator)) do return false, true
		}
	}
	os.make_directory(g_store.data_root)
	os.make_directory(checkpoints_root())
	if !write_file_durable(path, bytes) do return false, false
	store_mark_dirty(cp.object_id)
	return true, true
}

/** Remove an object's checkpoint file (vanish). */
purge_checkpoint :: proc(object_id: string) -> bool {
	if !object_id_safe(object_id) || object_id == VANISH_LOG_ID do return false
	return os.remove(checkpoint_path(object_id)) == nil
}

/** Object ids that have a checkpoint on disk. */
checkpointed_object_ids :: proc(allocator := context.temp_allocator) -> [dynamic]string {
	out := make([dynamic]string, allocator)
	dir, derr := os.open(checkpoints_root())
	if derr != nil do return out
	defer os.close(dir)
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	if ferr != nil do return out
	for f in files {
		if f.type == .Directory || !strings.has_suffix(f.name, ".pb") do continue
		append(&out, strings.clone(f.name[:len(f.name) - 3], allocator))
	}
	return out
}

/** Hex change ids folded into the stored checkpoint, empty when none. */
checkpoint_covered_hex :: proc(object_id: string, allocator := context.temp_allocator) -> map[string]bool {
	out := make(map[string]bool, allocator = allocator)
	cp, ok := load_checkpoint(object_id, context.temp_allocator)
	if !ok do return out
	for id in cp.covered_ids do out[string(hex.encode(id, allocator))] = true
	return out
}

// ── HTTP ─────────────────────────────────────────────────────────────

handle_checkpoints_list :: proc(sock: net.TCP_Socket) {
	Row :: struct {
		heads:   [dynamic]string,
		changes: int,
	}
	rows := make(map[string]Row, allocator = context.temp_allocator)
	vanished := vanished_ids()
	{
		sync.lock(&g_store.mu)
		defer sync.unlock(&g_store.mu)
		ensure_loaded()
		for id, state in g_store.states {
			if id in vanished do continue
			row: Row
			row.heads = make([dynamic]string, 0, len(state.heads), context.temp_allocator)
			for h in state.heads do append(&row.heads, strings.clone(h, context.temp_allocator))
			rows[strings.clone(id, context.temp_allocator)] = row
		}
	}
	// Change counts from disk: what a checkpoint would fold in.
	if dir, derr := os.open(g_store.root); derr == nil {
		defer os.close(dir)
		if entries, eerr := os.read_dir(dir, -1, context.temp_allocator); eerr == nil {
			for entry in entries {
				if entry.type != .Directory || strings.has_prefix(entry.name, ".") do continue
				row, present := &rows[entry.name]
				if !present do continue
				odir, oerr := os.open(entry.fullpath)
				if oerr != nil do continue
				files, ferr := os.read_dir(odir, -1, context.temp_allocator)
				os.close(odir)
				if ferr != nil do continue
				for f in files do if strings.has_suffix(f.name, ".pb") do row.changes += 1
			}
		}
	}

	out := core.jobj()
	for id, row in rows {
		o := core.jobj()
		heads := make([dynamic]json.Value, 0, len(row.heads), context.temp_allocator)
		for h in row.heads do append(&heads, json.String(h))
		o["heads"] = json.Array(heads)
		o["changes"] = json.Integer(i64(row.changes))
		cp_path := checkpoint_path(id)
		if cp_bytes, rerr := os.read_entire_file(cp_path, context.temp_allocator); rerr == nil {
			if cp, ok := core.decode_checkpoint(cp_bytes, context.temp_allocator); ok && cp.object_id == id {
				cp_heads := make([dynamic]json.Value, 0, len(cp.head_ids), context.temp_allocator)
				for h in cp.head_ids do append(&cp_heads, json.String(string(hex.encode(h, context.temp_allocator))))
				o["checkpointHeads"] = json.Array(cp_heads)
				o["checkpointHash"] = json.String(core.checkpoint_hash(cp_bytes, context.temp_allocator))
				o["covered"] = json.Integer(i64(len(cp.covered_ids)))
				out[id] = json.Object(o)
				continue
			}
		}
		o["checkpointHeads"] = json.Null{}
		o["checkpointHash"] = json.String("")
		o["covered"] = json.Integer(0)
		out[id] = json.Object(o)
	}
	respond_json(sock, json.Object(out))
}

/** Result of build_checkpoint; `error` is "" on success. */
Checkpoint_Build :: struct {
	checkpoint: core.Checkpoint,
	bytes:      []byte,
	heads:      [dynamic]string,
	error:  string,
	status: string,
}

/**
 * Build a checkpoint from this machine's full history of one object and
 * persist it (temp-allocated). Changes are decoded fresh rather than taken
 * from the cached state: covered_ids must be derived from what was actually
 * replayed. A stored prior checkpoint seeds the build only when
 * core.checkpoint_for_replay accepts it - the same gate compute_state applies
 * - so covered order stays the order a genesis replay would produce.
 */
build_checkpoint :: proc(object_id: string) -> Checkpoint_Build {
	if !object_id_safe(object_id) do return {error = "bad object id", status = "400 Bad Request"}
	if object_id in vanished_ids() do return {error = "object vanished", status = "410 Gone"}

	dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
	changes := make([dynamic]core.Change, context.temp_allocator)
	if dir, derr := os.open(dir_path); derr == nil {
		defer os.close(dir)
		if files, ferr := os.read_dir(dir, -1, context.temp_allocator); ferr == nil {
			for f in files {
				if !strings.has_suffix(f.name, ".pb") do continue
				data, rerr := os.read_entire_file(f.fullpath, context.temp_allocator)
				if rerr != nil do continue
				c, cok := core.decode_change(data, context.temp_allocator)
				if !cok || !change_matches_name(c, f.name) do continue
				append(&changes, c)
			}
		}
	}
	prior, has_prior := load_checkpoint(object_id, context.temp_allocator)
	seed: ^core.Checkpoint = has_prior ? core.checkpoint_for_replay(changes[:], &prior) : nil
	if len(changes) == 0 && seed == nil do return {error = "unknown object", status = "404 Not Found"}
	state, ok := core.compute_state(changes[:], context.temp_allocator, seed)
	if !ok do return {error = "object does not replay", status = "409 Conflict"}
	cp := core.checkpoint_build(&state, changes[:], unix_ms(), seed, context.temp_allocator)
	bytes := core.encode_checkpoint(cp, context.temp_allocator)
	stored, wok := store_checkpoint(&cp, bytes)
	if !wok do return {error = "cannot write checkpoint", status = "500 Internal Server Error"}
	if !stored {
		// The stored one covers as much: it is what peers hold, so publish it.
		if existing, rerr := os.read_entire_file(checkpoint_path(object_id), context.temp_allocator); rerr == nil {
			if ecp, eok := core.decode_checkpoint(existing, context.temp_allocator); eok do return {checkpoint = ecp, bytes = existing, heads = state.heads}
		}
	}
	return {checkpoint = cp, bytes = bytes, heads = state.heads}
}

handle_checkpoint_build :: proc(sock: net.TCP_Socket, body: []byte) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	built := build_checkpoint(core.json_str(parsed, "objectId"))
	if built.error != "" {
		respond_error(sock, built.error, built.status)
		return
	}
	out := core.jobj()
	out["objectId"] = json.String(built.checkpoint.object_id)
	out["b64"] = json.String(base64.encode(built.bytes, allocator = context.temp_allocator))
	out["hash"] = json.String(core.checkpoint_hash(built.bytes, context.temp_allocator))
	heads := make([dynamic]json.Value, 0, len(built.heads), context.temp_allocator)
	for h in built.heads do append(&heads, json.String(h))
	out["heads"] = json.Array(heads)
	out["covered"] = json.Integer(i64(len(built.checkpoint.covered_ids)))
	respond_json(sock, json.Object(out))
}

handle_checkpoints_import :: proc(sock: net.TCP_Socket, body: []byte) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	list, present := core.json_field(parsed, "checkpoints")
	arr, aok := list.(json.Array)
	if !present || !aok {
		respond_error(sock, "checkpoints array required")
		return
	}
	provenance, shared, valid_provenance := shared_provenance_parse(parsed)
	if !valid_provenance {
		respond_error(sock, "invalid shared provenance", "403 Forbidden")
		return
	}

	imported := 0
	skipped := 0
	rejected := 0
	dropped := 0
	vanished := vanished_ids()
	touched := make(map[string]bool, context.temp_allocator)
	// One row per accepted (stored or already-covered) checkpoint: the
	// harness has no codec, so heads and hash come back from here.
	items := make([dynamic]json.Value, context.temp_allocator)
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
		if !cok || !object_id_safe(cp.object_id) || cp.object_id == VANISH_LOG_ID {
			rejected += 1
			continue
		}
		if shared && !shared_checkpoint_allowed(&cp, provenance) {
			rejected += 1
			continue
		}
		if cp.object_id in vanished {
			dropped += 1
			continue
		}
		stored, wok := store_checkpoint(&cp, data)
		if !wok {
			rejected += 1
			continue
		}
		if stored {
			imported += 1
			touched[strings.clone(cp.object_id, context.temp_allocator)] = true
		} else {
			skipped += 1
		}
		row := core.jobj()
		row["objectId"] = json.String(cp.object_id)
		row["hash"] = json.String(core.checkpoint_hash(data, context.temp_allocator))
		row["covered"] = json.Integer(i64(len(cp.covered_ids)))
		row["stored"] = json.Boolean(stored)
		heads := make([dynamic]json.Value, 0, len(cp.head_ids), context.temp_allocator)
		for h in cp.head_ids do append(&heads, json.String(string(hex.encode(h, context.temp_allocator))))
		row["heads"] = json.Array(heads)
		append(&items, json.Object(row))
	}
	for object_id in touched do sse_broadcast(object_id)

	out := core.jobj()
	out["ok"] = json.Boolean(true)
	out["imported"] = json.Integer(i64(imported))
	out["skipped"] = json.Integer(i64(skipped))
	out["rejected"] = json.Integer(i64(rejected))
	out["dropped"] = json.Integer(i64(dropped))
	out["items"] = json.Array(items)
	respond_json(sock, json.Object(out))
}
