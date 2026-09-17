import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { DeferredCredentialSwitchIntentV1 } from "@/types";
import { requestAgentLaunchSelectionChange } from "./agentRuntimeLaunchSelectionChange";
import type {
	AgentRuntimeTransitionObserver,
	AgentRuntimeTransitionRequest,
} from "./agentRuntimeTransitionAction";

const mocks = vi.hoisted(() => ({ transition: vi.fn() }));
vi.mock("./agentRuntimeTransitionAction", () => ({
	transitionAgentRuntime: mocks.transition,
}));

const selection = {
	model: "gpt-6-astra",
	effort: "high",
	permissionMode: "default" as const,
};
const pending: DeferredCredentialSwitchIntentV1 = {
	schemaVersion: 1,
	requestId: "pending-1",
	sourceSessionId: "session-1",
	sourceWorkspaceId: "workspace-1",
	sourceConversationId: "conversation-1",
	sourceCredentialId: null,
	sourceCreateIdempotencyKey: "create-1",
	sourceCredentialGeneration: null,
	sourceTerminalEpoch: "terminal-1",
	sourceSelectionRevision: 7,
	baselineRuntimeRevision: "2",
	baselineTurnCompletedCount: "0",
	panelId: "agent:agent-1",
	requestedAtMs: 1,
	targetCredentialId: "account-1",
	targetCredentialDirectory: "/account-1",
	targetLaunchSelection: { ...selection, permissionMode: "skip_permissions" },
};
const request = () =>
	requestAgentLaunchSelectionChange({
		agentId: "agent-1",
		panelId: "agent:agent-1",
		update: (source) => ({ ...source, effort: "xhigh" }),
	});
beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [
			managedAgentFixture({
				conversationId: "conversation-1",
				pendingCredentialSwitch: { ...pending },
			}),
		],
		accounts: [
			{
				id: "account-1",
				provider: "codex",
				name: "Account",
				dir: "/account-1",
			},
		],
		sessionAgentRuntimeState: {},
	});
});

describe("pending runtime setting edits", () => {
	it.each([false, true])(
		"combines a later effort edit with the pending account (legacy: %s)",
		async (legacy) => {
			if (legacy)
				useStore.setState((state) => ({
					agents: state.agents.map((agent) => ({
						...agent,
						pendingCredentialSwitch: {
							...pending,
							sourceSelectionRevision: undefined,
							targetLaunchSelection: undefined,
						},
					})),
				}));
			mocks.transition.mockImplementation(
				async (
					input: AgentRuntimeTransitionRequest,
					observer: AgentRuntimeTransitionObserver,
				) => {
					observer.onSourceProjection?.({ selectionRevision: 7 } as never);
					expect(input.expectedSourceRevision).toBe(legacy ? undefined : 7);
					expect(input.credentialAction).toEqual({
						targetCredentialId: "account-1",
					});
					input.beforeTransition?.();
					return {
						selectionRevision: 8,
						providerConversationRef: "conversation-1",
						launchSelection: input.targetLaunchSelectionUpdate?.(selection),
					};
				},
			);
			expect(await request()).toMatchObject({
				outcome: "applied",
				value: {
					conversationId: "conversation-1",
					settings: {
						model: "gpt-6-astra",
						effort: "xhigh",
						permissionMode: legacy ? "default" : "skip_permissions",
					},
				},
			});
			expect(
				useStore.getState().agents[0].pendingCredentialSwitch,
			).toBeUndefined();
		},
	);
	it.each(["cancel", "replace"])(
		"refuses the prepared change if the queued request is %s before dispatch",
		async (action) => {
			let committed = false;
			mocks.transition.mockImplementation(
				async (
					input: AgentRuntimeTransitionRequest,
					observer: AgentRuntimeTransitionObserver,
				) => {
					observer.onSourceProjection?.({ selectionRevision: 7 } as never);
					input.targetLaunchSelectionUpdate?.(selection);
					useStore.setState((state) => ({
						agents: state.agents.map((agent) => ({
							...agent,
							pendingCredentialSwitch:
								action === "cancel"
									? undefined
									: { ...pending, requestId: "pending-new" },
						})),
					}));
					input.beforeTransition?.();
					committed = true;
				},
			);
			await expect(request()).rejects.toThrow(
				"client_agent_runtime_transition_conflict",
			);
			expect(committed).toBe(false);
			expect(
				useStore.getState().agents[0].pendingCredentialSwitch?.requestId,
			).toBe(action === "cancel" ? undefined : "pending-new");
		},
	);
	it("does not merge settings from a different source revision", async () => {
		mocks.transition.mockImplementation(
			async (
				input: AgentRuntimeTransitionRequest,
				observer: AgentRuntimeTransitionObserver,
			) => {
				observer.onSourceProjection?.({ selectionRevision: 8 } as never);
				input.targetLaunchSelectionUpdate?.(selection);
			},
		);
		await expect(request()).rejects.toThrow(
			"client_agent_runtime_transition_conflict",
		);
		expect(
			useStore.getState().agents[0].pendingCredentialSwitch?.requestId,
		).toBe("pending-1");
	});
});
