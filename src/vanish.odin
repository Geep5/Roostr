package glon

// Vanish: real deletion, as opposed to the `deleted` tombstone flag.
//
// `Object_Delete` only appends a tombstone — the object's changes stay on
// disk and on the relays, and the sync daemon's union reconcile keeps
// re-importing and re-publishing them forever. Vanishing an object means
// three things must happen together, or the object comes back:
//
//   1. Its change files are removed locally.
//   2. Every device learns the object is vanished, so nobody republishes
//      it and nobody accepts a relay copy back. That record must itself
//      sync, so it lives in the DAG: a `vanish_log` object whose fields
//      map vanished object id → purge timestamp. It rides the same
//      kind-1078 transport as everything else and can never be vanished.
//   3. The relays are asked to drop the events (NIP-09 kind 5). That part
//      belongs to the harness, which holds the nostr key; it is advisory
//      and unreliable, which is exactly why (1) and (2) carry the weight.
//
// The ledger is authoritative and enforced, not merely recorded: when a
// vanished object's directory exists (a relay copy raced in before the
// ledger arrived, or an old device republished it), the store deletes it
// on the next load.

import "core:encoding/json"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:sync"

VANISH_LOG_ID :: "__vanished__"
VANISH_LOG_TYPE :: "vanish_log"
// Entry keys are prefixed so the ledger's own metadata (name, …) can never
// be mistaken for a vanished object id.
VANISH_KEY_PREFIX :: "vanished:"

/** Vanished object ids → purge timestamp (ms). Caller must hold the lock. */
vanished_locked :: proc(allocator := context.temp_allocator) -> map[string]i64 {
	out := make(map[string]i64, allocator = allocator)
	log, ok := g_store.states[VANISH_LOG_ID]
	if !ok do return out
	for e in log.fields {
		if !strings.has_prefix(e.key, VANISH_KEY_PREFIX) do continue
		object_id := e.key[len(VANISH_KEY_PREFIX):]
		if object_id == "" || object_id == VANISH_LOG_ID do continue
		at: i64 = 0
		if e.value.kind == .Int do at = e.value.i
		out[object_id] = at
	}
	return out
}

/** Vanished object ids, taking the store lock. */
vanished_ids :: proc(allocator := context.temp_allocator) -> map[string]i64 {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	return vanished_locked(allocator)
}

/** Delete an object's change directory. Returns files removed. */
purge_object_files :: proc(object_id: string) -> int {
	if object_id == "" || object_id == VANISH_LOG_ID do return 0
	if strings.contains(object_id, "/") || strings.contains(object_id, "..") do return 0
	dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
	dir, derr := os.open(dir_path)
	if derr != nil do return 0
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	os.close(dir)
	if ferr != nil do return 0
	removed := 0
	for f in files {
		if os.remove(f.fullpath) == nil do removed += 1
	}
	_ = os.remove(dir_path) // succeeds once the directory is empty
	return removed
}

/**
 * Delete the change files of every object the ledger says is vanished.
 * Caller must hold the lock; runs after a load so `states` is populated.
 * Returns the number of objects reclaimed (0 in the common case).
 */
enforce_vanished_locked :: proc() -> int {
	vanished := vanished_locked()
	if len(vanished) == 0 do return 0
	reclaimed := 0
	for object_id in vanished {
		if purge_object_files(object_id) > 0 do reclaimed += 1
		delete_key(&g_store.states, object_id)
	}
	return reclaimed
}

/**
 * Record every id in the ledger (one change) and purge them locally. The
 * ledger write goes through the normal commit path, so it syncs like any
 * other change. Returns the number of objects recorded.
 */
vanish_objects :: proc(object_ids: []string) -> int {
	ops := make([dynamic]Operation, context.temp_allocator)
	// First write bootstraps the ledger object.
	exists := false
	{
		sync.lock(&g_store.mu)
		ensure_loaded()
		_, exists = g_store.states[VANISH_LOG_ID]
		sync.unlock(&g_store.mu)
	}
	if !exists {
		append(&ops, Operation{kind = .Object_Create, type_key = VANISH_LOG_TYPE})
		append(&ops, Operation{kind = .Field_Set, key = "name", value = string_value("Vanished objects")})
	}

	accepted := make([dynamic]string, context.temp_allocator)
	now := unix_ms()
	for object_id in object_ids {
		if object_id == "" || object_id == VANISH_LOG_ID do continue
		if strings.contains(object_id, "/") || strings.contains(object_id, "..") do continue
		key := strings.concatenate({VANISH_KEY_PREFIX, object_id}, context.temp_allocator)
		append(&ops, Operation{kind = .Field_Set, key = key, value = int_value(now)})
		append(&accepted, object_id)
	}
	if len(accepted) == 0 do return 0
	if !commit_ops(VANISH_LOG_ID, ops[:]) do return 0

	for object_id in accepted do purge_object_files(object_id)
	// The purged objects must leave `states` and the new ledger fields must be
	// visible to import suppression: cheapest correct answer is a rebuild.
	store_invalidate()
	for object_id in accepted do sse_broadcast(object_id)
	sse_broadcast(VANISH_LOG_ID)
	return len(accepted)
}

/** GET /api/vanished → {"vanished": [{objectId, at}], "count": n} */
handle_vanished :: proc(sock: net.TCP_Socket) {
	ids := vanished_ids()
	arr := make([dynamic]json.Value, context.temp_allocator)
	for object_id, at in ids {
		o := jobj()
		o["objectId"] = json.String(object_id)
		o["at"] = json.Integer(at)
		append(&arr, json.Object(o))
	}
	out := jobj()
	out["vanished"] = json.Array(arr)
	out["count"] = json.Integer(i64(len(arr)))
	respond_json(sock, json.Object(out))
}
