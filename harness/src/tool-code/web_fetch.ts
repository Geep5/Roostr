import type { Roostr } from "../tool-sdk";

export const description =
	"Fetch a live web page through this machine's headless Chrome (renders JavaScript) and return its text. Use for looking things up on the web - profiles, docs, articles. If the capability is unavailable the call files a holdup for the human and tells you so - relay that honestly and continue without it.";
export const inputs = "url: string - absolute http(s) URL";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const url = (typeof input.url === "string" ? input.url : "").trim();
	if (!/^https?:\/\//i.test(url)) return "error: url must be absolute http(s)";
	const page = await roostr.webPage(url);
	if (!page.ok) {
		return page.unavailable
			? `Capability unavailable: ${page.reason}. A holdup has been filed - the human will see it in the Machine panel and can fix it there. Tell them plainly; do not retry this turn.`
			: `Capability failed: ${page.reason}. A holdup has been filed for the human in the Machine panel. Tell them plainly.`;
	}
	// Crude but honest DOM -> text: scripts/styles out, links kept with their targets, tags out, whitespace collapsed.
	const html = page.html;
	const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, body: string) => `${body.replace(/<[^>]+>/g, "")} (${href}) `)
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s*\n\s*/g, "\n")
		.trim();
	return ((title ? `[title] ${title}\n` : "") + text).slice(0, 14_000) || "(page rendered empty)";
}
