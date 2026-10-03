/**
 * A repeating object's rule as people and the engine's occurrence planner
 * see it: the words the Repeat cell shows, and the local clock the planner
 * takes to put occurrences in this computer's time.
 */
import type { ValueJSON } from "./api";

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Minutes after local midnight as a clock time: 570 -> "9:30 AM". */
function clockTime(minutes: number): string {
	return new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * An object's repeat rule in the words the Repeat cell uses, with its next
 * occurrence: "every 2 weeks on Wed at 9:00 AM, 1:00 PM · next Wed, Oct 8,
 * 9:00 AM", "every 5 minutes on Mon, Tue from 9:00 AM to 5:00 PM · next ...".
 */
export function describeRepeat(v: ValueJSON | undefined): string {
	const e = v?.mapValue?.entries;
	if (!e) return "does not repeat";
	const ints = (key: string): number[] => (e[key]?.valuesValue?.items ?? []).map((i) => i.intValue ?? 0);
	const freq = e["freq"]?.stringValue ?? "";
	const every = e["interval"]?.intValue ?? 1;
	const unit = every === 1 ? freq : `${every} ${freq}s`;
	const days = ints("weekdays").map((i) => WEEKDAY_NAMES[i] ?? "").map((d) => d.charAt(0).toUpperCase() + d.slice(1));
	const subDaily = freq === "minute" || freq === "hour";
	let at: string;
	if (subDaily) {
		const [from = 0, until = 1439] = ints("window");
		at = from === 0 && until === 1439 ? "" : ` from ${clockTime(from)} to ${clockTime(until)}`;
	} else {
		// Rules written before several times a day carry one `time`.
		const times = e["times"] ? ints("times") : [e["time"]?.intValue ?? 0];
		at = ` at ${times.map(clockTime).join(", ")}`;
	}
	const next = e["next"]?.intValue;
	const on = (freq === "week" || subDaily) && days.length ? ` on ${days.join(", ")}` : "";
	const when = next ? ` · next ${new Date(next).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "";
	return `every ${unit}${on}${at}${when}`;
}

/** The occurrence planner's clock params: now, and this machine's UTC offset. */
export function localClock(): { now_ms: number; tz_offset_min: number } {
	return { now_ms: Date.now(), tz_offset_min: -new Date().getTimezoneOffset() };
}
