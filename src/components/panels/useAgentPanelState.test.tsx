// @vitest-environment jsdom

import {
	act,
	cleanup,
	render,
	renderHook,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentPanelState } from "@/components/panels/useAgentPanelState";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	inspectExact: vi.fn(),
	inspectSelectedProjection: vi.fn(),
	inspectStructuredProjection: vi.fn(),
	inspectTransitionIntent: vi.fn(),
	assertRouteAuthority: vi.fn(),
	resolveSelectedRoute: vi.fn(),
	transition: vi.fn(),
	repair: vi.fn(),
	adoptCheckpoint: vi.fn(),
	registerCredential: vi.fn(),
	preflightRemote: vi.fn(),
	convergeManagedRehost: vi.fn(),
}));

vi.mock("@/lib/ipc/dureBackend", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureBackend")>()),
	assertDureBackendRouteAuthority: mocks.assertRouteAuthority,
	resolveSelectedDureBackendRouteAuthority: mocks.resolveSelectedRoute,
}));

vi.mock(
	"@/lib/agents/agentRuntimeProjectionRecovery",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/agents/agentRuntimeProjectionRecovery")
		>()),
		inspectSelectedAgentRuntimeProjection: mocks.inspectSelectedProjection,
		inspectStructuredAgentRuntimeProjection: mocks.inspectStructuredProjection,
	}),
);

vi.mock("@/lib/ipc/dureAgentRuntime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureAgentRuntime")>()),
	createDureAgentRuntimeClient: () => ({
		inspect: mocks.inspect,
		inspectExact: mocks.inspectExact,
		inspectTransitionIntent: mocks.inspectTransitionIntent,
		transition: mocks.transition,
		repair: mocks.repair,
	}),
}));

vi.mock("@/lib/sessions/managed/managedAgentCheckpointBinding", () => ({
	adoptCurrentManagedAgentCheckpoint: mocks.adoptCheckpoint,
}));

vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.registerCredential,
}));

vi.mock("@/lib/agents/remoteAccountOverlay", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/agents/remoteAccountOverlay")
	>()),
	preflightRemoteAccountLaunch: mocks.preflightRemote,
}));

vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: mocks.convergeManagedRehost,
}));

const project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local" as const,
	isRepo: true,
};

function nativeAgent(id: string, sessionId = `session-${id}`) {
	return agentFixture({
		id,
		projectId: project.id,
		worktreePath: `/repo/.worktrees/${id}`,
		sessionId,
		runtimeBinding: managedBindingFixture({
			sessionId,
			workspaceId: `workspace-${id}`,
			backendProfileId: "local",
		}),
		executionProfile: { kind: "provider_default" },
		conversationId: `conversation-${id}`,
	});
}

function nativeObservation(id: string, sessionId = `session-${id}`) {
	return {
		state: "stable" as const,
		backend: { id: "dure-local", generation: "generation-1" },
		backendProfileId: "local",
		routeAuthority: testDureBackendRouteAuthority("dure-local", "generation-1"),
		agentId: id,
		selectionRevision: 2,
		providerId: "codex" as const,
		executionProfile: { kind: "provider_default" as const },
		providerConversationRef: `conversation-${id}`,
		interactionProfile: "native_cli" as const,
		sessionId,
		workspaceId: `workspace-${id}`,
		launchIdempotencyKey: `launch-${id}`,
		stopFence: stopFenceFixture(),
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default" as const,
		},
	};
}

function transitioningObservation(id: string) {
	const source = nativeObservation(id);
	return {
		state: "transitioning" as const,
		agentId: id,
		operationId: `transition-${id}`,
		stage: "source_stopped" as const,
		journalRevision: 2,
		targetInteractionProfile: "native_cli" as const,
		targetExecutionProfile: { kind: "provider_default" as const },
		backend: source.backend,
		backendProfileId: source.backendProfileId,
		routeAuthority: source.routeAuthority,
	};
}

function admittedObservation(id: string) {
	return {
		...transitioningObservation(id),
		stage: "admitted" as const,
		journalRevision: 1,
	};
}

function structuredReceipt(id: string) {
	const interactionSessionId = `interaction-${id}`;
	const runtimeGeneration = `runtime-${id}`;
	const providerEpoch = `provider-${id}`;
	return {
		...nativeObservation(id),
		interactionProfile: "structured_protocol" as const,
		interactionSessionId,
		binding: {
			schemaVersion: 1 as const,
			interactionSessionId,
			agentId: id,
			providerId: "codex" as const,
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: `conversation-${id}`,
			runtime: { runtimeGeneration, providerEpoch },
			timelineEpoch: `timeline-${id}`,
			bindingRevision: 2,
			historyComplete: true,
			createdAtMs: 1,
			updatedAtMs: 1,
		},
	};
}

function structuredGeneration(id: string) {
	return {
		routeAuthority: nativeObservation(id).routeAuthority,
		bindingRevision: 2,
		runtimeGeneration: `runtime-${id}`,
		providerEpoch: `provider-${id}`,
	};
}

function structuredAgent(id: string) {
	const native = nativeAgent(id);
	return {
		...native,
		runtimeBinding: undefined,
		interactionProfile: {
			schemaVersion: 1 as const,
			kind: "structured_protocol" as const,
			backendProfileId: "local",
			interactionSessionId: `interaction-${id}`,
		},
	};
}

function managedCreateRepairIntent(
	id: string,
	targetInteractionProfile: "native_cli" | "structured_protocol",
	sourceInteractionProfile:
		| "native_cli"
		| "structured_protocol" = targetInteractionProfile === "native_cli"
		? "structured_protocol"
		: "native_cli",
) {
	const source = nativeObservation(id);
	const launchSelection = {
		model: null,
		effort: null,
		permissionMode: "default" as const,
	};
	return {
		state: "repair_required" as const,
		backend: source.backend,
		backendProfileId: source.backendProfileId,
		routeAuthority: source.routeAuthority,
		agentId: id,
		operationId: `operation-${id}`,
		journalRevision: 3,
		sourceSelectionRevision: source.selectionRevision,
		sourceInteractionProfile,
		sourceExecutionProfile: source.executionProfile,
		sourceLaunchSelection: launchSelection,
		targetInteractionProfile,
		targetExecutionProfile: source.executionProfile,
		targetLaunchSelection: launchSelection,
		failureKind: "launch_failed" as const,
		providerCode: "workflow_managed_create_requires_repair",
	};
}

function registeredProjectionContext(id: string) {
	return {
		schemaVersion: 1 as const,
		identity: { kind: "registered" as const },
		agent: {
			agentId: id,
			workspaceId: `workspace-${id}`,
			providerId: "codex" as const,
		},
		workspace: {
			workspaceId: `workspace-${id}`,
			projectId: project.id,
			rootPath: `/repo/.worktrees/${id}`,
		},
		project: {
			projectId: project.id,
			rootPath: project.path,
		},
	};
}

function routeLessRepairFixture(id: string) {
	const agent = {
		...nativeAgent(id),
		projectId: undefined,
		worktreePath: undefined,
		runtimeBinding: undefined,
	} as unknown as Agent;
	const repairIntent = managedCreateRepairIntent(
		id,
		"native_cli",
		"native_cli",
	);
	const projectionContext = registeredProjectionContext(id);
	return {
		agent,
		repairIntent,
		repairProjection: { ...repairIntent, projectionContext },
		projectionContext,
		committed: {
			...nativeObservation(id, `session-${id}-repaired`),
			selectionRevision: 3,
		},
	};
}

function PanelStateProbe({ agentId }: { agentId: string }) {
	useAgentPanelState(agentId, `agent:${agentId}`);
	return null;
}

