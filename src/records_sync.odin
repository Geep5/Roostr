package glon

// Record-mode sync routes (docs/state-objects.md "Device flows"): the
// harness (harness/src/recordsync.ts) carries patches, vanishes and packs
// between this store and the relay; the daemon owns records, journal,
// clock and per-stream cursors. All answer 409 outside record mode.
//
//   GET  /api/records/status                 {records, device, hlc, journal}
//   GET  /api/records/journal                unsent patches and vanishes, in write order
//   POST /api/records/journal/ack            {ids} - sent; drop from the journal
//   POST /api/records/apply                  {patches: [b64], vanish: [objectId]}
//   GET  /api/records/export?<select>&stream=&cursor=   the stream's pack plaintext (b64) + fingerprint
//   POST /api/records/import-pack            body = pack plaintext: merge every record
//   GET  /api/records/cursors                {<stream>: {...}}
//   POST /api/records/cursors                {streams: {<stream>: {...} | null}}
//   GET  /api/records/fingerprint?<select>   {root, buckets, records}
//
// <select> names a stream's objects: `space=<id>` (the space's objects, the
// space itself included) or `exclude=<id>,<id>` (the personal stream:
// every object whose space is none of the listed shared spaces).
//
// An object's space: a channel is its own, anything else its `channel`
// field ("" = personal), as harness/src/nostrsync.ts loadSpaceMap.

import "core:encoding/base64"
import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:slice"
import "core:strings"
import "core:sync"
import "../core"

/** Received vanishes (kind 1082) are remembered this long: patches for those ids are refused. */
RECORD_VANISH_KEEP_MS :: 30 * 24 * 60 * 60 * 1000

JOURNAL_VANISH_SUFFIX :: ".vanish"

@(private = "file")
sync_file :: proc(name: string) -> string {
	path, _ := filepath.join({g_store.data_root, name}, context.temp_allocator)
	return path
}

/** The space an object syncs in ("" = personal). */
record_space_of :: proc(s: ^core.Object_State) -> string {
	if s == nil do return ""
	if s.type_key == "channel" do return s.id
	return core.field_string(s.fields, "channel")
}

// ── Stream selection ────────────────────────────────────────────────

Stream_Select :: struct {
	space:    string,
	personal: bool,
	exclude:  map[string]bool,
}

@(private = "file")
query_params :: proc(query: string) -> map[string]string {
	out := make(map[string]string, allocator = context.temp_allocator)
	for pair in strings.split(query, "&", context.temp_allocator) {
		if pair == "" do continue
		eq := strings.index_byte(pair, '=')
		key := eq < 0 ? pair : pair[:eq]
		raw := eq < 0 ? "" : pair[eq + 1:]
		spaced, _ := strings.replace_all(raw, "+", " ", context.temp_allocator)
		value, ok := net.percent_decode(spaced, context.temp_allocator)
		out[key] = ok ? value : raw
	}
	return out
}

@(private = "file")
stream_select_parse :: proc(params: map[string]string) -> (Stream_Select, bool) {
	sel: Stream_Select
	sel.exclude = make(map[string]bool, allocator = context.temp_allocator)
	if space, ok := params["space"]; ok {
		if space == "" do return sel, false
		sel.space = space
		return sel, true
	}
	sel.personal = true
	for id in strings.split(params["exclude"] or_else "", ",", context.temp_allocator) do if id != "" do sel.exclude[id] = true
	return sel, true
}

@(private = "file")
stream_selects :: proc(sel: Stream_Select, s: ^core.Object_State) -> bool {
	space := record_space_of(s)
	if sel.personal do return space not_in sel.exclude
	return space == sel.space
}

/** The stream's records, sorted by id. Caller holds the lock (loaded). */
@(private = "file")
stream_records_locked :: proc(sel: Stream_Select) -> [dynamic]core.Record {
	out := make([dynamic]core.Record, context.temp_allocator)
	for id, r in g_store.records {
		if !stream_selects(sel, g_store.states[id]) do continue
		append(&out, r)
	}
	slice.sort_by(out[:], proc(a, b: core.Record) -> bool {return a.object_id < b.object_id})
	return out
}

