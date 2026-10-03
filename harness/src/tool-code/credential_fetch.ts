import type { Roostr } from "../tool-sdk";

export const description =
	"Fetch a live page signed in through one of YOUR credentials (the Credentials property) in a headless Chrome, and return its rendered text. Some things only appear after a click (a profile menu showing a balance, a tab, a dropdown): pass `click`, a list of controls to click in order, and the result says what opened. Every reply lists the page's clickable controls with selectors you can pass in `click`. Only click to open or reveal things - never a control that buys, sends, deletes, posts or changes anything. Use this instead of web_fetch when the page depends on a signed-in account. If the page shows a login wall, report the credential as signed out.";
export const inputs =
	"service: string - the `service` of one of your credentials (see Your credentials) that signs in with a browser\nurl: string - absolute http(s) URL\nclick?: string[] - controls to click first, in order: a selector from a previous reply's controls list, or the control's visible text / label";

export default async function (input: Record<string, unknown>, roostr: Roostr) {
	const url = (typeof input.url === "string" ? input.url : "").trim();
	if (!/^https?:\/\//i.test(url)) return "error: url must be absolute http(s)";
	// Models sometimes send the list JSON-encoded, or one target as a string: read all three.
	let clicks = Array.isArray(input.click) ? input.click.filter((c): c is string => typeof c === "string") : [];
	if (clicks.length === 0 && typeof input.click === "string" && input.click.trim()) {
		try {
			const parsed: unknown = JSON.parse(input.click);
			clicks = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
		} catch {
			clicks = [input.click.trim()];
		}
	}
	// Runs in the signed-in page (an async function body): click the named
	// controls in order, then report what opened and the page's clickable
	// controls, each with a selector `click` accepts. A target is a CSS
	// selector, or text matched against a control's visible text,
	// aria-label, title or alt.
	const script = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = ${JSON.stringify(clicks)};
await sleep(1200);
const controls = () => [...document.querySelectorAll('a, button, [role="button"], [role="tab"], [role="menuitem"], summary, img, [tabindex]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
const label = (e) => (e.innerText || e.getAttribute("aria-label") || e.getAttribute("title") || e.getAttribute("alt") || "").trim().replace(/\\s+/g, " ");
const selectorOf = (e) => {
	if (e.id) return "#" + CSS.escape(e.id);
	for (const a of ["aria-label", "data-testid", "title", "alt"]) { const v = e.getAttribute(a); if (v) return e.tagName.toLowerCase() + "[" + a + '="' + v.replace(/"/g, '\\"') + '"]'; }
	const cls = [...e.classList].find((c) => /^[a-z][\\w-]*$/i.test(c) && document.querySelectorAll("." + CSS.escape(c)).length === 1);
	if (cls) return e.tagName.toLowerCase() + "." + cls;
	return "";
};
const find = (t) => {
	try { const el = document.querySelector(t); if (el) return el; } catch {}
	const low = t.toLowerCase();
	const all = controls();
	return all.find((e) => label(e).toLowerCase() === low) ?? all.find((e) => label(e).toLowerCase().includes(low));
};
const press = (el) => { const target = el.closest('a, button, [role="button"], [role="tab"], [role="menuitem"], summary') ?? el; for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) target.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); };
const openNow = () => [...document.querySelectorAll('[role="menu"], [role="dialog"], [role="listbox"], [data-state="open"], [data-radix-popper-content-wrapper]')].map((m) => m.innerText.trim()).filter(Boolean);
// Panels already open before any click (a chat widget, a banner) are not what a click opened.
const before = new Set(openNow());
const done = [];
for (const t of want) {
	const el = find(t);
	if (!el) { done.push({ click: t, ok: false, error: "no control matches" }); break; }
	press(el);
	done.push({ click: t, ok: true, matched: label(el).slice(0, 60) || selectorOf(el) });
	await sleep(1200);
}
const opened = openNow().filter((t) => !before.has(t));
const seen = new Set();
const list = controls().map((e) => ({ label: label(e).slice(0, 50), selector: selectorOf(e) })).filter((c) => (c.label || c.selector) && !seen.has(c.label + c.selector) && seen.add(c.label + c.selector)).slice(0, 60);
return JSON.stringify({ clicks: done, opened: want.length ? ([...new Set(opened)].join(" | ").slice(0, 2000) || "(nothing new opened)") : "", controls: list });
`;
	const page = await roostr.credentials.page(typeof input.service === "string" ? input.service : "", url, script);
	if (!page.ok) return page.unavailable ? `Credential unavailable: ${page.error} Tell the person; do not retry this turn.` : `Credential page failed: ${page.error}`;
	if (page.signedOut) return `Credential signed out: ${url} showed a login page, so "${page.name}" is no longer signed in. Tell the person to press Reconnect on it.`;
	if (!page.arrived) return `Did not reach ${url}: the site sent the page to ${page.url}. Nothing was done there.\n${page.text}`.slice(0, 14_000);
	// What the clicks found leads: the page text after it is context and may be cut.
	return `${page.result ? `Result: ${page.result}\n\n` : ""}${page.title}\n${page.url}\n${page.text}`.slice(0, 14_000);
}
