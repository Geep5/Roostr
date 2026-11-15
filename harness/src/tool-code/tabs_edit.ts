import type { Roostr } from "../tool-sdk";

export const description = "Change the person's open tabs in the Roostr app for a space: open objects as new tabs (last, skipping ones already open), close tabs, move one. Tab #1 is the browsing tab: it never moves, and closing it shows the space home there. Every device sees the change within seconds; which tab is selected is up to each device. Answers with the tabs as they now are.";
export const inputs = "open?: string[] - object ids (or /app/... paths) to open as tabs at the end\nclose?: string[] - object ids (or paths) of tabs to close\nmove?: object - {id, to}: move the tab showing object id (or path) to 1-based position to (2 at the earliest)\nspace?: string - space id; omit for this conversation's space";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const space = (typeof input.space === "string" ? input.space.trim() : "") || (await roostr.space());
	const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((x): x is string => typeof x === "string" && x.trim() !== "");
	const open = list(input.open);
	const close = list(input.close);
	const m = input.move;
	let move: { id: string; to: number } | undefined;
	if (m && typeof m === "object" && !Array.isArray(m)) {
		const { id, to } = m as Record<string, unknown>;
		if (typeof id !== "string" || !id || !Number.isFinite(Number(to))) return "error: nothing written. move takes {id, to}: a tab's object id (or path) and a 1-based position.";
		move = { id, to: Number(to) };
	}
	if (!open.length && !close.length && !move) return "error: nothing written. Give open, close or move.";
	let strip: string[];
	try {
		strip = await roostr.tabs.edit(space, { open, close, move });
	} catch (err) {
		return `error: nothing written. ${err instanceof Error ? err.message : String(err)}`;
	}
	for (const id of open) roostr.touch(id);
	return roostr.tabs.show(space, strip);
}
