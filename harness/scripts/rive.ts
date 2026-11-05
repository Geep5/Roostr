#!/usr/bin/env bun
/**
 * Rive for Roostr agents: turn a Rive CLI project (rive.yaml + RML + Luau)
 * into a PNG or a video and store it as a File object in a space. Making
 * and editing the project is the Rive CLI's own job (`rive docs`, `rive
 * schema`, `rive <dir> --verify`, the project's AGENTS.md); this is the part
 * it doesn't do. Run as `roostr-rive` (harness/bin, linked into
 * ~/.local/bin by the harness):
 *
 *   roostr-rive shot <project dir> --space <id> [--at 2s] [--size 1920x1080] [--data path=value]... [--name N]
 *   roostr-rive render <project dir> --space <id> --seconds 3.6 [--fps 30|60] [--size WxH] [--data path=value]... [--alpha] [--name N] [--out path]
 *   roostr-rive --check
 *
 * A render is one headless `rive --screenshot` per frame (the scene is
 * deterministic in time), stitched by ffmpeg: an H.264 MP4, or with --alpha a
 * ProRes 4444 MOV whose transparency comes from rendering every frame over
 * black and over white (the artboard background bound to the view model
 * property `bg`) and differencing the two.
 *
 * Prints one JSON line: the stored File ({"id", "name", ...}) or {"error"}
 * with exit 1. `--check` is the "rive" capability's gate (skillmgr.ts).
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const HARNESS = "http://127.0.0.1:7334";
/** The harness's upload limit (authserver maxRequestBodySize). */
const MAX_BYTES = 1024 * 1024 * 1024;
/** Rive's `--advance` counts 1/60 s ticks. */
const TICKS_PER_SECOND = 60;

/** The alpha matte: white minus black, inverted, is coverage. */
export const MATTE = "[1][0]blend=all_mode=difference,negate,format=gray[a];[0][a]alphamerge,unpremultiply=inplace=1,format=rgba";

/** A moment in the scene as Rive ticks: `2s`, `500ms`, or a bare tick count (60 = 1 s); null when malformed. */
export function ticksAt(at: string): number | null {
	const m = at.trim().match(/^(\d+(?:\.\d+)?)(s|ms)?$/);
	if (!m) return null;
	const n = Number(m[1]);
	const ticks = m[2] === "s" ? n * TICKS_PER_SECOND : m[2] === "ms" ? (n * TICKS_PER_SECOND) / 1000 : n;
	return Math.max(1, Math.round(ticks));
}

/** Frame `i`'s time in ticks at `fps` (at least 1: a scene must advance once to draw). */
export function frameTicks(i: number, fps: number): number {
	return Math.max(1, Math.round((i * TICKS_PER_SECOND) / fps));
}

/** `WxH` as numbers; null when malformed. */
export function size(s: string): { w: number; h: number } | null {
	const m = s.trim().toLowerCase().match(/^(\d{2,5})x(\d{2,5})$/);
	return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** The ffmpeg arguments that stitch `frames` into `out`. */
export function stitchArgs(frames: string, fps: number, alpha: boolean, out: string): string[] {
	const args = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(frames, "black_%05d.png")];
	if (alpha) {
		args.push("-framerate", String(fps), "-i", join(frames, "white_%05d.png"), "-filter_complex", MATTE, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le");
	} else {
		args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart");
	}
	return [...args, out];
}

function fail(message: string): never {
	console.log(JSON.stringify({ error: message }));
	process.exit(1);
}

function arg(name: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? (process.argv[i + 1] ?? "") : "";
}

function args(name: string): string[] {
	return process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]] : []));
}

/** The Rive CLI: on PATH, else where its installer puts it. */
function riveBin(): string {
	return process.env.RIVE_BIN || Bun.which("rive") || join(homedir(), ".rive", "bin", "rive");
}

async function run(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
	try {
		const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	} catch {
		return { code: 127, out: "", err: `${cmd[0]}: not found` };
	}
}

async function check(): Promise<never> {
	const version = await run([riveBin(), "--version"]);
	if (version.code !== 0) fail("The Rive CLI is not installed: run `curl -fsSL https://releases.rive.app/cli/install.sh | sh`.");
	if ((await run(["ffmpeg", "-version"])).code !== 0) fail("ffmpeg is not installed: run `brew install ffmpeg` (videos are stitched with it).");
	console.log(JSON.stringify({ ok: true, rive: version.out.trim() }));
	process.exit(0);
}

/** The project directory named on the command line, checked. */
function project(): string {
	const dir = process.argv[3];
	if (!dir || dir.startsWith("--")) fail("Name the Rive project folder (the one holding rive.yaml).");
	const abs = resolve(dir);
	if (!existsSync(join(abs, "rive.yaml"))) fail(`${abs} is not a Rive project (no rive.yaml). Make one with \`rive create <name>\`.`);
	return abs;
}

