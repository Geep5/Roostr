package core

// Recurring objects. Any object may carry a `repeat` field: the rule the
// user edits plus the scheduler's bookkeeping, in one map value so every
// replica sees the same occurrence and the same "already fired" mark.
//
//   repeat: {
//     freq: "minute"|"hour"|"day"|"week"|"month"|"year", interval: n,
//     weekdays: [0..6] (week: which days; minute/hour: only these days, [] = every day),
//     monthly: "date"|"weekday" (month),
//     times: [minutes after local midnight] (day/week/month/year: every time on each day it runs),
//     slots: [[minutes], …] (day/week/month/year, interval >= 2, optional): one per
//       period of the cycle - "every 3 days" as Day 1, Day 2, Day 3 - each with
//       its own times, [] = that period is off; `times` then holds their union.
//       Absent: only the cycle's first period runs, at `times`.
//     window: [from, until] minutes after local midnight (minute/hour: the grid
//       runs from..until each day, restarting at `from`; after: runs wait for
//       it; absent = the whole day),
//     after: true (freq minute/hour/day): a quiet timer, not a calendar - each
//       run is `interval` units after the newest message in the object's chat
//       (anyone's, the agent's own included): every message restarts the
//       clock (chat_post), and a run with no reply since runs again after
//       the same wait. A run that would land outside `window` waits for it.
//     tz_offset (after): the UTC offset (minutes) the rule was last set or run
//       in, for the clock a chat message restarts when its writer sends none,
//     tz: IANA name (informational),
//     anchor: ms of the day the cadence counts from (start of local day),
//     next: ms of the current occurrence,
//     fired_for / fired_at / fired_by: idempotency mark for `next`,
//     last_done, count, last_run: {at, machine, conversation, error}
//   }
//
// Rules stored before `times` carry a single `time`; it reads as [time].
//
// A recurring object is never done: completing it advances `next`. Time
// zones are the host's problem - it passes its current UTC offset and the
// engine does wall-clock arithmetic in that offset. Offsets are refreshed on
// every completion, so a DST change is off by an hour for one occurrence.

import "core:encoding/json"
import "core:slice"
import "core:strconv"
import "core:strings"

REPEAT_KEY :: "repeat"
REPEAT_DAY_MS :: 86_400_000
REPEAT_MIN_MS :: 60_000
REPEAT_DAY_MIN :: 1440

Repeat_Rule :: struct {
	freq:       string,
	interval:   i64,
	weekdays:   [dynamic]i64,
	monthly:    string,
	times:      [dynamic]i64, // sorted, unique (day/week/month/year); with slots, their union
	slots:      [dynamic][dynamic]i64, // per period of the cycle (len = interval), each sorted, unique; empty = none
	win_from:   i64, // minute/hour grid window, minutes after local midnight
	win_until:  i64,
	tz:         string,
	anchor:     i64, // local-day index (days since 1970-01-01 in the wall clock)
	after:      bool, // quiet timer: `interval` x `freq` after the newest chat message
}

/** The wait of a quiet-timer rule, in minutes. */
repeat_after_minutes :: proc(rule: Repeat_Rule) -> i64 {
	unit: i64 = rule.freq == "day" ? REPEAT_DAY_MIN : rule.freq == "hour" ? 60 : 1
	return max(rule.interval, 1) * unit
}

/** Local minute `at`, or the next start of the rule's window when `at` falls outside it. */
repeat_in_window :: proc(rule: Repeat_Rule, at: i64) -> i64 {
	day := floor_div(at, REPEAT_DAY_MIN)
	minute := at - day * REPEAT_DAY_MIN
	if minute < rule.win_from do return day * REPEAT_DAY_MIN + rule.win_from
	if minute > rule.win_until do return (day + 1) * REPEAT_DAY_MIN + rule.win_from
	return at
}

/** A quiet-timer rule's run (local minute): the wait after local minute `from`, inside the window. */
repeat_after_next :: proc(rule: Repeat_Rule, from: i64) -> i64 {
	return repeat_in_window(rule, from + repeat_after_minutes(rule))
}

repeat_sub_daily :: proc(rule: Repeat_Rule) -> bool {
	return rule.freq == "minute" || rule.freq == "hour"
}

