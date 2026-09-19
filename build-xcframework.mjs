// Builds the engine as Glon.xcframework (iOS device, iOS simulator, macOS) for
// Swift hosts, plus a manifest fingerprinting the Odin sources it came from.
// Usage: node build-xcframework.mjs [output-dir]   (default ../RoostrIOS/Vendor)
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? join(root, "../RoostrIOS/Vendor"));
const compiler = process.env.ODIN ?? "odin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const slices = [
	{ name: "ios-arm64", args: ["-subtarget:iphone", "-minimum-os-version:17.0"] },
	{ name: "ios-arm64-simulator", args: ["-subtarget:iphonesimulator", "-minimum-os-version:17.0"] },
	{ name: "macos-arm64", args: ["-minimum-os-version:14.0"] },
];
const exports = ["core_abi_version", "core_init", "core_reserve", "core_reserve_blob", "core_execute", "core_response_pointer", "core_response_length", "core_reset"];
const header = `#ifndef GLON_H
#define GLON_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// Bounded JSON request/response ABI; see glonOdin/abi/abi.odin. Single-flight:
// the host must serialise every call and must not call from two threads.
uint32_t core_abi_version(void);
void core_init(void);
void *core_reserve(uint32_t length);
// Optional ABI v2 binary payload; reserve after core_reserve, before execute.
void *core_reserve_blob(uint32_t length);
uint32_t core_execute(void);
void *core_response_pointer(void);
uint32_t core_response_length(void);
void core_reset(uint32_t reset_all);
#ifdef __cplusplus
}
#endif
#endif
`;

const run = (command, args) => {
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status})`);
};

const sourceFiles = {};
for (const directory of ["abi", "core", "native"]) {
	for (const name of (await readdir(join(root, directory))).sort()) {
		if (!name.endsWith(".odin") || name.endsWith("_test.odin")) continue;
		const path = `${directory}/${name}`;
		sourceFiles[path] = hash(await readFile(join(root, path)));
	}
}
sourceFiles["build-xcframework.mjs"] = hash(await readFile(fileURLToPath(import.meta.url)));

const work = join(output, `.glon-${process.pid}`);
await mkdir(join(work, "include"), { recursive: true });
try {
	await writeFile(join(work, "include/glon.h"), header);
	await writeFile(join(work, "include/module.modulemap"), `module Glon {\n\theader "glon.h"\n\texport *\n}\n`);
	const libraries = [];
	for (const slice of slices) {
		const library = join(work, slice.name, "libglon.a");
		await mkdir(dirname(library), { recursive: true });
		run(compiler, ["build", join(root, "native"), "-build-mode:static", "-target:darwin_arm64", ...slice.args,
			"-o:speed", "-no-entry-point", `-out:${library}`]);
		const symbols = spawnSync("nm", ["-g", library], { encoding: "utf8" });
		if (symbols.status !== 0) throw new Error("nm failed");
		for (const name of exports) if (!symbols.stdout.includes(` T _${name}\n`)) throw new Error(`${slice.name}: missing export ${name}`);
		libraries.push(library);
	}
	const framework = join(work, "Glon.xcframework");
	run("xcodebuild", ["-create-xcframework", ...libraries.flatMap((l) => ["-library", l, "-headers", join(work, "include")]), "-output", framework]);
	const version = spawnSync(compiler, ["version"], { encoding: "utf8" });
	if (version.error || version.status !== 0) throw version.error ?? new Error("Cannot identify Odin compiler");
	const manifest = {
		abiVersion: 2,
		compiler: version.stdout.trim(),
		artifact: "Glon.xcframework",
		slices: slices.map((s) => s.name),
		sourceFingerprint: hash(JSON.stringify(sourceFiles)),
		sourceFiles,
	};
	await rm(join(output, "Glon.xcframework"), { recursive: true, force: true });
	await rename(framework, join(output, "Glon.xcframework"));
	await writeFile(join(output, "glon-core.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`Built ${join(output, "Glon.xcframework")} (source ${manifest.sourceFingerprint})`);
} finally {
	await rm(work, { recursive: true, force: true });
}
