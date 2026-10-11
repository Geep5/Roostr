package glon

import "../core"

// Change export/import — the wire surface the nostr sync daemon rides.
//
//   GET  /api/changes              → {objectId: [hexIds]} manifest
//   GET  /api/changes/<objectId>   → {changes: [{id, b64, b?, pending?, class?}]}
//   POST /api/changes              → service-only {changes: [b64 | {b64, b?}…],
//                                    provenance?: {spaceId,keyId,signer}};
//                                    shared imports verify installed authority
//                                    before content-addressed writes. Omitting
//                                    provenance is the trusted personal path.
//                                    `b` writes the .b sidecar; a change held
//                                    only in archive/ is skipped, never revived.
//
// Import bypasses commit_change on purpose: these changes already carry
// their identity (id = sha256(encode with id zeroed)); recomputing parents
// or timestamps would forge history.

import "core:encoding/base64"
import "core:encoding/hex"
import "core:encoding/json"
import "core:net"
import "core:os"
import "core:strings"
import "core:slice"
import "core:sync"

handle_changes_manifest :: proc(sock: net.TCP_Socket) {
	out := core.jobj()
	// Vanished objects are never offered for publication, even if a stray
	// directory is still on disk waiting for the next compaction to reclaim it.
	vanished := vanished_ids()
	dir, derr := os.open(g_store.root)
	if derr == nil {
		defer os.close(dir)
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		if eerr == nil {
			for entry in entries {
				if entry.type != .Directory || strings.has_prefix(entry.name, ".") do continue
				if entry.name in vanished do continue
				ids := make([dynamic]json.Value, context.temp_allocator)
				odir, oerr := os.open(entry.fullpath)
				if oerr != nil do continue
				files, ferr := os.read_dir(odir, -1, context.temp_allocator)
				os.close(odir)
				if ferr != nil do continue
				for f in files {
					if !strings.has_suffix(f.name, ".pb") do continue
					append(&ids, json.String(f.name[:len(f.name) - 3]))
				}
				out[strings.clone(entry.name, context.temp_allocator)] = json.Array(ids)
			}
		}
	}
	respond_json(sock, json.Object(out))
}

/**
 * State fingerprint for cross-device verification:
 * sha256 over the canonical manifest — for each object id (sorted), the line
 * "<objectId>:<sorted change hex ids joined by ,>\n". Vanished objects are
 * excluded (same rule as publication). Two devices with equal digests hold
 * identical change sets, order-independent.
 */
handle_sync_digest :: proc(sock: net.TCP_Socket) {
	vanished := vanished_ids()
	objects := make([dynamic]string, context.temp_allocator)
	per_obj := make(map[string][dynamic]string, context.temp_allocator)
	change_count := 0

	dir, derr := os.open(g_store.root)
	if derr == nil {
		defer os.close(dir)
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		if eerr == nil {
			for entry in entries {
				if entry.type != .Directory || strings.has_prefix(entry.name, ".") do continue
				if entry.name in vanished do continue
				ids := make([dynamic]string, context.temp_allocator)
				odir, oerr := os.open(entry.fullpath)
				if oerr != nil do continue
				files, ferr := os.read_dir(odir, -1, context.temp_allocator)
				os.close(odir)
				if ferr != nil do continue
				for f in files {
					if !strings.has_suffix(f.name, ".pb") do continue
					append(&ids, strings.clone(f.name[:len(f.name) - 3], context.temp_allocator))
				}
				if len(ids) == 0 do continue
				slice.sort(ids[:])
				oid := strings.clone(entry.name, context.temp_allocator)
				per_obj[oid] = ids
				append(&objects, oid)
				change_count += len(ids)
			}
		}
	}
	slice.sort(objects[:])

	buf := make([dynamic]byte, context.temp_allocator)
	for oid in objects {
		append(&buf, ..transmute([]byte)oid)
		append(&buf, u8(':'))
		for cid, i in per_obj[oid] {
			if i > 0 do append(&buf, u8(','))
			append(&buf, ..transmute([]byte)cid)
		}
		append(&buf, u8('\n'))
	}
	digest := core.sha256(buf[:])

	out := core.jobj()
	out["digest"] = json.String(string(hex.encode(digest[:], context.temp_allocator)))
	out["objects"] = json.Integer(i64(len(objects)))
	out["changes"] = json.Integer(i64(change_count))
	out["computedAt"] = json.Integer(unix_ms())
	respond_json(sock, json.Object(out))
}

