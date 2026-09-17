import { describe, expect, it } from "vitest";
import { isDispatchedAgent } from "@/lib/agents/agentDispatchOrigin";

describe("isDispatchedAgent", () => {
	it("is true when the agent carries a workflowDispatch receipt", () => {
		expect(
			isDispatchedAgent({
				workflowDispatch: {
					schemaVersion: 1,
					taskId: "task-1",
					dispatchId: "dispatch-1",
					generation: 1,
				},
			}),
		).toBe(true);
	});

	it("is false for an agent the user created — by hand or via quick-dispatch", () => {
		expect(isDispatchedAgent({})).toBe(false);
	});
});
