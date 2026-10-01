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
//     window: [from, until] minutes after local midnight (minute/hour: the grid
//       runs from..until each day, restarting at `from`; absent = the whole day),
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
	times:      [dynamic]i64, // sorted, unique (day/week/month/year)
	win_from:   i64, // minute/hour grid window, minutes after local midnight
	win_until:  i64,
	tz:         string,
	anchor:     i64, // local-day index (days since 1970-01-01 in the wall clock)
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

/** Next occurrence day strictly after `from`, keeping the cadence aligned to the anchor. */
repeat_step :: proc(rule: Repeat_Rule, from: i64) -> i64 {
	interval := max(rule.interval, 1)
	switch rule.freq {
	case "minute", "hour":
		// The interval spaces times within a day; every allowed day runs.
		for day := from + 1; day <= from + 7; day += 1 do if repeat_day_fits(rule, day) do return day
		return from + 1
	case "week":
		week_start :: proc(day: i64) -> i64 { return day - weekday_of_day(day) }
		w0 := week_start(rule.anchor)
		for day := from + 1; day < from + 7 * interval * 2 + 7; day += 1 {
			weeks := (week_start(day) - w0) / 7
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

/** The occurrence times (minutes after local midnight, ascending) on a day the rule runs. */
repeat_day_times :: proc(rule: Repeat_Rule) -> [dynamic]i64 {
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
	times := repeat_day_times(rule)
	d := day
	for i := 0; i < 5000; i += 1 {
		for t in times do if d * REPEAT_DAY_MIN + t > after do return d * REPEAT_DAY_MIN + t
		d = repeat_step(rule, d)
	}
	return d * REPEAT_DAY_MIN + times[0]
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
	rule.win_from, rule.win_until = 0, REPEAT_DAY_MIN - 1
	if w, present := repeat_entry(v, "window"); present && w.kind == .List && len(w.items) == 2 && w.items[0].kind == .Int && w.items[1].kind == .Int {
		rule.win_from, rule.win_until = w.items[0].i, w.items[1].i
	}
	return rule, repeat_rule_valid(rule)
}

repeat_rule_valid :: proc(rule: Repeat_Rule) -> bool {
	switch rule.freq {
	case "minute", "hour", "day", "week", "month", "year":
	case:
		return false
	}
	if rule.interval < 1 || rule.interval > 999 do return false
	for wd in rule.weekdays do if wd < 0 || wd > 6 do return false
	if repeat_sub_daily(rule) {
		if rule.win_from < 0 || rule.win_until >= REPEAT_DAY_MIN || rule.win_from > rule.win_until do return false
		if rule.freq == "hour" && rule.interval > 23 do return false
		return true
	}
	if len(rule.times) == 0 do return false
	for t in rule.times do if t < 0 || t >= REPEAT_DAY_MIN do return false
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
	rule.times = json_ints(v, "times")
	repeat_sorted_times(&rule.times)
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
	if repeat_sub_daily(rule) do put(&v, "window", ints([]i64{rule.win_from, rule.win_until}))
	else do put(&v, "times", ints(rule.times[:]))
	put(&v, "tz", string_value(rule.tz))
	put(&v, "anchor", int_value(rule.anchor))
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
	current_local := floor_div(next_ms, REPEAT_MIN_MS) + tz_offset_min
	next_local := repeat_advance(rule, current_local, now_local)
	out := repeat_with(current, "next", int_value(repeat_local_to_ms(next_local, tz_offset_min)))
	out = repeat_with(out, "last_done", int_value(now_ms))
	count, _ := repeat_entry_int(out, "count")
	out = repeat_with(out, "count", int_value(count + 1))
	for key in ([]string{"fired_for", "fired_at", "fired_by"}) do out = repeat_without(out, key)
	return out, ""
}

repeat_result :: proc(plan: ^Mutation_Plan, v: Value) {
	next, _ := repeat_entry_int(v, "next")
	plan.result["next"] = json.Integer(next)
}