// ── Civil dates (proleptic Gregorian, Howard Hinnant's algorithms) ──

days_from_civil :: proc(y, m, d: i64) -> i64 {
	y := y
	if m <= 2 do y -= 1
	era := (y >= 0 ? y : y - 399) / 400
	yoe := y - era * 400
	mp := (m + 9) % 12
	doy := (153 * mp + 2) / 5 + d - 1
	doe := yoe * 365 + yoe / 4 - yoe / 100 + doy
	return era * 146097 + doe - 719468
}

civil_from_days :: proc(z: i64) -> (y, m, d: i64) {
	z := z + 719468
	era := (z >= 0 ? z : z - 146096) / 146097
	doe := z - era * 146097
	yoe := (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
	y = yoe + era * 400
	doy := doe - (365 * yoe + yoe / 4 - yoe / 100)
	mp := (5 * doy + 2) / 153
	d = doy - (153 * mp + 2) / 5 + 1
	m = mp < 10 ? mp + 3 : mp - 9
	if m <= 2 do y += 1
	return
}

// 0 = Sunday. 1970-01-01 was a Thursday.
weekday_of_day :: proc(day: i64) -> i64 {
	return ((day + 4) % 7 + 7) % 7
}

days_in_month :: proc(y, m: i64) -> i64 {
	return days_from_civil(m == 12 ? y + 1 : y, m == 12 ? 1 : m + 1, 1) - days_from_civil(y, m, 1)
}

/** Ordinal of a day within its month's weekday sequence: 1..4, or 5 for "last". */
ordinal_in_month :: proc(day: i64) -> i64 {
	y, m, d := civil_from_days(day)
	if d + 7 > days_in_month(y, m) do return 5
	return (d - 1) / 7 + 1
}

nth_weekday_day :: proc(y, m, weekday, ordinal: i64) -> i64 {
	if ordinal == 5 {
		day := days_from_civil(y, m, days_in_month(y, m))
		for weekday_of_day(day) != weekday do day -= 1
		return day
	}
	day := days_from_civil(y, m, 1)
	for weekday_of_day(day) != weekday do day += 1
	return day + 7 * (ordinal - 1)
}

// ── Rule stepping (all in local-day indices) ──

repeat_day_fits :: proc(rule: Repeat_Rule, day: i64) -> bool {
	if repeat_sub_daily(rule) {
		if len(rule.weekdays) == 0 do return true
	} else if rule.freq != "week" do return true
	if len(rule.weekdays) == 0 do return weekday_of_day(day) == weekday_of_day(rule.anchor)
	for wd in rule.weekdays do if wd == weekday_of_day(day) do return true
	return false
}

repeat_slotted :: proc(rule: Repeat_Rule) -> bool {
	return len(rule.slots) > 0
}

repeat_week_start :: proc(day: i64) -> i64 { return day - weekday_of_day(day) }

/** Which period of the cycle `day` is in (0 = the anchor's), for slots. */
repeat_slot_of :: proc(rule: Repeat_Rule, day: i64) -> int {
	periods: i64
	switch rule.freq {
	case "week":
		periods = (repeat_week_start(day) - repeat_week_start(rule.anchor)) / 7
	case "month":
		y, m, _ := civil_from_days(day)
		ay, am, _ := civil_from_days(rule.anchor)
		periods = (y * 12 + m) - (ay * 12 + am)
	case "year":
		y, _, _ := civil_from_days(day)
		ay, _, _ := civil_from_days(rule.anchor)
		periods = y - ay
	case:
		periods = day - rule.anchor
	}
	n := i64(len(rule.slots))
	return int(((periods % n) + n) % n)
}

/** Next occurrence day strictly after `from`, keeping the cadence aligned to the anchor. */
repeat_step :: proc(rule: Repeat_Rule, from: i64) -> i64 {
	// Slots: every period is a candidate (its slot says whether, and when).
	interval := repeat_slotted(rule) ? 1 : max(rule.interval, 1)
	switch rule.freq {
	case "minute", "hour":
		// The interval spaces times within a day; every allowed day runs.
		for day := from + 1; day <= from + 7; day += 1 do if repeat_day_fits(rule, day) do return day
		return from + 1
	case "week":
		w0 := repeat_week_start(rule.anchor)
		for day := from + 1; day < from + 7 * interval * 2 + 7; day += 1 {
			weeks := (repeat_week_start(day) - w0) / 7
			if weeks % interval == 0 && repeat_day_fits(rule, day) do return day
		}
		return from + 7 * interval
	case "month":
		y, m, _ := civil_from_days(from)
		_, _, ad := civil_from_days(rule.anchor)
		total := y * 12 + (m - 1) + interval
		ny, nm := total / 12, total % 12 + 1
		if rule.monthly == "weekday" do return nth_weekday_day(ny, nm, weekday_of_day(rule.anchor), ordinal_in_month(rule.anchor))
		return days_from_civil(ny, nm, min(ad, days_in_month(ny, nm)))
	case "year":
		y, _, _ := civil_from_days(from)
		_, am, ad := civil_from_days(rule.anchor)
		ny := y + interval
		return days_from_civil(ny, am, min(ad, days_in_month(ny, am)))
	case:
		return from + interval
	}
}

/** The occurrence times (minutes after local midnight, ascending) on `day`, a day the rule may run (none: its slot is off). */
repeat_day_times :: proc(rule: Repeat_Rule, day: i64) -> [dynamic]i64 {
	if repeat_slotted(rule) do return rule.slots[repeat_slot_of(rule, day)]
	if !repeat_sub_daily(rule) do return rule.times
	out := make([dynamic]i64, context.temp_allocator)
	period := max(rule.interval, 1) * (rule.freq == "hour" ? 60 : 1)
	for t := rule.win_from; t <= rule.win_until; t += period do append(&out, t)
	return out
}

/**
 * First occurrence (a local minute index) strictly after local minute
 * `after`, walking occurrence days from `day` - which must itself be a day
 * the rule runs.
 */
repeat_next_after :: proc(rule: Repeat_Rule, day: i64, after: i64) -> i64 {
	d := day
	for i := 0; i < 5000; i += 1 {
		for t in repeat_day_times(rule, d) do if d * REPEAT_DAY_MIN + t > after do return d * REPEAT_DAY_MIN + t
		d = repeat_step(rule, d)
	}
	last := repeat_day_times(rule, d)
	return d * REPEAT_DAY_MIN + (len(last) > 0 ? last[0] : rule.times[0])
}

/** First occurrence (local minute): on the anchor day when it fits and a time is still ahead of `now_local_ms`. */
repeat_first :: proc(rule: Repeat_Rule, now_local_ms: i64) -> i64 {
	day := repeat_day_fits(rule, rule.anchor) ? rule.anchor : repeat_step(rule, rule.anchor)
	return repeat_next_after(rule, day, floor_div(now_local_ms, REPEAT_MIN_MS))
}

/** Occurrence (local minute) after `current` whose time is still ahead of `now_local_ms` (skips missed ones). */
repeat_advance :: proc(rule: Repeat_Rule, current: i64, now_local_ms: i64) -> i64 {
	return repeat_next_after(rule, floor_div(current, REPEAT_DAY_MIN), max(current, floor_div(now_local_ms, REPEAT_MIN_MS)))
}

// ── Value <-> rule ──

repeat_entry :: proc(v: Value, key: string) -> (Value, bool) {
	if v.kind != .Map do return {}, false
	return fields_get(v.entries, key)
}

repeat_entry_int :: proc(v: Value, key: string) -> (i64, bool) {
	e, ok := repeat_entry(v, key)
	if !ok do return 0, false
	#partial switch e.kind {
	case .Int: return e.i, true
	case .Float: return i64(e.f), true
	}
	return 0, false
}

