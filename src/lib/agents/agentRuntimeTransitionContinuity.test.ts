import { beforeEach, describe, expect, it, vi } from "vitest";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { transitionAgentRuntime } from "./agentRuntimeTransitionAction";
import type { AgentExecutionProfileV1 } from "./chat/agentConversationContract";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	transition: vi.fn(),
	converge: vi.fn(),
	registerCredential: vi.fn(),
	assertRoute: vi.fn(),
	adoptCheckpoint: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		inspect: mocks.inspect,
		inspectExact: mocks.inspect,
		transition: mocks.transition,
	}),
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: mocks.converge,
}));
vi.mock("@/lib/sessions/managed/managedAgentCheckpointBinding", () => ({
	adoptCurrentManagedAgentCheckpoint: mocks.adoptCheckpoint,
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.registerCredential,
}));
vi.mock("@/lib/ipc/dureBackend", async (original) => ({
	...(await original<object>()),
	assertDureBackendRouteAuthority: mocks.assertRoute,
}));

const originalConversation = "conversation-command-n";
const source = {
	state: "stable" as const,
	agentId: "agent-1",
	providerId: "codex" as const,
	backend: { id: "local", generation: "backend-1" },
	backendProfileId: "local",
	routeAuthority: testDureBackendRouteAuthority("local", "backend-1"),
	selectionRevision: 2,
	interactionProfile: "native_cli" as const,
	executionProfile: { kind: "provider_default" as const },
	providerConversationRef: originalConversation,
	sessionId: "session-1",
	workspaceId: "workspace-1",
	launchIdempotencyKey: "create-1",
	stopFence: stopFenceFixture(),
	launchSelection: {
		model: "gpt-6-astra",
		effort: "high",
		permissionMode: "default" as const,
	},
};
const edits = [
	{ name: "model", update: { model: "gpt-5.6-sol" } },
	{ name: "effort", update: { effort: "max" } },
	{
		name: "permission",
		update: { permissionMode: "skip_permissions" as const },
	},
];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.converge.mockResolvedValue(null);
	mocks.inspect.mockResolvedValue(source);
	mocks.transition.mockResolvedValue({
		...source,
		selectionRevision: 3,
		sessionId: "session-next",
	});
	useStore.setState({
		agents: [
			agentFixture({
				conversationId: originalConversation,
				runtimeBinding: managedBindingFixture({
					backendProfileId: "local",
					stopFence: source.stopFence,
				}),
			}),
		],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agentRuntimeLaunchPresentation: {},
		accounts: [],
	});
});

describe("checkpoint adoption after successor discovery", () => {
	it("preserves the discovery failure instead of submitting an unmanaged predecessor", async () => {
		const failure = new DureBackendRequestError(
			"hmux_descriptor_unavailable",
			"Successor observation is unavailable",
			{ kind: "operation", disposition: "retry_same" },
		);
		const agent = useStore.getState().agents[0];
		mocks.converge.mockRejectedValueOnce(failure);
		mocks.inspect.mockResolvedValueOnce({
			state: "unmanaged",
			agentId: source.agentId,
			backend: source.backend,
			backendProfileId: source.backendProfileId,
			routeAuthority: source.routeAuthority,
		});
		mocks.adoptCheckpoint.mockRejectedValueOnce(
			new Error("hmux_descriptor_mismatch"),
		);

		await expect(
			transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
			}),
		).rejects.toBe(failure);
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toBe(agent);
	});

	it("adopts an exact unmanaged checkpoint after a successful no-successor observation", async () => {
		mocks.inspect.mockResolvedValueOnce({
			state: "unmanaged",
			agentId: source.agentId,
			backend: source.backend,
			backendProfileId: source.backendProfileId,
			routeAuthority: source.routeAuthority,
		});
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
		});
		expect(mocks.adoptCheckpoint).toHaveBeenCalledExactlyOnceWith(
			source.agentId,
			source.routeAuthority,
		);
		expect(mocks.inspect).toHaveBeenCalledTimes(2);
		expect(mocks.transition).toHaveBeenCalledOnce();
	});

	it("keeps backend-owned settings available when advisory discovery fails", async () => {
		mocks.converge.mockRejectedValueOnce(
			new Error("hmux_descriptor_unavailable"),
		);
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
		});
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledOnce();
	});

	it("can learn a backend-owned conversation despite advisory discovery failure", async () => {
		mocks.converge.mockRejectedValueOnce(
			new Error("hmux_descriptor_unavailable"),
		);
		mocks.inspect.mockResolvedValueOnce({
			...source,
			providerConversationRef: null,
		});
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
		});
		expect(mocks.adoptCheckpoint).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledOnce();
	});
});

