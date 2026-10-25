import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machineId, resetMachineIdCache, setEnabled } from "./roster";

let dir = "";
const prior = process.env.GLON_DATA;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "roster-"));
	process.env.GLON_DATA = dir;
	resetMachineIdCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (prior === undefined) delete process.env.GLON_DATA;
	else process.env.GLON_DATA = prior;
	resetMachineIdCache();
});

test("a new computer mints its id once and keeps it", async () => {
	const id = await machineId();
	resetMachineIdCache();
	expect(await machineId()).toBe(id);
	await setEnabled("agent-1", true);
	resetMachineIdCache();
	expect(await machineId()).toBe(id);
});

test("an unreadable roster never becomes a new identity or loses the id", async () => {
	const path = join(dir, "harness.json");
	writeFileSync(path, '{"version": 1, "agents": [], "machineId": "real-id"');
	await expect(machineId()).rejects.toThrow("unreadable");
	await expect(setEnabled("agent-1", true)).rejects.toThrow("unreadable");
	// Nothing was written over it.
	expect(readFileSync(path, "utf8")).toBe('{"version": 1, "agents": [], "machineId": "real-id"');
});
