import { describe, expect, it } from "vitest";
import {
	censusProvesSessionEnded,
	exactCensusSession,
	hasPositiveAgentRuntimeObservation,
	isExitedHmuxSession,
} from "@/lib/agents/agentRuntimeLiveness";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

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

	it("finds a binding's exact session in a census", () => {
		const exact = hmuxSessionSummaryFixture();
		const sessions = [
			hmuxSessionSummaryFixture({ workspaceId: "workspace-2" }),
			exact,
		];
		expect(
			exactCensusSession(sessions, {
				sessionId: "session-1",
				workspaceId: "workspace-1",
			}),
		).toBe(exact);
		expect(
			exactCensusSession(sessions, {
				sessionId: "session-2",
				workspaceId: "workspace-1",
			}),
		).toBeUndefined();
	});

	it("proves a session ended only by its absence or its exit in this generation", () => {
		const stopFence = stopFenceFixture({ terminalEpoch: "terminal-1" });
		const binding = { sessionId: "session-1", workspaceId: "workspace-1", stopFence };
		const listed = (patch: Parameters<typeof hmuxSessionSummaryFixture>[0]) => [
			hmuxSessionSummaryFixture({ terminalEpoch: "terminal-1", stopFence, ...patch }),
		];
		expect(censusProvesSessionEnded([], binding)).toBe(true);
		expect(censusProvesSessionEnded(listed({ lifecycle: "exited" }), binding)).toBe(
			true,
		);
		// Live, or exited in another generation, says nothing about this one.
		expect(censusProvesSessionEnded(listed({}), binding)).toBe(false);
		expect(
			censusProvesSessionEnded(
				listed({ lifecycle: "exited", terminalEpoch: "terminal-2" }),
				binding,
			),
		).toBe(false);
		expect(
			censusProvesSessionEnded(
				listed({
					lifecycle: "exited",
					stopFence: stopFenceFixture({
						terminalEpoch: "terminal-1",
						hostInstanceId: "host-other",
					}),
				}),
				binding,
			),
		).toBe(false);
	});
});
