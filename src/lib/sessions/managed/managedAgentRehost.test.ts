import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import type {
	HmuxManagedStopReceipt,
	HmuxRecoveryPlanReceipt,
	HmuxSessionSummary,
} from "@/lib/ipc";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntime";
import { runManagedAgentRehostTransaction } from "@/lib/sessions/managed/managedAgentRehostTransaction";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { AccountProfile, Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	advanceManagedCreate: vi.fn(),
	executeRecovery: vi.fn(),
	ensureConversationIdentity: vi.fn(),
	getDockview: vi.fn(),
	inspectConversationIdentity: vi.fn(),
	ensureCoordinatorBinding: vi.fn(),
	ensureCoordinatorRoute: vi.fn(),
	loadProviderConversationDetails: vi.fn(),
	listSessions: vi.fn(),
	openAgentPanel: vi.fn(),
	planRecovery: vi.fn(),
	preflightRecovery: vi.fn(),
	probeSessions: vi.fn(),
	reconcileRecovery: vi.fn(),
	resolveManagedRehost: vi.fn(),
	resolveRouteAuthority: vi.fn(),
	resolveCurrentManagedSession: vi.fn(),
	resolvePaneById: vi.fn(),
	resolvePaneReference: vi.fn(),
	inspectExistingManagedWriter: vi.fn(),
	inspectDispatchSession: vi.fn(),
	rebindDispatchSession: vi.fn(),
	commitNativeRehost: vi.fn(),
	commitNativeResume: vi.fn(),
	registerCredential: vi.fn(),
	stopManaged: vi.fn(),
	emit: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
	resolvePaneById: mocks.resolvePaneById,
	resolvePaneReference: mocks.resolvePaneReference,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: mocks.getDockview,
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		advanceManagedCreate: mocks.advanceManagedCreate,
		inspectExistingManagedWriter: mocks.inspectExistingManagedWriter,
		inspectManagedConversationIdentity: mocks.inspectConversationIdentity,
		listSessions: mocks.listSessions,
		planRecovery: mocks.planRecovery,
		probeSessions: mocks.probeSessions,
		resolveManagedRehost: mocks.resolveManagedRehost,
		resolveCurrentManagedSession: mocks.resolveCurrentManagedSession,
	},
}));
vi.mock("@/lib/agents/providerConversationDiscovery", () => ({
	loadProviderConversationDetails: mocks.loadProviderConversationDetails,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: async (target: {
		sessionId: string;
		workspaceId: string;
	}) =>
		(await mocks.listSessions()).find(
			(session: { sessionId: string; workspaceId: string }) =>
				session.sessionId === target.sessionId &&
				session.workspaceId === target.workspaceId,
		),
}));

vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	executeManagedAgentRecovery: mocks.executeRecovery,
	ensureManagedConversationIdentity: mocks.ensureConversationIdentity,
	MANAGED_BOOTSTRAP_GEOMETRY: { columns: 120, rows: 30 },
	preflightManagedAgentRecovery: mocks.preflightRecovery,
	reconcileManagedAgentRecovery: mocks.reconcileRecovery,
}));

vi.mock("@/lib/sessions/managed/managedAgentStop", () => ({
	stopManagedAgentProvider: mocks.stopManaged,
}));

vi.mock("@/lib/ipc/dureWorkflow", () => ({
	createDureWorkflowTransport: () => ({
		ensureCoordinatorBinding: (route: unknown, request: unknown) => {
			mocks.ensureCoordinatorRoute(route);
			return mocks.ensureCoordinatorBinding(request);
		},
		inspectDispatchSession: (_route: unknown, session: unknown) =>
			mocks.inspectDispatchSession(session),
		rebindDispatchSession: (_route: unknown, request: unknown) =>
			mocks.rebindDispatchSession(request),
	}),
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.registerCredential,
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	resolveSelectedDureBackendRouteAuthority: mocks.resolveRouteAuthority,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostCommit", () => ({
	commitManagedAgentNativeRehost: mocks.commitNativeRehost,
	commitManagedAgentNativeResume: mocks.commitNativeResume,
}));

import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
	executeManagedAgentCredentialSwitch,
	executeManagedAgentRehost,
	executeUnavailableManagedAgentRecovery,
	inspectDisconnectedManagedAgentRecovery,
	inspectInterruptedManagedAgentCredentialSwitch,
	inspectManagedAgentCredentialSwitch,
	inspectManagedAgentRehost,
	managedAgentCredentialSwitchSyncPayload,
	managedAgentRehostSyncPayload,
	managedRebootRecoverySyncPayload,
	reconcileManagedAgentRehost,
} from "@/lib/sessions/managed/managedAgentRehost";
import { parseManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	applyCommittedManagedAgentRehostProjection,
	commitManagedAgentRehostReceipt,
	commitReconciledManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const conversationId = "019fa342-4698-78b2-a47d-784690b3c756";
const sourceStopFence = stopFenceFixture({
	runnerPrincipal: "principal-old",
	runnerInstance: "runner-old",
	channelEpoch: "7",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});
const replacementStopFence = stopFenceFixture({
	runnerPrincipal: "principal-new",
	runnerInstance: "runner-new",
	channelEpoch: "8",
	hostInstanceId: "host-new",
	terminalEpoch: "terminal-new",
});

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-managed",
		name: "hebbian-frontend",
		worktreePath: "/repo/worktree",
		branch: "agent/hebbian-frontend",
		sessionId: "session-old",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-old",
			stopFence: sourceStopFence,
		}),
		conversationId,
		...patch,
	});
}

function sourceSummary(
	lifecycle: "ready" | "exited" | "unavailable",
): HmuxSessionSummary {
	return {
		sessionId: "session-old",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle,
		...(lifecycle === "exited" ? { health: "exited" as const } : {}),
		...(lifecycle === "unavailable"
			? { health: "stale_transport" as const, inputAllowed: false }
			: {}),
		terminalEpoch: "terminal-old",
		outputSeq: "9",
		capabilities: [],
	};
}

function sourceMetadata(
	lifecycle: "exited" | "unavailable",
): Record<string, HmuxSessionSummary> {
	return {
		[JSON.stringify(["workspace-1", "session-old"])]: sourceSummary(lifecycle),
	};
}

function codexAccount(name: string): AccountProfile {
	return {
		id: `account-${name}`,
		provider: "codex",
		name,
		dir: `/profiles/codex-${name}`,
	};
}

function credentialBinding(
	credentialId: string,
	credentialGeneration?: number,
): Agent["runtimeBinding"] {
	return {
		...managedAgent().runtimeBinding,
		credentialId,
		...(credentialGeneration === undefined ? {} : { credentialGeneration }),
	} as Agent["runtimeBinding"];
}

const expectedPlanRequest = {
	sessionId: "session-old",
	workspaceId: "workspace-1",
	expectedSourceFence: sourceStopFence,
	conversationId,
	adapterSupportsExplicitResume: true,
	confirmed: false,
};

function plan(
	patch: Partial<HmuxRecoveryPlanReceipt> = {},
): HmuxRecoveryPlanReceipt {
	return {
		sessionId: "session-old",
		sourceBuildId: "build-old",
		targetBuildId: "build-current",
		action: "none",
		allowed: false,
		reason: "update_requires_confirmation",
		requiresConfirmation: true,
		...patch,
	};
}

function stopReceipt(): HmuxManagedStopReceipt {
	return {
		schema: "hmux-managed-stop-v1",
		schemaVersion: 2,
		stopId: "stop-old",
		sessionId: "session-old",
		workspaceId: "workspace-1",
		runnerPrincipal: sourceStopFence.runnerPrincipal,
		runnerInstance: sourceStopFence.runnerInstance,
		channelEpoch: Number(sourceStopFence.channelEpoch),
		hostInstanceId: "host-old",
		terminalEpoch: "terminal-old",
		outcome: "stopped",
		exitReason: "managed_provider_stop",
	};
}

function recoveryResult(credentialId?: string): ManagedAgentRecoveryResult {
	const replacement = {
		sessionId: "session-new",
		workspaceId: "workspace-1",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		terminalEpoch: "terminal-new",
		stopFence: replacementStopFence,
		outputSeq: "4",
		capabilities: [],
	};
	return {
		providerId: "codex",
		permissionMode: "default",
		conversationId,
		createIdempotencyKey: "recovery-exact",
		credentialId,
		replacement,
		receipt: {
			sourceSessionId: "session-old",
			targetBuildId: "build-current",
			action: "replace_ai_provider_with_explicit_conversation",
			outcome: "replaced",
			replayed: false,
			operationId: "rehost-operation-1",
			sourceStopReceipt: stopReceipt(),
			replacementTarget: {
				idempotencyKey: "recovery-exact",
				sessionId: replacement.sessionId,
				workspaceId: replacement.workspaceId,
				providerId: "codex",
				permissionMode: "default",
				runnerPrincipal: replacementStopFence.runnerPrincipal,
				runnerInstance: replacementStopFence.runnerInstance,
				channelEpoch: replacementStopFence.channelEpoch,
				hostInstanceId: replacementStopFence.hostInstanceId,
				terminalEpoch: replacementStopFence.terminalEpoch,
			},
			replacementSession: replacement,
		},
	};
}