@(private = "file")
fingerprint_json :: proc(out: ^map[string]json.Value, buckets: [256][32]byte, root: [32]byte, records: int) {
	list := make([dynamic]json.Value, 0, 256, context.temp_allocator)
	for b in buckets {
		hash := b
		append(&list, json.String(core.hex_id(hash[:], context.temp_allocator)))
	}
	r := root
	out^["root"] = json.String(core.hex_id(r[:], context.temp_allocator))
	out^["buckets"] = json.Array(list)
	out^["records"] = json.Integer(i64(records))
}

// ── Received vanishes (30-day ledger) ───────────────────────────────

@(private = "file")
vanish_ledger_load :: proc() -> map[string]i64 {
	out := make(map[string]i64, allocator = context.temp_allocator)
	data, err := os.read_entire_file(sync_file("record-vanished.json"), context.temp_allocator)
	if err != nil do return out
	parsed, perr := json.parse(data, parse_integers = true, allocator = context.temp_allocator)
	obj, ok := parsed.(json.Object)
	if perr != nil || !ok do return out
	cutoff := unix_ms() - RECORD_VANISH_KEEP_MS
	for id, v in obj {
		if at, is_int := v.(json.Integer); is_int && i64(at) >= cutoff do out[id] = i64(at)
	}
	return out
}

@(private = "file")
vanish_ledger_save :: proc(ledger: map[string]i64) -> bool {
	obj := core.jobj()
	for id, at in ledger do obj[id] = json.Integer(at)
	return write_file_durable(sync_file("record-vanished.json"), core.marshal(json.Object(obj)))
}

// ── Journal ─────────────────────────────────────────────────────────

/**
 * A local vanish for the harness to announce (kind 1082) in the object's
 * stream: `<stamp hex>-<objectId>.vanish` holding the space id. The record
 * itself goes through purge_object_files. Caller holds the lock.
 */
records_journal_vanish_locked :: proc(object_id: string, space: string) {
	if !g_store.record_mode || !object_id_safe(object_id) do return
	stamp := core.hlc_now(&g_records.hlc, unix_ms())
	hlc_save()
	name := fmt.tprintf("%016x-%s%s", stamp, object_id, JOURNAL_VANISH_SUFFIX)
	path, _ := filepath.join({journal_root(), name}, context.temp_allocator)
	os.make_directory(journal_root())
	if !write_file_durable(path, transmute([]byte)space) do fmt.eprintfln("[records] cannot journal the vanish of %s", object_id)
}

@(private = "file")
handle_records_journal :: proc(sock: net.TCP_Socket) {
	sync.lock(&g_store.mu)
	ensure_loaded()
	items := make([dynamic]json.Value, context.temp_allocator)
	patches := records_journal_list()
	for item in patches {
		o := core.jobj()
		o["id"] = json.String(item.name)
		o["objectId"] = json.String(item.patch.object_id)
		// Copied: the state's strings are freed by any later write to the
		// object, and the response is written after the lock is released.
		o["space"] = json.String(strings.clone(record_space_of(g_store.states[item.patch.object_id]), context.temp_allocator))
		o["patch"] = json.String(base64.encode(core.patch_encode(item.patch, context.temp_allocator), allocator = context.temp_allocator))
		append(&items, json.Object(o))
	}
	if dir, err := os.open(journal_root()); err == nil {
		files, ferr := os.read_dir(dir, -1, context.temp_allocator)
		os.close(dir)
		if ferr == nil {
			for f in files {
				if !strings.has_suffix(f.name, JOURNAL_VANISH_SUFFIX) do continue
				dash := strings.index_byte(f.name, '-')
				if dash < 0 do continue
				data, rerr := os.read_entire_file(f.fullpath, context.temp_allocator)
				if rerr != nil do continue
				o := core.jobj()
				o["id"] = json.String(strings.clone(f.name, context.temp_allocator))
				o["objectId"] = json.String(strings.clone(f.name[dash + 1:len(f.name) - len(JOURNAL_VANISH_SUFFIX)], context.temp_allocator))
				o["space"] = json.String(string(data))
				o["vanish"] = json.Boolean(true)
				append(&items, json.Object(o))
			}
		}
	}
	sync.unlock(&g_store.mu)
	// Write order: names start with the stamp.
	slice.sort_by(items[:], proc(a, b: json.Value) -> bool {return core.json_str(a, "id") < core.json_str(b, "id")})
	out := core.jobj()
	out["items"] = json.Array(items)
	respond_json(sock, json.Object(out))
}

