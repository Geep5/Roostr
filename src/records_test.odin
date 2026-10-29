package glon

// Record mode (GLON_RECORDS=1, src/records.odin): every mutation turns into
// a patch on the object's record, and the record's view is the object the
// DAG would show after the same changes. Also: conversion on first start,
// persistence across restarts, the journal, the hybrid clock, per-device
// directory counters and per-participant entries. Runs inside
// store_durability_contract: the store is one global.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:slice"
import "core:strconv"
import "core:strings"
import "core:testing"
import "../core"

/** Every change committed, as the DAG would hold it (parents = the previous change of the object). */
@(private = "file")
Twin :: struct {
	changes: [dynamic]core.Change,
	heads:   map[string][]byte,
	retyped: map[string]bool, // a later Object_Create moved the DAG's createdAt
}

@(private = "file")
twin_make :: proc() -> Twin {
	return Twin{changes = make([dynamic]core.Change, context.temp_allocator), heads = make(map[string][]byte, allocator = context.temp_allocator), retyped = make(map[string]bool, allocator = context.temp_allocator)}
}

@(private = "file")
twin_commit :: proc(t: ^testing.T, tw: ^Twin, change: ^core.Change) -> bool {
	change.parent_ids = make([dynamic][]byte, context.temp_allocator)
	if head, ok := tw.heads[change.object_id]; ok {
		append(&change.parent_ids, head)
		for op in change.ops do if op.kind == .Object_Create do tw.retyped[change.object_id] = true
	}
	_, ok := commit_change(change)
	testing.expectf(t, ok, "commit on %s", change.object_id)
	if !ok do return false
	append(&tw.changes, change^)
	tw.heads[strings.clone(change.object_id, context.temp_allocator)] = change.id
	return true
}

/** Plan an action with the real planner on the record views and commit it through the twin. */
@(private = "file")
act :: proc(t: ^testing.T, tw: ^Twin, params: json.Object) -> json.Object {
	plan, err := native_mutation_plan(json.Object(params))
	testing.expectf(t, err == "", "%s: %s", core.json_str(json.Object(params), "action"), err)
	for &change in plan.changes {
		change.author = "glon-odin"
		twin_commit(t, tw, &change)
	}
	if len(plan.vanish_ids) > 0 do vanish_objects(plan.vanish_ids[:])
	return json.Object(plan.result)
}

@(private = "file")
p :: proc(action: string, pairs: ..[2]string) -> json.Object {
	o := core.jobj()
	o["action"] = json.String(action)
	for kv in pairs do o[kv[0]] = json.String(kv[1])
	return json.Object(o)
}

@(private = "file")
text_block :: proc(id, text: string) -> json.Value {
	inner := core.jobj()
	inner["text"] = json.String(text)
	inner["style"] = json.Integer(0)
	content := core.jobj()
	content["text"] = json.Object(inner)
	b := core.jobj()
	b["id"] = json.String(id)
	b["content"] = json.Object(content)
	return json.Object(b)
}

@(private = "file")
object_json :: proc(object_id: string) -> (string, bool) {
	Probe :: struct {
		id:    string,
		out:   string,
		found: bool,
	}
	probe := Probe{id = object_id}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		pr := cast(^Probe)user
		s, ok := states[pr.id]
		if !ok do return
		pr.found = true
		pr.out = strings.clone(string(core.object_to_json(s)), context.temp_allocator)
	}, &probe)
	return probe.out, probe.found
}

@(private = "file")
all_objects_json :: proc() -> map[string]string {
	out := make(map[string]string, allocator = context.temp_allocator)
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		m := cast(^map[string]string)user
		for id, s in states do m[strings.clone(id, context.temp_allocator)] = strings.clone(string(core.object_to_json(s)), context.temp_allocator)
	}, &out)
	return out
}

