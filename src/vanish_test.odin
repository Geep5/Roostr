package glon

// A vanished space takes everything in it, on every load: objects this
// replica already held, objects that land afterwards (an import or a peer
// that had not heard), and later changes that no longer carry the channel.
// System objects (no channel) and other spaces are untouched; a space this
// identity merely left is purged here but never recorded for the relays.
// Runs inside store_durability_contract: the store is one global.

import "core:encoding/json"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:testing"
import "../core"

@(private = "file")
plant :: proc(t: ^testing.T, object_id, type_key, channel: string) {
	c: core.Change
	c.object_id = object_id
	c.timestamp = 1
	c.author = "t"
	c.ops = make([dynamic]core.Operation, context.temp_allocator)
	if type_key != "" do append(&c.ops, core.Operation{kind = .Object_Create, type_key = type_key})
	append(&c.ops, core.Operation{kind = .Field_Set, key = "name", value = core.string_value(object_id)})
	if channel != "" do append(&c.ops, core.Operation{kind = .Field_Set, key = "channel", value = core.string_value(channel)})
	_, ok := commit_change(&c)
	testing.expectf(t, ok, "commit %s", object_id)
}

@(private = "file")
loaded :: proc(object_id: string) -> bool {
	Probe :: struct {
		id:    string,
		found: bool,
	}
	probe := Probe{id = object_id}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		p := cast(^Probe)user
		_, p.found = states[p.id]
	}, &probe)
	return probe.found
}

@(private = "file")
on_disk :: proc(root, object_id: string) -> bool {
	dir, _ := filepath.join({root, "changes", object_id}, context.temp_allocator)
	return os.exists(dir)
}

@(private = "file")
plan_error :: proc(action: string, fields: ..[2]string) -> string {
	params := core.jobj()
	params["action"] = json.String(action)
	for f in fields do params[f[0]] = json.String(f[1])
	_, err := native_mutation_plan(json.Object(params))
	return err
}

space_vanish_contract :: proc(t: ^testing.T) {
	root := fmt.aprintf("%s/glon-vanish-%d", os.temp_directory(context.temp_allocator), unix_ms())
	os.make_directory(root)
	defer os.remove_all(root)
	store_init(root)
	store_invalidate()

	for space in ([]string{"s1", "s2", "s3"}) do plant(t, space, "channel", "")
	plant(t, "n1", "note", "s1")
	plant(t, "n2", "note", "s2")
	plant(t, "n3", "note", "s3")
	plant(t, "sys", "note", "")
	testing.expect(t, loaded("n1") && loaded("sys"))

	// ── The owner vanishes s1: what it held goes with it ───────────
	vanish := core.mutation_vanish_ops([]string{"s1"}, 100, false)
	testing.expect(t, commit_ops(VANISH_LOG_ID, vanish[:]))
	gone := vanished_ids()
	testing.expect(t, "s1" in gone && "n1" in gone, "the space and the object in it are vanished")
	testing.expect(t, "sys" not_in gone && "n2" not_in gone, "system objects and other spaces stay")
	testing.expect(t, !loaded("n1") && !on_disk(root, "n1"), "the object in the vanished space is purged")
	testing.expect(t, loaded("sys") && loaded("n2") && on_disk(root, "sys"), "system objects and other spaces are untouched")

	// ── An object that arrives after the space vanished ────────────
	plant(t, "late-1", "note", "s1")
	testing.expect(t, !loaded("late-1") && !on_disk(root, "late-1"), "an object landing in a vanished space is dropped")
	// Its later change no longer names the space; the id alone refuses it.
	plant(t, "n1", "", "")
	testing.expect(t, !loaded("n1") && !on_disk(root, "n1"), "a channel-less change for a purged object is dropped")

	// ── The rule's ids join the ledger, so every device refuses them ─
	recorded, ok := record_space_vanished()
	testing.expect(t, ok)
	testing.expect_value(t, recorded, 2)
	testing.expect_value(t, len(g_store.vanish_pending), 0)
	ledger := vanished_ids()
	testing.expect(t, "n1" in ledger && "late-1" in ledger)

	// ── Leaving s3 purges here, records nothing ────────────────────
	leave := core.mutation_vanish_ops([]string{"s3"}, 300, true, core.LEFT_KEY_PREFIX)
	testing.expect(t, commit_ops(VANISH_LOG_ID, leave[:]))
	gone = vanished_ids()
	testing.expect(t, gone["s3"].left, "a left space is marked left")
	testing.expect(t, !loaded("n3") && !on_disk(root, "n3"), "objects of a left space leave this replica")
	testing.expect(t, "n3" not_in g_store.vanish_pending, "a left space's objects are never recorded for deletion")
	recorded, ok = record_space_vanished()
	testing.expect(t, ok && recorded == 0)

	// ── Nothing can be written into a vanished space ───────────────
	testing.expect_value(t, plan_error("delete_field", {"object_id", "sys"}, {"key", "name"}), "")
	testing.expect_value(t, plan_error("delete_field", {"object_id", "n2"}, {"key", "name"}), "")
	err := plan_error("seed_space_defaults", {"channel_id", "s1"})
	testing.expect(t, strings.has_prefix(err, "space ") && strings.contains(err, "was deleted"), err)
	err = plan_error("delete_field", {"object_id", "late-1"}, {"key", "name"})
	testing.expect(t, strings.has_prefix(err, "object ") && strings.contains(err, "was deleted"), err)
}