repeat_entry_str :: proc(v: Value, key: string) -> string {
	e, ok := repeat_entry(v, key)
	if ok && e.kind == .String do return e.str
	return ""
}

/** Times as stored: sorted and de-duplicated, so the walk can stop at the first later one. */
repeat_sorted_times :: proc(times: ^[dynamic]i64) {
	slice.sort(times[:])
	kept := 0
	for t, i in times do if i == 0 || t != times[kept - 1] { times[kept] = t; kept += 1 }
	resize(times, kept)
}

repeat_rule_from_value :: proc(v: Value) -> (rule: Repeat_Rule, ok: bool) {
	if v.kind != .Map do return
	rule.freq = repeat_entry_str(v, "freq")
	rule.interval, _ = repeat_entry_int(v, "interval")
	rule.monthly = repeat_entry_str(v, "monthly")
	rule.tz = repeat_entry_str(v, "tz")
	rule.anchor, _ = repeat_entry_int(v, "anchor")
	rule.weekdays = make([dynamic]i64, context.temp_allocator)
	if wd, present := repeat_entry(v, "weekdays"); present && wd.kind == .List {
		for item in wd.items do if item.kind == .Int do append(&rule.weekdays, item.i)
	}
	rule.times = make([dynamic]i64, context.temp_allocator)
	if ts, present := repeat_entry(v, "times"); present && ts.kind == .List {
		for item in ts.items do if item.kind == .Int do append(&rule.times, item.i)
	} else if t, has_time := repeat_entry_int(v, "time"); has_time {
		append(&rule.times, t)
	}
	repeat_sorted_times(&rule.times)
	rule.slots = make([dynamic][dynamic]i64, context.temp_allocator)
	if ss, present := repeat_entry(v, "slots"); present && ss.kind == .List {
		for slot in ss.items {
			times := make([dynamic]i64, context.temp_allocator)
			if slot.kind == .List do for item in slot.items do if item.kind == .Int do append(&times, item.i)
			append(&rule.slots, times)
		}
	}
	repeat_settle_slots(&rule)
	rule.win_from, rule.win_until = 0, REPEAT_DAY_MIN - 1
	if w, present := repeat_entry(v, "window"); present && w.kind == .List && len(w.items) == 2 && w.items[0].kind == .Int && w.items[1].kind == .Int {
		rule.win_from, rule.win_until = w.items[0].i, w.items[1].i
	}
	if a, present := repeat_entry(v, "after"); present && a.kind == .Bool do rule.after = a.b
	return rule, repeat_rule_valid(rule)
}

