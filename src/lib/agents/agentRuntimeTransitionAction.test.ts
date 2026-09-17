import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	inspectTransitionIntent: vi.fn(),
	transition: vi.fn(),
	repair: vi.fn(),
	project: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		...mocks,
		inspectExact: mocks.inspect,
	}),
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: async () => null,
}));
vi.mock("@/lib/agents/agentRuntimeStoreProjector", () => ({
	projectAgentRuntimeTransition: mocks.project,
}));

import { useStore } from "@/store";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { transitionAgentRuntime } from "./agentRuntimeTransitionAction";

const routeAuthority = testDureBackendRouteAuthority("local", "backend-1");
const admitted = {
	state: "transitioning",
	stage: "admitted",
	agentId: "agent-1",
	operationId: "transition-1",
	journalRevision: 1,
	targetInteractionProfile: "structured_protocol",
	targetExecutionProfile: { kind: "provider_default" },
	backend: { id: "local", generation: "backend-1" },
	backendProfileId: "local",
	routeAuthority,
} as const;
const intent = {
	...admitted,
	sourceSelectionRevision: 2,
	sourceInteractionProfile: "native_cli",
	sourceExecutionProfile: { kind: "provider_default" },
	sourceLaunchSelection: {
		model: null,
		effort: null,
		permissionMode: "default",
	},
	targetLaunchSelection: {
		model: null,
		effort: null,
		permissionMode: "default",
	},
};
const result = {
	agentId: admitted.agentId,
	interactionProfile: admitted.targetInteractionProfile,
	executionProfile: admitted.targetExecutionProfile,
	selectionRevision: 3,
	backend: admitted.backend,
	backendProfileId: admitted.backendProfileId,
	routeAuthority,
};

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [agentFixture({ runtimeBinding: managedBindingFixture() })],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
	});
	mocks.inspect.mockResolvedValue(admitted);
	mocks.inspectTransitionIntent.mockResolvedValue(intent);
	mocks.transition.mockResolvedValue(result);
	mocks.repair.mockResolvedValue(result);
});

describe("admitted runtime actions", () => {
	it("submits the same transition intent as the CLI without selecting repair", async () => {
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
			}),
		).resolves.toEqual(result);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-1",
				targetInteractionProfile: "structured_protocol",
				routeAuthority,
			}),
		);
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("lets the backend decide a different target instead of rejecting it locally", async () => {
		const conflict = new Error("agent_runtime_transition_conflict");
		mocks.transition.mockRejectedValue(conflict);
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "native_cli",
			}),
		).rejects.toBe(conflict);
		expect(mocks.transition).toHaveBeenCalledTimes(1);
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("normalizes launch edits from the journal source and submits them once", async () => {
		await transitionAgentRuntime({
			agentId: "agent-1",
			targetInteractionProfile: "structured_protocol",
			targetLaunchSelectionUpdate: (source) => ({
				...source,
				model: "gpt-5.6-sol",
			}),
		});
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetLaunchSelection: {
					model: "gpt-5.6-sol",
					effort: null,
					permissionMode: "default",
				},
			}),
		);
		expect(mocks.repair).not.toHaveBeenCalled();
	});
});

describe("queued runtime dispatch authorization", () => {
	it("honors cancellation after asynchronous source preparation and before dispatch", async () => {
		let cancelled = false;
		mocks.inspectTransitionIntent.mockImplementationOnce(async () => {
			cancelled = true;
			return intent;
		});
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
				expectedSourceRevision: 2,
				beforeTransition: () => {
					if (cancelled) throw new Error("request_cancelled");
				},
			}),
		).rejects.toThrow("request_cancelled");
		expect(mocks.transition).not.toHaveBeenCalled();
	});
});
