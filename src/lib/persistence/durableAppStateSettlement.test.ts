import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
}));

vi.mock("@/store", () => ({
	rehydrateAppStoreFromDurableStorage: vi.fn(async () => {
		fixture.state = {
			...fixture.state,
			agents: [
				{
					id: "agent-1",
					name: "agent-1",
					provider: "codex",
					projectId: "project-1",
					worktreePath: "/repo/.worktrees/agent-1",
					branch: "agent-1",
					sessionId: "session-new",
					sessionKind: "pty",
				},
			],
			projects: [],
			sshHosts: [],
			layouts: {},
		};
	}),
	useStore: {
		getState: () => fixture.state,
		setState: (
			update:
				| Record<string, unknown>
				| ((state: Record<string, unknown>) => Record<string, unknown>),
		) => {
			const patch = typeof update === "function" ? update(fixture.state) : update;
			fixture.state = { ...fixture.state, ...patch };
		},
	},
}));

import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";

describe("settleDurableAppState", () => {
	beforeEach(() => {
		fixture.state = {
			agents: [
				{
					id: "agent-1",
					name: "agent-1",
					provider: "codex",
					projectId: "project-1",
					worktreePath: "/repo/.worktrees/agent-1",
					branch: "agent-1",
					sessionId: "session-old",
					sessionKind: "pty",
				},
			],
			projects: [{ id: "project-1" }],
			sshHosts: [],
			layouts: {},
			detected: {
				"project-1": [{ path: "/repo" }],
			},
			agentActivity: { "agent-1": true },
			chatDrafts: {},
			chatDraftMoves: {},
			agentRuntimeLaunchPresentation: { "agent-1": "working" },
			diffComments: { "agent-1": [] },
			gitStatuses: { "agent-1": [] },
			gitStatusErrors: { "agent-1": "error" },
			restartRequests: { "agent-1": true },
			sessionAgentRuntimeState: { "session-old": "working" },
			sessionAgentRuntimeObservers: { "session-old": { "view-1": "epoch-old" } },
			sessionCwd: { "session-old": "/repo" },
			sessionAgent: { "session-old": "codex" },
			sessionTitle: { "session-old": "Old session" },
			sessionActivity: { "session-old": true },
			sessionAgentPin: { "session-old": true },
			sshStates: { "session-old": "connected" },
			sshMessages: { "session-old": "stale" },
		};
	});

	it("removes runtime records whose durable references disappear during rehydrate", async () => {
		await settleDurableAppState();

		expect(fixture.state.agents).toEqual([
			expect.objectContaining({ id: "agent-1", sessionId: "session-new" }),
		]);
		expect(fixture.state.agentActivity).toEqual({});
		expect(fixture.state.sessionTitle).toEqual({});
		expect(fixture.state.sessionAgentRuntimeObservers).toEqual({});
		expect(fixture.state.sshMessages).toEqual({});
		expect(fixture.state.detected).toEqual({});
	});
});
