import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalAddAgentRunInput } from "@/lib/agents/addAgentCanonicalRun";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	runCanonicalAddAgent: vi.fn(),
	ensureManagedAgentRuntime: vi.fn(),
	openAgentPanel: vi.fn(),
	resolveOwnership: vi.fn(),
	resumeExactManagedAgentPane: vi.fn(),
	assertPermit: vi.fn(),
	revalidatePermit: vi.fn(),
	inspectSelectedProjection: vi.fn(),
	inspectStructuredProjectionContext: vi.fn(),
	startFreshManagedAgentPane: vi.fn(),
	ensureRemoteManagedAgentRuntime: vi.fn(),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main-window" }),
}));
vi.mock("@/lib/agents/addAgentCanonicalRun", () => ({
	runCanonicalAddAgent: mocks.runCanonicalAddAgent,
	runCanonicalAddAgentPresenting: mocks.runCanonicalAddAgent,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
}));
vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensureManagedAgentRuntime,
	MANAGED_BOOTSTRAP_GEOMETRY: { columns: 120, rows: 30 },
}));
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => ({
	resumeExactManagedAgentPane: mocks.resumeExactManagedAgentPane,
}));
vi.mock("@/lib/sessions/managed/managedAgentFreshStart", () => ({
	startFreshManagedAgentPane: mocks.startFreshManagedAgentPane,
}));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensureRemoteManagedAgentRuntime,
}));
vi.mock("@/lib/sessions/managed/managedConversationOwnership", () => ({
	ManagedConversationOwnershipUnavailableError: class extends Error {
		constructor(readonly reason: string) {
			super(reason);
		}
	},
	resolveManagedConversationOwnership: mocks.resolveOwnership,
	assertManagedConversationLaunchPermit: mocks.assertPermit,
	revalidateManagedConversationLaunchPermit: mocks.revalidatePermit,
}));
vi.mock("@/lib/agents/agentRuntimeProjectionRecovery", () => ({
	inspectSelectedAgentRuntimeProjection: mocks.inspectSelectedProjection,
	inspectStructuredAgentRuntimeProjectionContext:
		mocks.inspectStructuredProjectionContext,
}));

import {
	launchManagedConversationPane,
	launchManagedConversationTargetInSibling,
	launchPreparedManagedConversationPane,
	ManagedConversationAlreadyActiveError,
	ManagedConversationPresentedInBackgroundError,
	managedConversationLaunchFailureMessage,
	recoverExitedManagedConversationPane,
} from "@/lib/sessions/managed/managedConversationLaunch";
import { ManagedConversationOwnershipUnavailableError } from "@/lib/sessions/managed/managedConversationOwnership";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority(
	"dure-local",
	"generation-1",
	"local",
);

function sourceAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-source",
		name: "pixel",
		displayName: "Pixel",
		provider: "codex",
		projectId: "project-1",
		worktreePath: "/repo/.worktrees/pixel",
		branch: "agent/pixel",
		sessionId: "hmux-source",
		runtimeBinding: managedBindingFixture({
			sessionId: "hmux-source",
			workspaceId: "workspace-source",
			createIdempotencyKey: "source-create",
			backendProfileId: "local",
			credentialId: "credential-crispy",
			credentialGeneration: 4,
			stopFence: stopFenceFixture(),
		}),
		executionProfile: {
			kind: "credential_reference",
			reference_id: "credential-crispy",
			credential_generation: "credential-generation-4",
		},
		conversationId: "conversation-live",
		accountId: "credential-crispy",
		credentialId: "credential-crispy",
		started: true,
		...patch,
	});
}

function structuredSource(patch: Partial<Agent> = {}): Agent {
	return sourceAgent({
		runtimeBinding: undefined,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-source",
		},
		...patch,
	});
}

function projectionContext(source: Agent) {
	return {
		schemaVersion: 1 as const,
		identity: { kind: "registered" as const },
		agent: {
			agentId: source.id,
			workspaceId: "workspace-source",
			providerId: source.provider,
		},
		workspace: {
			workspaceId: "workspace-source",
			projectId: "project-1",
			rootPath: source.worktreePath,
		},
		project: { projectId: "project-1", rootPath: "/repo" },
	};
}

