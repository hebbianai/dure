import { describe, expectTypeOf, it } from "vitest";
import type { AgentRuntimeLaunchSelectionUpdateV1 } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { DureAgentRuntimeLaunchSelectionTargetV1 } from "@/lib/ipc/dureAgentRuntime";

describe("Agent runtime launch selection", () => {
	it("accepts only source-derived updates rather than stale full snapshots", () => {
		expectTypeOf<AgentRuntimeLaunchSelectionUpdateV1>().toBeFunction();
		expectTypeOf<DureAgentRuntimeLaunchSelectionTargetV1>().not.toExtend<AgentRuntimeLaunchSelectionUpdateV1>();
	});
});
