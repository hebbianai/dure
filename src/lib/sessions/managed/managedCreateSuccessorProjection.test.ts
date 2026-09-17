import { describe, expect, it } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { managedCreateSuccessorProjection } from "@/lib/sessions/managed/managedCreateSuccessorProjection";
import {
	agentFixture,
	hmuxSessionMetadataFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const sourceSessionId = "session-source";
const successorSessionId = "session-successor";

function sourceAgent() {
	return agentFixture({
		id: "agent-source",
		sessionId: sourceSessionId,
		started: false,
		pendingCmd: "codex resume",
		runtimeBinding: managedBindingFixture({
			sessionId: sourceSessionId,
			createIdempotencyKey: "create-source",
		}),
	});
}

function projectionState(agent = sourceAgent()) {
	return {
		agents: [agent, agentFixture({ id: "agent-unrelated" })],
		sessionAgentRuntimeObservers: {
			[sourceSessionId]: { observer: "terminal-source" },
		},
		sessionAgentRuntimeState: {
			[sourceSessionId]: {
				terminalEpoch: "terminal-source",
				revision: "8",
			} as HmuxAgentRuntimeState,
		},
		sessionCwd: {
			[sourceSessionId]: "/source",
			"session-unrelated": "/unrelated",
		},
		sessionAgent: {
			[sourceSessionId]: "codex" as const,
			"session-unrelated": null,
		},
		sessionTitle: {
			[sourceSessionId]: "source title",
			"session-unrelated": "unrelated title",
		},
		sessionActivity: {
			[sourceSessionId]: { text: "source prompt", at: 1 },
		},
		sessionAgentPin: { [sourceSessionId]: "codex" as const },
		sshStates: {
			[sourceSessionId]: "connected" as const,
			"session-unrelated": "closed" as const,
		},
		sshMessages: {
			[sourceSessionId]: "source message",
			"session-unrelated": "unrelated message",
		},
		hmuxSessionMetadata: {
			...hmuxSessionMetadataFixture({
				sessionId: sourceSessionId,
				workspaceId: "workspace-1",
			}),
			...hmuxSessionMetadataFixture({
				sessionId: "session-unrelated",
				workspaceId: "workspace-unrelated",
			}),
		},
	};
}

describe("managedCreateSuccessorProjection", () => {
	it("atomically replaces the full agent identity and clears every source-session projection", () => {
		const agent = sourceAgent();
		const state = projectionState(agent);
		const before = structuredClone(state);
		const stopFence = stopFenceFixture({
			terminalEpoch: "terminal-successor",
		});
		const targetBinding = managedBindingFixture({
			sessionId: successorSessionId,
			createIdempotencyKey: "create-successor",
			stopFence,
		});

		const patch = managedCreateSuccessorProjection(state, agent, targetBinding);

		expect(patch.agents[0]).toMatchObject({
			id: agent.id,
			sessionId: successorSessionId,
			started: true,
			runtimeBinding: {
				sessionId: successorSessionId,
				createIdempotencyKey: "create-successor",
				stopFence,
			},
		});
		expect(patch.agents[0].pendingCmd).toBeUndefined();
		for (const record of [
			patch.sessionAgentRuntimeObservers,
			patch.sessionAgentRuntimeState,
			patch.sessionCwd,
			patch.sessionAgent,
			patch.sessionTitle,
			patch.sessionActivity,
			patch.sessionAgentPin,
			patch.sshStates,
			patch.sshMessages,
		]) {
			expect(record).not.toHaveProperty(sourceSessionId);
		}
		expect(patch.hmuxSessionMetadata).toEqual(
			hmuxSessionMetadataFixture({
				sessionId: "session-unrelated",
				workspaceId: "workspace-unrelated",
			}),
		);
		expect(patch.sessionCwd).toEqual({
			"session-unrelated": "/unrelated",
			[successorSessionId]: agent.worktreePath,
		});
		expect(patch.sshStates).toEqual({
			"session-unrelated": "closed",
		});
		expect(patch.sshMessages).toEqual({
			"session-unrelated": "unrelated message",
		});
		// Projection is a pure patch: installing the successor never mutates the
		// Zustand input snapshot.
		expect(state).toEqual(before);
		expect(state.sessionCwd).not.toHaveProperty(successorSessionId);
	});

	it("does not mutate a cwd snapshot that lacks the source identity", () => {
		const agent = sourceAgent();
		const state = projectionState(agent);
		const stateWithoutSourceCwd = {
			...state,
			sessionCwd: { "session-unrelated": "/unrelated" },
		};
		const originalCwd = stateWithoutSourceCwd.sessionCwd;
		const before = { ...originalCwd };

		const patch = managedCreateSuccessorProjection(
			stateWithoutSourceCwd,
			agent,
			managedBindingFixture({ sessionId: successorSessionId }),
		);

		expect(stateWithoutSourceCwd.sessionCwd).toBe(originalCwd);
		expect(stateWithoutSourceCwd.sessionCwd).toEqual(before);
		expect(patch.sessionCwd).toHaveProperty(
			successorSessionId,
			agent.worktreePath,
		);
	});

	it("keeps unrelated projection maps by reference when identity is current", () => {
		const agent = sourceAgent();
		const state = projectionState(agent);
		const targetBinding = managedBindingFixture({
			sessionId: sourceSessionId,
			createIdempotencyKey: "create-source",
			stopFence: stopFenceFixture(),
		});

		const patch = managedCreateSuccessorProjection(state, agent, targetBinding);

		const next = { ...state, ...patch };
		expect(Object.keys(patch)).toEqual(["agents"]);
		expect(next.sessionAgentRuntimeState).toBe(state.sessionAgentRuntimeState);
		expect(next.hmuxSessionMetadata).toBe(state.hmuxSessionMetadata);
		expect(next.sessionCwd).toBe(state.sessionCwd);
		expect(next.sessionAgent).toBe(state.sessionAgent);
		expect(next.sessionTitle).toBe(state.sessionTitle);
		expect(next.sessionActivity).toBe(state.sessionActivity);
		expect(next.sessionAgentPin).toBe(state.sessionAgentPin);
		expect(next.sshStates).toBe(state.sshStates);
		expect(next.sshMessages).toBe(state.sshMessages);
	});
});