@(private = "file")
handle_records_journal_ack :: proc(sock: net.TCP_Socket, body: []byte) {
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	ids, ok := core.json_field(parsed, "ids")
	list, is_list := ids.(json.Array)
	if perr != nil || !ok || !is_list {
		respond_error(sock, "ids required")
		return
	}
	removed := 0
	sync.lock(&g_store.mu)
	for v in list {
		name, is_str := v.(json.String)
		if !is_str || !object_id_safe(string(name)) do continue
		if !strings.has_suffix(string(name), ".pb") && !strings.has_suffix(string(name), JOURNAL_VANISH_SUFFIX) do continue
		path, _ := filepath.join({journal_root(), string(name)}, context.temp_allocator)
		if os.remove(path) == nil do removed += 1
	}
	sync.unlock(&g_store.mu)
	out := core.jobj()
	out["removed"] = json.Integer(i64(removed))
	respond_json(sock, json.Object(out))
}

// ── Apply ───────────────────────────────────────────────────────────

/** Why a remote patch is refused ("" = accepted): a stamp past the 24 h window, or a vanished object. */
@(private = "file")
patch_refusal :: proc(p: core.Patch, vanished: map[string]core.Vanish_Entry, ledger: map[string]i64, now: i64) -> string {
	if !object_id_safe(p.object_id) do return "bad object id"
	if p.object_id in vanished || p.object_id in ledger do return "vanished"
	for e in p.entries do if core.stamp_ms(e.stamp.time) > now + core.HLC_MAX_FUTURE_MS do return "stamp more than 24 h in the future"
	return ""
}

/**
 * Merge `incoming` into the object's record; true when the record changed.
 * `written` holds this request's records already rewritten: g_store.records
 * reloads them only at the next ensure_loaded, so a later patch for the same
 * object must merge into the written one, not the stale state. Caller holds
 * the lock; `written` is temp-allocated.
 */
@(private = "file")
merge_into_locked :: proc(incoming: core.Record, written: ^map[string]core.Record) -> (changed: bool, ok: bool) {
	current, has := written[incoming.object_id]
	if !has do current, has = g_store.records[incoming.object_id]
	if !has do current = core.Record{object_id = incoming.object_id}
	merged := core.record_merge(current, incoming, context.temp_allocator) or_return
	if has && core.record_hash(merged) == core.record_hash(current) do return false, true
	if !record_write(merged) do return false, false
	written[merged.object_id] = merged
	hlc_observe_record(merged)
	if g_store.dirty == nil do g_store.dirty = make(map[string]bool)
	if incoming.object_id not_in g_store.dirty do g_store.dirty[strings.clone(incoming.object_id)] = true
	return true, true
}

