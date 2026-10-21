package glon

// The daemon's own device record (device.odin): full, 100%, kind engine,
// named after the machine; a second write within core.DEVICE_SEEN_MS
// commits nothing. Runs inside store_durability_contract: the store is one
// global.

import "core:strings"
import "core:testing"
import "../core"

@(private = "file")
Record :: struct {
	id:      string,
	found:   bool,
	name:    string,
	kind:    string,
	holding: string,
	percent: i64,
	seen:    i64,
}

@(private = "file")
read_record :: proc() -> Record {
	out := Record{id = device_record_id()}
	with_states(proc(states: map[string]^core.Object_State, user: rawptr) {
		r := cast(^Record)user
		s, ok := states[r.id]
		if !ok || s.type_key != core.DEVICE_TYPE do return
		r.found = true
		r.name = strings.clone(core.field_string(s.fields, "name"), context.temp_allocator)
		r.kind = strings.clone(core.field_string(s.fields, "kind"), context.temp_allocator)
		r.holding = strings.clone(core.field_string(s.fields, "holding"), context.temp_allocator)
		if v, has := core.fields_get(s.fields, "percent"); has do r.percent = v.i
		if v, has := core.fields_get(s.fields, "last_seen"); has do r.seen = v.i
	}, &out)
	return out
}

device_record_contract :: proc(t: ^testing.T) {
	g_device_name = "Grant's MacBook Pro"
	device_record_write()
	r := read_record()
	testing.expect(t, r.found, "the daemon writes its device record")
	testing.expect_value(t, r.name, "Grant's MacBook Pro")
	testing.expect_value(t, r.kind, "engine")
	testing.expect_value(t, r.holding, "full")
	testing.expect_value(t, r.percent, 100)
	testing.expect(t, r.seen > 0, "last_seen set")
	head := object_heads(r.id)
	testing.expect_value(t, len(head), 1)

	// Within the cadence nothing is due: the head stays where it was.
	device_record_write()
	again := object_heads(r.id)
	testing.expect(t, len(again) == 1 && len(head) == 1 && string(again[0]) == string(head[0]), "no second write within DEVICE_SEEN_MS")
}

@(test)
host_labels :: proc(t: ^testing.T) {
	testing.expect_value(t, host_label("Grants-MacBook-Pro.local\n"), "Grants-MacBook-Pro")
	testing.expect_value(t, host_label("studio"), "studio")
	testing.expect_value(t, host_label("  "), "This computer")
}
