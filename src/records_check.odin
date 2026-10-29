package glon

// `glon-odin records-check`: an offline dry run of the record conversion
// (docs/state-objects.md "Migration") over the whole store at GLON_DATA.
// Every object is loaded and replayed as the store does, converted to a
// record, viewed back and compared with today's state. Read-only, no
// network; prints a report.

import "base:runtime"
import "core:encoding/hex"
import "core:encoding/json"
import "core:fmt"
import "core:mem/virtual"
import "core:os"
import "core:slice"
import "core:strings"
import "core:time"
import "../core"

@(private = "file")
Check_Cause :: struct {
	count:    int,
	examples: [dynamic]string,
}

@(private = "file")
Check :: struct {
	persist:        runtime.Allocator,
	causes:         map[string]^Check_Cause,
	checked:        int,
	api_equal:      int,
	exact:          int,
	nothing_held:   int,
	replay_failed:  int,
	vanished:       int,
	hook_differs:   int,
	convert_errors: int,
	self_failures:  int, // records changed by their JSON round trip or a self-merge
	entries:        int, // field, block and message entries
	tombstones:     int,
	seeded:         int, // entries stamped by a checkpoint seed (device 0)
	repeated:       [dynamic]string, // objects with a block listed under two parents
	record_bytes:   int,
	history_bytes:  int,
	ids:            [dynamic]string,
	hashes:         [dynamic][32]byte,
}

@(private = "file")
check_note :: proc(c: ^Check, cause: string, example: string) {
	entry, ok := c.causes[cause]
	if !ok {
		entry = new(Check_Cause, c.persist)
		entry.examples = make([dynamic]string, c.persist)
		c.causes[strings.clone(cause, c.persist)] = entry
	}
	entry.count += 1
	if len(entry.examples) < 3 do append(&entry.examples, strings.clone(example, c.persist))
}

@(private = "file")
json_text :: proc(v: json.Value) -> string {
	return string(core.marshal(v))
}

/**
 * Differences between today's state and the view, as (cause, path) pairs:
 * cause names the kind of difference with indices and keys folded, path the
 * first concrete place it shows. Blocks are matched by id.
 */
@(private = "file")
diff_states :: proc(want, got: json.Value, out: ^[dynamic][2]string) {
	w, _ := want.(json.Object)
	g, _ := got.(json.Object)
	keys := make(map[string]bool, allocator = context.temp_allocator)
	for k in w do keys[k] = true
	for k in g do keys[k] = true
	add :: proc(out: ^[dynamic][2]string, cause, path: string) {
		append(out, [2]string{cause, path})
	}
	for k in keys {
		wv, has_w := w[k]
		gv, has_g := g[k]
		switch {
		case !has_w:
			add(out, fmt.tprintf("%s: only in view", k), k)
		case !has_g:
			add(out, fmt.tprintf("%s: missing from view", k), k)
		case k == "fields":
			wf, _ := wv.(json.Object)
			gf, _ := gv.(json.Object)
			for fk, fv in wf {
				other, ok := gf[fk]
				if !ok do add(out, "fields: missing from view", fmt.tprintf("fields.%s", fk))
				else if json_text(fv) != json_text(other) do add(out, "fields: value differs", fmt.tprintf("fields.%s", fk))
			}
			for fk in gf do if fk not_in wf do add(out, "fields: only in view", fmt.tprintf("fields.%s", fk))
		case k == "blocks":
			wb, _ := wv.(json.Array)
			gb, _ := gv.(json.Array)
			by_id :: proc(list: json.Array) -> (map[string]json.Object, [dynamic]string) {
				m := make(map[string]json.Object, allocator = context.temp_allocator)
				order := make([dynamic]string, context.temp_allocator)
				for b in list {
					o, _ := b.(json.Object)
					id, _ := o["id"].(json.String)
					m[string(id)] = o
					append(&order, string(id))
				}
				return m, order
			}
			wm, worder := by_id(wb)
			gm, gorder := by_id(gb)
			same_set := true
			for id, wo in wm {
				gob, ok := gm[id]
				if !ok {
					add(out, "blocks: missing from view", fmt.tprintf("blocks[%s]", id))
					same_set = false
					continue
				}
				for bk, bv in wo {
					other := gob[bk] or_else nil
					if json_text(bv) == json_text(other) do continue
					cause := fmt.tprintf("blocks: %s differs", bk)
					if bk == "childrenIds" {
						// Today keeps references to children that are not in the state; a record cannot.
						kept := make([dynamic]json.Value, context.temp_allocator)
						for child in bv.(json.Array) or_else nil do if string(child.(json.String) or_else "") in wm do append(&kept, child)
						if json_text(json.Array(kept)) == json_text(other) do cause = "blocks: dangling child reference dropped (child not in the state)"
					} else if bk == "fields" && other == nil && json_text(bv) == `{"entries":{}}` {
						cause = "blocks: empty fields map dropped (present but empty today)"
					}
					add(out, cause, fmt.tprintf("blocks[%s].%s", id, bk))
				}
				for bk in gob do if bk not_in wo do add(out, fmt.tprintf("blocks: %s only in view", bk), fmt.tprintf("blocks[%s].%s", id, bk))
			}
			for id in gm do if id not_in wm {
				add(out, "blocks: only in view", fmt.tprintf("blocks[%s]", id))
				same_set = false
			}
			if same_set && !slice.equal(worder[:], gorder[:]) do add(out, "blocks: preorder differs", "blocks")
		case:
			if json_text(wv) != json_text(gv) do add(out, fmt.tprintf("%s differs", k), fmt.tprintf("%s: today %s, view %s", k, json_text(wv), json_text(gv)))
		}
	}
}