describe("managed Agent one-shot rehost", () => {
	let params: Record<string, unknown>;
	let updateParameters: ReturnType<typeof vi.fn>;
	let setActive: ReturnType<typeof vi.fn>;
	let panelPresent: boolean;
	let dockApi: {
		getPanel: ReturnType<typeof vi.fn>;
		toJSON: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		for (const mock of Object.values(mocks)) mock.mockReset();
		mocks.resolveRouteAuthority.mockImplementation(
			async (profileId: string) => ({
				schemaVersion: 1,
				profileId,
				revision: `sha256:${"a".repeat(64)}`,
				backend: { id: `backend-${profileId}`, generation: "generation-1" },
				target: { source: "local", hostId: "local" },
			}),
		);
		mocks.ensureCoordinatorBinding.mockImplementation(async (request) => ({
			agentId: request.agentId,
			sessionId: request.sessionId,
			bindingGeneration: 2,
		}));
		mocks.commitNativeRehost.mockImplementation(
			async (payload, routeAuthority) => ({
				agentId: payload.agentId,
				providerId: payload.providerId,
				interactionProfile: "native_cli",
				executionProfile: payload.binding.credentialId
					? {
							kind: "credential_reference",
							reference_id: payload.binding.credentialId,
							credential_generation: "credential-generation-1",
						}
					: { kind: "provider_default" },
				providerConversationRef: payload.conversationId,
				sessionId: payload.binding.sessionId,
				workspaceId: payload.binding.workspaceId,
				launchIdempotencyKey: payload.binding.createIdempotencyKey,
				stopFence: payload.binding.stopFence,
				backend: routeAuthority.backend,
				backendProfileId: routeAuthority.profileId,
				routeAuthority,
				selectionRevision: 2,
				launchSelection: {
					model: null,
					effort: null,
					permissionMode:
						payload.permissionMode === "bypass_approvals"
							? "skip_permissions"
							: "default",
				},
			}),
		);
		mocks.commitNativeResume.mockImplementation(
			async (payload, routeAuthority) =>
				mocks.commitNativeRehost(payload, routeAuthority),
		);
		mocks.advanceManagedCreate.mockImplementation(async (request) => ({
			state: request.replaceCurrent ? "advanced" : "current",
			receipt: {
				session: {
					sessionId: request.replaceCurrent
						? "managed_resume_target_0881f166decc4781"
						: request.sessionId,
					workspaceId: request.workspaceId,
					sessionClass: "managed",
					lifecycle: "ready",
					terminalEpoch: replacementStopFence.terminalEpoch,
					stopFence: replacementStopFence,
					outputSeq: "0",
					capabilities: [],
				},
				idempotencyKey: request.replaceCurrent
					? "managed_resume_create_target_0881f166decc4781"
					: request.idempotencyKey,
				cwd: request.cwd,
				outcome: "created",
				...(request.credentialId ? { credentialId: request.credentialId } : {}),
			},
		}));
		mocks.inspectDispatchSession.mockImplementation(async (session) => ({
			schemaVersion: 1,
			outcome: "unassigned",
			session,
		}));
		mocks.rebindDispatchSession.mockImplementation(async (request) => ({
			schemaVersion: 1,
			operationId: request.operationId,
			outcome: "unassigned",
			source: request.source,
			target: request.target,
		}));
		mocks.ensureConversationIdentity.mockResolvedValue(undefined);
		mocks.inspectConversationIdentity.mockImplementation(
			async (request: {
				sessionId: string;
				workspaceId: string;
				providerId: Agent["provider"];
			}) => ({
				...request,
				conversationId:
					useStore
						.getState()
						.agents.find((agent) => agent.sessionId === request.sessionId)
						?.conversationId ?? conversationId,
			}),
		);
		mocks.reconcileRecovery.mockResolvedValue(null);
		mocks.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: { sessionId: "session-old", workspaceId: "workspace-1" },
		});
		mocks.loadProviderConversationDetails.mockResolvedValue({
			inputAuthority: { kind: "independent" },
			subagents: [],
			totalCount: 0,
		});
		params = { agentRef: { agentId: "agent-managed" } };
		updateParameters = vi.fn((next: Record<string, unknown>) => {
			params = next;
		});
		setActive = vi.fn();
		panelPresent = true;
		const panel = {
			id: "agent:agent-managed",
			api: {
				component: "agent",
				getParameters: () => params,
				updateParameters,
				setActive,
			},
		};
		dockApi = {
			getPanel: vi.fn(() => (panelPresent ? panel : undefined)),
			toJSON: vi.fn(() => ({ panels: [params] })),
		};
		mocks.getDockview.mockReturnValue(dockApi);
		mocks.openAgentPanel.mockImplementation(
			(_desktopId: string, _agent: Agent) => {
				panelPresent = true;
				params = { agentRef: { agentId: "agent-managed" } };
			},
		);
		mocks.resolvePaneReference.mockResolvedValue(paneReference());
		mocks.resolvePaneById.mockResolvedValue(paneReference());
		mocks.planRecovery.mockResolvedValue(plan());
		mocks.stopManaged.mockResolvedValue(stopReceipt());
		mocks.executeRecovery.mockImplementation(
			async (
				agent: Agent,
				options: {
					prepareFirstAdmission?: (
						backendRouteAuthority: Awaited<
							ReturnType<typeof mocks.resolveRouteAuthority>
						>,
					) => Agent | Promise<Agent>;
				},
			) => {
				const binding = agent.runtimeBinding;
				const backendRouteAuthority = await mocks.resolveRouteAuthority(
					binding?.runtime === "hmux_managed_v1"
						? (binding.backendProfileId ?? "local")
						: "local",
				);
				const launchAgent = options.prepareFirstAdmission
					? await options.prepareFirstAdmission(backendRouteAuthority)
					: agent;
				return {
					...recoveryResult(launchAgent.credentialId),
					backendRouteAuthority,
				};
			},
		);
		mocks.listSessions.mockResolvedValue([sourceSummary("ready")]);
		useStore.setState({
			activeSpaceId: "desktop-1",
			projects: [
				{
					id: "project-1",
					name: "HebbianIDE",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [managedAgent()],
			agentRuntimeLaunchPresentation: {},
			skipPermissions: { codex: true },
			layouts: {},
			sessionCwd: { "session-old": "/repo/worktree" },
			hmuxSessionMetadata: {},
		});
	});

	function paneReference() {
		return {
			desktopId: "desktop-1",
			api: dockApi,
			panelId: "agent:agent-managed",
			cwd: "/repo/worktree",
		};
	}

	/** Moves the store's managed Agent onto a third runtime identity. */
	function retargetManagedSource(): void {
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => {
				if (agent.runtimeBinding?.runtime !== "hmux_managed_v1") return agent;
				return {
					...agent,
					sessionId: "session-third",
					runtimeBinding: {
						...agent.runtimeBinding,
						sessionId: "session-third",
					},
				};
			}),
		}));
	}

	function retargetSourceDuringPaneResolution(): void {
		mocks.resolvePaneById.mockImplementationOnce(async () => {
			retargetManagedSource();
			return paneReference();
		});
	}

	it.each(["pane:stable-slot", "launcher:previous-content"])(
		"admits an exact pane constraint by Agent reference: %s",
		async (panelId) => {
			mocks.resolvePaneById.mockResolvedValue({ ...paneReference(), panelId });
			const inspection = await inspectManagedAgentRehost("agent-managed", panelId);
			expect(inspection).toMatchObject({
				panelId,
				agentId: "agent-managed",
				sourcePaneState: "present",
			});
			expect(mocks.planRecovery).toHaveBeenCalledExactlyOnceWith(
				expectedPlanRequest,
			);
		},
	);

	it("does not activate a pane retargeted while the committed receipt resolves it", async () => {
		const payload = await preparedRehostPayload();
		mocks.resolvePaneById.mockImplementationOnce(async () => {
			params = { agentRef: { agentId: "another-agent" } };
			return paneReference();
		});
		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({
			projection: "applied",
			presentation: "pending",
			pane: null,
		});
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(setActive).not.toHaveBeenCalled();
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it.each([undefined, "agent:agent-managed", "pane:stable-slot"])(
		"replays the existing journal before inspecting missing source hints (pane=%s)",
		async (panelId) => {
			useStore.setState({ agents: [managedAgent({ conversationId: undefined })] });
			mocks.reconcileRecovery.mockResolvedValue({
				...recoveryResult(),
				backendRouteAuthority: await mocks.resolveRouteAuthority("local"),
			});
			mocks.resolvePaneById.mockRejectedValue(
				new PaneCommandError("pane_not_found", "closed"),
			);
			const result = await runManagedAgentRehostTransaction({
				name: "agent-managed",
				panelId,
				confirmed: false,
			});
			expect(result).toMatchObject({
				state: "completed",
				rehost: {
					replayed: true,
					presentation: "pending",
					replacementSession: { sessionId: "session-new" },
				},
			});
			expect(mocks.planRecovery).not.toHaveBeenCalled();
			expect(mocks.executeRecovery).not.toHaveBeenCalled();
			expect(mocks.reconcileRecovery).toHaveBeenCalledOnce();
		},
	);

	it("completes journal replay without activating an explicitly selected slot now owned by another Agent", async () => {
		params = { agentRef: { agentId: "another-agent" } };
		mocks.reconcileRecovery.mockResolvedValue({
			...recoveryResult(),
			backendRouteAuthority: await mocks.resolveRouteAuthority("local"),
		});
		const result = await runManagedAgentRehostTransaction({
			name: "agent-managed",
			panelId: "pane:stable-slot",
			confirmed: false,
		});
		expect(result).toMatchObject({
			state: "completed",
			rehost: { replayed: true, presentation: "pending" },
		});
		expect(setActive).not.toHaveBeenCalled();
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("rejects a changed explicit pane before planning a new replacement", async () => {
		params = { agentRef: { agentId: "another-agent" } };
		await expect(
			inspectManagedAgentRehost("agent-managed", "agent:agent-managed"),
		).rejects.toMatchObject({ code: "pane_changed" });
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it.each(["pane:stable-slot", "launcher:previous-content"])(
		"keeps the inspected runtime target independent of presentation %s",
		async (panelId) => {
			mocks.resolvePaneReference.mockResolvedValueOnce({
				...paneReference(),
				panelId,
			});
			const inspection = await inspectManagedAgentRehost("agent-managed");
			expect(inspection.panelId).toBe(panelId);
			const execution = await executeManagedAgentRehost(inspection);
			expect(managedAgentRehostSyncPayload(inspection, execution)).toMatchObject({
				agentId: "agent-managed",
				panelId,
				binding: { sessionId: "session-new" },
			});
			expect(mocks.executeRecovery).toHaveBeenCalledOnce();
		},
	);

	/** Runs the standard inspect → execute → payload rehost pipeline. */
	async function preparedRehostPayload() {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const execution = await executeManagedAgentRehost(inspection);
		return managedAgentRehostSyncPayload(inspection, execution);
	}

	async function preparedCredentialSwitchPayload(
		targetCredentialId: string | null,
	) {
		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			targetCredentialId,
		);
		const execution = await executeManagedAgentCredentialSwitch(inspection);
		return managedAgentCredentialSwitchSyncPayload(inspection, execution);
	}

	function inspectDisconnected() {
		return inspectDisconnectedManagedAgentRecovery(
			"agent-managed",
			conversationId,
		);
	}

	/** Seeds a dead source: store metadata plus one exact census observation. */
	function seedDisconnectedSource(
		lifecycle: "exited" | "unavailable",
		agent: Agent = managedAgent({ conversationId: undefined }),
	): void {
		useStore.setState({
			agents: [agent],
			hmuxSessionMetadata: sourceMetadata(lifecycle),
		});
		mocks.listSessions.mockResolvedValueOnce([sourceSummary(lifecycle)]);
	}

	/** Seeds the store agent, its pane binding, and the account catalog. */
	function seedAgentWithAccounts(
		patch: Partial<Agent>,
		accounts: AccountProfile[],
	): void {
		const source = managedAgent(patch);
		params.binding = source.runtimeBinding;
		useStore.setState({ agents: [source], accounts });
	}

	/** Seeds a pre-fence agent whose binding predates durable stop fences. */
	function seedLegacyAgent(): void {
		const legacyBinding = {
			...managedAgent().runtimeBinding,
			stopFence: undefined,
		} as Agent["runtimeBinding"];
		params = { agentRef: { agentId: "agent-managed" }, agentId: "agent-managed", binding: legacyBinding };
		useStore.setState({
			agents: [managedAgent({ runtimeBinding: legacyBinding })],
		});
	}

	it("plans without stopping or replacing the live provider", async () => {
		const inspection = await inspectManagedAgentRehost(
			"HebbianIDE/hebbian-frontend",
		);

		expect(inspection).toMatchObject({
			sourceBinding: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
			},
			conversationId,
			permissionMode: "bypass_approvals",
			plan: {
				sourceBuildId: "build-old",
				targetBuildId: "build-current",
			},
		});
		expect(mocks.planRecovery).toHaveBeenCalledWith(expectedPlanRequest);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("lets journaled recovery decide when the source transport is already terminating", async () => {
		mocks.resolveCurrentManagedSession.mockRejectedValueOnce(
			new Error("hmux_stale_transport: Host is terminating"),
		);

		const inspection = await inspectManagedAgentRehost(
			"HebbianIDE/hebbian-frontend",
		);

		expect(inspection.sourceBinding).toMatchObject({
			sessionId: "session-old",
			workspaceId: "workspace-1",
		});
		expect(mocks.planRecovery).toHaveBeenCalledWith(expectedPlanRequest);
		expect(mocks.resolveCurrentManagedSession).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("plans a pre-fence pane without a transport backfill", async () => {
		seedLegacyAgent();
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(inspection.sourceBinding.stopFence).toBeUndefined();
		expect(mocks.planRecovery).toHaveBeenCalledOnce();
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("refuses a non-confirmation recovery policy before any side effect", async () => {
		mocks.planRecovery.mockResolvedValueOnce(
			plan({
				reason: "conversation_identity_required",
				requiresConfirmation: false,
			}),
		);

		await expect(
			inspectManagedAgentRehost("hebbian-frontend"),
		).rejects.toMatchObject({
			code: "invalid_request",
			message: "conversation_identity_required",
		});
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("delegates exact source stop and replacement to one backend transaction before the frontend CAS", async () => {
		const payload = await preparedRehostPayload();
		expect(payload.backendRouteAuthority).toBeDefined();
		mocks.resolveRouteAuthority.mockClear();
		mocks.resolveRouteAuthority.mockResolvedValue({
			schemaVersion: 1,
			profileId: "local",
			revision: `sha256:${"b".repeat(64)}`,
			backend: { id: "backend-b", generation: "generation-b" },
			target: { source: "local", hostId: "local" },
		});
		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.preflightRecovery).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "session-old" }),
		);
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "agent-managed",
				sessionId: "session-old",
				conversationId,
			}),
			expect.objectContaining({
				columns: 120,
				rows: 30,
				confirmed: true,
				preflighted: true,
				expectedTargetBuildId: "build-current",
				prepareFirstAdmission: expect.any(Function),
			}),
		);
		expect(synchronized?.pane).toMatchObject({
			desktopId: "desktop-1",
			panelId: "agent:agent-managed",
			sessionId: "session-new",
			workspaceId: "workspace-1",
			conversationId,
		});
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
		expect(mocks.commitNativeRehost).toHaveBeenCalledWith(
			payload,
			payload.backendRouteAuthority,
			expect.any(Object),
		);
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			conversationId,
			pendingCmd: undefined,
			runtimeBinding: {
				sessionId: "session-new",
				workspaceId: "workspace-1",
			},
		});
		expect(useStore.getState().sessionCwd).not.toHaveProperty("session-old");
		expect(useStore.getState().sessionCwd).toHaveProperty(
			"session-new",
			"/repo/worktree",
		);
		expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
			stopFence: replacementStopFence,
		});
		expect(updateParameters).not.toHaveBeenCalled();
		expect(setActive).toHaveBeenCalledOnce();
	});

	it("resumes an exact conversation in the existing pane without a sibling", async () => {
		seedDisconnectedSource("exited");
		const committed = await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(committed).toMatchObject({
			presentation: "applied",
			pane: {
				panelId: "agent:agent-managed",
				sessionId: expect.stringMatching(/^managed_resume_/),
				conversationId,
			},
		});
		expect(useStore.getState().agents).toHaveLength(1);
		expect(useStore.getState().agentActivity["agent-managed"]).toBe(
			"connecting",
		);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		expect(updateParameters).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			expect.objectContaining({
				agentId: "agent-managed",
				panelId: "agent:agent-managed",
				conversationId,
			}),
		);
	});

	it("attempts a new target before consulting historical recovery authority", async () => {
		seedDisconnectedSource("exited");

		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(mocks.advanceManagedCreate).toHaveBeenCalledOnce();
		expect(mocks.advanceManagedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				replaceCurrent: true,
				idempotencyKey: "create-old",
				sessionId: "session-old",
				workspaceId: "workspace-1",
				providerId: "codex",
				conversationId,
				cwd: "/repo/worktree",
			}),
			undefined,
		);
		expect(mocks.advanceManagedCreate.mock.calls[0][0]).not.toHaveProperty(
			"credentialGeneration",
		);
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(mocks.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.advanceManagedCreate.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.resolveRouteAuthority.mock.invocationCallOrder[0],
		);
	});

	it("does not let a pending launch command override exact conversation resume", async () => {
		seedDisconnectedSource("exited", managedAgent({ pendingCmd: "codex" }));
		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);
		expect(mocks.advanceManagedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId,
				command: expect.stringContaining(`resume ${conversationId}`),
			}),
			undefined,
		);
	});

	it("uses the compatibility create identity for a pre-field binding", async () => {
		seedDisconnectedSource(
			"exited",
			managedAgent({
				runtimeBinding: managedBindingFixture({
					sessionId: "session-old",
					workspaceId: "workspace-1",
					createIdempotencyKey: undefined,
					stopFence: sourceStopFence,
				}),
			}),
		);

		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(mocks.advanceManagedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				replaceCurrent: true,
				idempotencyKey: "session-old",
				sessionId: "session-old",
			}),
			undefined,
		);
	});

	it("replays only the same replace identity across a retry boundary", async () => {
		seedDisconnectedSource("exited");
		mocks.advanceManagedCreate.mockResolvedValueOnce({
			state: "retry_same",
			reason: "authority_unavailable",
			code: "hmux_managed_create_advance_authority_unavailable",
			message: "replacement receipt response was interrupted",
		});

		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(mocks.advanceManagedCreate).toHaveBeenCalledTimes(2);
		expect(mocks.advanceManagedCreate.mock.calls[1][0]).toEqual(
			mocks.advanceManagedCreate.mock.calls[0][0],
		);
		expect(mocks.commitNativeResume).toHaveBeenCalledOnce();
	});

	it("surfaces an actual Host launch rejection without consulting backend authority", async () => {
		seedDisconnectedSource("exited");
		mocks.advanceManagedCreate.mockResolvedValueOnce({
			state: "rejected",
			code: "provider_launch_failed",
			message: "provider process exited during launch",
		});

		await expect(
			resumeExactManagedAgentPane(
				"agent-managed",
				"agent:agent-managed",
				conversationId,
			),
		).rejects.toMatchObject({
			code: "managed_create_rejected",
			backendCode: "provider_launch_failed",
		});

		expect(mocks.advanceManagedCreate).toHaveBeenCalledOnce();
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
		expect(mocks.commitNativeResume).not.toHaveBeenCalled();
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(mocks.inspectExistingManagedWriter).not.toHaveBeenCalled();
	});

	it("keeps a ready Resume target when backend projection is unavailable", async () => {
		seedDisconnectedSource("exited");
		mocks.commitNativeResume.mockRejectedValueOnce(
			new Error("backend projection unavailable"),
		);

		await expect(
			resumeExactManagedAgentPane(
				"agent-managed",
				"agent:agent-managed",
				conversationId,
			),
		).resolves.toMatchObject({
			projection: "applied",
			pane: {
				sessionId: expect.stringMatching(/^managed_resume_target_/),
			},
		});

		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: expect.stringMatching(/^managed_resume_target_/),
			conversationId,
		});
		expect(mocks.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			expect.objectContaining({ launchKind: "resume_new_host" }),
		);
	});

	it("keeps a ready Resume target when the source Agent projection disappears", async () => {
		seedDisconnectedSource("exited");
		const advance = mocks.advanceManagedCreate.getMockImplementation();
		if (!advance) throw new Error("managed create fixture is unavailable");
		mocks.advanceManagedCreate.mockImplementationOnce(async (request) => {
			const resolution = await advance(request);
			useStore.setState({ agents: [] });
			return resolution;
		});

		await expect(
			resumeExactManagedAgentPane(
				"agent-managed",
				"agent:agent-managed",
				conversationId,
			),
		).resolves.toMatchObject({
			projection: "pending",
			presentation: "pending",
			pane: null,
			payload: {
				binding: {
					sessionId: expect.stringMatching(/^managed_resume_target_/),
				},
			},
		});
		expect(mocks.commitNativeResume).toHaveBeenCalledOnce();
	});

	it("keeps a ready Resume target when cross-WebView publication fails", async () => {
		seedDisconnectedSource("exited");
		mocks.emit.mockRejectedValueOnce(new Error("event channel unavailable"));

		await expect(
			resumeExactManagedAgentPane(
				"agent-managed",
				"agent:agent-managed",
				conversationId,
			),
		).resolves.toMatchObject({
			projection: "applied",
			payload: {
				binding: {
					sessionId: expect.stringMatching(/^managed_resume_target_/),
				},
			},
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: expect.stringMatching(/^managed_resume_target_/),
			conversationId,
		});
	});

	it("uses a deferred credential target on the first new Host attempt", async () => {
		seedAgentWithAccounts(
			{
				pendingCredentialSwitch: {
					schemaVersion: 1,
					requestId: "deferred-resume-1",
					targetCredentialId: "account-crispy",
					targetCredentialDirectory: "/profiles/codex-crispy",
					sourceSessionId: "session-old",
					sourceWorkspaceId: "workspace-1",
					sourceConversationId: conversationId,
					sourceCredentialId: null,
					sourceCreateIdempotencyKey: "create-old",
					sourceCredentialGeneration: null,
					sourceTerminalEpoch: sourceStopFence.terminalEpoch,
					baselineRuntimeRevision: "7",
					baselineTurnCompletedCount: "3",
					panelId: "agent:agent-managed",
					requestedAtMs: 1,
				},
			},
			[codexAccount("crispy")],
		);

		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(mocks.advanceManagedCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "account-crispy",
				credentialDirectory: "/profiles/codex-crispy",
				conversationId,
			}),
			undefined,
		);
		expect(mocks.commitNativeResume).toHaveBeenCalledWith(
			expect.objectContaining({
				launchKind: "resume_new_host",
				targetCredentialId: "account-crispy",
			}),
			expect.any(Object),
			expect.any(Object),
		);
		expect(
			useStore.getState().agents[0].pendingCredentialSwitch,
		).toBeUndefined();
	});

	it("falls back to a real provider-default launch when a credential reference is stale", async () => {
		seedDisconnectedSource(
			"exited",
			managedAgent({
				credentialId: "account-gone",
				runtimeBinding: credentialBinding("account-gone", 9),
			}),
		);
		useStore.setState({ accounts: [] });

		await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		const request = mocks.advanceManagedCreate.mock.calls[0][0];
		expect(request).not.toHaveProperty("credentialId");
		expect(request).not.toHaveProperty("credentialDirectory");
		expect(request).not.toHaveProperty("credentialGeneration");
		expect(mocks.commitNativeResume).toHaveBeenCalledWith(
			expect.objectContaining({ targetCredentialId: null }),
			expect.any(Object),
			expect.any(Object),
		);
	});

	it("does not consult a historical healthy successor before launching a new Host", async () => {
		seedDisconnectedSource("exited", managedAgent());
		const completed = recoveryResult();
		const replacement = {
			...completed.replacement,
			sessionId: "session-durable",
		};
		mocks.executeRecovery.mockResolvedValueOnce({
			...completed,
			createIdempotencyKey: "create-durable",
			replacement,
			backendRouteAuthority: await mocks.resolveRouteAuthority("local"),
			receipt: {
				...completed.receipt,
				replayed: true,
				operationId: "credential-recovery-agent-managed",
				replacementTarget: {
					...completed.receipt.replacementTarget!,
					idempotencyKey: "create-durable",
					sessionId: "session-durable",
				},
				replacementSession: replacement,
			},
		});

		const committed = await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(committed).toMatchObject({
			pane: {
				panelId: "agent:agent-managed",
				sessionId: expect.stringMatching(/^managed_resume_/),
				conversationId,
			},
		});
		expect(mocks.advanceManagedCreate).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].sessionId).toMatch(/^managed_resume_/);
	});

	it("does not consult a historical dead successor before launching a new Host", async () => {
		seedDisconnectedSource("exited", managedAgent());
		mocks.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: ["credential-recovery-agent-managed"],
			sourceGeneration: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				...sourceStopFence,
			},
			currentGeneration: {
				sessionId: "session-dead-successor",
				workspaceId: "workspace-1",
				...replacementStopFence,
			},
			providerId: "codex",
			permissionMode: "bypass_approvals",
			launchIdentity: { conversationId },
		});
		mocks.inspectExistingManagedWriter.mockRejectedValue(
			new Error(
				"existing_managed_writer_unavailable: exact managed Host is not healthy",
			),
		);

		const committed = await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(committed).toMatchObject({
			pane: {
				panelId: "agent:agent-managed",
				sessionId: expect.stringMatching(/^managed_resume_/),
				conversationId,
			},
		});
		expect(mocks.advanceManagedCreate).toHaveBeenCalledOnce();
		expect(mocks.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.resolveManagedRehost).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].sessionId).toMatch(/^managed_resume_/);
	});

	it("keeps exact resume committed when its pane unmounts during handoff", async () => {
		seedDisconnectedSource("exited");
		mocks.resolvePaneById.mockRejectedValueOnce(
			new PaneCommandError("pane_not_found", "pane unmounted"),
		);

		const committed = await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(committed).toMatchObject({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: {
				binding: { sessionId: expect.stringMatching(/^managed_resume_/) },
			},
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: expect.stringMatching(/^managed_resume_/),
			conversationId,
		});
		expect(mocks.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			expect.objectContaining({
				agentId: "agent-managed",
				panelId: "agent:agent-managed",
			}),
		);
	});

	it("resumes without rewriting a legacy pane projection", async () => {
		seedDisconnectedSource("exited");
		const sourceBinding = useStore.getState().agents[0].runtimeBinding;
		if (
			sourceBinding?.runtime !== "hmux_managed_v1" ||
			sourceBinding.source !== "local"
		) {
			throw new Error("test fixture lost managed source authority");
		}
		const { stopFence: _stopFence, ...persistedPaneBinding } = sourceBinding;
		params = {
			agentRef: { agentId: "agent-managed" },
			agentId: "agent-managed",
			binding: persistedPaneBinding,
		};

		const committed = await resumeExactManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
			conversationId,
		);

		expect(committed).toMatchObject({
			presentation: "applied",
			pane: {
				panelId: "agent:agent-managed",
				sessionId: expect.stringMatching(/^managed_resume_/),
				conversationId,
			},
		});
		expect(updateParameters).not.toHaveBeenCalled();
		expect(params.binding).toEqual(persistedPaneBinding);
	});

	it("preflights the explicitly selected conversation for a ready identity-less source", async () => {
		const source = managedAgent({ conversationId: undefined });
		params.binding = source.runtimeBinding;
		useStore.setState({ agents: [source] });
		const inspection = await inspectDisconnected();

		await expect(executeManagedAgentRehost(inspection)).resolves.toMatchObject({
			recovery: expect.any(Object),
		});

		expect(mocks.loadProviderConversationDetails).toHaveBeenCalledWith(
			{
				provider: "codex",
				conversationId,
				executionLocation: "local",
			},
			[],
		);
		expect(mocks.preflightRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId,
				conversationIdentity: undefined,
			}),
		);
	});

	it("refuses a parent-controlled provider conversation before the destructive boundary or successor projection", async () => {
		const childConversationId = "019ff9c5-2046-7703-a36f-75420e9b7536";
		const parentConversationId = "019ff9c0-0013-7e42-957c-19a142414277";
		const source = managedAgent({ conversationId: childConversationId });
		params.binding = source.runtimeBinding;
		useStore.setState({ agents: [source] });
		mocks.loadProviderConversationDetails.mockResolvedValueOnce({
			inputAuthority: {
				kind: "controlled_by_parent",
				parentConversationId,
			},
			subagents: [],
			totalCount: 0,
		});
		const beforeStop = vi.fn();
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		await expect(
			executeManagedAgentRehost(inspection, { beforeStop }),
		).rejects.toMatchObject({
			name: "ProviderConversationInputAuthorityError",
			code: "provider_conversation_controlled_by_parent",
			conversationId: childConversationId,
			parentConversationId,
		});

		expect(mocks.loadProviderConversationDetails).toHaveBeenCalledWith(
			{
				provider: "codex",
				conversationId: childConversationId,
				executionLocation: "local",
			},
			[],
		);
		expect(beforeStop).not.toHaveBeenCalled();
		expect(params.binding).toMatchObject({ sessionId: "session-old" });
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-old",
			conversationId: childConversationId,
		});
	});

	it("validates the target permission policy before the destructive callback", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const beforeStop = vi.fn();
		mocks.preflightRecovery.mockRejectedValueOnce(
			new Error("managed_recovery_exact_resume_unsupported"),
		);

		await expect(
			executeManagedAgentRehost(inspection, {
				permissionMode: "default",
				beforeStop,
			}),
		).rejects.toThrow("managed_recovery_exact_resume_unsupported");
		expect(mocks.preflightRecovery).toHaveBeenCalledWith(
			expect.objectContaining({ skipPermissions: false }),
		);
		expect(beforeStop).not.toHaveBeenCalled();
	});

	it("projects the journal-selected permission mode into the same Agent and pane", async () => {
		const workflowDispatch = {
			schemaVersion: 1 as const,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		useStore.setState({ agents: [managedAgent({ workflowDispatch })] });
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const recovery = {
			...recoveryResult(),
			backendRouteAuthority: {
				schemaVersion: 1 as const,
				profileId: "local",
				revision: `sha256:${"a".repeat(64)}`,
				backend: { id: "backend-local", generation: "generation-1" },
				target: { source: "local" as const, hostId: "local" as const },
			},
		};
		const payload = managedAgentRehostSyncPayload(inspection, { recovery });

		expect(payload.permissionMode).toBe("default");
		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0]).toMatchObject({
			id: "agent-managed",
			sessionId: "session-new",
			skipPermissions: false,
		});
		expect(useStore.getState().agents[0].workflowDispatch).toEqual(
			workflowDispatch,
		);
	});

	it("rebinds a projected Dispatch to the journal-selected successor", async () => {
		const workflowDispatch = {
			schemaVersion: 1 as const,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		useStore.setState({ agents: [managedAgent({ workflowDispatch })] });
		mocks.inspectDispatchSession.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "active_dispatch",
			session: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				providerId: "codex",
				...sourceStopFence,
			},
			target: {
				authority: { workspaceId: "workspace-1" },
				runId: `run.${"a".repeat(64)}`,
				...workflowDispatch,
			},
		});
		mocks.rebindDispatchSession.mockImplementationOnce(async (request) => ({
			schemaVersion: 1,
			operationId: request.operationId,
			outcome: "rebound",
			source: request.source,
			target: request.target,
			runId: `run.${"a".repeat(64)}`,
			taskId: workflowDispatch.taskId,
			dispatchId: workflowDispatch.dispatchId,
			generation: workflowDispatch.generation,
		}));
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		const execution = await executeManagedAgentRehost(inspection);

		expect(mocks.inspectDispatchSession).toHaveBeenCalledWith({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			providerId: "codex",
			...sourceStopFence,
		});
		expect(mocks.rebindDispatchSession).toHaveBeenCalledWith({
			schemaVersion: 1,
			operationId: "rehost-operation-1",
			source: expect.objectContaining({
				sessionId: "session-old",
				terminalEpoch: "terminal-old",
			}),
			target: expect.objectContaining({
				sessionId: "session-new",
				terminalEpoch: "terminal-new",
			}),
			reboundAtMs: expect.any(Number),
		});
		expect(execution).toMatchObject({
			dispatch: {
				outcome: "rebound",
				dispatchId: workflowDispatch.dispatchId,
			},
		});
	});

	it("does not inspect service lineage without a client Dispatch projection", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		const execution = await executeManagedAgentRehost(inspection);

		expect(mocks.inspectDispatchSession).not.toHaveBeenCalled();
		expect(mocks.rebindDispatchSession).not.toHaveBeenCalled();
		expect(execution.dispatch).toBeUndefined();
	});

	it("allows a completed projected Dispatch to rehost without inventing an assignment", async () => {
		const workflowDispatch = {
			schemaVersion: 1 as const,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		useStore.setState({ agents: [managedAgent({ workflowDispatch })] });
		mocks.inspectDispatchSession.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "unassigned",
			session: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				providerId: "codex",
				...sourceStopFence,
			},
		});
		mocks.rebindDispatchSession.mockImplementationOnce(async (request) => ({
			schemaVersion: 1,
			operationId: request.operationId,
			outcome: "unassigned",
			source: request.source,
			target: request.target,
		}));
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		await expect(executeManagedAgentRehost(inspection)).resolves.toMatchObject({
			recovery: expect.any(Object),
		});
		expect(mocks.rebindDispatchSession).toHaveBeenCalledOnce();
	});

	it("refuses to publish a replacement that omitted its durable stop fence", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const invalid = recoveryResult();
		delete invalid.replacement.stopFence;

		expect(() =>
			managedAgentRehostSyncPayload(inspection, { recovery: invalid }),
		).toThrowError(expect.objectContaining({ code: "pane_changed" }));
	});

	it("applies a completed rehost after the optional source fence changed", async () => {
		const payload = await preparedRehostPayload();
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => {
				if (agent.runtimeBinding?.runtime !== "hmux_managed_v1") return agent;
				return {
					...agent,
					worktreePath: "/repo/presentation-moved",
					runtimeBinding: {
						...agent.runtimeBinding,
						stopFence: {
							...sourceStopFence,
							hostInstanceId: "host-rebound",
							terminalEpoch: "terminal-rebound",
						},
					},
				};
			}),
		}));

		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			worktreePath: "/repo/presentation-moved",
		});
		expect(useStore.getState().sessionCwd["session-new"]).toBe(
			"/repo/presentation-moved",
		);
	});

	it("converges a drifted third runtime identity onto the committed successor", async () => {
		// An active backend commit converges its drifted local projection.
		const payload = await preparedRehostPayload();
		retargetManagedSource();

		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
	});

	it("re-adopts the receipt even over a newer reused target identity", async () => {
		const payload = await preparedRehostPayload();
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				sessionId: payload.binding.sessionId,
				runtimeBinding: {
					...payload.binding,
					createIdempotencyKey: "newer-create",
					stopFence: {
						...replacementStopFence,
						hostInstanceId: "host-newer",
						terminalEpoch: "terminal-newer",
					},
				},
			})),
		}));

		// Only the active commit projects directly; notifications re-read storage.
		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
			createIdempotencyKey: payload.binding.createIdempotencyKey,
		});
	});

	it("does not let pane lookup reclassify a committed runtime transaction", async () => {
		const payload = await preparedRehostPayload();
		retargetSourceDuringPaneResolution();

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({
			projection: "pending",
			presentation: "pending",
			pane: null,
			payload: { binding: { sessionId: "session-new" } },
		});
		expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].sessionId).toBe("session-third");
		expect(setActive).not.toHaveBeenCalled();
		expect(updateParameters).not.toHaveBeenCalled();
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
	});

	it("reports applied presentation when the canonical pane is mounted", async () => {
		const payload = await preparedRehostPayload();

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({
			projection: "applied",
			presentation: "applied",
			pane: { sessionId: "session-new" },
		});
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("commits an exact source when its mutable permission projection is stale", async () => {
		const payload = await preparedRehostPayload();
		useStore.setState({ skipPermissions: { codex: false } });

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
	});

	it("commits the Agent projection while its presentation pane is unmounted", async () => {
		const payload = await preparedRehostPayload();
		panelPresent = false;

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: { binding: { sessionId: "session-new" } },
		});
		expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("does not invoke a pane runtime writer during receipt commit", async () => {
		const payload = await preparedRehostPayload();
		updateParameters.mockImplementationOnce(() => {
			throw new Error("pane update failed");
		});

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("ignores a different legacy pane binding during receipt commit", async () => {
		const payload = await preparedRehostPayload();
		params = {
			agentRef: { agentId: "agent-managed" },
			agentId: "agent-managed",
			binding: {
				...managedAgent().runtimeBinding,
				sessionId: "session-third",
			},
		};

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(updateParameters).not.toHaveBeenCalled();
		expect(params.binding).toMatchObject({ sessionId: "session-third" });
	});

	it("converges a target pane when the Agent projection still has the source", async () => {
		const payload = await preparedRehostPayload();
		params = {
			agentRef: { agentId: "agent-managed" },
			agentId: payload.agentId,
			binding: payload.binding,
		};

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("replays an exact target when its mutable permission projection is stale", async () => {
		const payload = await preparedRehostPayload();
		await commitManagedAgentRehostReceipt(payload);
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				skipPermissions: true,
			})),
		}));

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(mocks.commitNativeRehost).toHaveBeenCalledTimes(2);
	});

	it("replays an exact target after its display name changes", async () => {
		const payload = await preparedRehostPayload();
		await commitManagedAgentRehostReceipt(payload);
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				name: "renamed-after-hmux-effect",
			})),
		}));

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(useStore.getState().agents[0].name).toBe(
			"renamed-after-hmux-effect",
		);
	});

	it("commits the successor even when the source conversation drifted", async () => {
		const payload = await preparedRehostPayload();
		useStore.setState((state) => ({
			agents: state.agents.map((agent) =>
				agent.id === "agent-managed"
					? { ...agent, conversationId: "conversation-other" }
					: agent,
			),
		}));

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
	});

	it("converges a conversation that changes during backend commit", async () => {
		const payload = await preparedRehostPayload();
		const nativeCommit = mocks.commitNativeRehost.getMockImplementation();
		if (!nativeCommit) throw new Error("native commit fixture missing");
		mocks.commitNativeRehost.mockImplementationOnce(async (...args) => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) =>
					agent.id === payload.agentId
						? { ...agent, conversationId: "conversation-newer" }
						: agent,
				),
			}));
			return nativeCommit(...args);
		});

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ projection: "applied" });
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
	});

	it("runs an async automatic race fence before entering the backend transaction", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const beforeStop = vi
			.fn()
			.mockRejectedValue(new Error("automatic_managed_rehost_no_longer_idle"));

		await expect(
			executeManagedAgentRehost(inspection, { beforeStop }),
		).rejects.toThrow("automatic_managed_rehost_no_longer_idle");

		expect(beforeStop).toHaveBeenCalledOnce();
		expect(mocks.preflightRecovery).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("runs the local ordering callback after preflight for first admission", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const beforeStop = vi.fn();

		await executeManagedAgentRehost(inspection, {
			beforeStop,
		});

		expect(mocks.preflightRecovery.mock.invocationCallOrder[0]).toBeLessThan(
			beforeStop.mock.invocationCallOrder[0],
		);
	});

	it("can CAS an unattended off-screen receipt without selecting its pane", async () => {
		const payload = await preparedRehostPayload();

		const synchronized = await commitManagedAgentRehostReceipt(payload, {
			activate: false,
		});

		expect(synchronized?.pane?.sessionId).toBe("session-new");
		expect(updateParameters).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
	});

	it("recovers a stale managed source without stopping a reused or absent pid", async () => {
		mocks.preflightRecovery.mockRejectedValueOnce(
			new Error(
				"conversation_identity_source_unavailable: managed Host is not healthy",
			),
		);
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const execution = await executeUnavailableManagedAgentRecovery(inspection);
		const payload = managedAgentRehostSyncPayload(inspection, execution);
		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "agent-managed",
				sessionId: "session-old",
				conversationId,
			}),
			expect.objectContaining({
				columns: 120,
				rows: 30,
				confirmed: true,
				preflighted: true,
				prepareFirstAdmission: expect.any(Function),
			}),
		);
		expect(synchronized?.pane).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
	});

	it("recovers the exact conversation when the active Dispatch supersedes a stale projection", async () => {
		const projectedDispatch = {
			schemaVersion: 1 as const,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		const activeDispatch = {
			authority: { workspaceId: "workspace-1" },
			runId: `run.${"b".repeat(64)}`,
			taskId: `task.${"b".repeat(64)}`,
			dispatchId: `dispatch.${"b".repeat(64)}`,
			generation: 2,
		};
		seedDisconnectedSource(
			"exited",
			managedAgent({ workflowDispatch: projectedDispatch }),
		);
		mocks.inspectDispatchSession.mockResolvedValueOnce({
			schemaVersion: 1,
			outcome: "active_dispatch",
			session: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				providerId: "codex",
				...sourceStopFence,
			},
			target: activeDispatch,
		});
		mocks.rebindDispatchSession.mockImplementationOnce(async (request) => ({
			schemaVersion: 1,
			operationId: request.operationId,
			outcome: "rebound",
			source: request.source,
			target: request.target,
			runId: activeDispatch.runId,
			taskId: activeDispatch.taskId,
			dispatchId: activeDispatch.dispatchId,
			generation: activeDispatch.generation,
		}));

		const inspection = await inspectDisconnected();
		const execution = await executeUnavailableManagedAgentRecovery(inspection);
		const payload = managedAgentRehostSyncPayload(inspection, execution);
		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(synchronized?.pane).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
		expect(mocks.rebindDispatchSession).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].workflowDispatch).toEqual({
			schemaVersion: 1,
			taskId: activeDispatch.taskId,
			dispatchId: activeDispatch.dispatchId,
			generation: activeDispatch.generation,
		});

		const newerProjection = {
			schemaVersion: 1 as const,
			taskId: `task.${"c".repeat(64)}`,
			dispatchId: `dispatch.${"c".repeat(64)}`,
			generation: 3,
		};
		useStore.setState((state) => ({
			agents: state.agents.map((agent) =>
				agent.id === "agent-managed"
					? { ...agent, workflowDispatch: newerProjection }
					: agent,
			),
		}));
		// Replay converges too — a newer projection is re-adopted by the next
		// backend reconcile rather than vetoing the receipt here.
		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0].workflowDispatch).toEqual({
			schemaVersion: 1,
			taskId: activeDispatch.taskId,
			dispatchId: activeDispatch.dispatchId,
			generation: activeDispatch.generation,
		});
	});

	it("uses the stored exact conversation when the source provider is unavailable", async () => {
		seedDisconnectedSource(
			"unavailable",
			managedAgent({
				conversationIdentity: {
					state: "unavailable",
					code: "conversation_identity_timeout",
					detail: "provider is disconnected",
				},
			}),
		);

		const inspection = await inspectManagedAgentRehost("hebbian-frontend");

		expect(inspection.conversationId).toBe(conversationId);
		expect(mocks.ensureConversationIdentity).not.toHaveBeenCalled();
		expect(mocks.inspectConversationIdentity).not.toHaveBeenCalled();
		expect(mocks.planRecovery).toHaveBeenCalledOnce();
	});

	it("converges a reboot replacement with the exact pre-stop backend route recovered from its journal", async () => {
		const agent = useStore.getState().agents[0];
		if (
			agent.runtimeBinding?.runtime !== "hmux_managed_v1" ||
			agent.runtimeBinding.source !== "local"
		) {
			throw new Error("test fixture lost managed binding");
		}
		const backendRouteAuthority = {
			schemaVersion: 1 as const,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend-local", generation: "generation-1" },
			target: { source: "local" as const, hostId: "local" as const },
		};
		const payload = managedRebootRecoverySyncPayload(
			agent,
			agent.runtimeBinding,
			{ ...recoveryResult(), backendRouteAuthority },
			"desktop-1",
			"agent:agent-managed",
		);
		mocks.commitNativeRehost.mockResolvedValueOnce(undefined);

		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(payload.backendRouteAuthority).toEqual(backendRouteAuthority);
		expect(synchronized?.pane).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			conversationId,
			runtimeBinding: { sessionId: "session-new" },
		});
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.commitNativeRehost).toHaveBeenCalledWith(
			payload,
			backendRouteAuthority,
			expect.any(Object),
		);
		expect(mocks.ensureCoordinatorBinding).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-managed",
				sessionId: "session-new",
			}),
		);
	});

	it("projects a fresh successor for a typed unmanaged native backend", async () => {
		const exact = await preparedRehostPayload();
		const payload = {
			...exact,
			launchKind: "fresh" as const,
			permissionMode: "default" as const,
			conversationId: null,
			targetCredentialId: null,
		};
		mocks.commitNativeRehost.mockResolvedValueOnce(undefined);

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });

		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			conversationId: undefined,
		});
		expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
	});

	it("replays a fresh precommit payload after Control Plane refines its conversation", async () => {
		const exact = await preparedRehostPayload();
		const routeAuthority = {
			schemaVersion: 1 as const,
			profileId: "local",
			revision: `sha256:${"c".repeat(64)}`,
			backend: { id: "backend-fresh", generation: "generation-fresh" },
			target: { source: "local" as const, hostId: "local" },
		};
		mocks.resolveRouteAuthority.mockResolvedValueOnce(routeAuthority);
		const payload = {
			...exact,
			backendRouteAuthority: undefined,
			launchKind: "fresh" as const,
			permissionMode: "default" as const,
			conversationId: null,
			targetCredentialId: null,
		};
		const receipt = await mocks.commitNativeRehost(payload, routeAuthority);
		receipt.providerConversationRef = "conversation-live";
		mocks.commitNativeRehost.mockClear().mockResolvedValue(receipt);

		const first = await commitManagedAgentRehostReceipt(payload);

		expect(first).toMatchObject({
			pane: { conversationId: "conversation-live" },
			payload: {
				launchKind: "fresh",
				conversationId: "conversation-live",
				backendRouteAuthority: routeAuthority,
			},
		});
		mocks.resolveRouteAuthority.mockClear();
		mocks.resolveRouteAuthority.mockResolvedValue({
			...routeAuthority,
			revision: `sha256:${"d".repeat(64)}`,
			backend: { id: "backend-other", generation: "generation-other" },
		});
		const replay = await commitManagedAgentRehostReceipt(first?.payload);
		expect(replay).toMatchObject({
			pane: { conversationId: "conversation-live" },
			payload: {
				launchKind: "fresh",
				conversationId: "conversation-live",
				backendRouteAuthority: routeAuthority,
			},
		});
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
		expect(mocks.commitNativeRehost).toHaveBeenLastCalledWith(
			expect.objectContaining({ backendRouteAuthority: routeAuthority }),
			routeAuthority,
			expect.any(Object),
		);
		expect(useStore.getState().agents[0].conversationId).toBe(
			"conversation-live",
		);
		expect(mocks.commitNativeRehost).toHaveBeenCalledTimes(2);
	});

	it("CAS-recovers an exited legacy Agent with an explicit conversation", async () => {
		const source = managedAgent({ conversationId: undefined });
		params.binding = source.runtimeBinding;
		seedDisconnectedSource("exited", source);
		const inspection = await inspectDisconnected();
		const execution = await executeUnavailableManagedAgentRecovery(inspection);
		const payload = managedAgentRehostSyncPayload(inspection, execution);
		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(inspection).toMatchObject({
			sourceLifecycle: "exited",
			sourceConversationId: undefined,
			conversationId,
			plan: {
				action: "replace_ai_provider_with_explicit_conversation",
				reason: "update_requires_confirmation",
				requiresConfirmation: true,
			},
		});
		expect(payload.sourceConversationId).toBeNull();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(synchronized?.pane).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
	});

	it("keeps a missing pane presentation-only after exact exited recovery", async () => {
		panelPresent = false;
		seedDisconnectedSource("exited");
		mocks.resolvePaneReference.mockImplementation(() =>
			panelPresent
				? Promise.resolve(paneReference())
				: Promise.reject(
						new PaneCommandError(
							"pane_not_found",
							"no pane owns session session-old",
						),
					),
		);

		const inspection = await inspectDisconnected();
		const execution = await executeUnavailableManagedAgentRecovery(inspection);
		const payload = managedAgentRehostSyncPayload(inspection, execution);
		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(inspection).toMatchObject({
			sourceLifecycle: "exited",
			sourcePaneState: "absent",
			desktopId: "desktop-1",
			panelId: "agent:agent-managed",
		});
		expect(payload.sourcePaneState).toBe("absent");
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		expect(synchronized).toMatchObject({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: { binding: { sessionId: "session-new" } },
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			conversationId,
		});
		expect(setActive).not.toHaveBeenCalled();
	});

	it("executes recovery when no desktop can materialize its pane", async () => {
		panelPresent = false;
		seedDisconnectedSource("exited");
		mocks.resolvePaneReference.mockRejectedValue(
			new PaneCommandError(
				"pane_not_found",
				"no pane owns session session-old",
			),
		);
		mocks.getDockview.mockReturnValue(undefined);

		const inspection = await inspectDisconnected();

		await expect(
			executeUnavailableManagedAgentRecovery(inspection),
		).resolves.toMatchObject({ recovery: { replacement: expect.any(Object) } });
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-old",
			conversationId: undefined,
		});
	});

	it("leaves a live-source race to the backend generation fence", async () => {
		const inspection = await inspectDisconnected();
		await executeUnavailableManagedAgentRecovery(inspection);

		expect(mocks.planRecovery).toHaveBeenCalledOnce();
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("inspects an unavailable source with one explicitly selected conversation", async () => {
		seedDisconnectedSource("unavailable");

		const inspection = await inspectDisconnected();

		expect(inspection).toMatchObject({
			sourceLifecycle: "unavailable",
			sourceConversationId: undefined,
			conversationId,
		});
		expect(mocks.planRecovery).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it.each([undefined, true] as const)(
		"recovers exact selection with socket-owner guard %s",
		async (requireSocketOwnerAbsent) => {
			useStore.setState({
				agents: [
					managedAgent({
						conversationId: undefined,
						conversationIdentity: {
							state: "pending",
							code: "conversation_identity_required",
							detail: "Claude live session is not available yet",
						},
					}),
				],
			});
			mocks.listSessions.mockResolvedValueOnce([sourceSummary("unavailable")]);

			const inspection = await inspectDisconnected();
			await executeUnavailableManagedAgentRecovery(inspection, {
				requireSocketOwnerAbsent,
			});

			expect(mocks.preflightRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId,
					conversationIdentity: undefined,
				}),
			);
			expect(mocks.executeRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId,
					conversationIdentity: undefined,
				}),
				expect.objectContaining({
					preflighted: true,
					requireSocketOwnerAbsent,
				}),
			);
		},
	);

	it("inspects an unavailable source without making its pane authoritative", async () => {
		panelPresent = false;
		seedDisconnectedSource("unavailable");

		await expect(inspectDisconnected()).resolves.toMatchObject({
			sourceLifecycle: "unavailable",
			sourcePaneState: "absent",
			desktopId: "desktop-1",
		});
		expect(mocks.planRecovery).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("continues past a drifted fenced conversation instead of dying", async () => {
		// Drift is logged, not fatal (owner decision 2026-09-01) — the backend
		// stop-fence CAS is the real destructive guard.
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		useStore.setState({
			agents: [
				managedAgent({
					conversationId: "different-conversation",
				}),
			],
		});

		await expect(executeManagedAgentRehost(inspection)).resolves.toBeTruthy();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("continues past a drifted managed credential fence", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const original = managedAgent();
		if (
			original.runtimeBinding?.runtime !== "hmux_managed_v1" ||
			original.runtimeBinding.source !== "local"
		) {
			throw new Error("test fixture lost managed binding");
		}
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: {
						...original.runtimeBinding,
						credentialGeneration: 2,
					},
				}),
			],
		});

		await expect(executeManagedAgentRehost(inspection)).resolves.toBeTruthy();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("recovers under combined drift and orchestration outage (resilience contract)", async () => {
		// Structural guard for the recovery path (owner decision 2026-09-01):
		// resume must complete even when everything advisory goes wrong at
		// once — renamed agent, moved conversation, rejected lineage store,
		// timed-out rebind. Only the backend transaction itself may fail a
		// recovery. If a future change makes this test fail, it added a veto
		// to the recovery path; remove the veto, not this test.
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		mocks.inspectDispatchSession.mockRejectedValue(
			new Error("orchestration store rejected the operation"),
		);
		mocks.rebindDispatchSession.mockRejectedValue(
			new Error("backend request deadline exceeded"),
		);
		useStore.setState({
			agents: [
				managedAgent({
					name: "renamed-mid-flight",
					conversationId: "different-conversation",
					worktreePath: "/repo/moved-elsewhere",
				}),
			],
		});

		await expect(executeManagedAgentRehost(inspection)).resolves.toBeTruthy();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("fails provider preflight before stopping the source", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		mocks.preflightRecovery.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);

		await expect(executeManagedAgentRehost(inspection)).rejects.toThrow(
			"provider unavailable",
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("keeps the source binding retryable when replacement fails after stop", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		mocks.executeRecovery.mockRejectedValueOnce(
			new Error("replacement unavailable"),
		);

		await expect(executeManagedAgentRehost(inspection)).rejects.toThrow(
			"replacement unavailable",
		);
		expect(useStore.getState().agents[0].sessionId).toBe("session-old");
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(updateParameters).not.toHaveBeenCalled();

		const execution = await executeManagedAgentRehost(inspection);
		await expect(
			commitManagedAgentRehostReceipt(
				managedAgentRehostSyncPayload(inspection, execution),
			),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("accepts a journaled replacement before changed client hints can block replay", async () => {
		const inspection = await inspectManagedAgentRehost("hebbian-frontend");
		const recovered = recoveryResult();
		mocks.executeRecovery.mockResolvedValueOnce(recovered);
		useStore.setState((current) => ({
			agents: current.agents.map((agent) => ({
				...agent,
				conversationId: undefined,
				runtimeBinding:
					agent.runtimeBinding?.runtime === "hmux_managed_v1"
						? {
								...agent.runtimeBinding,
								stopFence: undefined,
							}
						: agent.runtimeBinding,
			})),
		}));

		await expect(executeManagedAgentRehost(inspection)).resolves.toMatchObject({
			recovery: recovered,
		});
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0].sessionId).toBe("session-old");
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("replays an already-applied pane handoff without a second mutation", async () => {
		const payload = await preparedRehostPayload();

		await commitManagedAgentRehostReceipt(payload);
		updateParameters.mockClear();
		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("leaves Agent and pane untouched when backend convergence refuses", async () => {
		const payload = await preparedRehostPayload();
		mocks.commitNativeRehost.mockRejectedValueOnce(
			new Error("backend temporarily unavailable"),
		);

		await expect(commitManagedAgentRehostReceipt(payload)).rejects.toThrow(
			"backend temporarily unavailable",
		);
		expect(useStore.getState().agents[0].sessionId).toBe("session-old");
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(updateParameters).not.toHaveBeenCalled();

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(mocks.commitNativeRehost).toHaveBeenCalledTimes(2);
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
	});

	it("returns durable success without a pane runtime repair writer", async () => {
		const payload = await preparedRehostPayload();
		updateParameters.mockImplementationOnce(() => {
			throw new Error("fault injection: DockView update failed");
		});

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({
			pane: { sessionId: "session-new" },
			payload: { operationId: payload.operationId },
		});
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(params).toEqual({ agentRef: { agentId: "agent-managed" } });
		expect(updateParameters).not.toHaveBeenCalled();

		await expect(
			commitManagedAgentRehostReceipt(payload),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("ignores a stale pane lineage that does not reach the selected Agent generation", async () => {
		const sourceBinding = managedAgent().runtimeBinding;
		if (
			sourceBinding?.runtime !== "hmux_managed_v1" ||
			sourceBinding.source !== "local"
		) {
			throw new Error("test requires a local managed source binding");
		}
		const targetBinding = managedBindingFixture({
			sessionId: "session-current",
			workspaceId: sourceBinding.workspaceId,
			createIdempotencyKey: "create-current",
			stopFence: replacementStopFence,
		});
		const abandonedStopFence = stopFenceFixture({
			runnerPrincipal: "principal-abandoned",
			runnerInstance: "runner-abandoned",
			channelEpoch: "9",
			hostInstanceId: "host-abandoned",
			terminalEpoch: "terminal-abandoned",
		});
		useStore.setState({
			agents: [
				managedAgent({
					sessionId: targetBinding.sessionId,
					runtimeBinding: targetBinding,
				}),
			],
			sessionCwd: { [targetBinding.sessionId]: "/repo/worktree" },
		});
		params = { agentRef: { agentId: "agent-managed" }, agentId: "agent-managed", binding: sourceBinding };
		mocks.resolveManagedRehost.mockImplementation(
			async (sessionId: string, workspaceId: string) =>
				sessionId === targetBinding.sessionId
					? {
							schema: "hmux-managed-rehost-resolution-v1" as const,
							schemaVersion: 1 as const,
							state: "not_found" as const,
							source: { sessionId, workspaceId },
						}
					: {
							schema: "hmux-managed-rehost-resolution-v1" as const,
							schemaVersion: 1 as const,
							state: "resolved" as const,
							operationIds: ["rehost-operation-abandoned"],
							sourceGeneration: {
								sessionId: sourceBinding.sessionId,
								workspaceId: sourceBinding.workspaceId,
								...sourceStopFence,
							},
							currentGeneration: {
								sessionId: "session-abandoned",
								workspaceId: sourceBinding.workspaceId,
								...abandonedStopFence,
							},
							providerId: "codex" as const,
							permissionMode: "bypass_approvals" as const,
						},
		);
		mocks.inspectExistingManagedWriter.mockRejectedValue(
			new Error(
				"existing_managed_writer_unavailable: exact managed Host is not healthy",
			),
		);

		await expect(
			reconcileManagedAgentRehost("agent-managed", "agent:agent-managed"),
		).resolves.toBeNull();

		expect(mocks.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
		expect(params.binding).toMatchObject({
			sessionId: sourceBinding.sessionId,
		});
		expect(useStore.getState().agents[0].sessionId).toBe(
			targetBinding.sessionId,
		);
	});

	it("idempotently rebinds Dispatch on the recovered exact route during restart reconciliation", async () => {
		const sourceDispatch = {
			schemaVersion: 1 as const,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		const targetDispatch = {
			runId: `run.${"b".repeat(64)}`,
			taskId: `task.${"b".repeat(64)}`,
			dispatchId: `dispatch.${"b".repeat(64)}`,
			generation: 2,
		};
		useStore.setState({
			agents: [managedAgent({ workflowDispatch: sourceDispatch })],
		});
		const backendRouteAuthority = {
			schemaVersion: 1 as const,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend-local", generation: "generation-1" },
			target: { source: "local" as const, hostId: "local" as const },
		};
		mocks.reconcileRecovery.mockResolvedValueOnce({
			...recoveryResult(),
			backendRouteAuthority,
		});
		mocks.rebindDispatchSession.mockImplementationOnce(async (request) => ({
			schemaVersion: 1,
			operationId: request.operationId,
			outcome: "rebound",
			source: request.source,
			target: request.target,
			...targetDispatch,
		}));

		const reconciliation = await reconcileManagedAgentRehost(
			"agent-managed",
			"agent:agent-managed",
		);

		expect(reconciliation?.payload.dispatchProjection).toEqual({
			source: sourceDispatch,
			target: {
				schemaVersion: 1,
				taskId: targetDispatch.taskId,
				dispatchId: targetDispatch.dispatchId,
				generation: targetDispatch.generation,
			},
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-old",
			workflowDispatch: sourceDispatch,
		});
		expect(mocks.rebindDispatchSession).toHaveBeenCalledOnce();
		expect(mocks.ensureCoordinatorBinding).not.toHaveBeenCalled();
	});

	it("projects the final writer after multiple durable rehosts", async () => {
		const finalStopFence = stopFenceFixture({
			runnerPrincipal: "principal-final",
			runnerInstance: "runner-final",
			channelEpoch: "9",
			hostInstanceId: "host-final",
			terminalEpoch: "terminal-final",
		});
		const resolution = {
			schema: "hmux-managed-rehost-resolution-v1" as const,
			schemaVersion: 1 as const,
			state: "resolved" as const,
			operationIds: ["rehost-operation-1", "rehost-operation-2"],
			sourceGeneration: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				...sourceStopFence,
			},
			currentGeneration: {
				sessionId: "session-final",
				workspaceId: "workspace-1",
				...finalStopFence,
			},
			providerId: "codex" as const,
			permissionMode: "bypass_approvals" as const,
		};
		mocks.resolveManagedRehost.mockResolvedValue(resolution);
		mocks.inspectExistingManagedWriter.mockResolvedValue({
			session: {
				sessionId: "session-final",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				health: "healthy",
				inputAllowed: true,
				detachOnly: false,
				terminalEpoch: finalStopFence.terminalEpoch,
				stopFence: finalStopFence,
				outputSeq: "12",
				capabilities: [],
			},
			idempotencyKey: "create-final",
			conversationId,
			permissionMode: "bypass_approvals",
		});
		mocks.reconcileRecovery.mockRejectedValue(
			new Error("the first receipt is no longer the final writer"),
		);

		const reconciliation = await reconcileManagedAgentRehost(
			"agent-managed",
			"agent:agent-managed",
		);

		expect(reconciliation).toMatchObject({
			payload: {
				operationId: "rehost-operation-2",
				sourceBinding: { sessionId: "session-old" },
				binding: {
					sessionId: "session-final",
					createIdempotencyKey: "create-final",
					stopFence: finalStopFence,
				},
			},
			replacement: { sessionId: "session-final" },
			conversationId,
		});
		expect(mocks.reconcileRecovery).not.toHaveBeenCalled();
		expect(mocks.resolveManagedRehost).toHaveBeenCalledTimes(2);
	});

	it("publishes successor metadata even when the Agent fence drifted", async () => {
		const payload = await preparedRehostPayload();
		const replacement = recoveryResult().replacement;
		retargetManagedSource();

		await expect(
			commitReconciledManagedAgentRehostReceipt({
				payload,
				replacement,
				conversationId,
			}),
		).resolves.toMatchObject({
			payload: { binding: { sessionId: "session-new" } },
		});
		expect(
			useStore.getState().hmuxSessionMetadata[
				hmuxSessionMetadataKey(replacement.workspaceId, replacement.sessionId)
			],
		).toBeTruthy();
		expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
	});

	it("keeps a reconciled durable success when a third Agent generation wins", async () => {
		let finishReconcile!: (result: ManagedAgentRecoveryResult) => void;
		mocks.reconcileRecovery.mockReturnValueOnce(
			new Promise((resolve) => {
				finishReconcile = resolve;
			}),
		);
		const reconciliation = reconcileManagedAgentRehost(
			"agent-managed",
			"agent:agent-managed",
		);
		await vi.waitFor(() =>
			expect(mocks.reconcileRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: "session-old",
					workspaceId: "workspace-1",
				}),
			),
		);
		const thirdBinding = managedAgent().runtimeBinding;
		if (
			thirdBinding?.runtime !== "hmux_managed_v1" ||
			thirdBinding.source !== "local"
		) {
			throw new Error("test requires a local managed binding");
		}
		useStore.setState((state) => ({
			agents: state.agents.map((agent) =>
				agent.id === "agent-managed"
					? {
							...agent,
							sessionId: "session-third",
							runtimeBinding: {
								...thirdBinding,
								sessionId: "session-third",
								createIdempotencyKey: "create-third",
							},
						}
					: agent,
			),
		}));
		finishReconcile(recoveryResult());

		await expect(reconciliation).resolves.toMatchObject({
			recovery: { replacement: { sessionId: "session-new" } },
		});
		expect(useStore.getState().agents[0].sessionId).toBe("session-third");
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it("synchronizes another WebView store without touching its DockView", async () => {
		const payload = await preparedRehostPayload();
		useStore.setState((current) => ({
			agents: current.agents.map((agent) => ({
				...agent,
				pendingCredentialSwitch: {
					requestId: "pending-before-rehost",
				} as Agent["pendingCredentialSwitch"],
			})),
		}));

		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0].sessionId).toBe("session-new");
		expect(
			useStore.getState().agents[0].pendingCredentialSwitch,
		).toBeUndefined();
		expect(updateParameters).not.toHaveBeenCalled();
		expect(setActive).not.toHaveBeenCalled();
	});

	it("switches credentials from the stored exact conversation without reinspection", async () => {
		seedAgentWithAccounts(
			{
				accountId: "account-canonical",
				credentialId: "account-canonical",
				conversationIdentity: {
					state: "unavailable",
					code: "conversation_identity_timeout",
					detail: "exact identity was not observed after 40 attempts",
				},
				runtimeBinding: credentialBinding("account-canonical"),
			},
			[codexAccount("canonical"), codexAccount("crispy")],
		);
		mocks.inspectConversationIdentity.mockRejectedValue(
			new Error("conversation_identity_timeout: inspection unavailable"),
		);

		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);
		expect(inspection).toMatchObject({
			conversationId,
			sourceCredentialId: "account-canonical",
			targetCredentialId: "account-crispy",
		});
		expect(mocks.inspectConversationIdentity).not.toHaveBeenCalled();
		expect(mocks.planRecovery).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();

		const execution = await executeManagedAgentCredentialSwitch(inspection);
		expect(mocks.preflightRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				accountId: "account-crispy",
				credentialId: "account-crispy",
				runtimeBinding: expect.objectContaining({
					sessionId: "session-old",
					credentialId: "account-crispy",
				}),
			}),
			expect.objectContaining({
				id: "account-crispy",
				dir: "/profiles/codex-crispy",
			}),
		);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId,
				worktreePath: "/repo/worktree",
				credentialId: "account-crispy",
			}),
			expect.objectContaining({
				columns: 120,
				rows: 30,
				confirmed: true,
				preflighted: true,
				credentialAccount: expect.objectContaining({
					id: "account-crispy",
					dir: "/profiles/codex-crispy",
				}),
			}),
		);

		const payload = managedAgentCredentialSwitchSyncPayload(
			inspection,
			execution,
		);
		mocks.commitNativeRehost.mockResolvedValueOnce(undefined);
		await commitManagedAgentRehostReceipt(payload);
		expect(mocks.ensureCoordinatorBinding).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-managed",
				sessionId: "session-new",
			}),
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: "session-new",
			worktreePath: "/repo/worktree",
			conversationId,
			pendingCmd: undefined,
			accountId: "account-crispy",
			credentialId: "account-crispy",
			runtimeBinding: {
				sessionId: "session-new",
				credentialId: "account-crispy",
			},
		});

		const mismatchedPayload = {
			...payload,
			binding: {
				...payload.binding,
				credentialId: "account-canonical",
			},
		};
		expect(
			parseManagedAgentRehostSyncPayload(mismatchedPayload),
		).toBeUndefined();
	});

	it("projects the credential committed by Control Plane over a stale candidate", async () => {
		seedAgentWithAccounts(
			{
				accountId: "account-canonical",
				credentialId: "account-canonical",
				runtimeBinding: credentialBinding("account-canonical"),
			},
			[codexAccount("canonical"), codexAccount("crispy")],
		);
		const payload = await preparedCredentialSwitchPayload("account-crispy");
		mocks.commitNativeRehost.mockResolvedValueOnce({
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-canonical",
				credential_generation: "generation-canonical",
			},
			providerConversationRef: conversationId,
			launchSelection: { permissionMode: "default" },
		});

		const synchronized = await commitManagedAgentRehostReceipt(payload);

		expect(synchronized?.payload).toMatchObject({
			targetCredentialId: "account-canonical",
			binding: { credentialId: "account-canonical" },
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			accountId: "account-canonical",
			credentialId: "account-canonical",
			runtimeBinding: { credentialId: "account-canonical" },
		});
		expect(updateParameters).not.toHaveBeenCalled();
	});

	it.each(["agent:agent-managed", "pane:stable-slot"])("rebuilds an interrupted credential switch from %s only after the exact source exited", async (panelId) => {
		seedAgentWithAccounts(
			{
				accountId: "account-canonical",
				credentialId: "account-canonical",
				runtimeBinding: credentialBinding("account-canonical"),
			},
			[codexAccount("crispy")],
		);
		const intent = {
			schemaVersion: 1 as const,
			requestId: "switch-1",
			targetCredentialId: "account-crispy",
			targetCredentialDirectory: "/profiles/codex-crispy",
			sourceSessionId: "session-old",
			sourceWorkspaceId: "workspace-1",
			sourceConversationId: conversationId,
			sourceCredentialId: "account-canonical",
			sourceCreateIdempotencyKey: "create-old",
			sourceCredentialGeneration: null,
			sourceTerminalEpoch: "terminal-old",
			baselineRuntimeRevision: "4",
			baselineTurnCompletedCount: "2",
			completionRuntimeRevision: "5",
			completionTurnCompletedCount: "3",
			panelId,
			requestedAtMs: 1,
		};

		await expect(
			inspectInterruptedManagedAgentCredentialSwitch("agent-managed", intent),
		).rejects.toThrow("source is still live");
		mocks.listSessions.mockResolvedValueOnce([sourceSummary("exited")]);
		await expect(
			inspectInterruptedManagedAgentCredentialSwitch("agent-managed", intent),
		).resolves.toMatchObject({
			sourceBinding: { sessionId: "session-old" },
			targetCredentialId: "account-crispy",
			conversationId,
		});
		expect(mocks.inspectConversationIdentity).not.toHaveBeenCalled();
	});

	it("inspects a pre-fence credential switch without a transport backfill", async () => {
		seedLegacyAgent();
		useStore.setState({ accounts: [codexAccount("crispy")] });
		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);

		expect(mocks.probeSessions).not.toHaveBeenCalled();
		expect(inspection.sourceBinding.stopFence).toBeUndefined();
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("clears credential identity and generation when switching back to the runtime default", async () => {
		seedAgentWithAccounts(
			{
				accountId: "account-crispy",
				credentialId: "account-crispy",
				runtimeBinding: credentialBinding("account-crispy", 7),
			},
			[codexAccount("crispy")],
		);

		const payload = await preparedCredentialSwitchPayload(null);

		expect(payload).toMatchObject({ targetCredentialId: null });
		expect(payload.binding).not.toHaveProperty("credentialId");
		expect(payload.binding).not.toHaveProperty("credentialGeneration");
		await commitManagedAgentRehostReceipt(payload);
		expect(useStore.getState().agents[0]).toMatchObject({
			accountId: null,
			sessionId: "session-new",
		});
		expect(useStore.getState().agents[0].credentialId).toBeUndefined();
		expect(useStore.getState().agents[0].runtimeBinding).not.toHaveProperty(
			"credentialId",
		);
		expect(useStore.getState().agents[0].runtimeBinding).not.toHaveProperty(
			"credentialGeneration",
		);
	});

	it("runs a deferred race gate after preflight and immediately before stop", async () => {
		useStore.setState({ accounts: [codexAccount("crispy")] });
		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);
		const beforeStop = vi.fn(() => {
			throw new Error("fault injection: a newer turn started");
		});

		await expect(
			executeManagedAgentCredentialSwitch(inspection, { beforeStop }),
		).rejects.toThrow("a newer turn started");
		expect(mocks.preflightRecovery).toHaveBeenCalledTimes(1);
		expect(beforeStop).toHaveBeenCalledTimes(1);
		expect(mocks.stopManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("does not use pane presence as credential replacement authority", async () => {
		useStore.setState({ accounts: [codexAccount("crispy")] });
		mocks.resolvePaneReference.mockRejectedValue(
			new PaneCommandError("pane_not_found", "pane unmounted"),
		);
		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);
		expect(inspection.sourcePaneState).toBe("absent");

		await expect(
			executeManagedAgentCredentialSwitch(inspection),
		).resolves.toMatchObject({ recovery: expect.any(Object) });

		expect(mocks.preflightRecovery).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("repairs a stale selector when replaying an already-applied credential binding", async () => {
		seedAgentWithAccounts(
			{
				accountId: "account-canonical",
				credentialId: "account-canonical",
				runtimeBinding: credentialBinding("account-canonical"),
			},
			[codexAccount("canonical"), codexAccount("crispy")],
		);
		const payload = await preparedCredentialSwitchPayload("account-crispy");
		await commitManagedAgentRehostReceipt(payload);
		useStore.setState((current) => ({
			agents: current.agents.map((agent) => ({
				...agent,
				provider: "claude",
				accountId: "account-canonical",
				credentialId: "account-canonical",
				started: false,
				pendingCredentialSwitch: {
					requestId: "partial-handoff",
				} as Agent["pendingCredentialSwitch"],
				pendingCmd: "stale-launch-command",
				runtimeBinding:
					agent.runtimeBinding?.runtime === "hmux_managed_v1"
						? {
								...agent.runtimeBinding,
								credentialId: "account-canonical",
								credentialGeneration: 99,
							}
						: agent.runtimeBinding,
			})),
		}));

		expect(applyCommittedManagedAgentRehostProjection(payload)).toBe(true);
		expect(useStore.getState().agents[0]).toMatchObject({
			provider: "codex",
			sessionId: "session-new",
			accountId: "account-crispy",
			credentialId: "account-crispy",
			started: true,
			pendingCredentialSwitch: undefined,
			pendingCmd: undefined,
			runtimeBinding: {
				credentialId: "account-crispy",
			},
		});
	});

	it("refuses a credential switch without an exact conversation before preflight or stop", async () => {
		useStore.setState({
			agents: [managedAgent({ conversationId: undefined })],
			accounts: [codexAccount("crispy")],
		});

		await expect(
			inspectManagedAgentCredentialSwitch("agent-managed", "account-crispy"),
		).rejects.toMatchObject({
			code: "invalid_request",
			message: "conversation_identity_required",
		});
		expect(mocks.preflightRecovery).not.toHaveBeenCalled();
		expect(mocks.stopManaged).not.toHaveBeenCalled();
	});

	it("waits for a fresh managed identity before inspecting a credential switch", async () => {
		useStore.setState({
			agents: [managedAgent({ conversationId: undefined })],
			accounts: [codexAccount("crispy")],
		});
		mocks.ensureConversationIdentity.mockImplementation(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((agent) => ({
					...agent,
					conversationId,
				})),
			}));
			return conversationId;
		});

		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);

		expect(inspection.conversationId).toBe(conversationId);
		expect(mocks.ensureConversationIdentity).toHaveBeenCalledTimes(1);
	});

	it("uses the Host-owned binding identity without polling stale client fields", async () => {
		const runtimeBinding = managedBindingFixture({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-old",
			stopFence: sourceStopFence,
			conversationIdentity: {
				schemaVersion: 1,
				sessionId: "session-old",
				workspaceId: "workspace-1",
				...sourceStopFence,
				revision: "3",
				observedThroughOutputSeq: "9",
				providerId: "codex",
				conversationId,
				source: "provider_event",
			},
		});
		useStore.setState({
			agents: [
				managedAgent({
					conversationId: undefined,
					conversationIdentity: {
						state: "unavailable",
						code: "conversation_identity_timeout",
						detail: "stale client projection",
					},
					runtimeBinding,
				}),
			],
			accounts: [codexAccount("crispy")],
		});
		params = { agentRef: { agentId: "agent-managed" }, agentId: "agent-managed", binding: runtimeBinding };

		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);

		expect(inspection.conversationId).toBe(conversationId);
		expect(mocks.ensureConversationIdentity).not.toHaveBeenCalled();
		expect(mocks.inspectConversationIdentity).not.toHaveBeenCalled();
	});

	it("continues when a selected credential directory changes before stop", async () => {
		seedAgentWithAccounts({}, [codexAccount("crispy")]);
		const inspection = await inspectManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
		);
		useStore.setState({
			accounts: [
				{ ...codexAccount("crispy"), dir: "/profiles/codex-replaced" },
			],
		});

		await expect(
			executeManagedAgentCredentialSwitch(inspection),
		).resolves.toBeTruthy();
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("keeps equal credential selections invalid", async () => {
		seedAgentWithAccounts(
			{
				accountId: "account-crispy",
				credentialId: "account-crispy",
				runtimeBinding: credentialBinding("account-crispy"),
			},
			[codexAccount("crispy")],
		);

		await expect(
			inspectManagedAgentCredentialSwitch("agent-managed", "account-crispy"),
		).rejects.toThrow("credential_selection_unchanged");
	});

	it("keeps an equal Default selection invalid", async () => {
		seedAgentWithAccounts({ accountId: null }, []);

		await expect(
			inspectManagedAgentCredentialSwitch("agent-managed", null),
		).rejects.toThrow("credential_selection_unchanged");
	});
});
