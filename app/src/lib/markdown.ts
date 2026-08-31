/**
 * Minimal, safe markdown renderer for chat messages (Discussion).
 * Escapes all input, then applies a chat-appropriate subset:
 * fenced code blocks, inline code, bold, italic, strikethrough,
 * links (+ bare URLs), lists, blockquotes, headings, paragraphs.
 * No dependency, no raw HTML passthrough.
 */

const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function safeHref(url: string): string {
	const u = url.trim();
	if (/^(https?:|mailto:)/i.test(u)) return u;
	if (/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u)) return `https://${u}`; // bare domain
	return "";
}

function inline(s: string): string {
	let out = escapeHtml(s);
	// inline code first (contents protected from other transforms)
	const codes: string[] = [];
	out = out.replace(/`([^`\n]+)`/g, (_, c) => {
		codes.push(`<code class="ic">${c}</code>`);
		return `\x00C${codes.length - 1}\x00`;
	});
	out = out
		.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
		.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>")
		.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>")
		.replace(/~~([^~]+)~~/g, "<s>$1</s>")
		// [text](url)
		.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
			const href = safeHref(u.replace(/&amp;/g, "&"));
			return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${t}</a>` : t;
		})
		// bare URLs
		.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
	return out.replace(/\x00C(\d+)\x00/g, (_, i) => codes[Number(i)] ?? "");
}

export function renderMarkdown(src: string): string {
	// 1) extract fenced code blocks
	const blocks: string[] = [];
	const text = src.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
		blocks.push(
			`<pre class="cb">${lang ? `<span class="cb-lang">${escapeHtml(lang)}</span>` : ""}<code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`,
		);
		return `\n\x00B${blocks.length - 1}\x00\n`;
	});

	// 2) block structure: headings, quotes, lists, paragraphs
	const lines = text.split("\n");
	const out: string[] = [];
	let para: string[] = [];
	let list: { tag: "ul" | "ol"; items: Array<{ text: string; check: "" | "todo" | "done" }> } | null = null;
	let quote: string[] = [];
	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${para.map(inline).join("<br>")}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			const tasky = list.items.some((i) => i.check);
			const cls = tasky ? ' class="md-tasks"' : "";
			const li = (i: { text: string; check: string }) =>
				i.check
					? `<li class="md-task${i.check === "done" ? " md-done" : ""}"><span class="md-cb">${i.check === "done" ? "\u2713" : ""}</span><span>${inline(i.text)}</span></li>`
					: `<li>${inline(i.text)}</li>`;
			out.push(`<${list.tag}${cls}>${list.items.map(li).join("")}</${list.tag}>`);
			list = null;
		}
	};
	const flushQuote = () => {
		if (quote.length) {
			out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
			quote = [];
		}
	};
	const flushAll = () => {
		flushPara();
		flushList();
		flushQuote();
	};

	for (const line of lines) {
		const blockMatch = line.match(/^\x00B(\d+)\x00$/);
		if (blockMatch) {
			flushAll();
			out.push(blocks[Number(blockMatch[1])] ?? "");
			continue;
		}
		const h = line.match(/^(#{1,3})\s+(.*)$/);
		if (h) {
			flushAll();
			out.push(`<div class="md-h md-h${h[1].length}">${inline(h[2])}</div>`);
			continue;
		}
		if (/^\s*[-*_]{3,}\s*$/.test(line)) {
			flushAll();
			out.push("<hr>");
			continue;
		}
		const ul = line.match(/^\s*[-*]\s+(.*)$/);
		const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
		if (ul || ol) {
			flushPara();
			flushQuote();
			const tag = ul ? "ul" : "ol";
			if (!list || list.tag !== tag) flushList(), (list = { tag, items: [] });
			let item = (ul ?? ol)![1];
			let check: "" | "todo" | "done" = "";
			const task = ul && item.match(/^\[( |x|X)\]\s+(.*)$/);
			if (task) {
				check = task[1] === " " ? "todo" : "done";
				item = task[2];
			}
			list!.items.push({ text: item, check });
			continue;
		}
		const q = line.match(/^>\s?(.*)$/);
		if (q) {
			flushPara();
			flushList();
			quote.push(q[1]);
			continue;
		}
		if (line.trim() === "") {
			flushAll();
			continue;
		}
		flushList();
		flushQuote();
		para.push(line);
	}
	flushAll();
	return out.join("");
}
