#+build !js
package core

import "core:encoding/json"
import "core:strings"
import "core:testing"

@(private = "file")
slot_rule :: proc(t: ^testing.T, src: string, anchor_day: i64) -> (Repeat_Rule, bool) {
	v, err := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	testing.expect(t, err == nil, src)
	return repeat_rule_from_json(v, 0, anchor_day * REPEAT_DAY_MS)
}

/** The first `n` occurrences (local minutes) from the start of the anchor day. */
@(private = "file")
walk :: proc(rule: Repeat_Rule, n: int) -> [dynamic]i64 {
	out := make([dynamic]i64, context.temp_allocator)
	at := repeat_first(rule, rule.anchor * REPEAT_DAY_MS)
	for len(out) < n {
		append(&out, at)
		at = repeat_advance(rule, at, at * REPEAT_MIN_MS)
	}
	return out
}

@(test)
repeat_slots_give_each_day_of_the_cycle_its_own_times :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	day := days_from_civil(2026, 11, 2) // a Monday
	// Every 3 days: Day 1 at 9:00, Day 2 off, Day 3 at 14:00 and 18:00.
	rule, ok := slot_rule(t, `{"freq":"day","interval":3,"times":[540],"slots":[[540],[],[840,1080]]}`, day)
	testing.expect(t, ok)
	got := walk(rule, 5)
	want := []i64{day * 1440 + 540, (day + 2) * 1440 + 840, (day + 2) * 1440 + 1080, (day + 3) * 1440 + 540, (day + 5) * 1440 + 840}
	testing.expectf(t, slice_eq(got[:], want), "got %v want %v", got, want)
	testing.expect(t, len(rule.times) == 3, "times is the slots' union")
}

@(test)
repeat_slots_per_week_of_the_cycle :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	monday := days_from_civil(2026, 11, 2)
	// Every 2 weeks on Monday: week 1 at 9:00, week 2 at 10:00.
	rule, ok := slot_rule(t, `{"freq":"week","interval":2,"weekdays":[1],"times":[540],"slots":[[540],[600]]}`, monday)
	testing.expect(t, ok)
	got := walk(rule, 3)
	want := []i64{monday * 1440 + 540, (monday + 7) * 1440 + 600, (monday + 14) * 1440 + 540}
	testing.expectf(t, slice_eq(got[:], want), "got %v want %v", got, want)
}

@(test)
repeat_slots_with_only_the_first_period_are_the_plain_rule :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	day := days_from_civil(2026, 11, 2)
	rule, ok := slot_rule(t, `{"freq":"day","interval":3,"times":[540],"slots":[[540],[],[]]}`, day)
	testing.expect(t, ok && !repeat_slotted(rule))
	got := walk(rule, 2)
	testing.expect(t, slice_eq(got[:], []i64{day * 1440 + 540, (day + 3) * 1440 + 540}))
	stored := repeat_value(rule, got[0], 0, {}, false)
	_, has_slots := repeat_entry(stored, "slots")
	testing.expect(t, !has_slots, "a plain rule stores no slots")
}

@(test)
repeat_slots_round_trip_and_must_match_the_interval :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	day := days_from_civil(2026, 11, 2)
	rule, ok := slot_rule(t, `{"freq":"day","interval":2,"times":[540],"slots":[[540],[600]]}`, day)
	testing.expect(t, ok)
	back, back_ok := repeat_rule_from_value(repeat_value(rule, day * 1440 + 540, 0, {}, false))
	testing.expect(t, back_ok && len(back.slots) == 2 && len(back.slots[1]) == 1 && back.slots[1][0] == 600)
	_, wrong := slot_rule(t, `{"freq":"day","interval":3,"times":[540],"slots":[[540],[600]]}`, day)
	testing.expect(t, !wrong, "two slots for every 3 days")
}

@(private = "file")
slice_eq :: proc(a, b: []i64) -> bool {
	if len(a) != len(b) do return false
	for x, i in a do if x != b[i] do return false
	return true
}

@(private = "file")
after_rule :: proc(t: ^testing.T, src: string) -> Repeat_Rule {
	v, err := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	testing.expect(t, err == nil, src)
	rule, ok := repeat_rule_from_json(v, 0, 0)
	testing.expect(t, ok, src)
	return rule
}

