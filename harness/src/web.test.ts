import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReason, resolveFile, respond } from "./web";

const repo = mkdtempSync(join(tmpdir(), "roostr-web-"));
const dist = join(repo, "gpui/web-dist");
const PAGE = "<html><head><title>x</title></head><body></body></html>";
for (const [file, body] of Object.entries({
	"index.html": PAGE,
	"200.html": PAGE,
	"guide.html": PAGE,
	"main.js": "",
	"roostr_web.js": "",
	"roostr_web_bg.wasm": "\0asm",
	"engine.wasm": "\0asm",
	"engine-core.json": "{}",
	"docs/index.html": PAGE,
})) {
	mkdirSync(join(dist, file, ".."), { recursive: true });
	writeFileSync(join(dist, file), body);
}
afterAll(() => rmSync(repo, { recursive: true, force: true }));

test("paths resolve like Caddy's try_files {path} {path}.html {path}/index.html /200.html", () => {
	expect(resolveFile(dist, "/")).toBe(join(dist, "index.html"));
	expect(resolveFile(dist, "/guide")).toBe(join(dist, "guide.html"));
	expect(resolveFile(dist, "/docs")).toBe(join(dist, "docs/index.html"));
	expect(resolveFile(dist, "/roostr_web_bg.wasm")).toBe(join(dist, "roostr_web_bg.wasm"));
	for (const path of ["/app", "/app/object/abc", "/nope.js", "/%2e%2e/%2e%2e/etc/passwd", "/../../etc/passwd"]) {
		expect(resolveFile(dist, path)).toBe(join(dist, "200.html"));
	}
	expect(resolveFile(dist, "/%E0%A4%A")).toBeNull();
});

test("responses carry the file's type, no-cache, and the daemon-mode default on pages", async () => {
	const app = await respond(dist, new Request("http://127.0.0.1:5190/app"));
	expect(app.status).toBe(200);
	expect(app.headers.get("content-type")).toStartWith("text/html");
	expect(app.headers.get("cache-control")).toBe("no-cache");
	expect(await app.text()).toContain(`<meta name="roostr-mode" content="daemon" />\n  </head>`);
	const wasm = await respond(dist, new Request("http://127.0.0.1:5190/roostr_web_bg.wasm"));
	expect(wasm.headers.get("content-type")).toBe("application/wasm");
	expect((await respond(dist, new Request("http://127.0.0.1:5190/", { method: "POST" }))).status).toBe(405);
});

test("a build is needed when an output is missing or an input is newer", () => {
	const input = join(repo, "gpui/crates/a.rs");
	mkdirSync(join(input, ".."), { recursive: true });
	writeFileSync(input, "");
	utimesSync(input, new Date(0), new Date(0));
	expect(buildReason(repo)).toBeNull();
	utimesSync(input, new Date(), new Date(Date.now() + 60_000));
	expect(buildReason(repo)).toBe("gpui/crates changed since gpui/web-dist was built");
	const target = join(repo, "gpui/crates/target/x");
	mkdirSync(join(target, ".."), { recursive: true });
	utimesSync(input, new Date(0), new Date(0));
	writeFileSync(target, "");
	utimesSync(target, new Date(), new Date(Date.now() + 60_000));
	expect(buildReason(repo)).toBeNull();
	rmSync(join(dist, "main.js"));
	expect(buildReason(repo)).toBe("gpui/web-dist/main.js is missing");
});
