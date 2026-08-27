/** Object icon: the emoji when set, else the type glyph (Anytype's IconObject rule). */

export const TYPE_GLYPHS: Record<string, string> = {
	query: "▤",
	set: "▤",
	collection: "⛁",
	note: "▨",
	task: "☐",
	person: "◉",
	peer: "◉",
	agent: "◈",
	channel: "◍",
	chat: "💬",
};

export function objectIcon(emoji: string | undefined, typeKey: string): string {
	if (emoji) return emoji;
	return TYPE_GLYPHS[typeKey] ?? "•";
}