function stableStructuredProjection(source: Agent) {
	const profile = source.interactionProfile;
	if (profile?.kind !== "structured_protocol") {
		throw new Error("expected structured source");
	}
	return {
		state: "stable" as const,
		agentId: source.id,
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		selectionRevision: 4,
		providerId: source.provider,
		executionProfile: source.executionProfile ?? {
			kind: "provider_default" as const,
		},
		providerConversationRef: source.conversationId ?? null,
		launchSelection: {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "skip_permissions" as const,
		},
		interactionProfile: "structured_protocol" as const,
		interactionSessionId: profile.interactionSessionId,
		projectionContext: projectionContext(source),
	};
}

function stableNativeProjection(source: Agent) {
	const binding = source.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || !binding.stopFence) {
		throw new Error("expected fenced native source");
	}
	return {
		state: "stable" as const,
		agentId: source.id,
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		selectionRevision: 4,
		providerId: source.provider,
		executionProfile: source.executionProfile ?? {
			kind: "provider_default" as const,
		},
		providerConversationRef: source.conversationId ?? null,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default" as const,
		},
		interactionProfile: "native_cli" as const,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		launchIdempotencyKey: binding.createIdempotencyKey ?? null,
		stopFence: binding.stopFence,
		projectionContext: projectionContext(source),
	};
}

async function presentCanonicalRun(
	input: CanonicalAddAgentRunInput,
	disposition: "pane" | "background" = "pane",
): Promise<{
	run: { agentId: string };
	disposition: "pane" | "background";
}> {
	const source = useStore
		.getState()
		.agents.find(
			(agent) => agent.id === input.existingWorkspace?.sourceAgentId,
		);
	if (!source || !input.existingWorkspace) {
		throw new Error("missing existing workspace source");
	}
	const id = `agent-history-${mocks.runCanonicalAddAgent.mock.calls.length}`;
	const launched: Agent = {
		...source,
		id,
		name: input.agentName,
		displayName: undefined,
		sessionId: id,
		started: true,
		runtimeBinding: undefined,
		executionProfile: input.existingWorkspace.executionProfile,
		conversationId:
			input.existingWorkspace.providerConversationRef ?? undefined,
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: input.existingWorkspace.routeAuthority.profileId,
			interactionSessionId: `interaction-${id}`,
		},
	};
	useStore.setState((state) => ({ agents: [...state.agents, launched] }));
	return { run: { agentId: id }, disposition };
}

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.openAgentPanel.mockReturnValue(true);
	mocks.revalidatePermit.mockResolvedValue(undefined);
	const source = structuredSource();
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [source],
		agentActivity: { [source.id]: "working" },
		activeSpaceId: "desktop-1",
		stats: {
			agentsStarted: 4,
			prsCreated: 0,
			activeMs: 0,
			since: 1,
		},
	});
	mocks.resolveOwnership.mockResolvedValue({
		state: "vacant",
		permit: {
			schemaVersion: 1,
			providerId: "codex",
			conversationId: "conversation-history",
			candidateFingerprints: [],
		},
	});
	mocks.inspectStructuredProjectionContext.mockResolvedValue(
		stableStructuredProjection(source),
	);
	mocks.inspectSelectedProjection.mockImplementation(async () => {
		const current = useStore
			.getState()
			.agents.find((agent) => agent.id === "agent-source")!;
		return stableNativeProjection(current);
	});
	mocks.runCanonicalAddAgent.mockImplementation(presentCanonicalRun);
});