describe("late-learned native conversation before an explicit setting change", () => {
	it.each(edits)(
		"converges the missing backend conversation before changing $name",
		async ({ update }) => {
			mocks.inspect.mockResolvedValueOnce({
				...source,
				providerConversationRef: null,
			});
			await transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					...update,
				}),
			});
			expect(mocks.adoptCheckpoint).toHaveBeenCalledExactlyOnceWith(
				"agent-1",
				source.routeAuthority,
			);
			expect(mocks.inspect).toHaveBeenCalledTimes(2);
			expect(mocks.transition).toHaveBeenCalledOnce();
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
		},
	);
	it("does not adopt an already-known conversation", async () => {
		await transitionAgentRuntime({
			agentId: "agent-1",
			targetInteractionProfile: "preserve",
		});
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
		expect(mocks.inspect).toHaveBeenCalledOnce();
	});
	it("retains a pane whose conversation changes during checkpoint admission", async () => {
		mocks.inspect.mockResolvedValueOnce({
			...source,
			providerConversationRef: null,
		});
		mocks.adoptCheckpoint.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					conversationId: "human-selected-conversation",
				})),
			}));
		});
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].conversationId).toBe(
			"human-selected-conversation",
		);
	});
	it("prepares an account change after the backend learns the same conversation", async () => {
		mocks.inspect.mockResolvedValueOnce({
			...source,
			providerConversationRef: null,
		});
		await transitionAgentRuntime({
			agentId: "agent-1",
			targetInteractionProfile: "preserve",
			credentialAction: { targetCredentialId: null },
		});
		expect(mocks.adoptCheckpoint).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].conversationId).toBe(
			originalConversation,
		);
	});
	it("does not reinterpret a different known conversation as missing", async () => {
		mocks.inspect.mockResolvedValue({
			...source,
			providerConversationRef: "other-conversation",
		});
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
	});
	it("retains the pane when exact checkpoint convergence fails", async () => {
		mocks.inspect.mockResolvedValue({
			...source,
			providerConversationRef: null,
		});
		mocks.adoptCheckpoint.mockRejectedValue(
			new Error("hmux_descriptor_mismatch"),
		);
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
			}),
		).rejects.toThrow("hmux_descriptor_mismatch");
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].conversationId).toBe(
			originalConversation,
		);
	});
	it("does not retry or erase the visible conversation when it remains unknown", async () => {
		mocks.inspect.mockResolvedValue({
			...source,
			providerConversationRef: null,
		});
		await expect(
			transitionAgentRuntime({
				agentId: "agent-1",
				targetInteractionProfile: "preserve",
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(mocks.adoptCheckpoint).toHaveBeenCalledOnce();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].conversationId).toBe(
			originalConversation,
		);
	});
});

