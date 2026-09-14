package core

// Recurring objects. Any object may carry a `repeat` field: the rule the
// user edits plus the scheduler's bookkeeping, in one map value so every
// replica sees the same occurrence and the same "already fired" mark.
//
//   repeat: {
//     freq: "day"|"week"|"month"|"year", interval: n,
//     weekdays: [0..6] (week), monthly: "date"|"weekday" (month),
//     time: minutes after local midnight, tz: IANA name (informational),
//     anchor: ms of the day the cadence counts from (start of local day),
//     next: ms of the current occurrence,
//     fired_for / fired_at / fired_by: idempotency mark for `next`,
//     last_done, last_skipped, count, last_run: {at, machine, conversation, error}
//   }
//
// A recurring object is never done: completing it advances `next`. Time
// zones are the host's problem - it passes its current UTC offset and the
// engine does wall-clock arithmetic in that offset. Offsets are refreshed on
// every completion, so a DST change is off by an hour for one occurrence.

import "core:encoding/json"
import "core:strings"

REPEAT_KEY :: "repeat"
REPEAT_DAY_MS :: 86_400_000
REPEAT_MIN_MS :: 60_000

Repeat_Rule :: struct {
	freq:     string,
	interval: i64,
	weekdays: [dynamic]i64,
	monthly:  string,
	time:     i64,
	tz:       string,
	anchor:   i64, // local-day index (days since 1970-01-01 in the wall clock)
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
	if rule.freq != "week" do return true
	if len(rule.weekdays) == 0 do return weekday_of_day(day) == weekday_of_day(rule.anchor)
	for wd in rule.weekdays do if wd == weekday_of_day(day) do return true
	return false
}