/** The DAG twin's object, as the API shows it (createdAt dropped where a re-create moved it: see records_contract). */
@(private = "file")
dag_json :: proc(tw: ^Twin, object_id: string, keep_created := true) -> (string, bool) {
	changes := make([dynamic]core.Change, context.temp_allocator)
	for c in tw.changes do if c.object_id == object_id do append(&changes, c)
	if len(changes) == 0 do return "", false
	state, ok := core.compute_state(changes[:], context.temp_allocator)
	if !ok do return "", false
	core.state_drop_repeated_refs(&state, context.temp_allocator)
	v := core.object_to_json_value(&state)
	if !keep_created do delete_key(&v.(json.Object), "createdAt")
	return string(core.marshal(v)), true
}

@(private = "file")
without_created :: proc(s: string) -> string {
	v, err := json.parse(transmute([]byte)s, parse_integers = true, allocator = context.temp_allocator)
	if err != nil do return s
	delete_key(&v.(json.Object), "createdAt")
	return string(core.marshal(v))
}

@(private = "file")
expect_same :: proc(t: ^testing.T, tw: ^Twin, object_id: string, label: string) {
	retyped := object_id in tw.retyped
	want, wok := dag_json(tw, object_id, keep_created = !retyped)
	got, gok := object_json(object_id)
	testing.expectf(t, wok && gok, "%s: %s held in both (dag %v, record %v)", label, object_id, wok, gok)
	if retyped do got = without_created(got)
	testing.expectf(t, got == want, "%s: %s\n record: %s\n    dag: %s", label, object_id, got, want)
}

@(private = "file")
expect_all_same :: proc(t: ^testing.T, tw: ^Twin, label: string) {
	ids := make(map[string]bool, allocator = context.temp_allocator)
	for c in tw.changes do ids[c.object_id] = true
	for id in ids do expect_same(t, tw, id, label)
}

@(private = "file")
record_of :: proc(object_id: string) -> (core.Record, bool) {
	data, err := os.read_entire_file(record_path(object_id), context.temp_allocator)
	if err != nil do return {}, false
	return core.record_decode(data, context.temp_allocator)
}

@(private = "file")
field_entry :: proc(r: core.Record, key: string) -> (core.Record_Entry, bool) {
	for e in r.fields do if e.key == key do return e, true
	return {}, false
}

@(private = "file")
file_count :: proc(dir: string) -> int {
	n := 0
	handle, err := os.open(dir)
	if err != nil do return 0
	entries, _ := os.read_dir(handle, -1, context.temp_allocator)
	os.close(handle)
	for e in entries {
		if e.type == .Directory do n += file_count(e.fullpath)
		else do n += 1
	}
	return n
}

@(private = "file")
hlc_on_disk :: proc(root: string) -> u64 {
	path, _ := filepath.join({root, "hlc"}, context.temp_allocator)
	data, _ := os.read_entire_file(path, context.temp_allocator)
	v, _ := strconv.parse_u64(strings.trim_space(string(data)))
	return v
}

@(private = "file")
value_json :: proc(kind: string, v: json.Value) -> json.Value {
	o := core.jobj()
	o[kind] = v
	return json.Object(o)
}

