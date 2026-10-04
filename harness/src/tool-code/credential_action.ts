import type { Roostr } from "../tool-sdk";

export const description =
	"Act as a signed-in account through one of YOUR credentials (the Credentials property). The 'Your credentials' section lists each credential's actions as `key - what it does and returns (read|write)`; pass that credential's `service` and one of its action keys, with the inputs the summary names (`url`, `ids`). Only report done what the action's result confirms.";
export const inputs =
	"service: string - the `service` of one of your credentials (see Your credentials)\naction: string - one of that credential's action keys\nurl?: string - page URL for actions whose summary names one\nids?: number[] - numeric ids for actions whose summary names them";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const service = typeof input.service === "string" ? input.service : "";
	const action = typeof input.action === "string" ? input.action : "";
	// Having the credential is the permission; its actions are its service's.
	const cred = await roostr.credentials.get(service);
	if (!cred.ok) return `Credential unavailable: ${cred.error} Tell the person; do not retry this turn.`;
	if (!cred.actions.some((a) => a.key === action)) {
		const valid = cred.actions.map((a) => a.key).join(", ");
		return `error: "${cred.name}" has no action "${action}"${valid ? `; its actions are ${valid}` : " - it has no actions"}. Don't retry with another name.`;
	}

	if (service === "x" && (action === "read_mentions" || action === "retweet_post")) {
		const url = action === "read_mentions" ? "https://x.com/notifications/mentions" : (typeof input.url === "string" ? input.url : "").trim();
		if (!/^https:\/\/(?:x|twitter)\.com\//i.test(url)) return "error: url must be an x.com or twitter.com URL";
		// Page scripts are async function bodies run in the signed-in page; they return a string (JSON for structured answers).
		// The posts on an X timeline page (mentions, a profile, search), each with the link retweet_post takes and whether it is already reposted.
		const timeline = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let t = 0; t < 40 && !document.querySelector('article[data-testid="tweet"]'); t++) await sleep(250);
const posts = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 25).map((a) => {
	const link = [...a.querySelectorAll('a[href*="/status/"]')].find((l) => l.querySelector("time"));
	return {
		url: link ? new URL(link.getAttribute("href"), location.origin).href : "",
		author: (a.querySelector('[data-testid="User-Name"]')?.innerText ?? "").replace(/\\s*\\n\\s*/g, " "),
		time: link?.querySelector("time")?.getAttribute("datetime") ?? "",
		text: (a.querySelector('[data-testid="tweetText"]')?.innerText ?? "").slice(0, 280),
		reposted: !!a.querySelector('[data-testid="unretweet"]'),
	};
});
return JSON.stringify(posts);
`;
		// Repost exactly the post the page's /status/<id> URL names - never the
		// first button on the page, which on a reply thread or an
		// already-reposted post belongs to someone else - and confirm the page
		// shows it reposted.
		const repost = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = location.pathname.match(/\\/status\\/(\\d+)/)?.[1];
if (!id) return JSON.stringify({ ok: false, error: "not a post URL: " + location.href });
const focal = () => [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => [...a.querySelectorAll('a[href*="/status/' + id + '"]')].some((l) => l.querySelector("time")));
let post;
for (let t = 0; t < 40 && !(post = focal()); t++) await sleep(250);
if (!post) return JSON.stringify({ ok: false, error: "the post did not load (deleted, protected, or the session is signed out)" });
if (post.querySelector('[data-testid="unretweet"]')) return JSON.stringify({ ok: true, already: true, detail: "already reposted" });
const button = post.querySelector('[data-testid="retweet"]');
if (!button) return JSON.stringify({ ok: false, error: "this post has no repost button (reposts may be turned off)" });
button.click();
let confirm;
for (let t = 0; t < 20 && !(confirm = document.querySelector('[data-testid="retweetConfirm"]')); t++) await sleep(150);
if (!confirm) return JSON.stringify({ ok: false, error: "the Repost menu did not open" });
confirm.click();
for (let t = 0; t < 30; t++) {
	await sleep(200);
	if (focal()?.querySelector('[data-testid="unretweet"]')) return JSON.stringify({ ok: true, detail: "reposted and confirmed on the page" });
}
return JSON.stringify({ ok: false, error: "clicked Repost but the page never showed it reposted" });
`;
		const page = await roostr.credentials.page("x", url, action === "read_mentions" ? timeline : repost);
		if (!page.ok) return page.unavailable ? `Credential unavailable: ${page.error} Tell the person; do not retry this turn.` : `Credential page failed: ${page.error}`;
		if (page.signedOut) return `Credential signed out: ${url} showed a login page, so "${page.name}" is no longer signed in. Tell the person to press Reconnect on it.`;
		if (!page.arrived) return `Did not reach ${url}: the site sent the page to ${page.url}. Nothing was done there.\n${page.text}`.slice(0, 14_000);
		// The action's answer leads: the page text after it is context and may be cut.
		return `${page.result ? `Result: ${page.result}\n\n` : ""}${page.title}\n${page.url}\n${page.text}`.slice(0, 14_000);
	}

	// Any other action's code lives on the harness (a private extension's credentialActions), signed in there.
	const { service: _service, action: _action, ...rest } = input;
	const done = await roostr.credentials.act(service, action, rest);
	return done.ok ? done.result : `Credential action failed: ${done.error}`;
}
