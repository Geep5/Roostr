import { afterEach, expect, test } from "bun:test";
import { fetchWithRetry, requestJson } from "./llm";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("provider requests retry transient socket resets before succeeding", async () => {
	let calls = 0;
	globalThis.fetch = Object.assign(async () => {
		calls++;
		if (calls === 1) throw new Error("The socket connection was closed unexpectedly");
		return new Response("{}", { status: 200 });
	}, { preconnect: originalFetch.preconnect });
	const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", { method: "POST" }, [0]);
	expect(res.status).toBe(200);
	expect(calls).toBe(2);
});

test("provider requests do not retry non-transient failures", async () => {
	let calls = 0;
	globalThis.fetch = Object.assign(async () => {
		calls++;
		throw new Error("certificate expired");
	}, { preconnect: originalFetch.preconnect });
	await expect(fetchWithRetry("https://api.anthropic.com/v1/messages", { method: "POST" })).rejects.toThrow("certificate expired");
	expect(calls).toBe(1);
});

test("a request whose text was cut through an emoji still serializes to valid JSON for the API", () => {
	const cut = "great reply 😘".slice(0, -1); // half of the emoji's UTF-16 pair
	const json = requestJson({ messages: [{ role: "user", content: cut }], ok: "😘 stays" });
	expect(json).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
	expect(JSON.parse(json)).toEqual({ messages: [{ role: "user", content: "great reply \uFFFD" }], ok: "😘 stays" });
});
