import { expect, test } from "bun:test";
import type { Serving } from "./api";
import { agentRunsOn } from "./machine";

const serving = (reason: Serving["reason"], machineId: string): Serving => ({ machineId, reason, skills: [], candidates: [] });

test("an agent runs on its own computer on every object, except work on a computer or installation itself", () => {
	// Object pins, capability routing and other guests' pins never move an agent.
	for (const reason of ["pinned", "pinned-uncapable", "capability", "agent", "agent-capable", "unsatisfied", "unserved"] as const) {
		expect(agentRunsOn(serving(reason, "object-host"), "agent-host")).toBe("agent-host");
	}
	// A computer or installation object is physical: its work happens there.
	expect(agentRunsOn(serving("self", "object-host"), "agent-host")).toBe("object-host");
	// An agent with no Served by runs nowhere, whatever the object says.
	for (const reason of ["self", "pinned", "agent", "unserved"] as const) {
		expect(agentRunsOn(serving(reason, "object-host"), "")).toBe("");
	}
});