@(private = "file")
history_file_bytes :: proc(src: ^Record_Source, object_id: string) -> int {
	total := 0
	for raw in src.holdings.raw do total += len(raw)
	for b in src.holdings.bases do total += len(b.bytes)
	if src.holdings.legacy != nil {
		if info, err := os.stat(checkpoint_path(object_id), context.temp_allocator); err == nil do total += int(info.size)
	}
	return total
}

/** Object ids the store loads: change directories, then checkpoint- or base-only objects. Sorted. */
@(private = "file")
store_object_ids :: proc(allocator: runtime.Allocator) -> [dynamic]string {
	seen := make(map[string]bool, allocator = allocator)
	out := make([dynamic]string, allocator)
	add :: proc(seen: ^map[string]bool, out: ^[dynamic]string, id: string, allocator: runtime.Allocator) {
		if id in seen^ do return
		owned := strings.clone(id, allocator)
		seen[owned] = true
		append(out, owned)
	}
	if dir, err := os.open(g_store.root); err == nil {
		entries, eerr := os.read_dir(dir, -1, context.temp_allocator)
		os.close(dir)
		if eerr == nil {
			for e in entries do if e.type == .Directory && !strings.has_prefix(e.name, ".") do add(&seen, &out, e.name, allocator)
		}
	}
	for id in checkpointed_object_ids() do add(&seen, &out, id, allocator)
	for id in based_object_ids() do add(&seen, &out, id, allocator)
	slice.sort(out[:])
	return out
}