/** Compile first: a broken scene is reported as Rive says it, not as a missing frame. */
async function verify(dir: string): Promise<void> {
	const res = await run([riveBin(), dir, "--verify"]);
	if (res.code !== 0) fail(`The Rive project doesn't compile: ${(res.err || res.out).trim().split("\n").slice(-6).join(" | ").slice(0, 600)}`);
}

async function screenshot(dir: string, png: string, ticks: number, view: { w: number; h: number } | null, data: string[]): Promise<void> {
	const cmd = [riveBin(), dir, "--quiet", `--screenshot=${png}`, `--advance=${ticks}`, ...(view ? [`--viewport=${view.w}x${view.h}`] : []), ...data.map((d) => `--data=${d}`)];
	const res = await run(cmd);
	const said = (res.err || res.out).trim();
	// Alpha renders over black and over white through the view model's `bg`.
	if (/--data bg: no property/.test(said)) fail("--alpha needs the artboard's background bound to a view model color property named `bg` (each frame is rendered over black and over white); this scene has no `bg`. Add and bind it, or render without --alpha.");
	if (res.code !== 0 || !existsSync(png)) fail(`Rendering failed at tick ${ticks}: ${said.slice(-400)}`);
}

async function store(path: string, name: string, mime: string, space: string, extra: Record<string, unknown>): Promise<void> {
	const bytes = statSync(path).size;
	if (bytes > MAX_BYTES) fail(`The result is ${(bytes / 1024 ** 3).toFixed(1)} GB, over Roostr's 1 GB file limit: render shorter, smaller or without --alpha.`);
	const token = (await readFile(join(process.env.GLON_DATA || join(homedir(), ".glon"), "api-token"), "utf8")).trim();
	const res = await fetch(`${HARNESS}/files?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}&space=${encodeURIComponent(space)}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: Bun.file(path),
	});
	const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
	if (!res.ok || !body.id) fail(`Storing ${name} in Roostr failed: ${body.error ?? res.status}`);
	console.log(JSON.stringify({ id: body.id, name, size: bytes, ...extra }));
}

/** Keep a copy where the person asked (e.g. the project's build/), besides the File. */
function keep(from: string): void {
	const out = arg("out");
	if (!out) return;
	mkdirSync(dirname(resolve(out)), { recursive: true });
	copyFileSync(from, resolve(out));
}

async function shot(space: string): Promise<void> {
	const dir = project();
	const at = arg("at") || "1s";
	const ticks = ticksAt(at) ?? fail("--at is a time like 2s, 500ms or a tick count (60 = 1 s).");
	const view = arg("size") ? (size(arg("size")) ?? fail("--size is WIDTHxHEIGHT, like 1920x1080.")) : null;
	await verify(dir);
	const tmp = mkdtempSync(join(tmpdir(), "roostr-rive-"));
	try {
		const png = join(tmp, "shot.png");
		await screenshot(dir, png, ticks, view, args("data"));
		keep(png);
		await store(png, arg("name") || `${basename(dir)} at ${at}.png`, "image/png", space, { at });
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

async function render(space: string): Promise<void> {
	const dir = project();
	const secs = Number(arg("seconds"));
	if (!(secs > 0) || secs > 600) fail("--seconds is the length to render, more than 0 and at most 600.");
	const fps = Number(arg("fps") || 30);
	if (fps !== 30 && fps !== 60) fail("--fps is 30 or 60 (Rive steps in 1/60 s ticks).");
	const view = size(arg("size") || "1920x1080") ?? fail("--size is WIDTHxHEIGHT, like 1920x1080.");
	const alpha = process.argv.includes("--alpha");
	const data = args("data");
	await verify(dir);
	const frames = mkdtempSync(join(tmpdir(), "roostr-rive-frames-"));
	try {
		const n = Math.round(fps * secs);
		const passes: Array<[string, string]> = alpha ? [["black", "FF000000"], ["white", "FFFFFFFF"]] : [["black", ""]];
		for (let i = 0; i < n; i++) {
			for (const [pass, bg] of passes) {
				await screenshot(dir, join(frames, `${pass}_${String(i).padStart(5, "0")}.png`), frameTicks(i, fps), view, bg ? [`bg=${bg}`, ...data] : data);
			}
		}
		const out = join(frames, alpha ? "render.mov" : "render.mp4");
		const stitched = await run(stitchArgs(frames, fps, alpha, out));
		if (stitched.code !== 0) fail(`ffmpeg could not stitch the frames: ${stitched.err.trim().slice(-400)}`);
		keep(out);
		const name = arg("name") || `${basename(dir)}.${alpha ? "mov" : "mp4"}`;
		await store(out, name, alpha ? "video/quicktime" : "video/mp4", space, { seconds: secs, fps, width: view.w, height: view.h, alpha, frames: n });
	} finally {
		rmSync(frames, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.argv.includes("--check")) await check();
	const cmd = process.argv[2];
	const space = arg("space");
	if (cmd !== "shot" && cmd !== "render") fail("Usage: roostr-rive shot|render <project dir> --space <id> ... | --check");
	if (!space) fail("--space <space id> is required (the space the File belongs to).");
	if (cmd === "shot") await shot(space);
	else await render(space);
}
