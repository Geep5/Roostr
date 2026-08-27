/**
 * Embed processor detection + URL transforms, ported from Anytype's
 * lib/util/embed.ts (domain regexps, youtube path extraction incl. shorts
 * and ?t= start offsets, youtube-nocookie embed host).
 */

export type EmbedProcessor = "youtube" | "vimeo" | "spotify";

const DOMAINS: Record<EmbedProcessor, string[]> = {
	youtube: ["youtube\\.com", "youtu\\.be", "youtube-nocookie\\.com"],
	vimeo: ["vimeo\\.com"],
	spotify: ["spotify\\.com", "open\\.spotify\\.com"],
};

const REGEXPS = Object.entries(DOMAINS).map(([p, domains]) => ({
	processor: p as EmbedProcessor,
	re: new RegExp(`://([^.]*\\.)?(${domains.join("|")})([/\\?#:]|$)`, "i"),
}));

/** Anytype getProcessorByUrl: first matching domain, with per-site limits
 * (youtube channel/hashtag pages are not embeddable). */
export function getProcessorByUrl(url: string): EmbedProcessor | null {
	for (const { processor, re } of REGEXPS) {
		if (!re.test(url)) continue;
		if (processor === "youtube") {
			try {
				const info = new URL(url);
				if (/^\/@/.test(info.pathname) || /\/hashtag\//.test(info.pathname)) return null;
			} catch {
				return null;
			}
		}
		return processor;
	}
	return null;
}

/** Anytype getYoutubePath: video id + optional ?t= start. */
function youtubePath(url: string): string {
	url = url.replace(/\/shorts\//, "/watch?v=");
	const pm = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/);
	const tm = url.match(/(\?t=|&t=)(\d+)/);
	if (!pm || !pm[2].length) return "";
	return pm[2] + (tm && tm[2].length ? `?start=${tm[2]}` : "");
}

/** Anytype getParsedUrl: the iframe src for a raw URL. */
export function getEmbedUrl(processor: EmbedProcessor, url: string): string {
	switch (processor) {
		case "youtube":
			return `https://www.youtube-nocookie.com/embed/${youtubePath(url)}`;
		case "vimeo": {
			try {
				const u = new URL(url);
				return `https://player.vimeo.com/video${u.pathname}`;
			} catch {
				return url;
			}
		}
		case "spotify": {
			try {
				const u = new URL(url);
				return `https://open.spotify.com/embed${u.pathname}`;
			} catch {
				return url;
			}
		}
	}
}

/** A pasted string that is exactly one http(s) URL. */
export function isSingleUrl(text: string): boolean {
	const t = text.trim();
	return /^https?:\/\/\S+$/.test(t) && !t.includes("\n");
}
