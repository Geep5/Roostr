#+build !js
package core

import "core:encoding/json"
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
