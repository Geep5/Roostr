import { afterAll, expect, test } from "bun:test";
import { credentialPageAction } from "./browser";

// A page that shows the Cookie header it received: proves a credential's
// session cookies reach the site from a fresh, throwaway Chrome.
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: (req) => new Response(`<!doctype html><title>Echo</title><body><div id="c">${req.headers.get("cookie") ?? "none"}</div><button id="b">Run</button><script>document.getElementById("b").onclick=()=>document.getElementById("c").textContent="clicked";</script></body>`, { headers: { "Content-Type": "text/html" } }),
});
afterAll(() => server.stop(true));

test("a credential's session cookies are sent to the site, and the action's result comes back", async () => {
	const url = `http://127.0.0.1:${server.port}/page`;
	const cookies = [{ name: "auth_token", value: "abc123", domain: "127.0.0.1", path: "/", expires: Date.now() / 1000 + 3600, httpOnly: true, secure: false }];
	const page = await credentialPageAction(cookies, url, "const seen = document.getElementById('c').textContent; document.getElementById('b').click(); return seen;", 20_000);
	expect(page.actionResult).toBe("auth_token=abc123");
	expect(page.text).toContain("clicked");
}, 30_000);