/** Slots sorted and de-duplicated, `times` their union; none at all when no period but the first has a time (that is the plain rule). */
repeat_settle_slots :: proc(rule: ^Repeat_Rule) {
	if len(rule.slots) == 0 do return
	for &slot in rule.slots do repeat_sorted_times(&slot)
	others := false
	for slot, i in rule.slots do if i > 0 && len(slot) > 0 do others = true
	if !others {
		if len(rule.slots[0]) > 0 {
			clear(&rule.times)
			append(&rule.times, ..rule.slots[0][:])
		}
		clear(&rule.slots)
		return
	}
	clear(&rule.times)
	for slot in rule.slots do append(&rule.times, ..slot[:])
	repeat_sorted_times(&rule.times)
}

repeat_rule_valid :: proc(rule: Repeat_Rule) -> bool {
	switch rule.freq {
	case "minute", "hour", "day", "week", "month", "year":
	case:
		return false
	}
	if rule.interval < 1 || rule.interval > 999 do return false
	for wd in rule.weekdays do if wd < 0 || wd > 6 do return false
	if rule.after {
		if rule.freq != "minute" && rule.freq != "hour" && rule.freq != "day" do return false
		return rule.win_from >= 0 && rule.win_until < REPEAT_DAY_MIN && rule.win_from <= rule.win_until
	}
	if repeat_sub_daily(rule) {
		if rule.win_from < 0 || rule.win_until >= REPEAT_DAY_MIN || rule.win_from > rule.win_until do return false
		if rule.freq == "hour" && rule.interval > 23 do return false
		return true
	}
	if len(rule.times) == 0 do return false
	for t in rule.times do if t < 0 || t >= REPEAT_DAY_MIN do return false
	if repeat_slotted(rule) && i64(len(rule.slots)) != rule.interval do return false
	if rule.freq == "month" && rule.monthly != "date" && rule.monthly != "weekday" do return false
	return true
}

