import { afterEach, expect, test } from "bun:test";
import { fetchWithRetry } from "./llm";

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
