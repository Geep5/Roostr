/**
 * Wire types shared between the app server (which reads the glon DAG)
 * and the client. Mirrors of glon's proto shapes as plain JSON.
 */

export interface ValueJSON {
	stringValue?: string;
	intValue?: number;
	floatValue?: number;
	boolValue?: boolean;
	listValue?: { values: string[] };
	mapValue?: { entries: Record<string, ValueJSON> };
	valuesValue?: { items: ValueJSON[] };
	linkValue?: { targetId: string; relationKey: string };
}

export interface MarkJSON {
	from: number;
	to: number;
	type: number;
	param?: string;
}

export interface BlockJSON {
	id: string;
	childrenIds: string[];
	content: {
		text?: { text: string; style: number; marks?: MarkJSON[]; checked?: boolean; color?: string };
		custom?: { contentType: string; meta?: Record<string, string> };
		layout?: { style: number };
		table?: Record<string, never>;
		tableColumn?: Record<string, never>;
		tableRow?: { isHeader?: boolean };
	};
	fields?: { entries: Record<string, ValueJSON> };
	align?: number;
	backgroundColor?: string;
}

export interface ObjectJSON {
	id: string;
	typeKey: string;
	fields: Record<string, ValueJSON>;
	blocks: BlockJSON[];
	deleted: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ObjectSummary {
	id: string;
	typeKey: string;
	name: string;
	updatedAt: number;
	/** Scoping space object id ("" = personal/unassigned). */
	channelId: string;
	/** Object's emoji icon ("" = none, render the type glyph). */
	icon: string;
}

export interface SpaceJSON {
	id: string;
	name: string;
	icon: string;
	pinnedIds: string[];
	members: Array<{ npub: string; role: string }>;
	keyId: number;
	createdAt: number;
	/** Drag-reorder position for the rail. Absent = fall back to createdAt. */
	order?: number;
}

export interface RelationDefJSON {
	id: string;
	key: string;
	format: string;
	name: string;
	iconEmoji?: string;
	hidden: boolean;
	readOnly: boolean;
	maxCount: number;
	options: Array<{ id: string; text: string; color: string; orderId: string }>;
}

/**
 * The substrate's own object kinds - source files, programs, agent
 * internals, infrastructure. Anytype never surfaces its system objects in
 * sets; unsourced queries and pickers exclude these (a query can still
 * target one explicitly via Source).
 */
export const SYSTEM_TYPE_KEYS = [
	"typescript",
	"program",
	"json",
	"proto",
	"relation",
	"type",
	"template",
	"agent",
	"channel",
	"peer",
	"pinned_fact",
	"milestone",
	"skill",
	"set",
	"",
] as const;

/** glon.Position values. */
export const Pos = {
	NONE: 0,
	TOP: 1,
	BOTTOM: 2,
	LEFT: 3,
	RIGHT: 4,
	INNER: 5,
	REPLACE: 6,
	INNER_FIRST: 7,
} as const;

/** glon.TextStyle values. */
export const Style = {
	PARAGRAPH: 0,
	HEADER1: 1,
	HEADER2: 2,
	HEADER3: 3,
	QUOTE: 4,
	CODE: 5,
	BULLET: 6,
	NUMBERED: 7,
	CHECKBOX: 8,
	TITLE: 9,
	TOGGLE: 10,
	CALLOUT: 11,
	DESCRIPTION: 12,
} as const;

/** glon.LayoutStyle values. */
export const Layout = { ROW: 0, COLUMN: 1, DIV: 2, HEADER: 3, TABLE_ROWS: 4, TABLE_COLUMNS: 5 } as const;

/** glon.MarkType values. */
export const MarkT = {
	BOLD: 0,
	ITALIC: 1,
	STRIKETHROUGH: 2,
	UNDERLINE: 3,
	INLINE_CODE: 4,
	LINK: 5,
	TEXT_COLOR: 6,
	BACKGROUND_COLOR: 7,
	MENTION: 8,
	OBJECT_MARK: 9,
} as const;

export function fieldStr(fields: Record<string, ValueJSON>, key: string): string {
	const v = fields[key];
	return typeof v?.stringValue === "string" ? v.stringValue : "";
}