/** The rule as a JSON `rule` object: {freq, interval, weekdays, monthly, times, window, tz, anchor_ms?}. */
repeat_rule_from_json :: proc(v: json.Value, tz_offset_min: i64, default_anchor_local_ms: i64) -> (rule: Repeat_Rule, ok: bool) {
	rule.freq = json_str(v, "freq")
	rule.interval, _ = json_int(v, "interval")
	if _, present := json_field(v, "interval"); !present do rule.interval = 1
	rule.monthly = json_str(v, "monthly")
	if rule.monthly == "" do rule.monthly = "date"
	rule.tz = json_str(v, "tz")
	json_ints :: proc(v: json.Value, key: string) -> [dynamic]i64 {
		out := make([dynamic]i64, context.temp_allocator)
		for item in json_array(v, key) {
			if n, is_int := item.(i64); is_int do append(&out, n)
			else if f, is_float := item.(json.Float); is_float do append(&out, i64(f))
		}
		return out
	}
	rule.weekdays = json_ints(v, "weekdays")
	if a, is_bool := json_bool(v, "after"); is_bool do rule.after = a
	rule.times = json_ints(v, "times")
	repeat_sorted_times(&rule.times)
	rule.slots = make([dynamic][dynamic]i64, context.temp_allocator)
	if !rule.after && !repeat_sub_daily(rule) && rule.interval >= 2 {
		for slot in json_array(v, "slots") {
			times := make([dynamic]i64, context.temp_allocator)
			if items, is_array := slot.(json.Array); is_array {
				for item in items {
					if n, is_int := item.(i64); is_int do append(&times, n)
					else if f, is_float := item.(json.Float); is_float do append(&times, i64(f))
				}
			}
			append(&rule.slots, times)
		}
	}
	repeat_settle_slots(&rule)
	rule.win_from, rule.win_until = 0, REPEAT_DAY_MIN - 1
	if window := json_ints(v, "window"); len(window) == 2 do rule.win_from, rule.win_until = window[0], window[1]
	anchor_local := default_anchor_local_ms
	if anchor_ms, present := json_int(v, "anchor_ms"); present do anchor_local = anchor_ms + tz_offset_min * REPEAT_MIN_MS
	rule.anchor = floor_div(anchor_local, REPEAT_DAY_MS)
	if rule.freq == "week" && len(rule.weekdays) == 0 do append(&rule.weekdays, weekday_of_day(rule.anchor))
	return rule, repeat_rule_valid(rule)
}

floor_div :: proc(a, b: i64) -> i64 {
	q := a / b
	if (a % b != 0) && ((a < 0) != (b < 0)) do q -= 1
	return q
}

/** Builds the stored map: the rule plus bookkeeping carried over from `previous` (or fresh). `next_local` is a local minute index. */
repeat_value :: proc(rule: Repeat_Rule, next_local: i64, tz_offset_min: i64, previous: Value, has_previous: bool) -> Value {
	v := Value{kind = .Map}
	v.entries = make([dynamic]Value_Entry, context.temp_allocator)
	put :: proc(v: ^Value, key: string, value: Value) { append(&v.entries, Value_Entry{key = key, value = value}) }
	ints :: proc(xs: []i64) -> Value {
		out := make([dynamic]Value, context.temp_allocator)
		for x in xs do append(&out, int_value(x))
		return list_value(out[:])
	}
	put(&v, "freq", string_value(rule.freq))
	put(&v, "interval", int_value(rule.interval))
	put(&v, "weekdays", ints(rule.weekdays[:]))
	put(&v, "monthly", string_value(rule.monthly))
	if rule.after {
		put(&v, "after", bool_value(true))
		put(&v, "window", ints([]i64{rule.win_from, rule.win_until}))
	} else if repeat_sub_daily(rule) do put(&v, "window", ints([]i64{rule.win_from, rule.win_until}))
	else do put(&v, "times", ints(rule.times[:]))
	if repeat_slotted(rule) {
		slots := make([dynamic]Value, context.temp_allocator)
		for slot in rule.slots do append(&slots, ints(slot[:]))
		put(&v, "slots", list_value(slots[:]))
	}
	put(&v, "tz", string_value(rule.tz))
	put(&v, "anchor", int_value(rule.anchor))
	if rule.after do put(&v, "tz_offset", int_value(tz_offset_min))
	put(&v, "next", int_value(repeat_local_to_ms(next_local, tz_offset_min)))
	if has_previous {
		for key in ([]string{"last_done", "count", "last_run"}) {
			if e, ok := repeat_entry(previous, key); ok do put(&v, key, mutation_clone_value(e))
		}
	}
	return v
}