describe("managed conversation history launch", () => {
	it("presents the exact ledger successor after a prepared create advances", async () => {
		const staged = sourceAgent({
			id: "agent-prepared",
			name: "prepared",
			sessionId: "hmux-predecessor",
			started: false,
			conversationId: "conversation-history",
			runtimeBinding: managedBindingFixture({
				sessionId: "hmux-predecessor",
				workspaceId: "workspace-prepared",
				createIdempotencyKey: "create-predecessor",
				stopFence: undefined,
			}),
		});
		let successor: Agent | undefined;
		mocks.ensureManagedAgentRuntime.mockImplementationOnce(
			async (initial: Agent, options: { beforeCreate?: () => void }) => {
				options.beforeCreate?.();
				const binding = initial.runtimeBinding;
				if (binding?.runtime !== "hmux_managed_v1") {
					throw new Error("expected managed predecessor");
				}
				const committed: Agent = {
					...initial,
					sessionId: "hmux-successor",
					started: true,
					runtimeBinding: {
						...binding,
						sessionId: "hmux-successor",
						createIdempotencyKey: "create-successor",
						stopFence: stopFenceFixture({
							terminalEpoch: "terminal-successor",
						}),
					},
				};
				successor = committed;
				useStore.setState((state) => ({
					agents: state.agents.map((agent) =>
						agent.id === initial.id ? committed : agent,
					),
				}));
				return { agent: committed };
			},
		);

		const launched = await launchPreparedManagedConversationPane(
			staged,
			"desktop-1",
		);

		expect(launched).toBe(successor);
		expect(mocks.openAgentPanel).toHaveBeenCalledWith("desktop-1", successor);
	});

	it("preserves conversation evidence projected while prepared create is rejected", async () => {
		const staged = sourceAgent({
			id: "agent-prepared",
			name: "prepared",
			sessionId: "hmux-predecessor",
			started: false,
			conversationId: "conversation-history",
			conversationIdentity: undefined,
			runtimeBinding: managedBindingFixture({
				sessionId: "hmux-predecessor",
				workspaceId: "workspace-prepared",
				createIdempotencyKey: "create-predecessor",
				stopFence: undefined,
			}),
		});
		mocks.ensureManagedAgentRuntime.mockImplementationOnce(
			async (initial: Agent) => {
				useStore.setState((state) => ({
					agents: state.agents.map((candidate) =>
						candidate.id === initial.id
							? {
									...candidate,
									conversationIdentity: {
										state: "ready",
										conversationId: "conversation-history",
									},
								}
							: candidate,
					),
				}));
				throw new Error("managed Hmux create source changed before admission");
			},
		);

		await expect(
			launchPreparedManagedConversationPane(staged, "desktop-1"),
		).rejects.toThrow("managed Hmux create source changed before admission");

		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({ id: "agent-source" }),
			expect.objectContaining({
				id: staged.id,
				conversationIdentity: {
					state: "ready",
					conversationId: "conversation-history",
				},
			}),
		]);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("uses the canonical Chat-first run with exact resume and existing-workspace authority", async () => {
		const source = useStore.getState().agents[0]!;
		const launched = await launchManagedConversationTargetInSibling({
			sourceAgentId: source.id,
			desktopId: "desktop-1",
			referencePanelId: "agent:source",
			target: { kind: "id", id: "conversation-history" },
		});

		expect(mocks.runCanonicalAddAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				project: expect.objectContaining({ id: "project-1", kind: "local" }),
				provider: "codex",
				accountId: null,
				useWorktree: false,
				setupCommand: null,
				model: "gpt-5.6-sol",
				effort: "high",
				permissionOverride: "bypass_approvals",
				existingWorkspace: {
					sourceAgentId: source.id,
					workspaceId: "workspace-source",
					branch: source.branch,
					executionProfile: source.executionProfile,
					providerConversationRef: "conversation-history",
					routeAuthority,
				},
				actionId: expect.stringMatching(/^managed-conversation:[a-f0-9]{64}$/),
			}),
			{
				spaceId: "desktop-1",
				windowLabel: "main-window",
				referencePanelId: "agent:source",
			},
		);
		expect(launched).toMatchObject({
			worktreePath: source.worktreePath,
			conversationId: "conversation-history",
			interactionProfile: { kind: "structured_protocol" },
		});
		expect(useStore.getState().agents[0]).toBe(source);
		expect(mocks.ensureManagedAgentRuntime).not.toHaveBeenCalled();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("does not alias different exact conversations before either projects", async () => {
		mocks.runCanonicalAddAgent.mockRejectedValue(
			new Error("launch unavailable"),
		);

		for (const id of ["conversation-a", "conversation-b"]) {
			await expect(
				launchManagedConversationPane({
					sourceAgentId: "agent-source",
					desktopId: "desktop-1",
					conversationId: id,
				}),
			).rejects.toThrow("launch unavailable");
		}

		const actionIds = mocks.runCanonicalAddAgent.mock.calls.map(
			([input]) => (input as CanonicalAddAgentRunInput).actionId,
		);
		expect(actionIds).toHaveLength(2);
		expect(actionIds[0]).not.toBe(actionIds[1]);
		expect(actionIds).toEqual([
			expect.stringMatching(/^managed-conversation:[a-f0-9]{64}$/),
			expect.stringMatching(/^managed-conversation:[a-f0-9]{64}$/),
		]);
	});

	it("surfaces a background recovery without spawning again or losing its unopened projection", async () => {
		mocks.runCanonicalAddAgent.mockImplementationOnce(
			(input: CanonicalAddAgentRunInput) =>
				presentCanonicalRun(input, "background"),
		);

		await expect(
			launchManagedConversationTargetInSibling({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				referencePanelId: "agent:source",
				target: { kind: "fresh" },
			}),
		).rejects.toMatchObject({
			code: "managed_conversation_presented_in_background",
		});

		expect(mocks.runCanonicalAddAgent).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({ id: "agent-source" }),
			expect.objectContaining({ id: "agent-history-1" }),
		]);
	});

	it("routes a native source through the same canonical run without a PTY fallback", async () => {
		const native = sourceAgent();
		useStore.setState({ agents: [native] });
		const launched = await launchManagedConversationPane({
			sourceAgentId: native.id,
			desktopId: "desktop-1",
			conversationId: "conversation-history",
		});

		expect(mocks.inspectSelectedProjection).toHaveBeenCalledWith(native.id);
		expect(mocks.runCanonicalAddAgent).toHaveBeenCalledOnce();
		expect(launched.interactionProfile?.kind).toBe("structured_protocol");
		expect(mocks.ensureManagedAgentRuntime).not.toHaveBeenCalled();
	});

	it("preserves the complete sidebar drop placement through canonical presentation", async () => {
		const position = {
			referenceGroup: { id: "drop-group" },
			direction: "above",
		};

		await launchManagedConversationPane({
			sourceAgentId: "agent-source",
			desktopId: "desktop-1",
			conversationId: "conversation-history",
			position,
		});

		expect(mocks.runCanonicalAddAgent).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ position }),
		);
	});

	it("launches fresh intent through the same provider-neutral path", async () => {
		const launched = await launchManagedConversationPane({
			sourceAgentId: "agent-source",
			desktopId: "desktop-1",
		});

		expect(
			vi.mocked(mocks.runCanonicalAddAgent).mock.calls[0]?.[0].existingWorkspace
				?.providerConversationRef,
		).toBeNull();
		expect(launched.conversationId).toBeUndefined();
	});

	it.each([undefined, "conversation-history"])(
		"preserves auto-edit for fresh and exact sibling launches (%s)",
		async (conversationId) => {
			const source = useStore.getState().agents[0]!;
			mocks.inspectStructuredProjectionContext.mockResolvedValue({
				...stableStructuredProjection(source),
				launchSelection: {
					model: "gpt-5.6-sol",
					effort: "high",
					permissionMode: "auto_edit",
				},
			});

			await launchManagedConversationPane({
				sourceAgentId: source.id,
				desktopId: "desktop-1",
				...(conversationId ? { conversationId } : {}),
			});

			expect(mocks.runCanonicalAddAgent).toHaveBeenCalledWith(
				expect.objectContaining({ permissionOverride: "auto_edit" }),
				expect.objectContaining({ spaceId: "desktop-1" }),
			);
		},
	);

	it("preserves provider path segments through the canonical conversation boundary", async () => {
		await launchManagedConversationPane({
			sourceAgentId: "agent-source",
			desktopId: "desktop-1",
			conversationId: "threads/2026-08-30:turn_1",
		});

		expect(
			vi.mocked(mocks.runCanonicalAddAgent).mock.calls[0]?.[0].existingWorkspace
				?.providerConversationRef,
		).toBe("threads/2026-08-30:turn_1");
	});

	it("accepts cloned source records and display-only renames during ownership", async () => {
		mocks.resolveOwnership.mockImplementationOnce(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					displayName: "Renamed while resolving",
				})),
			}));
			return {
				state: "vacant",
				permit: {
					schemaVersion: 1,
					providerId: "codex",
					conversationId: "conversation-history",
					candidateFingerprints: [],
				},
			};
		});

		await expect(
			launchManagedConversationPane({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				conversationId: "conversation-history",
			}),
		).resolves.toMatchObject({ conversationId: "conversation-history" });
		expect(mocks.runCanonicalAddAgent).toHaveBeenCalledOnce();
	});

	it.each([
		[
			"workspace",
			(agent: Agent) => ({ ...agent, worktreePath: "/repo/other" }),
		],
		["provider", (agent: Agent) => ({ ...agent, provider: "claude" as const })],
		[
			"backend profile",
			(agent: Agent) => ({
				...agent,
				interactionProfile: {
					schemaVersion: 1 as const,
					kind: "structured_protocol" as const,
					backendProfileId: "backend-other",
					interactionSessionId: "interaction-source",
				},
			}),
		],
		[
			"interaction session",
			(agent: Agent) => ({
				...agent,
				interactionProfile: {
					schemaVersion: 1 as const,
					kind: "structured_protocol" as const,
					backendProfileId: "local",
					interactionSessionId: "interaction-other",
				},
			}),
		],
		[
			"credential generation",
			(agent: Agent) => ({
				...agent,
				executionProfile: {
					kind: "credential_reference" as const,
					reference_id: "credential-crispy",
					credential_generation: "credential-generation-5",
				},
			}),
		],
	] as const)(
		"rejects a semantic %s change before canonical apply",
		async (_label, change) => {
			mocks.resolveOwnership.mockImplementationOnce(async () => {
				useStore.setState((state) => ({
					agents: state.agents.map((agent) => change(agent)),
				}));
				return {
					state: "vacant",
					permit: {
						schemaVersion: 1,
						providerId: "codex",
						conversationId: "conversation-history",
						candidateFingerprints: [],
					},
				};
			});

			await expect(
				launchManagedConversationPane({
					sourceAgentId: "agent-source",
					desktopId: "desktop-1",
					conversationId: "conversation-history",
				}),
			).rejects.toThrow("source changed");
			expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
		},
	);

	it("refuses SSH before ownership, inspection, or canonical action", async () => {
		useStore.setState((state) => ({
			projects: state.projects.map((project) => ({
				...project,
				kind: "ssh" as const,
				sshHostId: "remote-1",
			})),
		}));

		await expect(
			launchManagedConversationPane({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				conversationId: "conversation-history",
			}),
		).rejects.toThrow("not a local project agent");
		expect(mocks.resolveOwnership).not.toHaveBeenCalled();
		expect(mocks.inspectStructuredProjectionContext).not.toHaveBeenCalled();
		expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
	});

	it("refuses duplicate live ownership and can return the verified owner", async () => {
		const owner = structuredSource({ id: "agent-owner" });
		mocks.resolveOwnership.mockResolvedValue({ state: "active", agent: owner });
		await expect(
			launchManagedConversationPane({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				conversationId: "conversation-history",
			}),
		).rejects.toBeInstanceOf(ManagedConversationAlreadyActiveError);
		await expect(
			launchManagedConversationPane({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				conversationId: "conversation-history",
				existingOwner: "return",
			}),
		).resolves.toBe(owner);
		expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
	});

	it("rejects unsafe and implicit-latest conversation identities before spawning", async () => {
		await expect(
			launchManagedConversationPane({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				conversationId: "conversation; reboot",
			}),
		).rejects.toThrow("invalid_conversation_identity");
		await expect(
			launchManagedConversationTargetInSibling({
				sourceAgentId: "agent-source",
				desktopId: "desktop-1",
				target: { kind: "continue" },
			}),
		).rejects.toThrow("managed_exact_or_fresh_conversation_required");
		expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
	});

	it("keeps pane-scoped exited recovery on its exact replacement path", async () => {
		mocks.resumeExactManagedAgentPane.mockResolvedValue({
			panelId: "agent:agent-source",
			payload: { conversationId: "conversation-live" },
		});
		await expect(
			recoverExitedManagedConversationPane({
				agentId: "agent-source",
				panelId: "agent:agent-source",
				target: { kind: "id", id: "conversation-live" },
			}),
		).resolves.toBe("conversation-live");
		expect(mocks.resumeExactManagedAgentPane).toHaveBeenCalledOnce();
		expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
	});

	it("does not let an exited-runtime lease preflight reject exact Resume", async () => {
		const checkpoint = vi.fn(() => {
			throw new Error("client_agent_runtime_transition_conflict");
		});
		mocks.resumeExactManagedAgentPane.mockResolvedValue({
			panelId: "agent:agent-source",
			payload: { conversationId: "conversation-live" },
		});

		await expect(
			recoverExitedManagedConversationPane(
				{
					agentId: "agent-source",
					panelId: "agent:agent-source",
					target: { kind: "id", id: "conversation-live" },
				},
				{ checkpoint },
			),
		).resolves.toBe("conversation-live");
		expect(checkpoint).not.toHaveBeenCalled();
		expect(mocks.resumeExactManagedAgentPane).toHaveBeenCalledOnce();
	});

	it("continues a never-created remote Agent after login using its original create key", async () => {
		const agent = sourceAgent({
			sessionId: "remote-pending",
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1, runtime: "hmux_managed_v1", source: "ssh",
				hostId: "host-remote", sessionId: "remote-pending", workspaceId: "workspace-remote",
				createIdempotencyKey: "original-create", commandBridgeNonce: "original-bridge",
				credentialId: "credential-crispy",
			},
		});
		useStore.setState({ agents: [agent] });
		const required = new Error("remote_credential_unavailable: remote profile has no credential");
		mocks.ensureRemoteManagedAgentRuntime.mockRejectedValueOnce(required).mockResolvedValueOnce({ agent });
		const request = { agentId: agent.id, panelId: `agent:${agent.id}`, target: { kind: "fresh" as const } };
		await expect(recoverExitedManagedConversationPane(request)).rejects.toBe(required);
		await expect(recoverExitedManagedConversationPane(request)).resolves.toBeNull();
		expect(mocks.ensureRemoteManagedAgentRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.ensureRemoteManagedAgentRuntime).toHaveBeenNthCalledWith(2, agent, { columns: 120, rows: 30 });
		expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
		expect(mocks.runCanonicalAddAgent).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("rechecks the exited-runtime lease after loading fresh-start code", async () => {
		const checkpoint = vi.fn(() => {
			throw new Error("client_agent_runtime_transition_conflict");
		});
		await expect(
			recoverExitedManagedConversationPane(
				{
					agentId: "agent-source",
					panelId: "agent:agent-source",
					target: { kind: "fresh" },
				},
				{ checkpoint },
			),
		).rejects.toThrow("client_agent_runtime_transition_conflict");
		expect(checkpoint).toHaveBeenCalledOnce();
		expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
	});

	it("explains an inconclusive ownership refusal without suggesting mutation", () => {
		const message = managedConversationLaunchFailureMessage(
			new ManagedConversationOwnershipUnavailableError(
				"exact discovery was unprobed",
			),
		);
		expect(message).toContain("exact discovery was unprobed");
		expect(message).toMatch(/그대로|unchanged/);
	});

	it("explains where a background-presented conversation remains recoverable", () => {
		const error = new ManagedConversationPresentedInBackgroundError(
			"agent-history-1",
		);
		expect(managedConversationLaunchFailureMessage(error)).toBe(error.message);
		expect(error.message).toMatch(/Unopened agents|열리지 않은 에이전트/);
	});
});
