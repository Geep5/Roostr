/**
 * Toggle-block open state — Anytype keeps it in localStorage per object
 * (lib/storage.ts checkToggle/setToggle), never in the DAG: whether a
 * toggle is expanded is a per-device viewing preference, not content.
 */

const key = (objectId: string) => `toggles-${objectId}`;

function read(objectId: string): Record<string, true> {
	try {
		return JSON.parse(localStorage.getItem(key(objectId)) ?? "{}") as Record<string, true>;
	} catch {
		return {};
	}
}

export function isToggleOpen(objectId: string, blockId: string): boolean {
	return !!read(objectId)[blockId];
}

export function setToggleOpen(objectId: string, blockId: string, open: boolean): void {
	const m = read(objectId);
	if (open) m[blockId] = true;
	else delete m[blockId];
	localStorage.setItem(key(objectId), JSON.stringify(m));
}