/** `only` != "": check that one object and print today's state, the view and the record. */
cli_records_check :: proc(only: string = "") {
	started := time.tick_now()
	persist := context.allocator
	c := Check{persist = persist}
	c.causes = make(map[string]^Check_Cause, allocator = persist)
	c.repeated = make([dynamic]string, persist)
	c.ids = make([dynamic]string, persist)
	c.hashes = make([dynamic][32]byte, persist)

	arena: virtual.Arena
	_ = virtual.arena_init_growing(&arena)
	defer virtual.arena_destroy(&arena)
	scratch := virtual.arena_allocator(&arena)
	reset :: proc(arena: ^virtual.Arena) {
		virtual.arena_free_all(arena)
		free_all(context.temp_allocator)
	}

	ids := store_object_ids(persist)
	if only != "" {
		clear(&ids)
		append(&ids, only)
	}

	// Device table: every author of every held change, sorted; 0 = checkpoint seed.
	authors_seen := make(map[string]bool, allocator = persist)
	for id in ids {
		h := read_holdings(id, scratch)
		for d in h.deltas do if d.change.author not_in authors_seen do authors_seen[strings.clone(d.change.author, persist)] = true
		reset(&arena)
	}
	authors := make([dynamic]string, persist)
	for a in authors_seen do append(&authors, a)
	slice.sort(authors[:])
	devices := make(map[string]u32, allocator = persist)
	for a, i in authors do devices[a] = u32(i) + 1
	authors_ms := time.duration_milliseconds(time.tick_since(started))

	// The vanish ledger, as the store enforces it.
	vanished: map[string]core.Vanish_Entry
	{
		src := record_source(VANISH_LOG_ID, scratch)
		ledger, ok := record_source_state(&src, scratch)
		vanished = core.vanished_from_ledger(ok && src.has ? &ledger : nil, persist)
		// Keys and values point into the arena: clone before it resets.
		owned := make(map[string]core.Vanish_Entry, allocator = persist)
		for k, v in vanished do owned[strings.clone(k, persist)] = v
		vanished = owned
		reset(&arena)
	}

	for id in ids {
		defer reset(&arena)
		context.allocator = scratch
		if id in vanished {
			c.vanished += 1
			continue
		}
		src := record_source(id, scratch)
		if !src.has {
			c.nothing_held += 1
			continue
		}
		today, ok := record_source_state(&src, scratch)
		if !ok {
			c.replay_failed += 1
			continue
		}
		if _, gone := core.state_vanished(vanished, &today); gone {
			c.vanished += 1
			continue
		}
		c.checked += 1
		c.history_bytes += history_file_bytes(&src, id)
		label := fmt.tprintf("%s (%s)", id, today.type_key)

		state, writers, wok := record_source_writers(&src, scratch)
		if !wok || json_text(core.record_state_to_json(&state)) != json_text(core.record_state_to_json(&today)) {
			c.hook_differs += 1
			check_note(&c, "hooked replay differs from today's", label)
			continue
		}
		record, err := core.record_from_object_state(&state, &writers, devices)
		if err != "" {
			c.convert_errors += 1
			check_note(&c, fmt.tprintf("conversion error: %s", err), label)
			continue
		}
		bytes := core.record_encode(record, scratch)
		c.record_bytes += len(bytes)
		append(&c.ids, strings.clone(id, persist))
		append(&c.hashes, core.sha256(bytes))
		for list in ([][dynamic]core.Record_Entry{record.fields, record.blocks, record.messages}) {
			for e in list {
				c.entries += 1
				if e.gone do c.tombstones += 1
				if e.stamp.device == 0 do c.seeded += 1
			}
		}
		// The record must survive its JSON form and merge with itself unchanged.
		parsed, perr := json.parse(core.marshal(core.record_to_json(record)), parse_integers = true, allocator = scratch)
		back, bok := core.record_from_json(parsed, scratch)
		merged, mok := core.record_merge(record, record, scratch)
		if perr != nil || !bok || string(core.record_encode(back, scratch)) != string(bytes) || !mok || string(core.record_encode(merged, scratch)) != string(bytes) {
			c.self_failures += 1
			check_note(&c, "record self-check: JSON round trip or self-merge changes it", label)
		}

		view := core.record_view(record, scratch)
		if core.state_drop_repeated_refs(&today, scratch) do append(&c.repeated, strings.clone(label, persist))
		api_equal := json_text(core.object_to_json_value(&view)) == json_text(core.object_to_json_value(&today))
		want := core.record_state_to_json(&today)
		got := core.record_state_to_json(&view)
		lossless_equal := json_text(want) == json_text(got)
		if only != "" {
			fmt.printfln("today:  %s", json_text(want))
			fmt.printfln("view:   %s", json_text(got))
			fmt.printfln("record: %s", json_text(core.record_to_json(record)))
		}
		if api_equal do c.api_equal += 1
		if api_equal && lossless_equal {
			c.exact += 1
			continue
		}
		diffs := make([dynamic][2]string, context.temp_allocator)
		diff_states(want, got, &diffs)
		if !api_equal && lossless_equal do append(&diffs, [2]string{"API projection differs (conversations / mailbox)", "conversations"})
		// One cause per object: the set of difference kinds it shows.
		kinds := make([dynamic]string, context.temp_allocator)
		first := make(map[string]string, allocator = context.temp_allocator)
		for d in diffs {
			if d[0] in first do continue
			first[d[0]] = d[1]
			append(&kinds, d[0])
		}
		slice.sort(kinds[:])
		paths := make([dynamic]string, context.temp_allocator)
		for k in kinds do append(&paths, first[k])
		check_note(&c, strings.join(kinds[:], " + ", context.temp_allocator), fmt.tprintf("%s: %s", label, strings.join(paths[:], "; ", context.temp_allocator)))
	}

	fp := core.records_fingerprint_hashes(c.ids[:], c.hashes[:])
	elapsed := time.duration_milliseconds(time.tick_since(started))

	fmt.printfln("records-check: %s", g_store.data_root)
	fmt.printfln("object ids found: %d (vanished %d, nothing held %d, replay failed %d)", len(ids), c.vanished, c.nothing_held, c.replay_failed)
	fmt.printfln("objects checked: %d", c.checked)
	fmt.printfln("exact matches (API JSON and lossless state): %d", c.exact)
	fmt.printfln("API JSON matches: %d", c.api_equal)
	fmt.printfln("mismatches: %d (hooked replay differs %d, conversion errors %d)", c.checked - c.exact, c.hook_differs, c.convert_errors)
	fmt.printfln("devices (authors): %d", len(authors))
	fmt.printfln("entries: %d (tombstones %d, stamped by a checkpoint seed %d); record self-check failures: %d", c.entries, c.tombstones, c.seeded, c.self_failures)
	causes := make([dynamic]string, context.temp_allocator)
	for k in c.causes do append(&causes, k)
	slice.sort_by(causes[:], proc(a, b: string) -> bool {return a < b})
	for k in causes {
		entry := c.causes[k]
		fmt.printfln("  [%d] %s", entry.count, k)
		for e in entry.examples do fmt.printfln("      %s", e)
	}
	fmt.printfln("blocks listed under two parents: %d objects", len(c.repeated))
	for r in c.repeated do fmt.printfln("      %s", r)
	fmt.printfln("record bytes (canonical): %d", c.record_bytes)
	fmt.printfln("history bytes on disk (changes + bases + checkpoints of checked objects): %d", c.history_bytes)
	fmt.printfln("records: %d, root fingerprint: %s", len(c.ids), string(hex.encode(fp.root[:], context.temp_allocator)))
	fmt.printfln("wall time: %.0f ms (author table %.0f ms)", elapsed, authors_ms)
}
