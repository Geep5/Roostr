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
//
// A space in the ledger takes everything in it (core.object_vanished), so
// objects the deleting device never saw - created on another computer, or
// arriving later - go too. The store purges them on load and records their
// ids in the ledger as well: other devices then refuse them by id (even a
// change that carries no channel), and the harness can chase their relay
// copies, which are tagged by object id. Spaces this identity merely LEFT
// (`left:`) are purged the same way but never recorded or chased.

import "core:encoding/json"
import "core:fmt"
import "core:net"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:sync"
import "core:time"
import "../core"

VANISH_LOG_ID :: core.VANISH_LOG_ID
VANISH_LOG_TYPE :: core.VANISH_LOG_TYPE

/**
 * Ledger entries plus the space-rule ids still waiting to be recorded.
 * Caller must hold the lock. Keys are copies in `allocator`, never views of
 * the store generation: callers keep the map after releasing the lock, and
 * a concurrent rebuild frees the generation (the 2026-10-02 crash was
 * GET /api/vanished marshalling ledger keys freed mid-write).
 */
vanished_locked :: proc(allocator := context.temp_allocator) -> map[string]core.Vanish_Entry {
	out := core.vanished_from_ledger(g_store.states[VANISH_LOG_ID], allocator)
	for id, entry in g_store.vanish_pending do if id not_in out do out[strings.clone(id, allocator)] = entry
	return out
}

/** Vanished object ids, taking the store lock. */
vanished_ids :: proc(allocator := context.temp_allocator) -> map[string]core.Vanish_Entry {
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	return vanished_locked(allocator)
}

/**
 * Remember an id the space rule removed so the recorder writes it to the
 * ledger. Left spaces stay local: their objects are nobody's to delete.
 * Caller must hold the lock.
 */
note_space_vanished_locked :: proc(object_id: string, entry: core.Vanish_Entry) {
	if entry.left || object_id == "" || object_id == VANISH_LOG_ID || object_id in g_store.vanish_pending do return
	if g_store.vanish_pending == nil do g_store.vanish_pending = make(map[string]core.Vanish_Entry)
	g_store.vanish_pending[strings.clone(object_id)] = entry
}

/** Delete an object's change directory and checkpoint. Returns files removed. */
purge_object_files :: proc(object_id: string) -> int {
	if object_id == "" || object_id == VANISH_LOG_ID do return 0
	if strings.contains(object_id, "/") || strings.contains(object_id, "..") do return 0
	removed := purge_checkpoint(object_id) ? 1 : 0
	dir_path, _ := filepath.join({g_store.root, object_id}, context.temp_allocator)
	dir, derr := os.open(dir_path)
	if derr != nil do return removed
	files, ferr := os.read_dir(dir, -1, context.temp_allocator)
	os.close(dir)
	if ferr != nil do return removed
	for f in files {
		if os.remove(f.fullpath) == nil do removed += 1
	}
	_ = os.remove(dir_path) // succeeds once the directory is empty
	return removed
}

/**
 * Delete the change files of every object the ledger says is vanished, by id
 * or by the space it lives in. Caller must hold the lock; runs after a load
 * so `states` is populated. Returns the number of objects reclaimed.
 */
enforce_vanished_locked :: proc() -> int {
	vanished := vanished_locked()
	if len(vanished) == 0 do return 0
	reclaimed := 0
	for object_id in vanished {
		if purge_object_files(object_id) > 0 do reclaimed += 1
		delete_key(&g_store.states, object_id)
	}
	doomed := make([dynamic]string, context.temp_allocator)
	for object_id, state in g_store.states {
		entry, gone := core.state_vanished(vanished, state)
		if !gone do continue
		append(&doomed, strings.clone(object_id, context.temp_allocator))
		note_space_vanished_locked(object_id, entry)
	}
	for object_id in doomed {
		purge_object_files(object_id)
		delete_key(&g_store.states, object_id)
		reclaimed += 1
	}
	if len(doomed) > 0 do fmt.eprintfln("[vanish] %d object(s) in vanished spaces purged", len(doomed))
	return reclaimed
}

/** The same rule for objects just (re)loaded. Caller must hold the lock. */
enforce_vanished_touched_locked :: proc(touched: []string) {
	vanished := vanished_locked()
	if len(vanished) == 0 do return
	for object_id in touched {
		entry, gone := vanished[object_id]
		if state, loaded := g_store.states[object_id]; loaded && !gone {
			entry, gone = core.state_vanished(vanished, state)
			if gone do note_space_vanished_locked(object_id, entry)
		}
		if !gone do continue
		purge_object_files(object_id)
		delete_key(&g_store.states, object_id)
	}
}

