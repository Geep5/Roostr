#!/usr/bin/env bun
/**
 * Video clips for Roostr agents: download a YouTube or Twitch clip (or any
 * site yt-dlp supports) into one MP4, check it with ffprobe, and store it as
 * a File object in a space. Run as `roostr-clip` (harness/bin, linked into
 * ~/.local/bin by the harness):
 *
 *   roostr-clip --space <space id> <url> [--start 1:23 --end 1:45]
 *   roostr-clip --space <space id> --store <path to a video>   (e.g. a Palmier export)
 *   roostr-clip --check
 *
 * Prints one JSON line: {"id", "name", "duration", "size", "width", "height", "audio"}
 * or {"error": "..."} with exit 1. `--check` is the "video-clips"
 * capability's gate (harness/src/skillmgr.ts).
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

/** Older yt-dlp gets HTTP 403 from YouTube (its SABR streaming change). */
export const MIN_YTDLP = "2026.08.19";
/** The harness's upload limit (authserver maxRequestBodySize). */
export const MAX_BYTES = 1024 * 1024 * 1024;
const HARNESS = "http://127.0.0.1:7334";

/** Whether yt-dlp `version` (2026.08.19, 2026.10.26.1) is at least `min`. */
export function ytdlpAtLeast(version: string, min = MIN_YTDLP): boolean {
	const parse = (v: string) => (v.match(/\d+/g) ?? []).map(Number);
	const [have, want] = [parse(version), parse(min)];
	if (have.length === 0) return false;
	for (let i = 0; i < want.length; i++) if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
	return true;
}

/** yt-dlp's failure, said so a person (or agent) knows what to do. */
export function explainFailure(stderr: string): string {
	const s = stderr;
	if (/HTTP Error 403|403: Forbidden/i.test(s)) return `The site refused the download (HTTP 403). On YouTube this means yt-dlp is out of date: run \`brew upgrade yt-dlp\` on this computer (needs ${MIN_YTDLP} or newer).`;
	if (/Private video|This video is private/i.test(s)) return "The video is private.";
	if (/video (is )?unavailable|has been removed|does not exist|HTTP Error 404/i.test(s)) return "The video is unavailable (deleted, or the link is wrong).";
	if (/Sign in to confirm you.re not a bot/i.test(s)) return "YouTube asked to sign in to prove this isn't a bot; try again later or from another computer.";
	if (/Unsupported URL/i.test(s)) return "yt-dlp doesn't support this link.";
	if (/members-only|subscriber/i.test(s)) return "The video is for members or subscribers only.";
	const last = s.split("\n").reverse().find((l) => /ERROR/.test(l)) ?? s.trim().split("\n").pop() ?? "";
	return last ? `Download failed: ${last.replace(/^ERROR:\s*/, "").slice(0, 300)}` : "Download failed with no message from yt-dlp.";
}

/** A `--start`/`--end` time: seconds, M:SS or H:MM:SS; null when malformed. */
export function seconds(t: string): number | null {
	if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
	return t.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

export interface Probe {
	duration: number;
	size: number;
	width: number;
	height: number;
	video: boolean;
	audio: boolean;
}

/** ffprobe's JSON (`-show_streams -show_format`) as what a clip needs. */
export function readProbe(json: string): Probe {
	const d = JSON.parse(json) as { streams?: Array<{ codec_type?: string; width?: number; height?: number }>; format?: { duration?: string; size?: string } };
	const streams = d.streams ?? [];
	const video = streams.find((s) => s.codec_type === "video");
	return {
		duration: Number(d.format?.duration ?? 0),
		size: Number(d.format?.size ?? 0),
		width: video?.width ?? 0,
		height: video?.height ?? 0,
		video: Boolean(video),
		audio: streams.some((s) => s.codec_type === "audio"),
	};
}

function fail(message: string): never {
	console.log(JSON.stringify({ error: message }));
	process.exit(1);
}

function arg(name: string): string {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? (process.argv[i + 1] ?? "") : "";
}

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, out, err };
	} catch {
		return { code: 127, out: "", err: `${cmd[0]}: not found` };
	}
}

