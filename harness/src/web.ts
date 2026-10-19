/**
 * The local web app (`bun run service install --web <RoostrWebsite repo>`):
 * roostr.space's app, built by the website repo's `gpui/scripts/build-web.sh`
 * into `gpui/web-dist/`, served on http://127.0.0.1:5190 the way the site's
 * Caddyfile serves it: `/<path>` is answered by `<path>`, `<path>.html`,
 * `<path>/index.html`, else `200.html` (the workspace, /app/**).
 *
 * The build runs first whenever web-dist is missing or older than any of
 * its inputs, so a restart after a pull serves the new code. The pages carry
 * `<meta name="roostr-mode" content="daemon">`: a new tab here pairs with
 * this computer's store, as the Svelte app's `dev:local` did; a loopback
 * page reads the one-use pairing code itself (`GET /api/pair/code`).
 *
 *   bun run src/web.ts <path to the RoostrWebsite repo>
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const WEB_HOST = "127.0.0.1";
export const WEB_PORT = 5190;
export const WEB_ORIGIN = `http://${WEB_HOST}:${WEB_PORT}`;

/** Everything build-web.sh reads, relative to the RoostrWebsite repo. */
const INPUTS = ["gpui/Cargo.toml", "gpui/Cargo.lock", "gpui/.cargo", "gpui/crates", "gpui/vendor", "gpui/scripts/build-web.sh", "static"];
/** Directories under the inputs that are build output, not input. */
const SKIPPED: Record<string, true> = { target: true, node_modules: true, ".git": true };
/** What a finished build always writes. */
const OUTPUTS = ["index.html", "200.html", "main.js", "roostr_web.js", "roostr_web_bg.wasm", "engine.wasm", "engine-core.json"];
const MODE_META = `<meta name="roostr-mode" content="daemon" />`;

function newest(path: string): number {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (!stat) return 0;
	if (!stat.isDirectory()) return stat.mtimeMs;
	let latest = 0;
	for (const entry of readdirSync(path)) {
		if (!SKIPPED[entry]) latest = Math.max(latest, newest(join(path, entry)));
	}
	return latest;
}

/** Why web-dist must be built first, or null when it is current. */
export function buildReason(repo: string): string | null {
	const dist = join(repo, "gpui/web-dist");
	const missing = OUTPUTS.find((file) => !existsSync(join(dist, file)));
	if (missing) return `gpui/web-dist/${missing} is missing`;
	const built = Math.min(...OUTPUTS.map((file) => statSync(join(dist, file)).mtimeMs));
	const changed = INPUTS.find((input) => newest(join(repo, input)) > built);
	return changed ? `${changed} changed since gpui/web-dist was built` : null;
}

/** The file Caddy's `try_files {path} {path}.html {path}/index.html /200.html` picks, or null. */
export function resolveFile(dist: string, pathname: string): string | null {
	let path: string;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	if (path.includes("\0")) return null;
	const root = resolve(dist);
	for (const candidate of [path, `${path}.html`, `${path}/index.html`, "/200.html"]) {
		const file = resolve(root, `.${candidate}`);
		if (file !== root && !file.startsWith(root + sep)) continue;
		if (statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
	}
	return null;
}

/** Answer one request from `dist`; every page carries the daemon-mode default. */
export async function respond(dist: string, request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
	const path = resolveFile(dist, new URL(request.url).pathname);
	if (!path) return new Response("not found", { status: 404 });
	const file = Bun.file(path);
	const headers = { "Content-Type": file.type, "Cache-Control": "no-cache" };
	if (!path.endsWith(".html")) return new Response(file, { headers });
	const html = await file.text();
	return new Response(html.replace("</head>", `    ${MODE_META}\n  </head>`), { headers });
}

if (import.meta.main) {
	const repo = resolve(process.argv[2] ?? "");
	const script = join(repo, "gpui/scripts/build-web.sh");
	if (!process.argv[2] || !existsSync(script)) {
		console.error(`usage: bun run src/web.ts <path to the RoostrWebsite repo> (no gpui/scripts/build-web.sh in ${repo})`);
		process.exit(1);
	}
	const reason = buildReason(repo);
	if (reason) {
		console.log(`[web] ${reason}: building it with gpui/scripts/build-web.sh`);
		if (Bun.spawnSync({ cmd: [script], cwd: join(repo, "gpui"), stdout: "inherit", stderr: "inherit" }).exitCode !== 0) {
			console.error("[web] gpui/scripts/build-web.sh failed");
			process.exit(1);
		}
	}
	const dist = join(repo, "gpui/web-dist");
	Bun.serve({ hostname: WEB_HOST, port: WEB_PORT, fetch: (request) => respond(dist, request) });
	console.log(`[web] Roostr on ${WEB_ORIGIN}/app, serving ${dist}`);
}