handle_changes_get :: proc(sock: net.TCP_Socket, object_id: string) {
	if object_id == "" || strings.contains(object_id, "/") || strings.contains(object_id, "..") {
		respond_error(sock, "bad object id")
		return
	}
	respond_json(sock, changes_rows(object_id))
}

/**
 * Working-set rows {id, b64, b?, pending?, class?}: `b` from the sidecar,
 * `pending` when written here and not yet published, `class` (core
 * classification) only when the object holds a base. Files that do not
 * decode to their own address are not offered.
 */
changes_rows :: proc(object_id: string) -> json.Value {
	arr := make([dynamic]json.Value, context.temp_allocator)
	// A peer must not be able to pull a vanished object back out of us.
	if object_id not_in vanished_ids() {
		h := read_holdings(object_id, context.temp_allocator)
		cls: core.Classification
		classified := len(h.cps) > 0
		if classified do cls = core.base_classify(h.cps, h.deltas[:], h.pending, context.temp_allocator)
		for &d, i in h.deltas {
			o := core.jobj()
			o["id"] = json.String(core.hex_id(d.change.id, context.temp_allocator))
			o["b64"] = json.String(base64.encode(h.raw[i], allocator = context.temp_allocator))
			if d.tagged do o["b"] = json.String(core.hex_id(d.b[:], context.temp_allocator))
			if string(d.change.id) in h.pending do o["pending"] = json.Boolean(true)
			if classified {
				class: string
				switch cls.classes[i] {
				case .Live: class = "live"
				case .Covered: class = "covered"
				case .Premigration_Covered: class = "premigrationCovered"
				case .Orphan: class = "orphan"
				case .Stale: class = "stale"
				}
				o["class"] = json.String(class)
			}
			append(&arr, json.Object(o))
		}
	}
	out := core.jobj()
	out["objectId"] = json.String(object_id)
	out["changes"] = json.Array(arr)
	return json.Object(out)
}

handle_changes_import :: proc(sock: net.TCP_Socket, body: []byte) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	result := changes_import(parsed)
	if result.error != "" {
		respond_error(sock, result.error, result.status)
		return
	}
	respond_json(sock, result.out)
}

