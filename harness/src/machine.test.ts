import { expect, test } from "bun:test";
import type { Serving } from "./api";
import { agentRunsOn } from "./machine";

const serving = (reason: Serving["reason"], machineId: string): Serving => ({ machineId, reason, skills: [], candidates: [] });

test("an unpinned agent runs nowhere; otherwise a placed object runs every guest on its server, else each on its own pin", () => {
	// Object pin, machine/install, and capability routing beat the agent's
	// pin - but never put an agent with no Served by to work.
	for (const reason of ["self", "pinned", "pinned-uncapable", "capability"] as const) {
		expect(agentRunsOn(serving(reason, "object-host"), "agent-host")).toBe("object-host");
		expect(agentRunsOn(serving(reason, "object-host"), "")).toBe("");
	}
	// Following another guest's pin: a co-guest keeps its own machine, and an
	// unpinned co-guest runs nowhere rather than on the lender's machine.
	for (const reason of ["agent", "agent-capable", "unsatisfied"] as const) {
		expect(agentRunsOn(serving(reason, "lender-host"), "agent-host")).toBe("agent-host");
		expect(agentRunsOn(serving(reason, "lender-host"), "")).toBe("");
	}
	expect(agentRunsOn(serving("unserved", ""), "agent-host")).toBe("agent-host");
	expect(agentRunsOn(serving("unserved", ""), "")).toBe("");
});