/**
 * Record every id in the ledger (one change) and purge them locally. The
 * ledger write goes through the normal commit path, so it syncs like any
 * other change. Returns the number of objects recorded.
 */
vanish_objects :: proc(object_ids: []string) -> int {
	exists := false
	{
		sync.lock(&g_store.mu)
		ensure_loaded()
		_, exists = g_store.states[VANISH_LOG_ID]
		sync.unlock(&g_store.mu)
	}

	accepted := make([dynamic]string, context.temp_allocator)
	now := unix_ms()
	for object_id in object_ids {
		if object_id == "" || object_id == VANISH_LOG_ID do continue
		if strings.contains(object_id, "/") || strings.contains(object_id, "..") do continue
		append(&accepted, object_id)
	}
	if len(accepted) == 0 do return 0
	ops := core.mutation_vanish_ops(accepted[:], now, exists)
	if !commit_ops(VANISH_LOG_ID, ops[:]) do return 0

	for object_id in accepted do purge_object_files(object_id)
	// The purged objects must leave `states` and the new ledger fields must be
	// visible to import suppression: cheapest correct answer is a rebuild.
	store_invalidate()
	for object_id in accepted do sse_broadcast(object_id)
	sse_broadcast(VANISH_LOG_ID)
	return len(accepted)
}

VANISH_RECORD_INTERVAL :: 2 * time.Second

vanish_recorder_loop :: proc() {
	for {
		time.sleep(VANISH_RECORD_INTERVAL)
		record_space_vanished()
		free_all(context.temp_allocator)
	}
}

/**
 * Writes the ids the space rule purged into the ledger, outside the store
 * lock (loads find them; a commit cannot happen under the lock). Their
 * files and states are already gone, so this is one ledger change; the
 * ledger's own reload re-runs enforcement and the SSE wakes the harness's
 * relay chase. Returns how many ids it wrote; false when the write failed
 * (they stay pending for the next pass).
 */
record_space_vanished :: proc() -> (recorded: int, ok: bool) {
	ids := make([dynamic]string, context.temp_allocator)
	exists := false
	{
		sync.lock(&g_store.mu)
		defer sync.unlock(&g_store.mu)
		if len(g_store.vanish_pending) == 0 do return 0, true
		ensure_loaded()
		ledger := core.vanished_from_ledger(g_store.states[VANISH_LOG_ID])
		_, exists = g_store.states[VANISH_LOG_ID]
		for id in g_store.vanish_pending do if id not_in ledger do append(&ids, strings.clone(id, context.temp_allocator))
	}
	if len(ids) > 0 {
		sync.lock(&g_mutation_mu)
		ops := core.mutation_vanish_ops(ids[:], unix_ms(), exists)
		written := commit_ops(VANISH_LOG_ID, ops[:])
		sync.unlock(&g_mutation_mu)
		if !written {
			fmt.eprintfln("[vanish] recording %d object(s) of vanished spaces failed; retrying", len(ids))
			return 0, false
		}
		fmt.eprintfln("[vanish] recorded %d object(s) of vanished spaces in the ledger", len(ids))
	}
	// Recorded now (or by another device): the ledger carries them.
	sync.lock(&g_store.mu)
	defer sync.unlock(&g_store.mu)
	ensure_loaded()
	ledger := core.vanished_from_ledger(g_store.states[VANISH_LOG_ID])
	done := make([dynamic]string, context.temp_allocator)
	for id in g_store.vanish_pending do if id in ledger do append(&done, id)
	for id in done {
		key, _ := delete_key(&g_store.vanish_pending, id)
		delete(key)
	}
	return len(ids), true
}

/** GET /api/vanished → {"vanished": [{objectId, at, left?}], "count": n} */
handle_vanished :: proc(sock: net.TCP_Socket) {
	ids := vanished_ids()
	arr := make([dynamic]json.Value, context.temp_allocator)
	for object_id, entry in ids {
		o := core.jobj()
		o["objectId"] = json.String(object_id)
		o["at"] = json.Integer(entry.at)
		if entry.left do o["left"] = json.Boolean(true)
		append(&arr, json.Object(o))
	}
	out := core.jobj()
	out["vanished"] = json.Array(arr)
	out["count"] = json.Integer(i64(len(arr)))
	respond_json(sock, json.Object(out))
}