@(private = "file")
handle_records_apply :: proc(sock: net.TCP_Socket, body: []byte) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	if perr != nil {
		respond_error(sock, "bad json")
		return
	}
	applied, unchanged := 0, 0
	refused := make([dynamic]json.Value, context.temp_allocator)
	touched := make([dynamic]string, context.temp_allocator)
	refuse :: proc(list: ^[dynamic]json.Value, object_id, reason: string) {
		o := core.jobj()
		o["objectId"] = json.String(object_id)
		o["reason"] = json.String(reason)
		append(list, json.Object(o))
	}

	sync.lock(&g_store.mu)
	ensure_loaded()
	now := unix_ms()
	vanished := vanished_locked()
	ledger := vanish_ledger_load()
	written := make(map[string]core.Record, allocator = context.temp_allocator)
	if field, ok := core.json_field(parsed, "patches"); ok {
		list, _ := field.(json.Array)
		for v in list {
			b64, is_str := v.(json.String)
			data, derr := base64.decode(string(b64), allocator = context.temp_allocator)
			p, pok := core.patch_decode(data, context.temp_allocator)
			if !is_str || derr != nil || !pok {
				refuse(&refused, "", "undecodable patch")
				continue
			}
			if reason := patch_refusal(p, vanished, ledger, now); reason != "" {
				refuse(&refused, p.object_id, reason)
				continue
			}
			as_record, rok := core.patch_to_record(p, context.temp_allocator)
			if !rok {
				refuse(&refused, p.object_id, "malformed patch")
				continue
			}
			changed, wok := merge_into_locked(as_record, &written)
			switch {
			case !wok:
				refuse(&refused, p.object_id, "write failed")
			case changed:
				applied += 1
				append(&touched, p.object_id)
			case:
				unchanged += 1
			}
		}
	}
	vanished_now := 0
	if field, ok := core.json_field(parsed, "vanish"); ok {
		list, _ := field.(json.Array)
		ledger_changed := false
		for v in list {
			id, is_str := v.(json.String)
			if !is_str || !object_id_safe(string(id)) || string(id) == VANISH_LOG_ID do continue
			if string(id) not_in ledger {
				ledger[strings.clone(string(id), context.temp_allocator)] = now
				ledger_changed = true
			}
			if purge_object_files(string(id)) > 0 || string(id) in g_store.states do vanished_now += 1
			delete_key(&g_store.states, string(id))
			delete_key(&g_store.records, string(id))
			append(&touched, string(id))
		}
		if ledger_changed && !vanish_ledger_save(ledger) do fmt.eprintln("[records] cannot write record-vanished.json")
	}
	if applied > 0 do hlc_save()
	sync.unlock(&g_store.mu)

	for id in touched do sse_broadcast(id)
	if len(refused) > 0 do fmt.eprintfln("[records] %d incoming patch(es) refused", len(refused))
	out := core.jobj()
	out["applied"] = json.Integer(i64(applied))
	out["unchanged"] = json.Integer(i64(unchanged))
	out["vanished"] = json.Integer(i64(vanished_now))
	out["refused"] = json.Array(refused)
	respond_json(sock, json.Object(out))
}

// ── Packs ───────────────────────────────────────────────────────────

@(private = "file")
handle_records_export :: proc(sock: net.TCP_Socket, query: string) {
	params := query_params(query)
	sel, ok := stream_select_parse(params)
	if !ok {
		respond_error(sock, "bad stream selection")
		return
	}
	cursor: u64
	if c, has := params["cursor"]; has {
		value, cok := parse_u64_strict(c)
		if !cok {
			respond_error(sock, "bad cursor")
			return
		}
		cursor = value
	}
	sync.lock(&g_store.mu)
	ensure_loaded()
	records := stream_records_locked(sel)
	pack, built := core.pack_build(records[:], params["stream"] or_else "", cursor, context.temp_allocator)
	sync.unlock(&g_store.mu)
	if !built {
		respond_error(sock, "pack build failed", "500 Internal Server Error")
		return
	}
	out := core.jobj()
	buckets: [256][32]byte
	for b, i in pack.header.buckets do buckets[i] = b.hash
	fingerprint_json(&out, buckets, pack.root, len(records))
	out["cursor"] = json.Integer(i64(cursor))
	out["size"] = json.Integer(i64(len(pack.plaintext)))
	out["plaintext"] = json.String(base64.encode(pack.plaintext, allocator = context.temp_allocator))
	respond_json(sock, json.Object(out))
}