describe("useAgentPanelState", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.convergeManagedRehost.mockResolvedValue(null);
		mocks.resolveSelectedRoute.mockResolvedValue(
			testDureBackendRouteAuthority("dure-local", "generation-1"),
		);
		useStore.setState({
			projects: [project],
			agents: [],
			accounts: [],
			sshHosts: [],
		});
	});

	afterEach(cleanup);

	it("mounts 32 Agent panes without issuing a backend runtime inspection", () => {
		const agents = Array.from({ length: 32 }, (_, index) =>
			nativeAgent(`agent-${index}`),
		);
		useStore.setState({ agents });

		render(
			agents.map((agent) => (
				<PanelStateProbe key={agent.id} agentId={agent.id} />
			)),
		);

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
	});

	it("hydrates existing Chat launch controls through one read-only runtime snapshot", async () => {
		const agent = structuredAgent("agent-chat-remount");
		useStore.setState({ agents: [agent] });
		mocks.inspectStructuredProjection.mockResolvedValueOnce({
			...structuredReceipt(agent.id),
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "auto_edit",
			},
		});

		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				loaded: true,
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "auto_edit",
			});
		});
		expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce();
		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.adoptCheckpoint).not.toHaveBeenCalled();
	});

	it("converges a stale Chat mount to the committed native successor without another user action", async () => {
		const credential = {
			kind: "credential_reference" as const,
			reference_id: "account-hebbian98",
			credential_generation: "credential-hebbian98-8",
		};
		const agent = {
			...structuredAgent("agent-chat-background-terminal"),
			executionProfile: credential,
			credentialId: credential.reference_id,
			accountId: credential.reference_id,
		};
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-recovered`),
			executionProfile: credential,
		};
		const cachedChat = {
			ownerKey: agentRuntimePresentationOwnerKey(agent),
			routeAuthority: committed.routeAuthority,
			selectionRevision: 2,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "max",
				permissionMode: "auto_edit" as const,
			},
		};
		useStore.setState({
			agents: [agent],
			agentRuntimeLaunchPresentation: { [agent.id]: cachedChat },
		});
		mocks.inspectStructuredProjection
			.mockResolvedValueOnce({
				...transitioningObservation(agent.id),
				targetExecutionProfile: credential,
			})
			.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		expect(useStore.getState().agentRuntimeLaunchPresentation[agent.id]).toBe(
			cachedChat,
		);
		expect(panel.result.current.launchSelection).toMatchObject({
			loaded: true,
			...cachedChat.launchSelection,
		});
		await waitFor(
			() => {
				expect(useStore.getState().agents[0]).toMatchObject({
					id: agent.id,
					sessionId: committed.sessionId,
					interactionProfile: undefined,
					credentialId: credential.reference_id,
					accountId: credential.reference_id,
					conversationId: committed.providerConversationRef,
					runtimeBinding: {
						runtime: "hmux_managed_v1",
						sessionId: committed.sessionId,
						credentialId: credential.reference_id,
						createIdempotencyKey: committed.launchIdempotencyKey,
					},
				});
			},
			{ timeout: 2_500 },
		);
		expect(mocks.inspectStructuredProjection).toHaveBeenCalledTimes(2);
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("releases a transitioning Chat attach when its pane unmounts", async () => {
		const agent = structuredAgent("agent-chat-unmounted-transition");
		let resolveInspection!: (
			observation: ReturnType<typeof transitioningObservation>,
		) => void;
		useStore.setState({ agents: [agent] });
		mocks.inspectStructuredProjection.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveInspection = resolve;
			}),
		);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);

		panel.unmount();
		await act(async () => {
			resolveInspection(transitioningObservation(agent.id));
			await new Promise((resolve) => globalThis.setTimeout(resolve, 75));
		});

		expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce();
	});

	it("keeps cached Chat controls while exposing a failed attach for retry", async () => {
		const agent = structuredAgent("agent-chat-cached-attach-failure");
		const cachedChat = {
			ownerKey: agentRuntimePresentationOwnerKey(agent),
			routeAuthority: nativeObservation(agent.id).routeAuthority,
			selectionRevision: 2,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "max",
				permissionMode: "auto_edit" as const,
			},
		};
		useStore.setState({
			agents: [agent],
			agentRuntimeLaunchPresentation: { [agent.id]: cachedChat },
		});
		mocks.inspectStructuredProjection.mockRejectedValueOnce(
			new Error("backend temporarily unavailable"),
		);

		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await waitFor(() =>
			expect(panel.result.current.launchSelection.hydrationError).toBe(true),
		);
		expect(panel.result.current.launchSelection).toMatchObject({
			loaded: true,
			...cachedChat.launchSelection,
		});
	});

	it("surfaces a failed launch-selection read and retries exactly once on request", async () => {
		const agent = structuredAgent("agent-chat-hydration-retry");
		const committed = {
			...structuredReceipt(agent.id),
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "auto_edit" as const,
			},
		};
		useStore.setState({ agents: [agent] });
		mocks.inspectStructuredProjection
			.mockRejectedValueOnce(new Error("backend unavailable"))
			.mockResolvedValueOnce(committed);

		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);
		await waitFor(() => {
			expect(panel.result.current.launchSelection.hydrationError).toBe(true);
		});

		act(() => {
			panel.result.current.launchSelection.retryHydration();
		});

		await waitFor(() => {
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledTimes(2);
			expect(panel.result.current.launchSelection).toMatchObject({
				loaded: true,
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "auto_edit",
			});
		});
	});

	it("keeps an unresolved launch-selection read replaceable until runtime invalidation commits it", async () => {
		const agent = structuredAgent("agent-chat-hydration-transitioning");
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "max",
				permissionMode: "auto_edit" as const,
			},
		};
		useStore.setState({ agents: [agent] });
		mocks.inspectStructuredProjection
			.mockResolvedValueOnce({
				state: "unmanaged",
				agentId: agent.id,
				backend: committed.backend,
				backendProfileId: committed.backendProfileId,
				routeAuthority: committed.routeAuthority,
			})
			.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);
		expect(panel.result.current.launchSelection).toMatchObject({
			loaded: false,
			hydrationError: false,
		});

		await act(async () => {
			await panel.result.current.onStructuredRuntimeInvalidated(
				structuredGeneration(agent.id),
			);
		});

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				loaded: true,
				hydrationError: false,
				...committed.launchSelection,
			});
		});
	});

	it("clears a stale Chat hydration failure after an external Terminal projection", async () => {
		const agent = structuredAgent("agent-chat-hydration-external-terminal");
		useStore.setState({ agents: [agent] });
		mocks.inspectStructuredProjection.mockRejectedValueOnce(
			new Error("backend unavailable"),
		);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await waitFor(() => {
			expect(panel.result.current.launchSelection.hydrationError).toBe(true);
		});

		act(() => {
			useStore.setState({ agents: [nativeAgent(agent.id)] });
		});

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				loaded: false,
				hydrationError: false,
				model: null,
				effort: null,
				permissionMode: "default",
				error: null,
			});
		});
		expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce();
	});

	it("drops a late native launch failure after an external runtime replacement", async () => {
		const agent = nativeAgent("agent-native-stale-launch-failure");
		let rejectTransition!: (error: Error) => void;
		mocks.inspect.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.transition.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectTransition = reject;
			}),
		);
		mocks.inspectExact.mockRejectedValue(new Error("backend unavailable"));
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: "gpt-5.6-terra",
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		act(() => {
			useStore.setState({
				agents: [nativeAgent(agent.id, `session-${agent.id}-replacement`)],
			});
		});
		await act(async () => {
			rejectTransition(
				new Error("agent_runtime_structured_profile_unavailable"),
			);
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				loaded: false,
				switching: false,
				error: null,
			});
		});
	});

	it("rejects a stale source observation before it can roll back the pane", async () => {
		const agent = structuredAgent("agent-stale-source-observation");
		const stale = nativeObservation(agent.id);
		const current = {
			ownerKey: agentRuntimePresentationOwnerKey(agent),
			routeAuthority: stale.routeAuthority,
			selectionRevision: stale.selectionRevision + 1,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "max",
				permissionMode: "auto_edit" as const,
			},
		};
		mocks.inspect.mockResolvedValueOnce(stale);
		useStore.setState({
			agents: [agent],
			agentRuntimeLaunchPresentation: { [agent.id]: current },
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				model: "gpt-5.6-terra",
			}));
		});

		await waitFor(() =>
			expect(panel.result.current.launchSelection.error).toBe(
				"client_agent_runtime_transition_conflict",
			),
		);
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toBe(agent);
		expect(useStore.getState().agentRuntimeLaunchPresentation[agent.id]).toBe(
			current,
		);
	});

	it("drops a late failure after the backend route is replaced in place", async () => {
		const agent = nativeAgent("agent-route-replaced-launch");
		const source = nativeObservation(agent.id);
		let rejectTransition!: (error: Error) => void;
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.inspectExact.mockRejectedValue(new Error("retired route"));
		mocks.transition.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectTransition = reject;
			}),
		);
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				model: "gpt-5.6-terra",
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
		const boundary =
			useStore.getState().agentRuntimeLaunchPresentation[agent.id];
		if (!boundary) throw new Error("source launch boundary missing");

		act(() => {
			useStore.setState((state) => ({
				agentRuntimeLaunchPresentation: {
					...state.agentRuntimeLaunchPresentation,
					[agent.id]: {
						...boundary,
						routeAuthority: testDureBackendRouteAuthority(
							"dure-local",
							"generation-2",
						),
						launchSelection: {
							model: "gpt-5.6-luna",
							effort: "medium",
							permissionMode: "default",
						},
					},
				},
			}));
		});
		await waitFor(() =>
			expect(panel.result.current.launchSelection.switching).toBe(false),
		);

		await act(async () => {
			rejectTransition(new Error("retired route rejected"));
			await Promise.resolve();
		});
		expect(panel.result.current.launchSelection.error).toBeNull();
	});

	it("lets the newer of two launch actions own settlement", async () => {
		const agent = nativeAgent("agent-concurrent-launch-actions");
		const source = nativeObservation(agent.id);
		let rejectFirst!: (error: Error) => void;
		let resolveSecond!: (result: DureAgentRuntimeTransitionResultV1) => void;
		mocks.inspect.mockResolvedValue(source);
		mocks.inspectExact.mockRejectedValue(new Error("no convergence"));
		mocks.transition
			.mockReturnValueOnce(
				new Promise((_, reject) => {
					rejectFirst = reject;
				}),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveSecond = resolve;
				}),
			);
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				model: "gpt-5.6-terra",
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(1));
		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				model: "gpt-5.6-luna",
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledTimes(2));

		await act(async () => {
			resolveSecond({
				...source,
				selectionRevision: source.selectionRevision + 1,
				launchSelection: {
					...source.launchSelection,
					model: "gpt-5.6-luna",
				},
			});
		});
		await waitFor(() =>
			expect(panel.result.current.launchSelection).toMatchObject({
				model: "gpt-5.6-luna",
				switching: false,
				error: null,
			}),
		);

		await act(async () => {
			rejectFirst(new Error("older launch rejected"));
			await Promise.resolve();
		});
		expect(panel.result.current.launchSelection).toMatchObject({
			model: "gpt-5.6-luna",
			switching: false,
			error: null,
		});
	});

	it("reports a launch failure against the source snapshot projected by its own inspection", async () => {
		const agent = nativeAgent("agent-native-own-source-failure");
		const source = nativeObservation(agent.id);
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(new Error("launch rejected"));
		mocks.inspectExact.mockRejectedValueOnce(new Error("backend unavailable"));
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				model: "gpt-5.6-terra",
			}));
		});

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				switching: false,
				error: "launch rejected",
			});
		});
		expect(
			useStore.getState().agentRuntimeLaunchPresentation[agent.id],
		).toMatchObject({ selectionRevision: source.selectionRevision });
	});

	it("hands a launch failure lease to the backend-projected interaction owner", async () => {
		const agent = nativeAgent("agent-stale-native-own-source-failure");
		const source = structuredReceipt(agent.id);
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(
			new Error("structured launch rejected"),
		);
		mocks.inspectExact.mockRejectedValueOnce(new Error("backend unavailable"));
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((selection) => ({
				...selection,
				effort: "max",
			}));
		});

		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				switching: false,
				error: "structured launch rejected",
			});
		});
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
			interactionSessionId: source.interactionSessionId,
		});
	});

	it("lets a newer same-runtime launch snapshot clear busy state and fence a late failure", async () => {
		const agent = nativeAgent("agent-native-external-launch");
		let rejectTransition!: (error: Error) => void;
		mocks.inspect.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.transition.mockReturnValueOnce(
			new Promise((_, reject) => {
				rejectTransition = reject;
			}),
		);
		mocks.inspectExact.mockRejectedValue(new Error("backend unavailable"));
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: "gpt-5.6-sol",
			}));
		});
		await waitFor(() =>
			expect(panel.result.current.launchSelection.switching).toBe(true),
		);
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
		const projected = useStore
			.getState()
			.agents.find((candidate) => candidate.id === agent.id);
		if (!projected) throw new Error("source projection missing");

		act(() => {
			useStore.setState((state) => ({
				agentRuntimeLaunchPresentation: {
					...state.agentRuntimeLaunchPresentation,
					[agent.id]: {
						ownerKey: agentRuntimePresentationOwnerKey(projected),
						routeAuthority: nativeObservation(agent.id).routeAuthority,
						selectionRevision: 3,
						launchSelection: {
							model: "gpt-5.6-terra",
							effort: "high",
							permissionMode: "default",
						},
					},
				},
			}));
		});
		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				model: "gpt-5.6-terra",
				effort: "high",
				switching: false,
				error: null,
			});
		});

		await act(async () => {
			rejectTransition(new Error("stale launch failure"));
			await Promise.resolve();
		});
		expect(panel.result.current.launchSelection.error).toBeNull();
	});

	it("changes a native launch field through the exact same-profile action", async () => {
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const base = nativeAgent("agent-native-launch-selection");
		const agent = {
			...base,
			executionProfile,
			accountId: "account-a",
			credentialId: "account-a",
			runtimeBinding: {
				...base.runtimeBinding!,
				credentialId: "account-a",
			},
		};
		const source = {
			...nativeObservation(agent.id),
			executionProfile,
			launchSelection: {
				model: "gpt-5.6-sol",
				effort: "high",
				permissionMode: "skip_permissions" as const,
			},
		};
		const targetLaunchSelection = {
			...source.launchSelection,
			effort: "max",
		};
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce({
			...source,
			selectionRevision: source.selectionRevision + 1,
			launchSelection: targetLaunchSelection,
		});
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((current) => ({
				...current,
				effort: "max",
			}));
		});

		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: agent.id,
			expectedSourceRevision: source.selectionRevision,
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: undefined,
			targetLaunchSelection,
			sourceStopPolicy: "preserve",
			routeAuthority: source.routeAuthority,
		});
		expect(mocks.inspectStructuredProjection).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			executionProfile,
			credentialId: "account-a",
			conversationId: source.providerConversationRef,
		});
	});

	it("preserves the backend interaction when the local launch projection is stale", async () => {
		const agent = nativeAgent("agent-stale-launch-surface");
		const source = structuredReceipt(agent.id);
		const targetLaunchSelection = {
			...source.launchSelection,
			model: "gpt-5.6-sol",
		};
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce({
			...source,
			selectionRevision: source.selectionRevision + 1,
			launchSelection: targetLaunchSelection,
		});
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((current) => ({
				...current,
				model: "gpt-5.6-sol",
			}));
		});

		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: agent.id,
				targetInteractionProfile: "structured_protocol",
				targetLaunchSelection,
			}),
		);
	});

	it("keeps an explicit launch action busy when hydration resolves first", async () => {
		const agent = structuredAgent("agent-launch-hydration-race");
		const source = structuredReceipt(agent.id);
		const targetLaunchSelection = {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default" as const,
		};
		let resolveHydration!: (observation: typeof source) => void;
		let resolveTransition!: (
			receipt: DureAgentRuntimeTransitionResultV1,
		) => void;
		mocks.inspectStructuredProjection.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveHydration = resolve;
			}),
		);
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveTransition = resolve;
			}),
		);
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection(
				() => targetLaunchSelection,
			);
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		await act(async () => resolveHydration(source));
		expect(panel.result.current.launchSelection).toMatchObject({
			loaded: true,
			switching: true,
		});

		await act(async () =>
			resolveTransition({
				...source,
				selectionRevision: source.selectionRevision + 1,
				launchSelection: targetLaunchSelection,
			}),
		);
		await waitFor(() => {
			expect(panel.result.current.launchSelection).toMatchObject({
				...targetLaunchSelection,
				switching: false,
			});
		});
	});

	it("ignores a stale Chat hydration response after Terminal commits", async () => {
		const agent = structuredAgent("agent-stale-chat-hydration");
		const source = structuredReceipt(agent.id);
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-native`),
			selectionRevision: source.selectionRevision + 1,
			launchSelection: {
				model: "gpt-5.6-luna",
				effort: "medium",
				permissionMode: "auto_edit" as const,
			},
		};
		let resolveHydration!: (observation: typeof source) => void;
		mocks.inspectStructuredProjection.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveHydration = resolve;
			}),
		);
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce(committed);
		useStore.setState({ agents: [agent] });
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
			resolveHydration(source);
			await Promise.resolve();
		});

		expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
		expect(panel.result.current.launchSelection).toMatchObject({
			...committed.launchSelection,
			loaded: true,
			hydrationError: false,
		});
	});

	it("treats a missing local Agent projection as unavailable without fetching per pane", () => {
		const panel = renderHook(() =>
			useAgentPanelState("agent-missing", "agent:agent-missing"),
		);

		expect(panel.result.current.agent).toBeUndefined();
		expect(mocks.inspect).not.toHaveBeenCalled();
	});

	it("resolves exact runtime authority only after an explicit profile switch", async () => {
		const agent = nativeAgent("agent-1");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.transition.mockResolvedValueOnce(structuredReceipt(agent.id));
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		expect(mocks.inspect).not.toHaveBeenCalled();
		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(agent.id, null);
		});

		expect(mocks.inspect).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: agent.id,
				expectedSourceRevision: 2,
				targetInteractionProfile: "structured_protocol",
			}),
		);
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(mocks.resolveSelectedRoute).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
			interactionSessionId: `interaction-${agent.id}`,
		});
	});

	it("converges a durable native successor before Chat transition admission", async () => {
		const agent = nativeAgent("agent-durable-successor");
		const panelId = `agent:${agent.id}`;
		const successor = nativeObservation(
			agent.id,
			`session-${agent.id}-successor`,
		);
		useStore.setState({ agents: [agent] });
		mocks.convergeManagedRehost.mockResolvedValueOnce({
			reconciliation: { conversationId: agent.conversationId },
			committed: {},
		});
		mocks.inspect.mockResolvedValueOnce(successor);
		mocks.transition.mockResolvedValueOnce({
			...structuredReceipt(agent.id),
			selectionRevision: successor.selectionRevision + 1,
		});
		const panel = renderHook(() => useAgentPanelState(agent.id, panelId));

		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(agent.id, null);
		});

		expect(mocks.convergeManagedRehost).toHaveBeenCalledWith(agent.id, panelId);
		expect(
			mocks.convergeManagedRehost.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.inspect.mock.invocationCallOrder[0]!);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: agent.id,
				expectedSourceRevision: successor.selectionRevision,
				targetInteractionProfile: "structured_protocol",
			}),
		);
	});

	it("uses the observed route without a caller-supplied backend profile", async () => {
		const agent = nativeAgent("agent-observed-route");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.transition.mockResolvedValueOnce(structuredReceipt(agent.id));
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(agent.id, null);
		});

		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: agent.id,
				routeAuthority: nativeObservation(agent.id).routeAuthority,
				targetInteractionProfile: "structured_protocol",
			}),
		);
	});

	it("rejects unsupported adoption when new input invalidates a waiting snapshot", async () => {
		const agent = nativeAgent("agent-unmanaged-input-race");
		useStore.setState({
			agents: [agent],
			agentActivity: { [agent.id]: "waiting" },
			sessionAgentRuntimeState: {
				[agent.sessionId]: {
					terminalEpoch: "terminal-1",
					revision: "1",
					observedThroughOutputSeq: "1",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "provider_event",
				},
			},
		});
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-1",
		);
		mocks.inspect
			.mockResolvedValueOnce({
				state: "unmanaged",
				agentId: agent.id,
				backend: {
					id: "dure-local",
					generation: "generation-1",
				},
				backendProfileId: "local",
				routeAuthority,
			})
			.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.adoptCheckpoint.mockImplementationOnce(async () => {
			useStore.setState({
				agentActivity: { [agent.id]: "working" },
				sessionAgentRuntimeState: {
					[agent.sessionId]: {
						terminalEpoch: "terminal-1",
						revision: "2",
						observedThroughOutputSeq: "2",
						lifecycle: "running",
						activity: "working",
						attention: "none",
						source: "controller_input",
					},
				},
			});
			throw new DureBackendRequestError(
				"agent_runtime_checkpoint_adoption_unsupported",
				"agent_runtime_checkpoint_adoption_unsupported",
				{ kind: "operation", disposition: "terminal" },
			);
		});
		mocks.transition.mockResolvedValueOnce(structuredReceipt(agent.id));
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentToStructuredChat(agent.id, null);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBeInstanceOf(DureBackendRequestError);
		expect(caught).toMatchObject({
			code: "agent_runtime_checkpoint_adoption_unsupported",
			failure: { kind: "operation", disposition: "terminal" },
		});
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.sessionId).toBe(agent.sessionId);
		expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
	});

	it("bootstraps an unmanaged pane when exact checkpoint adoption succeeds", async () => {
		const agent = nativeAgent("agent-unmanaged-bootstrap");
		const account = {
			id: "account-exact",
			provider: "codex" as const,
			name: "Exact",
			dir: "/profiles/codex-exact",
		};
		useStore.setState({ agents: [agent], accounts: [account] });
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-1",
		);
		mocks.inspect
			.mockResolvedValueOnce({
				state: "unmanaged",
				agentId: agent.id,
				backend: {
					id: "dure-local",
					generation: "generation-1",
				},
				backendProfileId: "local",
				routeAuthority,
			})
			.mockResolvedValueOnce(nativeObservation(agent.id));
		mocks.adoptCheckpoint.mockResolvedValueOnce(undefined);
		mocks.registerCredential.mockResolvedValueOnce({
			kind: "credential_reference",
			reference_id: account.id,
			credential_generation: "credential-generation-1",
		});
		mocks.transition.mockResolvedValueOnce(structuredReceipt(agent.id));
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(
				agent.id,
				account.id,
			);
		});

		expect(mocks.adoptCheckpoint).toHaveBeenCalledWith(
			agent.id,
			routeAuthority,
		);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetExecutionProfile: {
					kind: "credential_reference",
					reference_id: account.id,
					credential_generation: "credential-generation-1",
				},
			}),
		);
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
			interactionSessionId: `interaction-${agent.id}`,
		});
	});

	it("projects a committed transition after its response is lost", async () => {
		const agent = nativeAgent("agent-lost-response");
		useStore.setState({ agents: [agent] });
		const source = nativeObservation(agent.id);
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: source.selectionRevision + 1,
		};
		const lostResponse = new Error("transport response lost");
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(lostResponse);
		mocks.inspectExact.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(agent.id, null);
		});

		expect(mocks.inspectExact).toHaveBeenCalledWith(
			agent.id,
			source.routeAuthority,
		);
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
			interactionSessionId: `interaction-${agent.id}`,
		});
		expect(panel.result.current.launchSelection.loaded).toBe(true);
	});

	it("coalesces one response-lost Chat recovery across two mounted views", async () => {
		const agent = structuredAgent("agent-two-view-response-loss");
		const source = structuredReceipt(agent.id);
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-native`),
			selectionRevision: source.selectionRevision + 1,
			launchSelection: {
				model: "gpt-5.6-terra",
				effort: "high",
				permissionMode: "default" as const,
			},
		};
		const lostResponse = new Error("transport response lost");
		let resolveRecovery!: (value: typeof committed) => void;
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(lostResponse);
		mocks.inspectExact.mockResolvedValueOnce(source);
		mocks.inspectStructuredProjection.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveRecovery = resolve;
			}),
		);
		const panels = renderHook(
			() =>
				[
					useAgentPanelState(agent.id, `agent:${agent.id}`),
					useAgentPanelState(agent.id, `agent:${agent.id}`),
				] as const,
		);
		await waitFor(() =>
			expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce(),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panels.result.current[0].switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});
		expect(caught).toBe(lostResponse);
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
		});

		expect(mocks.inspectStructuredProjection).toHaveBeenCalledOnce();

		await act(async () => {
			resolveRecovery(committed);
			await Promise.resolve();
		});
		await waitFor(() => {
			expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
			expect(panels.result.current[0].launchSelection).toMatchObject({
				loaded: true,
				...committed.launchSelection,
			});
			expect(panels.result.current[1].launchSelection).toMatchObject({
				loaded: true,
				...committed.launchSelection,
			});
		});
	});

	it("sends the same transition intent when the user selects a parked Terminal target", async () => {
		const agent = structuredAgent("agent-parked-terminal");
		const repairRequired = managedCreateRepairIntent(agent.id, "native_cli");
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.repair.mockResolvedValueOnce(committed);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({
			agentId: agent.id,
			targetInteractionProfile: "native_cli",
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
		}));
		expect(mocks.inspectTransitionIntent).toHaveBeenCalledOnce();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			`session-${agent.id}-repaired`,
		);
	});

	it("submits a transition intent when the user retries an admitted Terminal switch", async () => {
		const agent = structuredAgent("agent-admitted-terminal");
		const admitted = admittedObservation(agent.id);
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValue(admitted);
		mocks.inspectTransitionIntent.mockResolvedValueOnce({
			...managedCreateRepairIntent(agent.id, "native_cli"),
			...admitted,
		});
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.inspect).toHaveBeenCalledTimes(4);
		expect(mocks.inspectTransitionIntent).toHaveBeenCalledWith(admitted);
		expect(mocks.transition).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent.id, targetInteractionProfile: "native_cli" }));
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			`session-${agent.id}-repaired`,
		);
	});

	it("converges a lost admitted-retry response without a second mutation", async () => {
		const agent = structuredAgent("agent-admitted-response-lost");
		const admitted = admittedObservation(agent.id);
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		};
		const lostResponse = new Error("transport response lost");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValue(admitted);
		mocks.inspectTransitionIntent.mockResolvedValueOnce({
			...managedCreateRepairIntent(agent.id, "native_cli"),
			...admitted,
		});
		mocks.transition.mockRejectedValueOnce(lostResponse);
		mocks.inspectExact.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.inspectExact).toHaveBeenCalledWith(
			agent.id,
			admitted.routeAuthority,
		);
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			`session-${agent.id}-repaired`,
		);
	});

	it("lets the backend refuse a different surface for an admitted operation", async () => {
		const agent = structuredAgent("agent-admitted-chat-target");
		const admitted = {
			...admittedObservation(agent.id),
			targetInteractionProfile: "structured_protocol" as const,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValue(admitted);
		mocks.inspectTransitionIntent.mockResolvedValueOnce({
			...managedCreateRepairIntent(agent.id, "structured_protocol"),
			...admitted,
		});
		const conflict = new Error("agent_runtime_transition_conflict");
		mocks.transition.mockRejectedValueOnce(conflict);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBe(conflict);
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledOnce();
	});

	it("converges a lost repair response through exact inspection without a second mutation", async () => {
		const agent = structuredAgent("agent-repair-response-lost");
		const repairRequired = managedCreateRepairIntent(agent.id, "native_cli");
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockRejectedValueOnce(new Error("repair response lost"));
		mocks.inspectExact.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.inspectExact).toHaveBeenCalledWith(
			agent.id,
			repairRequired.routeAuthority,
		);
		expect(useStore.getState().agents[0]?.sessionId).toBe(
			`session-${agent.id}-repaired`,
		);
	});

	it("rejects a mismatched repair result without issuing a second repair", async () => {
		const agent = structuredAgent("agent-invalid-repair-result");
		const repairRequired = managedCreateRepairIntent(agent.id, "native_cli");
		const mismatched = {
			...nativeObservation(agent.id),
			selectionRevision: 3,
			launchSelection: {
				model: null,
				effort: "high",
				permissionMode: "default" as const,
			},
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce(mismatched);
		mocks.inspectExact.mockResolvedValueOnce(repairRequired);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "client_agent_runtime_transition_conflict",
		});
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.inspectExact).toHaveBeenCalledOnce();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
		});
	});

	it("does not authorize repair after a transition response parks the runtime", async () => {
		const agent = nativeAgent("agent-transition-repair");
		const source = nativeObservation(agent.id);
		const repairRequired = managedCreateRepairIntent(
			agent.id,
			"structured_protocol",
		);
		const failure = new Error("repair required");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(failure);
		mocks.inspectExact.mockResolvedValueOnce(repairRequired);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await expect(
				panel.result.current.switchAgentToStructuredChat(agent.id, null),
			).rejects.toBe(failure);
		});

		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.sessionId).toBe(source.sessionId);
	});

	it("does not supersede a concurrent parked target after a transition response is lost", async () => {
		const agent = structuredAgent("agent-transition-concurrent-repair");
		const source = structuredReceipt(agent.id);
		const concurrentRepair = managedCreateRepairIntent(
			agent.id,
			"structured_protocol",
			"structured_protocol",
		);
		const lostResponse = new Error("transition response lost");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(lostResponse);
		mocks.inspectExact.mockResolvedValueOnce(concurrentRepair);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(concurrentRepair);
		mocks.repair.mockResolvedValueOnce({
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBe(lostResponse);
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
		});
	});

	it("does not consume a same-account parked generation after a prepared transition response is lost", async () => {
		const agent = nativeAgent("agent-transition-prepared-generation");
		const account = {
			id: "account-a",
			provider: "codex" as const,
			name: "Codex A",
			dir: "/profiles/codex-account-a",
		};
		const preparedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: account.id,
			credential_generation: "credential-generation-8",
		};
		const unrelatedParkedProfile = {
			...preparedExecutionProfile,
			credential_generation: "credential-generation-9",
		};
		const source = nativeObservation(agent.id);
		const concurrentRepair = {
			...managedCreateRepairIntent(agent.id, "structured_protocol"),
			targetExecutionProfile: unrelatedParkedProfile,
		};
		const lostResponse = new Error("transition response lost");
		useStore.setState({ agents: [agent], accounts: [account] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockRejectedValueOnce(lostResponse);
		mocks.inspectExact.mockResolvedValueOnce(concurrentRepair);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(concurrentRepair);
		mocks.repair.mockResolvedValueOnce({
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			executionProfile: unrelatedParkedProfile,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentToStructuredChat(
					agent.id,
					account.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBe(lostResponse);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				targetExecutionProfile: preparedExecutionProfile,
			}),
		);
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("reuses the parked credential generation before any credential preparation", async () => {
		const agent = structuredAgent("agent-parked-credential");
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-7",
		};
		const repairRequired = {
			...managedCreateRepairIntent(
				agent.id,
				"structured_protocol",
				"structured_protocol",
			),
			targetExecutionProfile: executionProfile,
		};
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			executionProfile,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentCredential(
				agent.id,
				"account-b",
				`agent:${agent.id}`,
			);
		});

		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.inspectTransitionIntent).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0]?.executionProfile).toEqual(
			executionProfile,
		);
	});

	it.each([
		{
			name: "uses the parked credential generation",
			preparedGeneration: "credential-generation-7",
		},
		{
			name: "uses the refreshed credential generation",
			preparedGeneration: "credential-generation-8",
		},
	])("$name for a stale same-reference credential", async (scenario) => {
		const agent = structuredAgent(`agent-stale-${scenario.preparedGeneration}`);
		const parkedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const repairRequired = {
			...managedCreateRepairIntent(
				agent.id,
				"structured_protocol",
				"structured_protocol",
			),
			targetExecutionProfile: parkedExecutionProfile,
			failureKind: "credential_stale" as const,
		};
		const preparedExecutionProfile = {
			...parkedExecutionProfile,
			credential_generation: scenario.preparedGeneration,
		};
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentCredential(
				agent.id,
				"account-a",
				`agent:${agent.id}`,
			);
		});

		expect(mocks.registerCredential).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
			targetExecutionProfile: preparedExecutionProfile,
		});
		expect(useStore.getState().agents[0]?.executionProfile).toEqual(
			preparedExecutionProfile,
		);
	});

	it("prepares and supersedes a parked repair for a different credential", async () => {
		const agent = structuredAgent("agent-parked-other-credential");
		const repairRequired = {
			...managedCreateRepairIntent(
				agent.id,
				"structured_protocol",
				"structured_protocol",
			),
			targetExecutionProfile: {
				kind: "credential_reference" as const,
				reference_id: "account-a",
				credential_generation: "credential-generation-3",
			},
		};
		const preparedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-9",
		};
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentCredential(
				agent.id,
				"account-b",
				`agent:${agent.id}`,
			);
		});

		expect(mocks.registerCredential).toHaveBeenCalledOnce();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: "structured_protocol",
			targetExecutionProfile: preparedExecutionProfile,
			targetLaunchSelection: repairRequired.sourceLaunchSelection,
		});
		expect(useStore.getState().agents[0]?.executionProfile).toEqual(
			preparedExecutionProfile,
		);
	});

	it("resumes the exact parked model and effort selection once", async () => {
		const agent = structuredAgent("agent-parked-launch-selection");
		const launchSelection = {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default" as const,
		};
		const repairRequired = {
			...managedCreateRepairIntent(
				agent.id,
				"structured_protocol",
				"structured_protocol",
			),
			targetLaunchSelection: launchSelection,
		};
		const committed = {
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			launchSelection,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: launchSelection.model,
				effort: launchSelection.effort,
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.inspectTransitionIntent).toHaveBeenCalledOnce();
		expect(panel.result.current.launchSelection).toMatchObject({
			...launchSelection,
			error: null,
			switching: false,
		});
	});

	it("keeps a Native launch action Native while superseding a parked Chat repair", async () => {
		const agent = nativeAgent("agent-native-parked-chat-selection");
		const repairRequired = managedCreateRepairIntent(
			agent.id,
			"structured_protocol",
		);
		const targetLaunchSelection = {
			...repairRequired.sourceLaunchSelection,
			effort: "high",
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce({
			...nativeObservation(agent.id),
			selectionRevision: 3,
			launchSelection: targetLaunchSelection,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				effort: "high",
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: { kind: "provider_default" },
			targetLaunchSelection,
		});
	});

	it("keeps a Native credential action Native while superseding a parked Chat repair", async () => {
		const agent = nativeAgent("agent-native-parked-chat-credential");
		const account = {
			id: "account-b",
			provider: "codex" as const,
			name: "Codex B",
			dir: "/profiles/codex-account-b",
		};
		const preparedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: account.id,
			credential_generation: "credential-generation-9",
		};
		const repairRequired = managedCreateRepairIntent(
			agent.id,
			"structured_protocol",
		);
		useStore.setState({ agents: [agent], accounts: [account] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce({
			...nativeObservation(agent.id),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchAgentCredential(
				agent.id,
				account.id,
				`agent:${agent.id}`,
			);
		});

		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: preparedExecutionProfile,
			targetLaunchSelection: repairRequired.sourceLaunchSelection,
		});
	});

	it("does not rotate the current credential for a healthy model or effort change", async () => {
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const agent = {
			...structuredAgent("agent-healthy-launch-selection"),
			executionProfile,
		};
		const source = { ...structuredReceipt(agent.id), executionProfile };
		const launchSelection = {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default" as const,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce({
			...source,
			selectionRevision: 3,
			launchSelection,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: launchSelection.model,
				effort: launchSelection.effort,
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(panel.result.current.launchSelection).toMatchObject({
			...launchSelection,
			error: null,
		});
	});

	it("leaves a healthy model change untouched when current account metadata is missing", async () => {
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-missing",
			credential_generation: "credential-generation-7",
		};
		const agent = {
			...structuredAgent("agent-healthy-missing-account"),
			executionProfile,
		};
		const source = { ...structuredReceipt(agent.id), executionProfile };
		const launchSelection = {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default" as const,
		};
		useStore.setState({ agents: [agent], accounts: [] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce({
			...source,
			selectionRevision: 3,
			launchSelection,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: launchSelection.model,
				effort: launchSelection.effort,
			}));
		});
		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());

		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(panel.result.current.launchSelection.error).toBeNull();
	});

	it("requires credential refresh before changing model or effort on a stale parked runtime", async () => {
		const parkedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const preparedExecutionProfile = {
			...parkedExecutionProfile,
			credential_generation: "credential-generation-8",
		};
		const agent = {
			...structuredAgent("agent-stale-launch-selection"),
			executionProfile: parkedExecutionProfile,
		};
		const launchSelection = {
			model: "gpt-5.6-sol",
			effort: "high",
			permissionMode: "default" as const,
		};
		const repairRequired = {
			...managedCreateRepairIntent(
				agent.id,
				"structured_protocol",
				"structured_protocol",
			),
			sourceExecutionProfile: parkedExecutionProfile,
			targetExecutionProfile: parkedExecutionProfile,
			targetLaunchSelection: launchSelection,
			failureKind: "credential_stale" as const,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce({
			...structuredReceipt(agent.id),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
			launchSelection,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		act(() => {
			panel.result.current.launchSelection.switchSelection((source) => ({
				...source,
				model: launchSelection.model,
				effort: launchSelection.effort,
			}));
		});

		await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
		expect(mocks.registerCredential).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
			targetExecutionProfile: preparedExecutionProfile,
		});
		expect(panel.result.current.launchSelection.error).toBeNull();
	});

	it("requires credential refresh before switching a stale parked runtime to Terminal", async () => {
		const parkedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const preparedExecutionProfile = {
			...parkedExecutionProfile,
			credential_generation: "credential-generation-8",
		};
		const agent = {
			...structuredAgent("agent-stale-terminal"),
			executionProfile: parkedExecutionProfile,
		};
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			sourceExecutionProfile: parkedExecutionProfile,
			targetExecutionProfile: parkedExecutionProfile,
			failureKind: "credential_stale" as const,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce({
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.registerCredential).toHaveBeenCalledOnce();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
			targetExecutionProfile: preparedExecutionProfile,
		});
		expect(useStore.getState().agents[0]?.executionProfile).toEqual(
			preparedExecutionProfile,
		);
	});

	it("uses the backend repair source credential when the frontend projection is stale", async () => {
		const sourceExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const staleFrontendProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-4",
		};
		const preparedExecutionProfile = {
			...sourceExecutionProfile,
			credential_generation: "credential-generation-8",
		};
		const agent = {
			...structuredAgent("agent-stale-frontend-credential"),
			executionProfile: staleFrontendProfile,
		};
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			sourceExecutionProfile,
			targetExecutionProfile: sourceExecutionProfile,
			failureKind: "credential_stale" as const,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.registerCredential.mockImplementationOnce(
			async ({ referenceId }) => ({
				kind: "credential_reference" as const,
				reference_id: referenceId,
				credential_generation: "credential-generation-8",
			}),
		);
		mocks.transition.mockImplementationOnce(async (action) => ({
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
			executionProfile: action.targetExecutionProfile,
		}));
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.registerCredential).toHaveBeenCalledWith(
			expect.objectContaining({ referenceId: "account-a" }),
			expect.any(Object),
		);
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
			targetExecutionProfile: preparedExecutionProfile,
		});
	});

	it("prepares provider default only for a stale repair and then retries it", async () => {
		const agent = structuredAgent("agent-stale-provider-default");
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			failureKind: "credential_unavailable" as const,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce({
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		});
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetExecutionProfile: repairRequired.targetExecutionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
		});
	});

	it("keeps a stale current credential explicit when its account metadata is missing", async () => {
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-missing",
			credential_generation: "credential-generation-7",
		};
		const agent = {
			...structuredAgent("agent-stale-missing-account"),
			executionProfile,
		};
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			sourceExecutionProfile: executionProfile,
			targetExecutionProfile: executionProfile,
			failureKind: "credential_stale" as const,
		};
		useStore.setState({ agents: [agent], accounts: [] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "credential_reference_unavailable",
		});
		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("does not repair when exact credential registration rejects remote authority", async () => {
		const id = "agent-stale-remote-account";
		const backendProfileId = "ssh-profile-1";
		const remoteProject = {
			id: "project-remote-current",
			name: "Remote Project",
			path: "/srv/repo",
			kind: "ssh" as const,
			isRepo: true,
			sshHostId: backendProfileId,
		};
		const remoteHost = {
			id: backendProfileId,
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto" as const,
		};
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			backendProfileId,
		);
		const executionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const agent = {
			...structuredAgent(id),
			projectId: remoteProject.id,
			worktreePath: `/srv/repo/.worktrees/${id}`,
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId,
				interactionSessionId: `interaction-${id}`,
			},
			executionProfile,
		};
		const repairRequired = {
			...managedCreateRepairIntent(id, "native_cli"),
			backend: routeAuthority.backend,
			backendProfileId,
			routeAuthority,
			sourceExecutionProfile: executionProfile,
			targetExecutionProfile: executionProfile,
			failureKind: "credential_stale" as const,
		};
		const authorityChanged = new Error("backend_transport_authority_changed");
		useStore.setState({
			agents: [agent],
			projects: [remoteProject],
			sshHosts: [remoteHost],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.preflightRemote.mockImplementationOnce(
			async (_host, _provider, _cwd, _account, options) => {
				await options.beforeOverlay?.();
				return { version: "2.1.234" };
			},
		);
		mocks.assertRouteAuthority
			.mockResolvedValueOnce(routeAuthority)
			.mockResolvedValueOnce(routeAuthority);
		mocks.registerCredential.mockRejectedValueOnce(authorityChanged);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(id);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBe(authorityChanged);
		expect(mocks.preflightRemote).toHaveBeenCalledOnce();
		expect(mocks.registerCredential).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ referenceId: "account-a" }),
			{ profileId: backendProfileId, routeAuthority },
		);
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.interactionProfile).toMatchObject({
			kind: "structured_protocol",
		});
	});

	it("supersedes a stale parked target with a different inherited credential without preparation", async () => {
		const sourceExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-4",
		};
		const agent = {
			...structuredAgent("agent-stale-other-target"),
			executionProfile: sourceExecutionProfile,
		};
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			sourceExecutionProfile,
			targetExecutionProfile: {
				kind: "credential_reference" as const,
				reference_id: "account-a",
				credential_generation: "credential-generation-7",
			},
			failureKind: "credential_stale" as const,
		};
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
			executionProfile: sourceExecutionProfile,
		};
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: sourceExecutionProfile,
			targetLaunchSelection: repairRequired.sourceLaunchSelection,
		});
		expect(useStore.getState().agents[0]?.executionProfile).toEqual(
			sourceExecutionProfile,
		);
	});

	it("does not inspect or repair after the source is retained", async () => {
		const agent = nativeAgent("agent-source-retained");
		const source = nativeObservation(agent.id);
		const retained = new DureAgentRuntimeSourceActiveError(
			new DureBackendRequestError(
				"agent_runtime_source_retained",
				"source retained",
				{ kind: "operation", disposition: "terminal" },
			),
		);
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(source);
		mocks.transition.mockRejectedValueOnce(retained);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentToStructuredChat(agent.id, null);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBeInstanceOf(DureAgentRuntimeSourceActiveError);
		expect(mocks.inspectExact).not.toHaveBeenCalled();
		expect(mocks.inspectTransitionIntent).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
	});

	it("keeps the same repair plan when only provider diagnostics differ", async () => {
		const agent = structuredAgent("agent-provider-diagnostic");
		const repairRequired = {
			...managedCreateRepairIntent(agent.id, "native_cli"),
			providerCode: "claude_credential_generation_stale",
		};
		const committed = {
			...nativeObservation(agent.id, `session-${agent.id}-repaired`),
			selectionRevision: 3,
		};
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairRequired);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(
				agent.id,
			);
		});

		expect(mocks.inspectTransitionIntent).toHaveBeenCalledOnce();
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairRequired.agentId,
			expectedSourceRevision: repairRequired.sourceSelectionRevision,
			routeAuthority: repairRequired.routeAuthority,
			targetInteractionProfile: repairRequired.targetInteractionProfile,
			targetExecutionProfile: repairRequired.targetExecutionProfile,
			targetLaunchSelection: repairRequired.targetLaunchSelection,
		});
		expect(useStore.getState().agents[0]?.interactionProfile).toBeUndefined();
	});

	it("carries the first projection authority through a route-less repair commit", async () => {
		const id = "agent-route-less-repair";
		const {
			agent,
			repairIntent,
			repairProjection,
			projectionContext,
			committed,
		} = routeLessRepairFixture(id);
		useStore.setState({ agents: [agent] });
		mocks.inspectSelectedProjection.mockResolvedValueOnce(repairProjection);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairIntent);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(id);
		});

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: repairIntent.agentId,
			expectedSourceRevision: repairIntent.sourceSelectionRevision,
			routeAuthority: repairIntent.routeAuthority,
			targetInteractionProfile: repairIntent.targetInteractionProfile,
			targetExecutionProfile: repairIntent.targetExecutionProfile,
			targetLaunchSelection: repairIntent.targetLaunchSelection,
		});
		expect(mocks.resolveSelectedRoute).toHaveBeenNthCalledWith(1, undefined);
		expect(mocks.resolveSelectedRoute).toHaveBeenNthCalledWith(2, undefined);
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			id,
			projectId: project.id,
			worktreePath: projectionContext.workspace.rootPath,
			sessionId: `session-${id}-repaired`,
		});
	});

	it("restarts a route-less stopped source even when rehost discovery is unavailable", async () => {
		const id = "agent-route-less-stopped";
		const { agent, projectionContext } = routeLessRepairFixture(id);
		const source = nativeObservation(id);
		const committed = {
			...source,
			selectionRevision: 8,
			sessionId: `session-${id}-restarted`,
		};
		useStore.setState({ agents: [agent] });
		mocks.convergeManagedRehost.mockRejectedValueOnce(
			new Error("hmux_descriptor_unavailable"),
		);
		mocks.inspectSelectedProjection.mockResolvedValueOnce({
			state: "closed",
			agentId: id,
			operationId: `close-${id}`,
			stage: "stopped",
			source: {
				selectionRevision: 7,
				interactionProfile: "native_cli",
				launchSelection: source.launchSelection,
			},
			projectionContext,
			backend: source.backend,
			backendProfileId: source.backendProfileId,
			routeAuthority: source.routeAuthority,
		});
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));

		await act(async () => {
			await panel.result.current.switchAgentCredential(id, null, `agent:${id}`);
		});

		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: id,
				expectedSourceRevision: 7,
				targetInteractionProfile: "native_cli",
			}),
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			projectId: project.id,
			worktreePath: projectionContext.workspace.rootPath,
			sessionId: committed.sessionId,
		});
	});

	it("completes Chat from the selected projection when cached Project is absent", async () => {
		const id = "agent-project-cache-missing-chat";
		const agent = nativeAgent(id);
		const projectionContext = registeredProjectionContext(id);
		const source = { ...nativeObservation(id), projectionContext };
		const committed = structuredReceipt(id);
		useStore.setState({ agents: [agent], projects: [] });
		mocks.inspectSelectedProjection.mockResolvedValueOnce(source);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));

		await act(async () => {
			await panel.result.current.switchAgentToStructuredChat(id, null);
		});

		expect(mocks.inspect).not.toHaveBeenCalled();
		expect(mocks.inspectSelectedProjection).toHaveBeenCalledWith(id);
		expect(mocks.transition).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: id,
				routeAuthority: source.routeAuthority,
				targetInteractionProfile: "structured_protocol",
			}),
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			id,
			projectId: project.id,
			worktreePath: projectionContext.workspace.rootPath,
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: source.backendProfileId,
			},
		});
		expect(useStore.getState().projects).toEqual([]);
	});

	it("pins the first selected backend while a route-less action converges", async () => {
		const id = "agent-route-less-convergence-authority";
		const agent = {
			...nativeAgent(id),
			projectId: undefined,
			worktreePath: undefined,
			runtimeBinding: undefined,
		} as unknown as Agent;
		const projectionContext = registeredProjectionContext(id);
		const firstAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-1",
		);
		const replacementAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);
		const transitioning = {
			state: "transitioning" as const,
			agentId: id,
			operationId: `operation-${id}`,
			stage: "source_stopped" as const,
			journalRevision: 2,
			targetInteractionProfile: "structured_protocol" as const,
			targetExecutionProfile: { kind: "provider_default" as const },
			backend: firstAuthority.backend,
			backendProfileId: firstAuthority.profileId,
			routeAuthority: firstAuthority,
			projectionContext,
		};
		const replacement = {
			...nativeObservation(id),
			backend: replacementAuthority.backend,
			backendProfileId: replacementAuthority.profileId,
			routeAuthority: replacementAuthority,
			projectionContext,
		};
		mocks.resolveSelectedRoute.mockResolvedValue(replacementAuthority);
		mocks.inspectSelectedProjection
			.mockResolvedValueOnce(transitioning)
			.mockImplementationOnce(
				async (
					_agentId: string,
					options?: { expectedRouteAuthority?: typeof firstAuthority },
				) => {
					if (options?.expectedRouteAuthority === firstAuthority) {
						throw new Error("agent_runtime_projection_backend_changed");
					}
					return replacement;
				},
			);
		mocks.transition.mockResolvedValueOnce(structuredReceipt(id));
		useStore.setState({ agents: [agent], projects: [] });
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentToStructuredChat(id, null);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "agent_runtime_projection_backend_changed",
		});
		expect(mocks.inspectSelectedProjection).toHaveBeenNthCalledWith(1, id);
		expect(mocks.inspectSelectedProjection).toHaveBeenNthCalledWith(2, id, {
			expectedRouteAuthority: firstAuthority,
		});
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.projectId).toBeUndefined();
	});

	it("prepares a route-less stale credential from the backend repair source", async () => {
		const id = "agent-route-less-stale-credential";
		const { agent, repairIntent, projectionContext } =
			routeLessRepairFixture(id);
		const sourceExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-7",
		};
		const preparedExecutionProfile = {
			...sourceExecutionProfile,
			credential_generation: "credential-generation-8",
		};
		const staleRepair = {
			...repairIntent,
			sourceExecutionProfile,
			targetExecutionProfile: sourceExecutionProfile,
			failureKind: "credential_stale" as const,
		};
		useStore.setState({
			agents: [agent],
			projects: [],
			accounts: [
				{
					id: "account-a",
					provider: "codex",
					name: "Codex A",
					dir: "/profiles/codex-account-a",
				},
			],
		});
		mocks.inspectSelectedProjection.mockResolvedValueOnce({
			...staleRepair,
			projectionContext,
		});
		mocks.inspectTransitionIntent.mockResolvedValueOnce(staleRepair);
		mocks.registerCredential.mockResolvedValueOnce(preparedExecutionProfile);
		mocks.transition.mockResolvedValueOnce({
			...nativeObservation(id, `session-${id}-repaired`),
			selectionRevision: 3,
			executionProfile: preparedExecutionProfile,
		});
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));

		await act(async () => {
			await panel.result.current.switchStructuredAgentToNativeTerminal(id);
		});

		expect(mocks.registerCredential).toHaveBeenCalledWith(
			expect.objectContaining({ referenceId: "account-a" }),
			expect.objectContaining({
				profileId: "local",
				routeAuthority: staleRepair.routeAuthority,
			}),
		);
		expect(mocks.transition).toHaveBeenCalledWith({
			agentId: staleRepair.agentId,
			expectedSourceRevision: staleRepair.sourceSelectionRevision,
			routeAuthority: staleRepair.routeAuthority,
			targetInteractionProfile: staleRepair.targetInteractionProfile,
			targetLaunchSelection: staleRepair.targetLaunchSelection,
			targetExecutionProfile: preparedExecutionProfile,
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			projectId: project.id,
			worktreePath: projectionContext.workspace.rootPath,
			executionProfile: preparedExecutionProfile,
		});
	});

	it("fences route-less credential preparation against the currently selected backend", async () => {
		const id = "agent-route-less-before-credential-prepare";
		const { agent, repairIntent, projectionContext } =
			routeLessRepairFixture(id);
		const parkedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-3",
		};
		const selectedRepairIntent = {
			...repairIntent,
			targetInteractionProfile: "structured_protocol" as const,
			targetExecutionProfile: parkedExecutionProfile,
		};
		const repairProjection = {
			...selectedRepairIntent,
			projectionContext,
		};
		const oldAuthority = repairIntent.routeAuthority;
		const newAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);
		useStore.setState({
			agents: [agent],
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspectSelectedProjection.mockResolvedValueOnce(repairProjection);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(selectedRepairIntent);
		mocks.assertRouteAuthority.mockResolvedValue(oldAuthority);
		mocks.resolveSelectedRoute.mockResolvedValueOnce(newAuthority);
		mocks.transition.mockResolvedValueOnce({
			...structuredReceipt(id),
			selectionRevision: 3,
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "credential-generation-9",
			},
		});
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentCredential(
					id,
					"account-b",
					`agent:${id}`,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "client_agent_runtime_transition_conflict",
		});
		expect(mocks.resolveSelectedRoute).toHaveBeenCalledWith(undefined);
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(mocks.registerCredential).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.projectId).toBeUndefined();
	});

	it("prepares on the captured backend but does not repair after the selected backend changes", async () => {
		const id = "agent-route-less-after-preflight";
		const backendProfileId = "ssh-profile-1";
		const remoteProject = {
			id: "project-remote",
			name: "Remote Project",
			path: "/srv/repo",
			kind: "ssh" as const,
			isRepo: true,
			sshHostId: backendProfileId,
		};
		const remoteHost = {
			id: backendProfileId,
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto" as const,
		};
		const oldAuthority = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			backendProfileId,
		);
		const newAuthority = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-2",
			backendProfileId,
		);
		const agent = {
			...nativeAgent(id),
			projectId: undefined,
			worktreePath: undefined,
			runtimeBinding: undefined,
		} as unknown as Agent;
		const projectionContext = {
			...registeredProjectionContext(id),
			workspace: {
				workspaceId: `workspace-${id}`,
				projectId: remoteProject.id,
				rootPath: `/srv/repo/.worktrees/${id}`,
			},
			project: {
				projectId: remoteProject.id,
				rootPath: remoteProject.path,
			},
		};
		const parkedExecutionProfile = {
			kind: "credential_reference" as const,
			reference_id: "account-a",
			credential_generation: "credential-generation-3",
		};
		const repairIntent = {
			...managedCreateRepairIntent(id, "structured_protocol"),
			backend: oldAuthority.backend,
			backendProfileId,
			routeAuthority: oldAuthority,
			targetExecutionProfile: parkedExecutionProfile,
		};
		mocks.registerCredential.mockResolvedValue({
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-generation-9",
		});
		mocks.preflightRemote.mockImplementation(
			async (_host, _provider, _cwd, _account, options) => {
				await options.beforeOverlay?.();
				return { version: "2.1.234" };
			},
		);
		useStore.setState({
			agents: [agent],
			projects: [],
			sshHosts: [remoteHost],
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "Codex B",
					dir: "/profiles/codex-account-b",
				},
			],
		});
		mocks.inspectSelectedProjection.mockResolvedValueOnce({
			...repairIntent,
			projectionContext,
		});
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairIntent);
		mocks.assertRouteAuthority.mockResolvedValue(oldAuthority);
		mocks.resolveSelectedRoute
			.mockResolvedValueOnce(oldAuthority)
			.mockResolvedValueOnce(oldAuthority)
			.mockResolvedValueOnce(oldAuthority)
			.mockResolvedValueOnce(newAuthority);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchAgentCredential(
					id,
					"account-b",
					`agent:${id}`,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "client_agent_runtime_transition_conflict",
		});
		expect(mocks.preflightRemote).toHaveBeenCalledOnce();
		expect(mocks.registerCredential).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ referenceId: "account-b" }),
			{ profileId: backendProfileId, routeAuthority: oldAuthority },
		);
		expect(mocks.repair).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.projectId).toBeUndefined();
	});

	it("refuses a route-less repair when the selected backend changes before mutation", async () => {
		const id = "agent-route-less-before-repair";
		const { agent, repairIntent, repairProjection, committed } =
			routeLessRepairFixture(id);
		const changedAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);
		useStore.setState({ agents: [agent] });
		mocks.inspectSelectedProjection.mockResolvedValueOnce(repairProjection);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairIntent);
		mocks.assertRouteAuthority.mockResolvedValue(repairIntent.routeAuthority);
		mocks.resolveSelectedRoute.mockResolvedValueOnce(changedAuthority);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(id);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "client_agent_runtime_transition_conflict",
		});
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.projectId).toBeUndefined();
	});

	it("refuses to commit a route-less repair after the selected backend changes", async () => {
		const id = "agent-route-less-before-commit";
		const { agent, repairIntent, repairProjection, committed } =
			routeLessRepairFixture(id);
		const changedAuthority = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);
		useStore.setState({ agents: [agent] });
		mocks.inspectSelectedProjection.mockResolvedValueOnce(repairProjection);
		mocks.inspectTransitionIntent.mockResolvedValueOnce(repairIntent);
		mocks.assertRouteAuthority.mockResolvedValue(repairIntent.routeAuthority);
		mocks.resolveSelectedRoute
			.mockResolvedValueOnce(repairIntent.routeAuthority)
			.mockResolvedValueOnce(changedAuthority);
		mocks.transition.mockResolvedValueOnce(committed);
		const panel = renderHook(() => useAgentPanelState(id, `agent:${id}`));
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(id);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toMatchObject({
			message: "client_agent_runtime_transition_conflict",
		});
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(mocks.resolveSelectedRoute).toHaveBeenCalledTimes(2);
		expect(mocks.assertRouteAuthority).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]?.projectId).toBeUndefined();
	});

	it("fails before repair when the selected backend lacks versioned intent inspection", async () => {
		const agent = structuredAgent("agent-old-backend");
		const repairRequired = managedCreateRepairIntent(agent.id, "native_cli");
		const unavailable = new Error("backend_transport_capability_missing");
		useStore.setState({ agents: [agent] });
		mocks.inspect.mockResolvedValueOnce(repairRequired);
		mocks.inspectTransitionIntent.mockRejectedValueOnce(unavailable);
		const panel = renderHook(() =>
			useAgentPanelState(agent.id, `agent:${agent.id}`),
		);
		let caught: unknown;

		await act(async () => {
			try {
				await panel.result.current.switchStructuredAgentToNativeTerminal(
					agent.id,
				);
			} catch (error) {
				caught = error;
			}
		});

		expect(caught).toBe(unavailable);
		expect(mocks.transition).not.toHaveBeenCalled();
		expect(mocks.repair).not.toHaveBeenCalled();
	});
});