repeat_local_to_ms :: proc(local_min: i64, tz_offset_min: i64) -> i64 {
	return (local_min - tz_offset_min) * REPEAT_MIN_MS
}

/** Copy of `v` with `key` replaced (or added). */
repeat_with :: proc(v: Value, key: string, value: Value) -> Value {
	out := mutation_clone_value(v)
	for &e in out.entries do if e.key == key { e.value = value; return out }
	append(&out.entries, Value_Entry{key = strings.clone(key, context.temp_allocator), value = value})
	return out
}

repeat_without :: proc(v: Value, key: string) -> Value {
	out := mutation_clone_value(v)
	kept := make([dynamic]Value_Entry, context.temp_allocator)
	for e in out.entries do if e.key != key do append(&kept, e)
	out.entries = kept
	return out
}

// ── Planner entry points ──

repeat_state_value :: proc(input: Mutation_Input, object_id: string) -> (Value, bool) {
	s, ok := input.states[object_id]
	if !ok do return {}, false
	return fields_get(s.fields, REPEAT_KEY)
}

/** Shared params: now_ms (default the change timestamp) and tz_offset_min (default 0 = UTC wall clock). */
repeat_clock :: proc(parsed: json.Value, input: Mutation_Input) -> (now_ms, tz_offset_min: i64) {
	now_ms, _ = json_int(parsed, "now_ms")
	if _, present := json_field(parsed, "now_ms"); !present do now_ms = input.timestamp
	tz_offset_min, _ = json_int(parsed, "tz_offset_min")
	return
}

/** Completing the current occurrence advances `next` past now and counts it. */
repeat_advance_ops :: proc(current: Value, now_ms, tz_offset_min: i64) -> (Value, string) {
	rule, ok := repeat_rule_from_value(current)
	if !ok do return {}, "object has no valid repeat rule"
	next_ms, has_next := repeat_entry_int(current, "next")
	if !has_next do return {}, "repeat has no current occurrence"
	now_local := now_ms + tz_offset_min * REPEAT_MIN_MS
	next_after: i64
	if rule.after {
		// A quiet timer runs again the same wait after this run, unless a
		// message (its own reply, usually) restarted the clock later still.
		next_after = repeat_local_to_ms(repeat_after_next(rule, floor_div(now_local, REPEAT_MIN_MS)), tz_offset_min)
		if next_ms > now_ms do next_after = max(next_after, next_ms)
	} else if moved, was_moved := repeat_entry(current, "moved"); was_moved {
		// A moved run (occurrence_move) sits off the rule's days: the rule
		// picks up from the occurrence it displaced - that one itself when
		// it is still ahead (moved earlier), else the first after now.
		from, _ := repeat_entry_int(moved, "from")
		from_local := floor_div(from, REPEAT_MIN_MS) + tz_offset_min
		next_after = from > now_ms ? repeat_local_to_ms(from_local, tz_offset_min) : repeat_local_to_ms(repeat_advance(rule, from_local, now_local), tz_offset_min)
	} else {
		current_local := floor_div(next_ms, REPEAT_MIN_MS) + tz_offset_min
		next_after = repeat_local_to_ms(repeat_advance(rule, current_local, now_local), tz_offset_min)
	}
	out := repeat_with(current, "next", int_value(next_after))
	out = repeat_with(out, "last_done", int_value(now_ms))
	count, _ := repeat_entry_int(out, "count")
	out = repeat_with(out, "count", int_value(count + 1))
	if rule.after do out = repeat_with(out, "tz_offset", int_value(tz_offset_min))
	for key in ([]string{"fired_for", "fired_at", "fired_by", "moved"}) do out = repeat_without(out, key)
	return out, ""
}

/**
 * A chat message at `at_ms` on an object whose repeat is a quiet timer:
 * the clock restarts there - the next run is the wait after it, in the
 * window. `tz_offset_min` is the writer's (the rule's last when it sent
 * none). An occurrence that fired and is still open stays as it is: its run
 * is answering, and finishing it restarts the clock (repeat_advance_ops).
 */