changes_import :: proc(parsed: json.Value) -> Op_Result {
	changes_json, ok := core.json_field(parsed, "changes")
	arr, aok := changes_json.(json.Array)
	if !ok || !aok do return {error = "changes array required", status = "400 Bad Request"}
	provenance, shared, valid_provenance := shared_provenance_parse(parsed)
	if !valid_provenance do return {error = "invalid shared provenance", status = "403 Forbidden"}

	imported := 0
	skipped := 0
	rejected := 0
	dropped := 0
	// The ledger is authoritative: a vanished object never comes back, no
	// matter how many relays or peers still hold its changes - nor does
	// anything placed into a vanished space, by a device that had not heard.
	vanished := vanished_ids()
	touched := make(map[string]bool, context.temp_allocator)
	ids := make([dynamic]json.Value, context.temp_allocator)

	for item in arr {
		// A bare base64 string, or {b64, b?} where b is the base hash hex the
		// change's event carried in its ["b", …] tag.
		text, b_hex: string
		#partial switch v in item {
		case json.String:
			text = string(v)
		case json.Object:
			text = core.json_str(item, "b64")
			b_hex = core.json_str(item, "b")
		}
		if text == "" || b_hex != "" && !hash_hex_valid(b_hex) {
			rejected += 1
			continue
		}
		data, derr := base64.decode(text, allocator = context.temp_allocator)
		if derr != nil {
			rejected += 1
			continue
		}
		c, cok := core.decode_change(data, context.temp_allocator)
		if !cok || c.object_id == "" || len(c.id) != 32 {
			rejected += 1
			continue
		}
		// Verify the content address over the RAW WIRE BYTES: the id is
		// defined as sha256(bytes with the id field zeroed to `0a00`), and
		// every writer emits the id as the leading field (0x0a 0x20 + 32).
		// Re-encoding through our codec would reject legacy changes whose
		// exact encoding predates schema evolution — bytes are the truth.
		if len(data) < 34 || data[0] != 0x0a || data[1] != 0x20 {
			rejected += 1
			continue
		}
		hashed := make([dynamic]byte, 0, len(data) - 32, context.temp_allocator)
		append(&hashed, 0x0a, 0x00)
		append(&hashed, ..data[34:])
		digest := core.sha256(hashed[:])
		if string(digest[:]) != string(c.id) {
			rejected += 1
			continue
		}
		if strings.contains(c.object_id, "/") || strings.contains(c.object_id, "..") || strings.contains(c.object_id, "\\") || strings.contains(c.object_id, "\x00") {
			rejected += 1
			continue
		}
		// Validate against locally trusted authority and the durable state from
		// preceding accepted changes, never this change's claimed author/scope.
		if shared && !shared_import_allowed(&c, provenance) {
			rejected += 1
			continue
		}
		// An object already purged is refused by id. A change that places an
		// object into a vanished space is refused by the space, and its id
		// joins the ledger: its later changes need not repeat the channel.
		if gone := core.change_vanished_by(vanished, &c, nil); gone != "" {
			entry := vanished[gone]
			if gone != c.object_id {
				object_id := strings.clone(c.object_id, context.temp_allocator)
				vanished[object_id] = entry
				sync.lock(&g_store.mu)
				note_space_vanished_locked(object_id, entry)
				sync.unlock(&g_store.mu)
			}
			// Never write it back. Reporting the id keeps the sync daemon from
			// echoing the change at the relay that just handed it to us.
			dropped += 1
			append(&ids, json.String(string(hex.encode(c.id, context.temp_allocator))))
			continue
		}
		hex_str := string(hex.encode(c.id, context.temp_allocator))
		path := change_file(c.object_id, hex_str, ".pb")
		if os.exists(path) {
			// A held change learns the base its event named.
			if b_hex != "" && !os.exists(change_file(c.object_id, hex_str, ".b")) && write_change_markers(c.object_id, hex_str, b_hex, false) {
				store_mark_dirty(c.object_id)
				touched[strings.clone(c.object_id, context.temp_allocator)] = true
			}
			skipped += 1
			append(&ids, json.String(hex_str))
			continue
		}
		// Never resurrect: a change pruned or rebased here stays in the archive.
		if os.exists(archive_file(c.object_id, hex_str, ".pb")) {
			skipped += 1
			append(&ids, json.String(hex_str))
			continue
		}
		if !write_change_markers(c.object_id, hex_str, b_hex, false) || os.write_entire_file(path, data) != nil {
			rejected += 1
			continue
		}
		archive_link(c.object_id, hex_str, path)
		imported += 1
		append(&ids, json.String(hex_str))
		// The next item must see accepted creates, membership removals and
		// snapshots immediately; do not defer cache invalidation to batch end.
		store_mark_dirty(c.object_id)
		if c.object_id == VANISH_LOG_ID do vanished = vanished_ids()
		touched[strings.clone(c.object_id, context.temp_allocator)] = true
	}

	// Each successful write was invalidated before validating its successor.
	for object_id in touched do sse_broadcast(object_id)

	out := core.jobj()
	out["ok"] = json.Boolean(true)
	out["imported"] = json.Integer(i64(imported))
	out["skipped"] = json.Integer(i64(skipped))
	out["rejected"] = json.Integer(i64(rejected))
	out["dropped"] = json.Integer(i64(dropped))
	out["ids"] = json.Array(ids)
	return {out = json.Object(out)}
}
