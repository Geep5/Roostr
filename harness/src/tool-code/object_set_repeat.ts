import type { Roostr } from "../tool-sdk";

export const description = "Make an object repeat, or change how it repeats - exactly what the Repeat cell on the object sets. Every `every` `unit`s. day/week/month/year: it runs at each of `times` (local HH:MM, default 09:00) on every day it runs - several times a day is one rule; weekly rules may name weekdays. minute/hour: it runs every `every` minutes/hours from `from` to `until` (local HH:MM, default the whole day), optionally only on `weekdays`. start is the first day (ISO date, default today). Each occurrence runs through an agent on the object's guest list. The reply is the rule and next occurrence as the human sees them.";
export const inputs = "id?: string - object id; omit for the object of this conversation\nevery?: number - interval, default 1 (1-999; hours 1-23)\nunit: minute|hour|day|week|month|year\ntimes?: string[] - day/week/month/year: local HH:MM times (24h) it runs on each day it runs; default [\"09:00\"]\nfrom?: string - minute/hour: local HH:MM the day's runs start; default 00:00\nuntil?: string - minute/hour: local HH:MM of the day's last possible run; default 23:59\nweekdays?: string[] - mon..sun. week: which days (default the start day's weekday); minute/hour: only these days (default every day)\nmonthly?: date|weekday - monthly only: same date (default) or same nth weekday\nstart?: string - first day, ISO date; default today";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const asText = (v: unknown): string => (typeof v === "string" ? v : "");
	/** "HH:MM" (24h) as minutes after midnight, or null. */
	const minutesOf = (hhmm: string): number | null => {
		const hm = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
		if (!hm || Number(hm[1]) > 23 || Number(hm[2]) > 59) return null;
		return Number(hm[1]) * 60 + Number(hm[2]);
	};
	const id = asText(input.id) || roostr.context.objectId;
	if (!id) return "error: nothing written. No object id and this turn is not running on an object.";
	const obj = await roostr.writable(id);
	roostr.touch(obj.id);
	const unit = asText(input.unit);
	if (!["minute", "hour", "day", "week", "month", "year"].includes(unit)) return `error: nothing written. unit must be minute, hour, day, week, month or year, not "${unit}".`;
	const subDaily = unit === "minute" || unit === "hour";
	const most = unit === "hour" ? 23 : 999;
	const every = input.every === undefined ? 1 : Number(input.every);
	if (!Number.isInteger(every) || every < 1 || every > most) return `error: nothing written. every must be a whole number from 1 to ${most}.`;
	const weekdays: number[] = [];
	for (const w of Array.isArray(input.weekdays) ? input.weekdays.filter((x): x is string => typeof x === "string") : []) {
		const i = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(w.trim().toLowerCase().slice(0, 3));
		if (i < 0) return `error: nothing written. "${w}" is not a weekday (mon..sun).`;
		weekdays.push(i);
	}
	const rule: Record<string, unknown> = {
		freq: unit,
		interval: every,
		weekdays: unit === "week" || subDaily ? weekdays : [],
		monthly: asText(input.monthly) === "weekday" ? "weekday" : "date",
		tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
	if (subDaily) {
		if (input.times !== undefined) return `error: nothing written. times is for day, week, month and year; a ${unit} rule runs from "from" to "until".`;
		const from = minutesOf(asText(input.from) || "00:00");
		const until = minutesOf(asText(input.until) || "23:59");
		if (from === null || until === null || from > until) return `error: nothing written. from and until must be HH:MM (24h) with from before until, not "${asText(input.from)}" - "${asText(input.until)}".`;
		rule.window = [from, until];
	} else {
		if (input.from !== undefined || input.until !== undefined) return `error: nothing written. from/until are for minute and hour rules; a ${unit} rule runs at its times.`;
		const raw = input.times === undefined ? ["09:00"] : Array.isArray(input.times) ? input.times.filter((x): x is string => typeof x === "string") : [];
		const times = raw.map(minutesOf);
		const bad = raw.find((_, i) => times[i] === null);
		if (raw.length === 0 || bad !== undefined) return `error: nothing written. times must be one or more HH:MM (24h)${bad === undefined ? "" : `, not "${bad}"`}.`;
		rule.times = times;
	}
	if (asText(input.start)) {
		const d = new Date(`${asText(input.start).slice(0, 10)}T12:00:00`);
		if (Number.isNaN(d.getTime())) return `error: nothing written. start must be an ISO date, not "${asText(input.start)}".`;
		// Noon, like the Repeat editor: the anchor lands on that local day whatever the UTC offset.
		rule.anchor_ms = d.getTime();
	}
	await roostr.mutate("repeat_set", { object_id: obj.id, rule, ...roostr.clock() });
	const after = await roostr.get(obj.id);
	const who = roostr.guests(after.fields).length ? "" : " No agent is on its guest list, so nothing runs each occurrence until one is added (object_set_field key=agent).";
	return `Repeats ${roostr.describeRepeat(after.fields["repeat"])}.${who}`;
}