repeat_after_message :: proc(current: Value, at_ms: i64, tz_offset_min: i64) -> (Value, bool) {
	rule, ok := repeat_rule_from_value(current)
	if !ok || !rule.after do return {}, false
	next_ms, _ := repeat_entry_int(current, "next")
	if fired_for, fired := repeat_entry_int(current, "fired_for"); fired && fired_for == next_ms do return {}, false
	at_local := floor_div(at_ms, REPEAT_MIN_MS) + tz_offset_min
	next := repeat_local_to_ms(repeat_after_next(rule, at_local), tz_offset_min)
	if next == next_ms do return {}, false
	out := repeat_with(current, "next", int_value(next))
	out = repeat_without(out, "moved")
	return out, true
}

/** The newest message (ms) in the object's human chat, 0 when it has none. */
repeat_last_message :: proc(s: ^Object_State) -> i64 {
	newest: i64 = 0
	for b in s.blocks {
		if b.id != DISCUSSION_ID do continue
		for child in b.children_ids {
			for m in s.blocks {
				if m.id != child || m.content.kind != .Custom || m.content.custom.content_type != "chat" do continue
				for pair in m.content.custom.meta do if pair.key == "ts" {
					if ts, parsed := strconv.parse_i64(pair.value); parsed do newest = max(newest, ts)
				}
			}
		}
	}
	return newest
}

/**
 * Move the next run, once, to `date` ("YYYY-MM-DD", local) at the rule's
 * own time, recording {from, at, by, reason} as `moved`; the rule itself is
 * untouched and picks up again after that run (repeat_advance_ops). An
 * occurrence that fired and is still open is finished by the move - its
 * run is what decided to check again later.
 */
repeat_move_ops :: proc(current: Value, date: string, by: string, reason: string, now_ms, tz_offset_min: i64) -> (Value, string) {
	rule, ok := repeat_rule_from_value(current)
	if !ok do return {}, "object has no valid repeat rule"
	if len(date) != 10 || date[4] != '-' || date[7] != '-' do return {}, "date must be YYYY-MM-DD"
	y, m, d := strconv.parse_i64(date[0:4]) or_else -1, strconv.parse_i64(date[5:7]) or_else -1, strconv.parse_i64(date[8:10]) or_else -1
	if y < 1970 || m < 1 || m > 12 || d < 1 || d > 31 do return {}, "date must be YYYY-MM-DD"
	day := days_from_civil(y, m, d)
	times := repeat_day_times(rule, day)
	at_min := len(times) > 0 ? times[0] : (len(rule.times) > 0 ? rule.times[0] : 0)
	target := repeat_local_to_ms(day * REPEAT_DAY_MIN + at_min, tz_offset_min)
	if target <= now_ms do return {}, "that run would be in the past"
	if target > now_ms + 366 * REPEAT_DAY_MS do return {}, "a run can move at most a year ahead"
	out := current
	next_ms, _ := repeat_entry_int(current, "next")
	if fired_for, fired := repeat_entry_int(current, "fired_for"); fired && fired_for == next_ms {
		advanced, err := repeat_advance_ops(current, now_ms, tz_offset_min)
		if err != "" do return {}, err
		out = advanced
	}
	// Moved twice: the rule still resumes from the occurrence first displaced.
	from, _ := repeat_entry_int(out, "next")
	if prior, was := repeat_entry(out, "moved"); was do from, _ = repeat_entry_int(prior, "from")
	moved := Value{kind = .Map}
	moved.entries = make([dynamic]Value_Entry, context.temp_allocator)
	append(&moved.entries, Value_Entry{key = "from", value = int_value(from)}, Value_Entry{key = "at", value = int_value(now_ms)})
	if by != "" do append(&moved.entries, Value_Entry{key = "by", value = string_value(by)})
	if reason != "" do append(&moved.entries, Value_Entry{key = "reason", value = string_value(reason)})
	out = repeat_with(out, "next", int_value(target))
	out = repeat_with(out, "moved", moved)
	return out, ""
}

repeat_result :: proc(plan: ^Mutation_Plan, v: Value) {
	next, _ := repeat_entry_int(v, "next")
	plan.result["next"] = json.Integer(next)
}
