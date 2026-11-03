#+build !js
package core

import "core:encoding/json"
import "core:strings"
import "core:testing"

@(private = "file")
PIN_OBJECTS :: `[
	{"id":"s","typeKey":"channel","fields":[],"blocks":[],"deleted":false,"createdAt":1,"updatedAt":1,"heads":[]},
	{"id":"a","typeKey":"task","fields":[["channel",{"stringValue":"s"}],["pin_order",{"stringValue":"V"}]],"blocks":[],"deleted":false,"createdAt":2,"updatedAt":2,"heads":[]},
	{"id":"b","typeKey":"task","fields":[["channel",{"stringValue":"s"}]],"blocks":[],"deleted":false,"createdAt":3,"updatedAt":3,"heads":[]}
]`

@(private = "file")
pin_run :: proc(t: ^testing.T, action, id: string) -> string {
	src := strings.concatenate({`{"action":"`, action, `","params":{"object_id":"`, id, `"},"objects":`, PIN_OBJECTS, `,"timestamp":10,"author":"me","id_seed":"n","key_id":0}`}, context.temp_allocator)
	payload, _ := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	out, err := mutation_dispatch(payload)
	testing.expectf(t, err == "", "%s", err)
	changes, _ := json_field(out, "changes")
	return string(marshal(changes))
}

@(test)
pin_puts_an_object_last_and_unpin_takes_it_off :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	pinned := pin_run(t, "pin", "b")
	testing.expect(t, strings.contains(pinned, `"pin_order"`), pinned)
	key := pin_key_between("V", "", false)
	testing.expect(t, key > "V" && strings.contains(pinned, strings.concatenate({`"`, key, `"`})), pinned)
	testing.expect_value(t, pin_run(t, "pin", "a"), "[]")
	testing.expect(t, strings.contains(pin_run(t, "unpin", "a"), "fieldDelete"))
	testing.expect_value(t, pin_run(t, "unpin", "b"), "[]")
}