@(private = "file")
parse_u64_strict :: proc(s: string) -> (u64, bool) {
	if s == "" || len(s) > 20 do return 0, false
	v: u64
	for c in s {
		if c < '0' || c > '9' do return 0, false
		v = v * 10 + u64(c - '0')
	}
	return v, true
}

@(private = "file")
handle_records_fingerprint :: proc(sock: net.TCP_Socket, query: string) {
	sel, ok := stream_select_parse(query_params(query))
	if !ok {
		respond_error(sock, "bad stream selection")
		return
	}
	sync.lock(&g_store.mu)
	ensure_loaded()
	records := stream_records_locked(sel)
	fp := core.records_fingerprint(records[:])
	sync.unlock(&g_store.mu)
	out := core.jobj()
	fingerprint_json(&out, fp.buckets, fp.root, len(records))
	respond_json(sock, json.Object(out))
}

/** Merge every record of a pack plaintext (decrypted by the harness); local newer entries survive. */
@(private = "file")
handle_records_import_pack :: proc(sock: net.TCP_Socket, body: []byte) {
	header, payload_start, ok := core.pack_read_header(body)
	if !ok {
		respond_error(sock, "not a pack")
		return
	}
	incoming := make([dynamic]core.Record, context.temp_allocator)
	for b in 0 ..< core.PACK_BUCKETS {
		data, bok := core.pack_bucket_bytes(body, header, payload_start, b)
		if !bok {
			respond_error(sock, "pack truncated")
			return
		}
		records, rok := core.pack_read_bucket(data, header, b, context.temp_allocator)
		if !rok {
			respond_error(sock, fmt.tprintf("pack bucket %d does not match its header", b))
			return
		}
		append(&incoming, ..records)
	}

	merged, unchanged := 0, 0
	refused := make([dynamic]json.Value, context.temp_allocator)
	touched := make([dynamic]string, context.temp_allocator)
	sync.lock(&g_store.mu)
	ensure_loaded()
	now := unix_ms()
	vanished := vanished_locked()
	ledger := vanish_ledger_load()
	written := make(map[string]core.Record, allocator = context.temp_allocator)
	for r in incoming {
		// The refusal rules of a patch, over every entry of the record.
		as_patch := core.Patch{object_id = r.object_id, entries = make([dynamic]core.Record_Entry, context.temp_allocator)}
		if r.type.key != "" do append(&as_patch.entries, r.type)
		if r.deleted.key != "" do append(&as_patch.entries, r.deleted)
		for list in ([][dynamic]core.Record_Entry{r.fields, r.blocks, r.messages}) do append(&as_patch.entries, ..list[:])
		if reason := patch_refusal(as_patch, vanished, ledger, now); reason != "" {
			o := core.jobj()
			o["objectId"] = json.String(r.object_id)
			o["reason"] = json.String(reason)
			append(&refused, json.Object(o))
			continue
		}
		changed, wok := merge_into_locked(r, &written)
		switch {
		case !wok:
			o := core.jobj()
			o["objectId"] = json.String(r.object_id)
			o["reason"] = json.String("write failed")
			append(&refused, json.Object(o))
		case changed:
			merged += 1
			append(&touched, r.object_id)
		case:
			unchanged += 1
		}
	}
	if merged > 0 do hlc_save()
	sync.unlock(&g_store.mu)
	for id in touched do sse_broadcast(id)
	out := core.jobj()
	out["stream"] = json.String(header.stream)
	out["cursor"] = json.Integer(i64(header.cursor))
	out["records"] = json.Integer(i64(len(incoming)))
	out["merged"] = json.Integer(i64(merged))
	out["unchanged"] = json.Integer(i64(unchanged))
	out["refused"] = json.Array(refused)
	respond_json(sock, json.Object(out))
}