records_contract :: proc(t: ^testing.T) {
	root := fmt.aprintf("%s/glon-records-%d", os.temp_directory(context.temp_allocator), unix_ms())
	os.make_directory(root)
	defer os.remove_all(root)

	// ── Conversion on first start ─────────────────────────────────
	// A DAG-mode vault: two objects, one edited twice.
	store_init(root)
	store_invalidate()
	dag := twin_make()
	for spec in ([][3]string{{"conv-a", "note", "first"}, {"conv-b", "task", "b"}}) {
		c: core.Change
		c.object_id = spec[0]
		c.timestamp = 1_700_000_000_000
		c.author = "author-a"
		c.ops = make([dynamic]core.Operation, context.temp_allocator)
		append(&c.ops, core.Operation{kind = .Object_Create, type_key = spec[1]}, core.Operation{kind = .Field_Set, key = "name", value = core.string_value(spec[2])})
		twin_commit(t, &dag, &c)
	}
	edit: core.Change
	edit.object_id = "conv-a"
	edit.timestamp = 1_700_000_001_000
	edit.author = "author-b"
	edit.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&edit.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value("second")})
	append(&edit.ops, core.Operation{kind = .Block_Add, block = core.Block{id = "p1", content = {kind = .Text, text = {text = "para"}}}})
	twin_commit(t, &dag, &edit)
	dag_before := all_objects_json()
	changes_dir, _ := filepath.join({root, "changes"}, context.temp_allocator)
	dag_files := file_count(changes_dir)

	store_init(root, records = true)
	store_invalidate()
	converted := all_objects_json()
	for id, want in dag_before {
		got, ok := converted[id]
		testing.expectf(t, ok && got == want, "converted %s\n record: %s\n    dag: %s", id, got, want)
	}
	testing.expect(t, records_converted(), "conversion is marked done")
	testing.expect_value(t, file_count(changes_dir), dag_files) // the DAG is untouched
	rec_a, has_a := record_of("conv-a")
	testing.expect(t, has_a, "conv-a has a record on disk")
	name_entry, _ := field_entry(rec_a, "name")
	testing.expect_value(t, core.stamp_ms(name_entry.stamp.time), 1_700_000_001_000)
	testing.expect(t, name_entry.stamp.device == g_records.devices["author-b"] && name_entry.stamp.device != 0, "the stamp's device is the last writer")
	testing.expect(t, "author-a" in g_records.devices && device_id() in g_records.devices, "the device table holds every author and this device")
	testing.expect(t, g_records.hlc.last >= name_entry.stamp.time, "the clock is past every converted stamp")
	marker_path, _ := filepath.join({root, "records", RECORDS_CONVERTED_MARKER}, context.temp_allocator)
	marker_before, _ := os.read_entire_file(marker_path, context.temp_allocator)
	// A second start reads records, never converts again.
	store_init(root, records = true)
	store_invalidate()
	_ = all_objects_json()
	marker_after, _ := os.read_entire_file(marker_path, context.temp_allocator)
	testing.expect(t, string(marker_before) == string(marker_after), "conversion runs once")

	// ── Mutations: the record shows what the DAG shows ────────────
	tw := dag // the twin continues the converted history
	space := act(t, &tw, p("channel_create", {"name", "Records space"}))
	space_id := core.json_str(json.Object(space), "id")
	expect_all_same(t, &tw, "channel_create")

	note_params := p("create", {"name", "Note"}, {"type_key", "note"})
	fields := core.jobj()
	fields["channel"] = value_json("stringValue", json.String(space_id))
	fields["priority"] = value_json("intValue", json.Integer(3))
	note_params["fields"] = json.Object(fields)
	note := core.json_str(json.Object(act(t, &tw, note_params)), "id")
	task_params := p("create", {"name", "Task"}, {"type_key", "task"})
	task_fields := core.jobj()
	task_fields["channel"] = value_json("stringValue", json.String(space_id))
	task_params["fields"] = json.Object(task_fields)
	task := core.json_str(json.Object(act(t, &tw, task_params)), "id")
	expect_all_same(t, &tw, "create")

	steps := [dynamic]json.Object{}
	steps.allocator = context.temp_allocator
	set_name := p("set_field", {"object_id", note}, {"key", "name"})
	set_name["value"] = value_json("stringValue", json.String("Renamed"))
	append(&steps, set_name)
	append(&steps, set_name) // same value again: still a write
	append(&steps, p("delete_field", {"object_id", note}, {"key", "priority"}))
	for id, i in ([]string{"b1", "b2", "b3"}) {
		add := p("block_add", {"object_id", note})
		add["block"] = text_block(id, fmt.tprintf("line %d", i))
		append(&steps, add)
	}
	child := p("block_add", {"object_id", note}, {"target_id", "b1"})
	child["block"] = text_block("b1-child", "nested")
	child["position"] = json.Integer(core.POS_INNER)
	append(&steps, child)
	top := p("block_add", {"object_id", note}, {"target_id", "b1"})
	top["block"] = text_block("b0", "before b1")
	top["position"] = json.Integer(core.POS_TOP)
	append(&steps, top)
	side := p("block_add", {"object_id", note}, {"target_id", "b2"})
	side["block"] = text_block("b2-side", "beside b2")
	side["position"] = json.Integer(core.POS_RIGHT) // wraps b2 in a row of columns
	append(&steps, side)
	upd := p("block_update", {"object_id", note}, {"block_id", "b3"})
	inner := core.jobj()
	inner["text"] = json.String("line 3, edited")
	content := core.jobj()
	content["text"] = json.Object(inner)
	upd["content"] = json.Object(content)
	append(&steps, upd)
	move := p("block_move", {"object_id", note}, {"block_id", "b3"}, {"target_id", "b0"})
	move["position"] = json.Integer(core.POS_TOP)
	append(&steps, move)
	attrs := p("block_set_attrs", {"object_id", note}, {"block_id", "b0"}, {"background_color", "red"})
	attrs["align"] = json.Integer(2)
	append(&steps, attrs)
	append(&steps, p("block_remove", {"object_id", note}, {"block_id", "b2-side"})) // unwraps the row
	append(&steps, p("block_remove", {"object_id", note}, {"block_id", "b1"})) // takes its child
	append(&steps, p("chat_post", {"object_id", note}, {"text", "hello"}))
	append(&steps, p("chat_post", {"object_id", note}, {"text", "again"}))
	opened := p("conversation_open", {"object_id", task}, {"kind", "agent_private"}, {"title", "Plan"})
	people := make([dynamic]json.Value, context.temp_allocator)
	append(&people, json.String("agent-writer"), json.String("agent-editor"))
	opened["participants"] = json.Array(people)
	append(&steps, opened)
	append(&steps, p("set_type", {"object_id", task}, {"type_key", "note"}))
	rule := core.jobj()
	rule["freq"] = json.String("day")
	times := make([dynamic]json.Value, context.temp_allocator)
	append(&times, json.Integer(540))
	rule["times"] = json.Array(times)
	repeat := p("repeat_set", {"object_id", task})
	repeat["rule"] = json.Object(rule)
	append(&steps, repeat)
	append(&steps, p("occurrence_complete", {"object_id", task}))
	append(&steps, p("repeat_clear", {"object_id", task}))
	append(&steps, p("delete", {"object_id", note}))
	append(&steps, p("restore", {"object_id", note}))
	append(&steps, p("table_create", {"object_id", task}))
	// A patch carries what changed, not the object: one entry for these.
	single := []string{"set_field", "delete_field", "block_update", "block_move", "block_set_attrs", "delete"}
	for step in steps {
		action := core.json_str(json.Object(step), "action")
		act(t, &tw, step)
		expect_all_same(t, &tw, action)
		if slice.contains(single, action) {
			journal := records_journal_list()
			newest := journal[len(journal) - 1].patch
			testing.expectf(t, len(newest.entries) == 1, "%s writes one entry, not %d", action, len(newest.entries))
		}
	}
	// The second post in a thread is the message alone.
	act(t, &tw, p("chat_post", {"object_id", note}, {"text", "third"}))
	expect_same(t, &tw, note, "chat_post")
	{
		journal := records_journal_list()
		newest := journal[len(journal) - 1].patch
		testing.expectf(t, len(newest.entries) == 1 && newest.entries[0].kind == .Message, "a chat post is one message entry (%d)", len(newest.entries))
	}

	// Participants: one entry each; the stored root has none.
	thread := ""
	{
		probe := [2]string{task, ""}
		with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
			out := cast(^[2]string)user
			for b in states[out[0]].blocks do if strings.has_prefix(b.id, "__thread__") do out[1] = strings.clone(b.id, context.temp_allocator)
		}, &probe)
		thread = probe[1]
	}
	testing.expect(t, thread != "", "the task has a thread")
	rec_task, _ := record_of(task)
	writer, has_writer := field_entry(rec_task, strings.concatenate({core.record_participant_prefix(thread), "agent-writer"}, context.temp_allocator))
	editor, has_editor := field_entry(rec_task, strings.concatenate({core.record_participant_prefix(thread), "agent-editor"}, context.temp_allocator))
	testing.expect(t, has_writer && has_editor, "each participant is its own entry")
	testing.expect(t, writer.value.i == 0 && editor.value.i == 1, "entries keep the list order")
	for e in rec_task.blocks do if e.key == thread {
		conv, _ := core.decode_conversation(e.body.content.custom.data, context.temp_allocator)
		testing.expect_value(t, len(conv.participants), 0)
	}
	// Two devices join concurrently: both survive the merge.
	join :: proc(base: core.Record, task, thread, who: string, device: u32, at: i64) -> core.Patch {
		patch := core.Patch{object_id = task, entries = make([dynamic]core.Record_Entry, context.temp_allocator)}
		append(&patch.entries, core.Record_Entry{key = strings.concatenate({core.record_participant_prefix(thread), who}, context.temp_allocator), stamp = core.stamp_from_ms(at, device), kind = .Value, value = core.Value{kind = .Int, i = 2}})
		return patch
	}
	far := core.stamp_ms(g_records.hlc.last) + 1000
	left, _ := core.record_apply_patch(rec_task, join(rec_task, task, thread, "agent-x", 90, far), context.temp_allocator)
	both, _ := core.record_apply_patch(left, join(rec_task, task, thread, "agent-y", 91, far), context.temp_allocator)
	merged_view := core.record_view(both, context.temp_allocator)
	for b in merged_view.blocks do if b.id == thread {
		conv, _ := core.decode_conversation(b.content.custom.data, context.temp_allocator)
		testing.expectf(t, len(conv.participants) == 4 && conv.participants[2] == "agent-x" && conv.participants[3] == "agent-y", "concurrent joins both kept: %v", conv.participants)
	}
	for f in merged_view.fields do testing.expectf(t, !strings.has_prefix(f.key, core.RECORD_PARTICIPANT_PREFIX), "participant entries are not shown as fields: %s", f.key)

	// Directory counters: one entry per device, and another device's survives ours.
	directory := ""
	{
		probe := [2]string{"", ""}
		with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
			out := cast(^[2]string)user
			for id, s in states do for f in s.fields do if strings.has_prefix(f.key, "count:") do out[0] = strings.clone(id, context.temp_allocator)
		}, &probe)
		directory = probe[0]
	}
	testing.expect(t, directory != "", "a directory keeps counts")
	rec_dir, _ := record_of(directory)
	mine := 0
	for e in rec_dir.fields do if strings.has_prefix(e.key, "count:") {
		testing.expectf(t, strings.has_suffix(e.key, strings.concatenate({":", device_id()}, context.temp_allocator)), "a count entry names its device: %s", e.key)
		mine += 1
	}
	testing.expect(t, mine > 0, "this device's counts are entries")
	other := core.Patch{object_id = directory, entries = make([dynamic]core.Record_Entry, context.temp_allocator)}
	append(&other.entries, core.Record_Entry{key = "count:note:other-device", stamp = core.stamp_from_ms(1, 77), kind = .Value, value = core.Value{kind = .Int, i = 5}})
	with_other, _ := core.record_apply_patch(rec_dir, other, context.temp_allocator)
	other_view := core.record_view(with_other, context.temp_allocator)
	theirs, _ := core.fields_get(other_view.fields, "count:note:other-device")
	testing.expect_value(t, theirs.i, 5)
	for e in rec_dir.fields do if strings.has_prefix(e.key, "count:") && !e.gone {
		v, ok := core.fields_get(other_view.fields, e.key)
		testing.expectf(t, ok && v.i == e.value.i, "an older count from another device leaves ours (%s)", e.key)
	}

	// ── Journal: one patch per write, stamped by this device, in order ──
	journal := records_journal_list()
	committed := 0
	for c in tw.changes[len(dag.changes):] do committed += 1
	testing.expectf(t, len(journal) > 0 && len(journal) <= committed, "journal holds the writes (%d patches, %d changes)", len(journal), committed)
	last: u64
	for item in journal {
		testing.expect(t, len(item.patch.entries) > 0, "no empty patches")
		for e in item.patch.entries {
			testing.expect_value(t, e.stamp.device, g_records.local)
			testing.expectf(t, e.stamp.time > last, "journal stamps increase (%s)", item.name)
		}
		last = item.patch.entries[0].stamp.time
	}
	testing.expect(t, hlc_on_disk(root) == g_records.hlc.last && g_records.hlc.last >= last, "the clock on disk is the last stamp")

	// Every record on disk is canonical bytes.
	{
		records_dir, _ := filepath.join({root, "records"}, context.temp_allocator)
		shards, _ := os.open(records_dir)
		entries, _ := os.read_dir(shards, -1, context.temp_allocator)
		os.close(shards)
		checked := 0
		for shard in entries {
			if shard.type != .Directory || strings.has_prefix(shard.name, ".") do continue
			dir, _ := os.open(shard.fullpath)
			files, _ := os.read_dir(dir, -1, context.temp_allocator)
			os.close(dir)
			for f in files {
				data, _ := os.read_entire_file(f.fullpath, context.temp_allocator)
				r, ok := core.record_decode(data, context.temp_allocator)
				testing.expectf(t, ok && string(core.record_encode(r, context.temp_allocator)) == string(data), "%s round-trips", f.name)
				checked += 1
			}
		}
		testing.expect(t, checked > 3)
	}

	// ── Restart: the same objects; the clock only moves forward ────
	before := all_objects_json()
	clock := g_records.hlc.last
	store_init(root, records = true)
	store_invalidate()
	after := all_objects_json()
	testing.expect_value(t, len(after), len(before))
	for id, want in before do testing.expectf(t, after[id] == want, "%s survives a restart", id)
	testing.expect(t, g_records.hlc.last >= clock, "the clock reloads")
	// A change dated in the past still stamps after everything seen.
	old: core.Change
	old.object_id = note
	old.timestamp = 1
	old.author = "glon-odin"
	old.ops = make([dynamic]core.Operation, context.temp_allocator)
	append(&old.ops, core.Operation{kind = .Field_Set, key = "late", value = core.string_value("x")})
	twin_commit(t, &tw, &old)
	testing.expect(t, g_records.hlc.last > clock && hlc_on_disk(root) == g_records.hlc.last, "stamps stay monotonic across a restart")
	late_rec, _ := record_of(note)
	late, _ := field_entry(late_rec, "late")
	testing.expect_value(t, late.stamp.time, g_records.hlc.last)

	// ── Crash between journal and record: the journal repairs it ───
	journal_now := records_journal_list()
	newest := journal_now[len(journal_now) - 1]
	testing.expect_value(t, newest.patch.object_id, note)
	_ = os.remove(record_path(note))
	store_init(root, records = true)
	store_invalidate()
	repaired, ok := object_json(note)
	testing.expect(t, ok, "the record is rebuilt from the journal")
	if ok {
		v, _ := json.parse(transmute([]byte)repaired, parse_integers = true, allocator = context.temp_allocator)
		fields_json := v.(json.Object)["fields"]
		testing.expect(t, strings.contains(string(core.marshal(fields_json)), "late"), "the journal's last patch is applied")
	}

	// ── Vanish: the record goes, the DAG stays; offline only ───────
	act(t, &tw, p("vanish", {"object_id", task}))
	_, task_left := object_json(task)
	testing.expect(t, !task_left && !os.exists(record_path(task)), "a vanished object's record is purged")
	testing.expect(t, records_sync_refused("/api/changes") && records_sync_refused("/api/bases/build") && records_sync_refused("/api/sync/digest"), "sync routes refuse in record mode")
	testing.expect(t, !records_sync_refused("/api/mutate") && !records_sync_refused("/api/objects"), "local routes stay")
	testing.expect_value(t, file_count(changes_dir), dag_files) // still untouched

	store_init(root)
	testing.expect(t, !records_sync_refused("/api/changes"), "DAG mode syncs")
}
