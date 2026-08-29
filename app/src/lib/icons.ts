/** Object icon: the emoji when set, else the type glyph (Anytype's IconObject rule). */

export const TYPE_GLYPHS: Record<string, string> = {
	// Anytype bundle equivalents (heart types.json iconNames as emoji).
	page: "📄",
	note: "📝",
	task: "✅",
	person: "👤",
	project: "🔨",
	bookmark: "🔖",
	query: "🔍",
	set: "🔍",
	collection: "🗂️",
	skill: "🛠️",
	peer: "◉",
	agent: "◈",
	channel: "◍",
	chat: "💬",
};

export function objectIcon(emoji: string | undefined, typeKey: string): string {
	if (emoji) return emoji;
	return TYPE_GLYPHS[typeKey] ?? "•";
}