/** Next occurrence day strictly after `from`, keeping the cadence aligned to the anchor. */
repeat_step :: proc(rule: Repeat_Rule, from: i64) -> i64 {
	interval := max(rule.interval, 1)
	switch rule.freq {
	case "week":
		week_start :: proc(day: i64) -> i64 { return day - weekday_of_day(day) }
		w0 := week_start(rule.anchor)
		for day := from + 1; day < from + 7 * interval * 2 + 7; day += 1 {
			weeks := (week_start(day) - w0) / 7
			if weeks % interval == 0 && repeat_day_fits(rule, day) do return day
		}
		return from + 7 * interval
	case "month":
		y, m, d := civil_from_days(from)
		ay, _, ad := civil_from_days(rule.anchor)
		_ = ay
		total := y * 12 + (m - 1) + interval
		ny, nm := total / 12, total % 12 + 1
		if rule.monthly == "weekday" do return nth_weekday_day(ny, nm, weekday_of_day(rule.anchor), ordinal_in_month(rule.anchor))
		_ = d
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

/** First occurrence: the anchor day itself when it fits and its time is still ahead of `now_local_ms`. */
repeat_first :: proc(rule: Repeat_Rule, now_local_ms: i64) -> i64 {
	if repeat_day_fits(rule, rule.anchor) && rule.anchor * REPEAT_DAY_MS + rule.time * REPEAT_MIN_MS > now_local_ms do return rule.anchor
	return repeat_step(rule, rule.anchor)
}

/** Occurrence strictly after `from` whose time is still ahead of `now_local_ms` (skips missed ones). */
repeat_advance :: proc(rule: Repeat_Rule, from: i64, now_local_ms: i64) -> i64 {
	day := repeat_step(rule, from)
	for i := 0; i < 5000 && day * REPEAT_DAY_MS + rule.time * REPEAT_MIN_MS <= now_local_ms; i += 1 do day = repeat_step(rule, day)
	return day
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

repeat_rule_from_value :: proc(v: Value) -> (rule: Repeat_Rule, ok: bool) {
	if v.kind != .Map do return
	rule.freq = repeat_entry_str(v, "freq")
	rule.interval, _ = repeat_entry_int(v, "interval")
	rule.monthly = repeat_entry_str(v, "monthly")
	rule.tz = repeat_entry_str(v, "tz")
	rule.time, _ = repeat_entry_int(v, "time")
	rule.anchor, _ = repeat_entry_int(v, "anchor")
	rule.weekdays = make([dynamic]i64, context.temp_allocator)
	if wd, present := repeat_entry(v, "weekdays"); present && wd.kind == .List {
		for item in wd.items do if item.kind == .Int do append(&rule.weekdays, item.i)
	}
	return rule, repeat_rule_valid(rule)
}

repeat_rule_valid :: proc(rule: Repeat_Rule) -> bool {
	switch rule.freq {
	case "day", "week", "month", "year":
	case:
		return false
	}
	if rule.interval < 1 || rule.interval > 999 do return false
	if rule.time < 0 || rule.time >= 24 * 60 do return false
	for wd in rule.weekdays do if wd < 0 || wd > 6 do return false
	if rule.freq == "month" && rule.monthly != "date" && rule.monthly != "weekday" do return false
	return true
}

/** The rule as a JSON `rule` object: {freq, interval, weekdays, monthly, time, tz, anchor_ms?}. */
repeat_rule_from_json :: proc(v: json.Value, tz_offset_min: i64, default_anchor_local_ms: i64) -> (rule: Repeat_Rule, ok: bool) {
	rule.freq = json_str(v, "freq")
	rule.interval, _ = json_int(v, "interval")
	if _, present := json_field(v, "interval"); !present do rule.interval = 1
	rule.monthly = json_str(v, "monthly")
	if rule.monthly == "" do rule.monthly = "date"
	rule.tz = json_str(v, "tz")
	rule.time, _ = json_int(v, "time")
	rule.weekdays = make([dynamic]i64, context.temp_allocator)
	for item in json_array(v, "weekdays") {
		if n, is_int := item.(i64); is_int do append(&rule.weekdays, n)
		else if f, is_float := item.(json.Float); is_float do append(&rule.weekdays, i64(f))
	}
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

/** Builds the stored map: the rule plus bookkeeping carried over from `previous` (or fresh). */
repeat_value :: proc(rule: Repeat_Rule, next_day: i64, tz_offset_min: i64, previous: Value, has_previous: bool) -> Value {
	v := Value{kind = .Map}
	v.entries = make([dynamic]Value_Entry, context.temp_allocator)
	put :: proc(v: ^Value, key: string, value: Value) { append(&v.entries, Value_Entry{key = key, value = value}) }
	put(&v, "freq", string_value(rule.freq))
	put(&v, "interval", int_value(rule.interval))
	weekdays := make([dynamic]Value, context.temp_allocator)
	for wd in rule.weekdays do append(&weekdays, int_value(wd))
	put(&v, "weekdays", list_value(weekdays[:]))
	put(&v, "monthly", string_value(rule.monthly))
	put(&v, "time", int_value(rule.time))
	put(&v, "tz", string_value(rule.tz))
	put(&v, "anchor", int_value(rule.anchor))
	put(&v, "next", int_value(repeat_local_to_ms(next_day, rule.time, tz_offset_min)))
	if has_previous {
		for key in ([]string{"last_done", "last_skipped", "count", "last_run"}) {
			if e, ok := repeat_entry(previous, key); ok do put(&v, key, mutation_clone_value(e))
		}
	}
	return v
}

repeat_local_to_ms :: proc(day: i64, time_min: i64, tz_offset_min: i64) -> i64 {
	return day * REPEAT_DAY_MS + time_min * REPEAT_MIN_MS - tz_offset_min * REPEAT_MIN_MS
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

/** Completing or skipping the current occurrence advances `next` past now. */
repeat_advance_ops :: proc(current: Value, now_ms, tz_offset_min: i64, mark: string) -> (Value, string) {
	rule, ok := repeat_rule_from_value(current)
	if !ok do return {}, "object has no valid repeat rule"
	next_ms, has_next := repeat_entry_int(current, "next")
	if !has_next do return {}, "repeat has no current occurrence"
	now_local := now_ms + tz_offset_min * REPEAT_MIN_MS
	current_day := floor_div(next_ms + tz_offset_min * REPEAT_MIN_MS, REPEAT_DAY_MS)
	next_day := repeat_advance(rule, current_day, now_local)
	out := repeat_with(current, "next", int_value(repeat_local_to_ms(next_day, rule.time, tz_offset_min)))
	out = repeat_with(out, mark, int_value(now_ms))
	if mark == "last_done" {
		count, _ := repeat_entry_int(out, "count")
		out = repeat_with(out, "count", int_value(count + 1))
	}
	for key in ([]string{"fired_for", "fired_at", "fired_by"}) do out = repeat_without(out, key)
	return out, ""
}

repeat_result :: proc(plan: ^Mutation_Plan, v: Value) {
	next, _ := repeat_entry_int(v, "next")
	plan.result["next"] = json.Integer(next)
}
