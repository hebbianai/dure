import { describe, expect, it } from "vitest";
import {
	hasPositiveAgentRuntimeObservation,
	isExitedHmuxSession,
} from "@/lib/agents/agentRuntimeLiveness";
import { agentFixture, hmuxSessionSummaryFixture } from "@/test/agentFixtures";

describe("agent runtime liveness", () => {
	it("treats projected, manifest, and health exits as terminal", () => {
		for (const summary of [
			hmuxSessionSummaryFixture({ lifecycle: "exited" }),
			hmuxSessionSummaryFixture({ manifestLifecycle: "exited" }),
			hmuxSessionSummaryFixture({ health: "exited" }),
		]) {
			expect(isExitedHmuxSession(summary)).toBe(true);
		}
		expect(isExitedHmuxSession(hmuxSessionSummaryFixture())).toBe(false);
	});

	it("uses only positive activity as a spawn-gap fence", () => {
		const agent = agentFixture();
		expect(
			hasPositiveAgentRuntimeObservation({
				agent,
				agentActivity: { [agent.id]: "connecting" },
				sessionAgentRuntimeState: {},
			}),
		).toBe(true);
		expect(
			hasPositiveAgentRuntimeObservation({
				agent,
				agentActivity: { [agent.id]: "exited" },
				sessionAgentRuntimeState: {},
			}),
		).toBe(false);
	});
});