// ── Cursors ─────────────────────────────────────────────────────────

g_record_cursors_mu: sync.Mutex

@(private = "file")
cursors_read :: proc() -> json.Object {
	data, err := os.read_entire_file(sync_file("record-cursors.json"), context.temp_allocator)
	if err != nil do return json.Object(core.jobj())
	parsed, perr := json.parse(data, allocator = context.temp_allocator)
	obj, ok := parsed.(json.Object)
	if perr != nil || !ok do return json.Object(core.jobj())
	return obj
}

@(private = "file")
handle_records_cursors_get :: proc(sock: net.TCP_Socket) {
	sync.lock(&g_record_cursors_mu)
	defer sync.unlock(&g_record_cursors_mu)
	respond_json(sock, cursors_read())
}

/** {streams: {<stream>: state | null}}: per-stream state replaced (null removes), others kept. */
@(private = "file")
handle_records_cursors_post :: proc(sock: net.TCP_Socket, body: []byte) {
	if !core.json_depth_ok(body) {
		respond_error(sock, "bad json")
		return
	}
	parsed, perr := json.parse(body, allocator = context.temp_allocator)
	field, ok := core.json_field(parsed, "streams")
	streams, is_obj := field.(json.Object)
	if perr != nil || !ok || !is_obj {
		respond_error(sock, "streams required")
		return
	}
	sync.lock(&g_record_cursors_mu)
	defer sync.unlock(&g_record_cursors_mu)
	current := cursors_read()
	for stream, state in streams {
		if _, is_null := state.(json.Null); is_null || state == nil {
			delete_key(&current, stream)
			continue
		}
		if _, is_state := state.(json.Object); !is_state {
			respond_error(sock, "a stream's state is an object or null")
			return
		}
		current[stream] = state
	}
	if !write_file_durable(sync_file("record-cursors.json"), core.marshal(current)) {
		respond_error(sock, "write failed", "500 Internal Server Error")
		return
	}
	respond_json(sock, current)
}

// ── Routing ─────────────────────────────────────────────────────────

/** The /api/records/ routes; false when `req` is none of them. */
records_route :: proc(sock: net.TCP_Socket, req: Request) -> bool {
	if !strings.has_prefix(req.path, "/api/records/") do return false
	if !g_store.record_mode {
		respond_error(sock, "record mode only (GLON_RECORDS=1)", "409 Conflict")
		return true
	}
	switch {
	case req.method == "GET" && req.path == "/api/records/status":
		sync.lock(&g_store.mu)
		ensure_loaded()
		journal := len(records_journal_list())
		hlc := g_records.hlc.last
		sync.unlock(&g_store.mu)
		out := core.jobj()
		out["records"] = json.Boolean(true)
		out["device"] = json.String(device_id())
		out["hlc"] = json.String(fmt.tprintf("%d", hlc))
		out["journal"] = json.Integer(i64(journal))
		respond_json(sock, json.Object(out))
	case req.method == "GET" && req.path == "/api/records/journal":
		handle_records_journal(sock)
	case req.method == "POST" && req.path == "/api/records/journal/ack":
		handle_records_journal_ack(sock, req.body)
	case req.method == "POST" && req.path == "/api/records/apply":
		handle_records_apply(sock, req.body)
	case req.method == "GET" && req.path == "/api/records/export":
		handle_records_export(sock, req.query)
	case req.method == "POST" && req.path == "/api/records/import-pack":
		handle_records_import_pack(sock, req.body)
	case req.method == "GET" && req.path == "/api/records/cursors":
		handle_records_cursors_get(sock)
	case req.method == "POST" && req.path == "/api/records/cursors":
		handle_records_cursors_post(sock, req.body)
	case req.method == "GET" && req.path == "/api/records/fingerprint":
		handle_records_fingerprint(sock, req.query)
	case:
		respond_error(sock, "not found", "404 Not Found")
	}
	return true
}
