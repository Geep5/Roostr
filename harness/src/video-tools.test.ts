/**
 * The decisions inside `roostr-clip` and `roostr-palmier` (harness/scripts):
 * which yt-dlp is new enough, what a failure tells the person, how clip
 * times read, and how Palmier's streamed MCP replies are read.
 */
import { expect, test } from "bun:test";
import { explainFailure, readProbe, seconds, ytdlpAtLeast } from "../scripts/clip";
import { resultText, rpcReply } from "../scripts/palmier";
import { MATTE, frameTicks, size, stitchArgs, ticksAt } from "../scripts/rive";

test("yt-dlp from 2026.08.19 on passes the check; anything older or unreadable fails", () => {
	expect(ytdlpAtLeast("2026.08.19")).toBe(true);
	expect(ytdlpAtLeast("2026.08.19.1")).toBe(true);
	expect(ytdlpAtLeast("2026.10.26")).toBe(true);
	expect(ytdlpAtLeast("2027.01.02")).toBe(true);
	expect(ytdlpAtLeast("2026.08.18")).toBe(false);
	expect(ytdlpAtLeast("2026.07.30")).toBe(false);
	expect(ytdlpAtLeast("2025.12.31")).toBe(false);
	expect(ytdlpAtLeast("")).toBe(false);
});

test("a 403 says to upgrade yt-dlp; other failures say what happened", () => {
	expect(explainFailure("ERROR: unable to download video data: HTTP Error 403: Forbidden")).toContain("brew upgrade yt-dlp");
	expect(explainFailure("ERROR: [youtube] aaaaaaaaaaa: This video is unavailable")).toBe("The video is unavailable (deleted, or the link is wrong).");
	expect(explainFailure("ERROR: [youtube] x: Private video. Sign in if you've been granted access")).toBe("The video is private.");
	expect(explainFailure("ERROR: Unsupported URL: https://example.com/x")).toBe("yt-dlp doesn't support this link.");
	expect(explainFailure("WARNING: x\nERROR: [twitch] something odd")).toBe("Download failed: [twitch] something odd");
});

test("clip times read as seconds, M:SS or H:MM:SS; anything else is refused", () => {
	expect(seconds("75")).toBe(75);
	expect(seconds("1:15")).toBe(75);
	expect(seconds("1:02:03")).toBe(3723);
	expect(seconds("0:05.5")).toBe(5.5);
	expect(seconds("1m15s")).toBeNull();
	expect(seconds("-3")).toBeNull();
	expect(seconds("")).toBeNull();
});

test("a probe without an audio stream or a video stream says so", () => {
	const both = readProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }], format: { duration: "33.7", size: "5789398" } }));
	expect(both).toEqual({ duration: 33.7, size: 5789398, width: 1920, height: 1080, video: true, audio: true });
	const silent = readProbe(JSON.stringify({ streams: [{ codec_type: "video", width: 320, height: 240 }], format: { duration: "7" } }));
	expect(silent.audio).toBe(false);
	expect(readProbe(JSON.stringify({ streams: [{ codec_type: "audio" }], format: {} })).video).toBe(false);
});

test("Palmier's reply is found by id in a server-sent event stream or plain JSON", () => {
	const stream = 'id: 3_5\ndata: \n\nid: 3_6\nevent: message\ndata: {"id":3,"jsonrpc":"2.0","result":{"content":[{"text":"{\\"ok\\":1}","type":"text"}]}}\n';
	expect(rpcReply(stream, 3)).toEqual({ id: 3, jsonrpc: "2.0", result: { content: [{ text: '{"ok":1}', type: "text" }] } } as never);
	expect(rpcReply(stream, 4)).toBeNull();
	expect(rpcReply('{"id":7,"jsonrpc":"2.0","error":{"message":"bad"}}', 7)?.error?.message).toBe("bad");
});

test("a Palmier tool's error result is an error, with its text", () => {
	expect(resultText({ content: [{ text: "Unknown tool: nope", type: "text" }], isError: true })).toEqual({ text: "Unknown tool: nope", isError: true });
	expect(resultText({ content: [{ text: "a", type: "text" }, { type: "image" }] })).toEqual({ text: "a\n[image content]", isError: false });
});

test("a Rive moment reads as 1/60 s ticks: seconds, milliseconds or a bare tick count, at least one", () => {
	expect(ticksAt("2s")).toBe(120);
	expect(ticksAt("500ms")).toBe(30);
	expect(ticksAt("120")).toBe(120);
	expect(ticksAt("0")).toBe(1);
	expect(ticksAt("1.5s")).toBe(90);
	expect(ticksAt("two seconds")).toBeNull();
	expect(ticksAt("-1s")).toBeNull();
});

test("frames land on the right ticks at 30 and 60 fps, the first one advanced once", () => {
	expect([0, 1, 2, 30].map((i) => frameTicks(i, 30))).toEqual([1, 2, 4, 60]);
	expect([0, 1, 2, 60].map((i) => frameTicks(i, 60))).toEqual([1, 1, 2, 60]);
	expect(size("1920x1080")).toEqual({ w: 1920, h: 1080 });
	expect(size("3840X2160")).toEqual({ w: 3840, h: 2160 });
	expect(size("1080p")).toBeNull();
});

test("a render stitches to H.264 MP4, or with alpha to ProRes 4444 from the black and white passes", () => {
	const mp4 = stitchArgs("/f", 30, false, "/o.mp4");
	expect(mp4).toContain("libx264");
	expect(mp4.join(" ")).not.toContain("white_");
	const mov = stitchArgs("/f", 60, true, "/o.mov");
	expect(mov.join(" ")).toContain("/f/white_%05d.png");
	expect(mov).toContain(MATTE);
	expect(mov.slice(mov.indexOf("-profile:v"), mov.indexOf("-profile:v") + 2)).toEqual(["-profile:v", "4444"]);
	expect(mov.at(-1)).toBe("/o.mov");
});