describe("setting edits after an exact Resume with an unclaimed credential generation", () => {
	const account = {
		id: "account-source",
		provider: "codex" as const,
		name: "Source",
		dir: "/accounts/codex-source",
	};
	const resumed = {
		...source,
		executionProfile: {
			kind: "credential_reference" as const,
			reference_id: account.id,
			credential_generation: null,
		},
	};
	const targetProfile = {
		...resumed.executionProfile,
		credential_generation: "target-generation",
	};
	beforeEach(() => {
		mocks.inspect.mockResolvedValue(resumed);
		mocks.registerCredential.mockResolvedValue(targetProfile);
		mocks.transition.mockImplementation(
			async (request: {
				targetExecutionProfile?: AgentExecutionProfileV1;
				targetLaunchSelection?: typeof source.launchSelection;
			}) => {
				const executionProfile =
					request.targetExecutionProfile ?? resumed.executionProfile;
				if (
					executionProfile.kind === "credential_reference" &&
					executionProfile.credential_generation === null
				) {
					throw new Error("agent_runtime_transition_request_invalid");
				}
				return {
					...resumed,
					executionProfile,
					selectionRevision: 3,
					sessionId: "session-next",
					launchSelection:
						request.targetLaunchSelection ?? resumed.launchSelection,
				};
			},
		);
		useStore.setState((state) => ({
			accounts: [
				account,
				{ ...account, id: "account-other", dir: "/accounts/codex-other" },
			],
			agents: state.agents.map((agent) => ({
				...agent,
				credentialId: "account-other",
			})),
		}));
	});

	it.each(edits)(
		"prepares the observed source account as the exact $name target",
		async ({ update }) => {
			await transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					...update,
				}),
			});
			expect(mocks.registerCredential).toHaveBeenCalledExactlyOnceWith(
				{
					providerId: "codex",
					referenceId: account.id,
					profileDirectoryName: "codex-source",
				},
				{ profileId: "local", routeAuthority: source.routeAuthority },
			);
			expect(mocks.transition).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					expectedSourceRevision: source.selectionRevision,
					sourceStopPolicy: "preserve",
					targetExecutionProfile: targetProfile,
					targetLaunchSelection: { ...source.launchSelection, ...update },
				}),
			);
			expect(resumed.executionProfile.credential_generation).toBeNull();
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
		},
	);

	it("keeps an explicit execution target instead of preparing the source account", async () => {
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
			targetExecutionProfile: { kind: "provider_default" },
		});
		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetExecutionProfile: { kind: "provider_default" },
			}),
		);
	});

	it("honors an explicit switch to provider credentials", async () => {
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
			credentialAction: { targetCredentialId: null },
		});
		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetExecutionProfile: { kind: "provider_default" },
			}),
		);
	});

	it("refuses a late preparation after the human selects another conversation", async () => {
		mocks.registerCredential.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					conversationId: "conversation-new-selection",
				})),
			}));
			return targetProfile;
		});
		await expect(
			transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					effort: "max",
				}),
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].conversationId).toBe(
			"conversation-new-selection",
		);
	});

	it("does not stop the source if target credential preparation fails", async () => {
		mocks.registerCredential.mockRejectedValue(
			new Error("credential_reference_unavailable"),
		);
		await expect(
			transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					effort: "max",
				}),
			}),
		).rejects.toThrow("credential_reference_unavailable");
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].sessionId).toBe(source.sessionId);
		expect(useStore.getState().agents[0].executionProfile).toEqual(
			resumed.executionProfile,
		);
	});
});
describe("runtime setting conversation continuity", () => {
	it("rejects an edit after the human selects a different conversation", async () => {
		await expect(
			transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
				expectedConversationId: "conversation-observed-before-human-change",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					effort: "max",
				}),
			}),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(mocks.transition).not.toHaveBeenCalled();
	});

	it.each(edits)(
		"rejects a stale $name edit through the existing selection revision",
		async ({ update }) => {
			await expect(
				transitionAgentRuntime({
					agentId: source.agentId,
					targetInteractionProfile: "preserve",
					expectedSourceRevision: source.selectionRevision - 1,
					expectedConversationId: originalConversation,
					targetLaunchSelectionUpdate: (selection) => ({
						...selection,
						...update,
					}),
				}),
			).rejects.toThrow("client_agent_runtime_transition_conflict");
			expect(mocks.transition).not.toHaveBeenCalled();
		},
	);
	it("accepts the first provider conversation when the source has not observed one yet", async () => {
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				conversationId: undefined,
			})),
		}));
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
			targetLaunchSelectionUpdate: (selection) => ({
				...selection,
				effort: "max",
			}),
		});
		expect(useStore.getState().agents[0].conversationId).toBe(
			originalConversation,
		);
		expect(mocks.transition).toHaveBeenCalledOnce();
	});

	it("accepts a newer source runtime generation for the same conversation", async () => {
		const rehosted = {
			...source,
			sessionId: "session-rehosted",
			selectionRevision: 3,
		};
		mocks.inspect.mockResolvedValue(rehosted);
		mocks.transition.mockResolvedValue({
			...rehosted,
			selectionRevision: 4,
			sessionId: "session-next",
		});
		await transitionAgentRuntime({
			agentId: source.agentId,
			targetInteractionProfile: "preserve",
			targetLaunchSelectionUpdate: (selection) => ({
				...selection,
				effort: "max",
			}),
		});
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({ expectedSourceRevision: 3 }),
		);
		expect(useStore.getState().agents[0].conversationId).toBe(
			originalConversation,
		);
	});

	it.each(edits)(
		"$name does not overwrite a conversation selected during source inspection",
		async ({ update }) => {
			mocks.inspect.mockImplementationOnce(async () => {
				useStore.setState((state) => ({
					agents: state.agents.map((agent) => ({
						...agent,
						conversationId: "conversation-new-selection",
						sessionId: "session-selected",
					})),
				}));
				return source;
			});
			await expect(
				transitionAgentRuntime({
					agentId: source.agentId,
					targetInteractionProfile: "preserve",
					targetLaunchSelectionUpdate: (selection) => ({
						...selection,
						...update,
					}),
				}),
			).rejects.toThrow("client_agent_runtime_transition_conflict");
			expect(mocks.transition).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0].conversationId).toBe(
				"conversation-new-selection",
			);
			expect(useStore.getState().agents[0].sessionId).toBe("session-selected");
		},
	);

	it.each(edits)(
		"$name does not install a mismatched transition receipt",
		async ({ update }) => {
			mocks.transition.mockResolvedValue({
				...source,
				selectionRevision: 3,
				sessionId: "session-other",
				providerConversationRef: "conversation-other-work",
			});
			await expect(
				transitionAgentRuntime({
					agentId: source.agentId,
					targetInteractionProfile: "preserve",
					targetLaunchSelectionUpdate: (selection) => ({
						...selection,
						...update,
					}),
				}),
			).rejects.toThrow("client_agent_runtime_transition_conflict");
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
			expect(useStore.getState().agents[0].sessionId).toBe(source.sessionId);
		},
	);

	it.each(edits)(
		"$name does not replace the visible conversation while inspecting its source",
		async ({ update }) => {
			const other = {
				...source,
				providerConversationRef: "conversation-other-work",
				sessionId: "session-other",
			};
			mocks.inspect.mockResolvedValue(other);
			mocks.transition.mockResolvedValue({ ...other, selectionRevision: 3 });
			await expect(
				transitionAgentRuntime({
					agentId: source.agentId,
					targetInteractionProfile: "preserve",
					targetLaunchSelectionUpdate: (selection) => ({
						...selection,
						...update,
					}),
				}),
			).rejects.toThrow("client_agent_runtime_transition_conflict");
			expect(mocks.transition).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
			expect(useStore.getState().agents[0].sessionId).toBe(source.sessionId);
		},
	);

	it.each(edits)(
		"$name preserves the conversation through a new runtime generation",
		async ({ update }) => {
			await transitionAgentRuntime({
				agentId: source.agentId,
				targetInteractionProfile: "preserve",
				targetLaunchSelectionUpdate: (selection) => ({
					...selection,
					...update,
				}),
			});
			expect(mocks.transition).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedSourceRevision: source.selectionRevision,
					sourceStopPolicy: "preserve",
					targetLaunchSelection: { ...source.launchSelection, ...update },
				}),
			);
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
			expect(useStore.getState().agents[0].sessionId).toBe("session-next");
		},
	);
});
