import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const website = resolve(process.argv[2] ?? join(root, "../RoostrWebsite"));
const output = join(website, "static");
const compiler = process.env.ODIN ?? "odin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = {};
for (const directory of ["core", "wasm"]) {
	for (const name of (await readdir(join(root, directory))).sort()) {
		if (!name.endsWith(".odin") || name.endsWith("_test.odin")) continue;
		const path = `${directory}/${name}`;
		sourceFiles[path] = hash(await readFile(join(root, path)));
	}
}
sourceFiles["build-wasm.mjs"] = hash(await readFile(fileURLToPath(import.meta.url)));
const runtimeFiles = {};
for (const path of ["src/lib/engine/core.ts", "src/lib/engine/odin-runtime.ts"]) {
	runtimeFiles[path] = hash(await readFile(join(website, path)));
}
await mkdir(output, { recursive: true });
const temporary = join(output, `.engine-${process.pid}.wasm`);
const args = ["build", join(root, "wasm"), "-target:js_wasm32", "-o:speed", `-out:${temporary}`, "-extra-linker-flags:--max-memory=536870912"];
try {
	const result = spawnSync(compiler, args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Odin WASM build failed (${result.status})`);
	const bytes = await readFile(temporary);
	const module = new WebAssembly.Module(bytes);
	const required = ["memory", "_start", "core_abi_version", "core_reserve", "core_execute", "core_response_pointer", "core_response_length", "core_reset"];
	const names = new Set(WebAssembly.Module.exports(module).map((item) => item.name));
	for (const name of required) if (!names.has(name)) throw new Error(`Missing WASM ABI export ${name}`);
	const version = spawnSync(compiler, ["version"], { encoding: "utf8" });
	if (version.error || version.status !== 0) throw version.error ?? new Error("Cannot identify Odin compiler");
	const manifest = {
		abiVersion: 1,
		compiler: version.stdout.trim(),
		target: "js_wasm32",
		artifact: "engine.wasm",
		sha256: hash(bytes),
		sourceFingerprint: hash(JSON.stringify(sourceFiles)),
		sourceFiles,
		runtimeFiles,
	};
	await writeFile(join(output, `.engine-core-${process.pid}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
	await rename(temporary, join(output, "engine.wasm"));
	await rename(join(output, `.engine-core-${process.pid}.json`), join(output, "engine-core.json"));
	console.log(`Built ${join(output, "engine.wasm")} (${bytes.length} bytes; source ${manifest.sourceFingerprint})`);
} finally {
	await rm(temporary, { force: true });
	await rm(join(output, `.engine-core-${process.pid}.json`), { force: true });
}
