package glon

// Conversion of an object held on disk (bases, changes, legacy checkpoint)
// into a state record (docs/state-objects.md "Migration"): the same replay
// load_object_dir runs, observed by core's Record_Writers hook. Read-only:
// nothing is quarantined, folded or rebased here.

import "core:strings"
import "../core"

/** What load_object_dir replays for one object. has = false: nothing held. */
Record_Source :: struct {
	holdings: Holdings,
	base:     ^core.Checkpoint, // the current base, nil when the object has none
	live:     []core.Change, // the changes replayed (on the base, or over the legacy checkpoint)
	has:      bool,
}

/** Holdings of `object_id` and the changes the store replays (bookkeeping in the temp allocator). */
record_source :: proc(object_id: string, alloc := context.allocator) -> Record_Source {
	src: Record_Source
	src.holdings = read_holdings(object_id, alloc)
	h := &src.holdings
	if len(h.deltas) == 0 && len(h.cps) == 0 && h.legacy == nil do return src
	src.has = true
	cls := core.base_classify(h.cps, h.deltas[:], h.pending, h.own, context.temp_allocator)
	if cls.current >= 0 {
		src.base = &h.cps[cls.current]
		src.live = core.deltas_of(h.deltas[:], cls, .Live, context.temp_allocator)
	} else {
		src.live = holdings_changes(h)
	}
	return src
}

/** Today's state, exactly as load_object_dir computes it. */
record_source_state :: proc(src: ^Record_Source, alloc := context.allocator) -> (core.Object_State, bool) {
	if src.base != nil do return core.state_from_base(src.base, src.live, alloc)
	return core.compute_state(src.live, alloc, src.holdings.legacy)
}

/** The same replay, recording who last wrote each entry. */
record_source_writers :: proc(src: ^Record_Source, alloc := context.allocator) -> (core.Object_State, core.Record_Writers, bool) {
	if src.base != nil do return core.record_writers_replay_base(src.base, src.live, alloc)
	return core.record_writers_replay(src.live, src.holdings.legacy, alloc)
}

/**
 * Give every author a writer names a device index: authors already in
 * `devices` keep theirs, new ones take len + 1 (0 is the checkpoint seed's).
 * Keys are cloned with the map's allocator.
 */
record_devices_assign :: proc(devices: ^map[string]u32, writers: ^core.Record_Writers) {
	add :: proc(devices: ^map[string]u32, w: core.Record_Writer) {
		if w.seed || w.author in devices^ do return
		devices[strings.clone(w.author, devices.allocator)] = u32(len(devices^)) + 1
	}
	for _, w in writers.slots do add(devices, w)
	for _, w in writers.fields do add(devices, w)
	for _, w in writers.blocks do add(devices, w)
}

/**
 * The record for `object_id` as this computer holds it. Authors missing from
 * `devices` are added (record_devices_assign); pass a pre-filled table for
 * indices that do not depend on conversion order. Error text when nothing is
 * held, the replay fails or conversion refuses the state.
 */
record_convert_object :: proc(object_id: string, devices: ^map[string]u32, allocator := context.allocator) -> (core.Record, string) {
	src := record_source(object_id, allocator)
	if !src.has do return {}, "nothing held"
	state, writers, ok := record_source_writers(&src, allocator)
	if !ok do return {}, "replay failed"
	record_devices_assign(devices, &writers)
	return core.record_from_object_state(&state, &writers, devices^, allocator)
}
