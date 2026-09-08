/**
 * In-app tabs - Anytype's tab bar mapped onto the web app.
 *
 * Browser model: the ACTIVE tab follows navigation (opening an object from
 * the sidebar replaces the active tab's content, like a browser tab), and
 * "Open in new tab" adds a background tab. Per-window, persisted to
 * localStorage so a reload restores the strip.
 */
import { goto } from "$app/navigation";
import { browser } from "$app/environment";

const KEY = "glon.tabs";
export const HOME_PATH = "/";

export interface Tab {
	uid: number;
	path: string;
}

let nextUid = 1;

class TabStrip {
	list = $state<Tab[]>([]);
	active = $state(0);

	constructor() {
		if (!browser) return;
		try {
			const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { paths: string[]; active: number } | null;
			if (raw && Array.isArray(raw.paths) && raw.paths.length) {
				this.list = raw.paths.map((path) => ({ uid: nextUid++, path }));
				this.active = Math.min(Math.max(0, raw.active | 0), raw.paths.length - 1);
			}
		} catch {
			// corrupted store - start fresh
		}
	}

	private save(): void {
		if (!browser) return;
		localStorage.setItem(KEY, JSON.stringify({ paths: this.list.map((t) => t.path), active: this.active }));
	}

	/** Route changed: the active tab absorbs it (first load creates the tab). */
	sync(path: string): void {
		if (this.list.length === 0) {
			this.list = [{ uid: nextUid++, path }];
			this.active = 0;
			this.save();
			return;
		}
		const cur = this.list[this.active];
		if (cur.path !== path) {
			cur.path = path;
			this.save();
		}
	}

	/** Add a tab; background by default (browser convention for context-menu opens). */
	open(path: string, background = true): void {
		this.list.push({ uid: nextUid++, path });
		if (!background) {
			this.active = this.list.length - 1;
			void goto(path);
		}
		this.save();
	}

	activate(i: number): void {
		if (i < 0 || i >= this.list.length || i === this.active) return;
		this.active = i;
		this.save();
		void goto(this.list[i].path);
	}

	close(i: number): void {
		if (this.list.length === 0) return;
		const wasActive = i === this.active;
		this.list.splice(i, 1);
		if (this.list.length === 0) {
			this.list = [{ uid: nextUid++, path: HOME_PATH }];
			this.active = 0;
			this.save();
			void goto(HOME_PATH);
			return;
		}
		if (i < this.active) this.active--;
		else if (wasActive) {
			this.active = Math.min(this.active, this.list.length - 1);
			void goto(this.list[this.active].path);
		}
		this.save();
	}
}

export const tabs = new TabStrip();