@(test)
repeat_after_waits_from_the_last_message_inside_its_window :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	day := days_from_civil(2026, 11, 6) * REPEAT_DAY_MIN
	// Two days after the last message, only between 9:00 and 18:00.
	rule := after_rule(t, `{"freq":"day","interval":2,"after":true,"window":[540,1080]}`)
	testing.expect_value(t, repeat_after_next(rule, day + 600), day + 2 * REPEAT_DAY_MIN + 600)
	// Landing at 20:00 waits for the next 9:00; landing at 7:00 for that day's.
	testing.expect_value(t, repeat_after_next(rule, day + 1200), day + 3 * REPEAT_DAY_MIN + 540)
	testing.expect_value(t, repeat_after_next(rule, day + 420), day + 2 * REPEAT_DAY_MIN + 540)
	// A calendar-only setting has no meaning here, and a quiet timer needs a wait unit up to days.
	_, weekly := repeat_rule_from_json(json.parse(transmute([]byte)string(`{"freq":"week","after":true}`), parse_integers = true, allocator = context.temp_allocator) or_else nil, 0, 0)
	testing.expect(t, !weekly)
}

@(test)
repeat_after_restarts_on_each_message_and_after_each_run :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	day := days_from_civil(2026, 11, 6) * REPEAT_DAY_MIN
	rule := after_rule(t, `{"freq":"hour","interval":3,"after":true}`)
	at := proc(local_min: i64) -> i64 { return local_min * REPEAT_MIN_MS }
	stored := repeat_value(rule, day + 600, 0, {}, false)
	// A message at 11:00 restarts the clock: the run is 14:00.
	moved, restarted := repeat_after_message(stored, at(day + 660), 0)
	testing.expect(t, restarted)
	next, _ := repeat_entry_int(moved, "next")
	testing.expect_value(t, next, at(day + 840))
	// The run fired: a message while it is open (its own reply) leaves it to finish.
	fired := repeat_with(moved, "fired_for", int_value(next))
	_, during := repeat_after_message(fired, at(day + 845), 0)
	testing.expect(t, !during)
	// Finishing it with no reply since waits the same again from now.
	done, err := repeat_advance_ops(fired, at(day + 850), 0)
	testing.expect_value(t, err, "")
	again, _ := repeat_entry_int(done, "next")
	testing.expect_value(t, again, at(day + 850 + 180))
	// A calendar rule is not restarted by messages.
	calendar := repeat_value(after_rule(t, `{"freq":"day","interval":1,"times":[540]}`), day + 540, 0, {}, false)
	_, cal := repeat_after_message(calendar, at(day + 660), 0)
	testing.expect(t, !cal)
}

@(test)
repeat_after_chat_post_restarts_in_the_same_change :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	src := `{"action":"chat_post","params":{"object_id":"q","text":"hi","tz_offset_min":0},"objects":[{"id":"q","typeKey":"query","fields":[["repeat",{"mapValue":{"entries":{"freq":{"stringValue":"day"},"interval":{"intValue":1},"after":{"boolValue":true},"window":{"valuesValue":{"items":[{"intValue":0},{"intValue":1439}]}},"next":{"intValue":5}}}}]],"blocks":[],"deleted":false,"createdAt":1,"updatedAt":1,"heads":[]}],"timestamp":60000,"author":"me","id_seed":"n","key_id":0}`
	payload, _ := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	out, err := mutation_dispatch(payload)
	testing.expectf(t, err == "", "%s", err)
	changes, _ := json_field(out, "changes")
	text := string(marshal(changes))
	// A day after the message at minute 1: minute 1441.
	testing.expect(t, strings.contains(text, `"repeat"`) && strings.contains(text, "86460000"), text)
}

@(test)
repeat_after_set_counts_from_the_newest_message_when_it_is_ahead_of_now :: proc(t: ^testing.T) {
	context.allocator = context.temp_allocator
	// The last message (minute 10) is newer than "now" (minute 1): an hour after it is minute 70.
	src := `{"action":"repeat_set","params":{"object_id":"q","rule":{"freq":"hour","interval":1,"after":true},"now_ms":60000,"tz_offset_min":0},"objects":[{"id":"q","typeKey":"query","fields":[],"blocks":[{"id":"__discussion__","childrenIds":["m1","m2"],"content":{"custom":{"contentType":"discussion","meta":{}}}},{"id":"m1","content":{"custom":{"contentType":"chat","meta":{"author":"a","ts":"120000","text":"x"}}}},{"id":"m2","content":{"custom":{"contentType":"chat","meta":{"author":"b","ts":"600000","text":"y"}}}}],"deleted":false,"createdAt":1,"updatedAt":1,"heads":[]}],"timestamp":60000,"author":"me","id_seed":"n","key_id":0}`
	payload, _ := json.parse(transmute([]byte)src, parse_integers = true, allocator = context.temp_allocator)
	out, err := mutation_dispatch(payload)
	testing.expectf(t, err == "", "%s", err)
	result, _ := json_field(out, "result")
	next, _ := json_int(result, "next")
	testing.expect_value(t, next, i64(70 * REPEAT_MIN_MS))
}
