import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import * as api from "./api";
import type { ObjectJSON } from "./api";
import { beginAgentTurn, flagAgent, settleAgentTurn } from "./agent-errors";

const AGENT = "a1b2c3d4-0000-4000-8000-000000000001";
let error = "";
let spies: Array<{ mockRestore(): void }> = [];
beforeAll(() => {
	spies = [
		spyOn(api, "fetchObject").mockImplementation(async (id: string) => ({ id, typeKey: "agent", fields: error ? { error: { stringValue: error } } : {}, blocks: [] }) as unknown as ObjectJSON),
		spyOn(api, "setField").mockImplementation(async (_id, key, value) => {
			if (key === "error") error = value.stringValue ?? "";
			return {} as never;
		}),
		spyOn(api, "deleteField").mockImplementation(async (_id, key) => {
			if (key === "error") error = "";
			return {} as never;
		}),
	];
});
afterAll(() => spies.forEach((s) => s.mockRestore()));
afterEach(() => {
	error = "";
});
process.on("exit", () => spies.forEach((s) => s.mockRestore()));

test("a problem raised mid-turn stays on the agent through that turn's clean end, and the next clean turn clears it", async () => {
	beginAgentTurn(AGENT);
	await flagAgent(AGENT, "helper agent failed: token expired");
	await settleAgentTurn(AGENT, "");
	expect(error).toBe("helper agent failed: token expired");

	beginAgentTurn(AGENT);
	await settleAgentTurn(AGENT, "");
	expect(error).toBe("");
});

test("a failed turn is the agent's Error; a person's Error is never overwritten or cleared", async () => {
	beginAgentTurn(AGENT);
	await settleAgentTurn(AGENT, "anthropic 400: bad request");
	expect(error).toBe("run failed: anthropic 400: bad request");

	error = "paused by Grant - don't run";
	beginAgentTurn(AGENT);
	await flagAgent(AGENT, "needs browserless: not installed");
	expect(error).toBe("paused by Grant - don't run");
	beginAgentTurn(AGENT);
	await settleAgentTurn(AGENT, "");
	expect(error).toBe("paused by Grant - don't run");
});
