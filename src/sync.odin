package glon

// Change export/import — the wire surface the nostr sync daemon rides.
//
//   GET  /api/changes              → {objectId: [hexIds]} manifest
//   GET  /api/changes/<objectId>   → {changes: [{id, b64}]}
//   POST /api/changes              → {changes: [b64…]} import; verifies the
//                                    content address, writes only absent
//                                    files, broadcasts per touched object.
//
// Import bypasses commit_change on purpose: these changes already carry
// their identity (id = sha256(encode with id zeroed)); recomputing parents
// or timestamps would forge history.

import "core:encoding/base64"
import "core:encoding/hex"
import "core:encoding/json"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strings"

handle_changes_manifest :: proc(sock: net.TCP_Socket) {
	out := jobj()
	dir, derr := os.open(g_store.root)
	if derr == nil {
		defer os.close(dir)
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		if eerr == nil {
			for entry in entries {
				if entry.type != .Directory || strings.has_prefix(entry.name, ".") do continue
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

handle_changes_get :: proc(sock: net.TCP_Socket, object_id: string) {
	if object_id == "" || strings.contains(object_id, "/") || strings.contains(object_id, "..") {
		respond_error(sock, "bad object id")
		return
	}
	dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
	arr := make([dynamic]json.Value, context.temp_allocator)
	dir, derr := os.open(dir_path)
	if derr == nil {
		defer os.close(dir)
		files, ferr := os.read_dir(dir, -1, context.temp_allocator)
		if ferr == nil {
			for f in files {
				if !strings.has_suffix(f.name, ".pb") do continue
				data, rerr := os.read_entire_file(f.fullpath, context.temp_allocator)
				if rerr != nil do continue
				o := jobj()
				o["id"] = json.String(f.name[:len(f.name) - 3])
				o["b64"] = json.String(base64.encode(data, allocator = context.temp_allocator))
				append(&arr, json.Object(o))
			}
		}
	}
	out := jobj()
	out["objectId"] = json.String(object_id)
	out["changes"] = json.Array(arr)
	respond_json(sock, json.Object(out))
}

handle_changes_import :: proc(sock: net.TCP_Socket, body: []byte) {
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	changes_json, ok := json_field(parsed, "changes")
	arr, aok := changes_json.(json.Array)
	if !ok || !aok {
		respond_error(sock, "changes array required")
		return
	}

	imported := 0
	skipped := 0
	rejected := 0
	touched := make(map[string]bool, context.temp_allocator)
	ids := make([dynamic]json.Value, context.temp_allocator)

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
		c, cok := decode_change(data, context.temp_allocator)
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
		digest := sha256(hashed[:])
		if string(digest[:]) != string(c.id) {
			rejected += 1
			continue
		}
		if strings.contains(c.object_id, "/") || strings.contains(c.object_id, "..") {
			rejected += 1
			continue
		}
		hex_str := string(hex.encode(c.id, context.temp_allocator))
		dir, _ := filepath.join({g_store.root, c.object_id}, context.temp_allocator)
		append(&ids, json.String(string(hex.encode(c.id, context.temp_allocator))))
		path, _ := filepath.join({dir, strings.concatenate({hex_str, ".pb"}, context.temp_allocator)}, context.temp_allocator)
		if os.exists(path) {
			skipped += 1
			continue
		}
		os.make_directory(g_store.data_root)
		os.make_directory(g_store.root)
		os.make_directory(dir)
		if os.write_entire_file(path, data) != nil {
			rejected += 1
			continue
		}
		imported += 1
		touched[strings.clone(c.object_id, context.temp_allocator)] = true
	}

	if imported > 0 {
		for object_id in touched do store_mark_dirty(object_id)
		for object_id in touched do sse_broadcast(object_id)
	}

	out := jobj()
	out["ok"] = json.Boolean(true)
	out["imported"] = json.Integer(i64(imported))
	out["skipped"] = json.Integer(i64(skipped))
	out["rejected"] = json.Integer(i64(rejected))
	out["ids"] = json.Array(ids)
	respond_json(sock, json.Object(out))
}