/** Exit 0 when yt-dlp (new enough), ffmpeg and ffprobe are all here; else say what's missing. */
async function check(): Promise<never> {
	const ytdlp = await run(["yt-dlp", "--version"]);
	if (ytdlp.code !== 0) fail("yt-dlp is not installed: run `brew install yt-dlp`.");
	const version = ytdlp.out.trim();
	if (!ytdlpAtLeast(version)) fail(`yt-dlp ${version} is older than ${MIN_YTDLP} (YouTube refuses it with HTTP 403): run \`brew upgrade yt-dlp\`.`);
	for (const tool of ["ffmpeg", "ffprobe"]) {
		if ((await run([tool, "-version"])).code !== 0) fail(`${tool} is not installed: run \`brew install ffmpeg\`.`);
	}
	console.log(JSON.stringify({ ok: true, ytdlp: version }));
	process.exit(0);
}

async function probe(path: string): Promise<Probe> {
	const res = await run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
	if (res.code !== 0) fail(`ffprobe could not read the video: ${res.err.trim().slice(0, 200)}`);
	return readProbe(res.out);
}

async function store(path: string, name: string, space: string): Promise<void> {
	const p = await probe(path);
	if (!p.video) fail("The file has no video stream.");
	if (!(p.duration > 0)) fail("The video has no length (a broken or empty file).");
	const size = statSync(path).size;
	if (size > MAX_BYTES) fail(`The video is ${(size / 1024 ** 3).toFixed(1)} GB, over Roostr's 1 GB file limit: download a part with --start and --end.`);
	const token = (await readFile(join(process.env.GLON_DATA || join(homedir(), ".glon"), "api-token"), "utf8")).trim();
	const mime = extname(path).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4";
	const res = await fetch(`${HARNESS}/files?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}&space=${encodeURIComponent(space)}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: Bun.file(path),
	});
	const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
	if (!res.ok || !body.id) fail(`Storing the video in Roostr failed: ${body.error ?? res.status}`);
	console.log(JSON.stringify({ id: body.id, name, duration: Math.round(p.duration * 10) / 10, size, width: p.width, height: p.height, audio: p.audio }));
}

async function download(url: string, space: string): Promise<void> {
	const [start, end] = [arg("start"), arg("end")];
	const section: string[] = [];
	if (start || end) {
		const [from, to] = [start ? seconds(start) : 0, end ? seconds(end) : null];
		if (from === null || (end && to === null)) fail("--start and --end are times like 75, 1:15 or 1:02:03.");
		if (to !== null && to <= (from ?? 0)) fail("--end must be after --start.");
		section.push("--download-sections", `*${from}-${to ?? "inf"}`, "--force-keyframes-at-cuts");
	}
	const dir = mkdtempSync(join(tmpdir(), "roostr-clip-"));
	try {
		// H.264 + AAC up to 1080p where offered (plays everywhere), merged into one MP4 by ffmpeg.
		const res = await run([
			"yt-dlp", "--no-playlist", "--no-progress", "--restrict-filenames",
			"-S", "res:1080,vcodec:h264,acodec:aac", "--merge-output-format", "mp4",
			"--max-filesize", String(MAX_BYTES),
			...section,
			"-o", join(dir, "%(title).80B [%(id)s].%(ext)s"),
			"--print", "after_move:%(filepath)s\t%(title)s",
			url,
		]);
		if (res.code !== 0) fail(explainFailure(res.err));
		const [path, title] = (res.out.trim().split("\n").pop() ?? "").split("\t");
		if (!path) fail("yt-dlp finished without a file (the size may be over the 1 GB limit: use --start and --end).");
		await store(path, `${(title || basename(path, extname(path))).slice(0, 120)}.mp4`, space);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	if (process.argv.includes("--check")) await check();
	const space = arg("space");
	if (!space) fail("--space <space id> is required (the space the File belongs to).");
	const local = arg("store");
	if (local) {
		await store(local, arg("name") || basename(local), space);
	} else {
		const url = process.argv.slice(2).find((a, i, all) => /^https?:\/\//.test(a) && !all[i - 1]?.startsWith("--"));
		if (!url) fail("Give the video's link (https://...).");
		await download(url, space);
	}
}
