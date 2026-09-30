import { expect, test } from "bun:test";
import { messageLines } from "./gmail";

const msg = (plain: string) => ({ id: "m", internalDate: "0", payload: { mimeType: "text/plain", body: { data: Buffer.from(plain).toString("base64url") } } });

test("a reply keeps its own words and drops the quoted history below it", () => {
	const lines = messageLines(msg("Hi,\n\nI still can't log in.\n\nThanks\nOn Tue, Sep 29, 2026 at 3:30 PM Matcherino <support@matcherino.com> wrote:\n> We received your ticket\n> ..."));
	expect(lines).toEqual(["Hi,", "", "I still can't log in.", "", "Thanks"]);
});

test("the quote attribution is recognised in any language", () => {
	expect(messageLines(msg("Neden lan neden\n\n29 Eyl 2026 Sal 22:02 tarihinde <support@matcherino.com> şunu yazdı:\n> You failed"))).toEqual(["Neden lan neden"]);
});

test("a reply with no words of its own keeps what it quoted, labelled", () => {
	const lines = messageLines(msg("Em qui., 9 de abr. de 2026 às 00:10, <support@matcherino.com> escreveu:\n\n> Hey Drrew,\n>\n> Congratulations! You earned $34.33"));
	expect(lines).toEqual(["(No text of their own - they replied to this earlier message:)", "Hey Drrew,", "", "Congratulations! You earned $34.33"]);
});

test("invisible preheader filler and runs of blank lines collapse", () => {
	expect(messageLines(msg("\u034f \u034f \u034f\n\n\nRegister now\n\n\n\nfor Oct 7"))).toEqual(["Register now", "", "for Oct 7"]);
});

test("an HTML-only message reads as text", () => {
	const html = { id: "m", internalDate: "0", payload: { mimeType: "text/html", body: { data: Buffer.from("<p>Hello &amp; welcome</p><div>Line two<br>three</div><style>x{}</style>").toString("base64url") } } };
	expect(messageLines(html)).toEqual(["Hello & welcome", "Line two", "three"]);
});
