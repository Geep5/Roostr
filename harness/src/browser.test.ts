import { expect, test } from "bun:test";
import { credentialPageAction } from "./browser";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const profile = mkdtempSync(join(tmpdir(), "roostr-cdp-profile-"));

test("credential browser action runs JavaScript and returns rendered page text", async () => {
	const html = `<!doctype html><title>Action test</title><body><button id="b">Run</button><div id="out">before</div><script>document.getElementById("b").onclick=()=>document.getElementById("out").textContent="after";</script></body>`;
	try {
		const url = `data:text/html,${encodeURIComponent(html)}`;
		const page = await credentialPageAction(profile, url, "document.getElementById('b').click(); return document.getElementById('out').textContent;", 5_000);
		expect(page.actionResult).toBe("after");
		expect(page.text).toContain("after");
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
}, 30_000);
