import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCliHmuxRehost } from "@/lib/cli/cliHmuxRehost";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	ensureCoordinatorBinding: vi.fn(),
	executeRecovery: vi.fn(),
	reconcileRecovery: vi.fn(),
	listSessions: vi.fn(),
	preflightFresh: vi.fn(),
	managedCredentialAccount: vi.fn(),
	commitNativeRehost: vi.fn(),
	registerCredential: vi.fn(),
	resolveRouteAuthority: vi.fn(),
	resolvePaneById: vi.fn(),
	resolvePaneReference: vi.fn(),
}));

const rehostCalls = () =>
	emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT);

vi.mock("@tauri-apps/api/event", () => ({
	emit: mocks.emit,
}));
vi.mock("@/lib/cli/cliRequestBroker", () => ({
	claimCliRequest: async () => true,
}));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: vi.fn(),
	resolvePaneById: mocks.resolvePaneById,
	resolvePaneReference: mocks.resolvePaneReference,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		executeRecovery: mocks.executeRecovery,
		reconcileManagedRecovery: mocks.reconcileRecovery,
		listSessions: mocks.listSessions,
	},
}));
vi.mock("@/lib/ipc/dureWorkflow", () => ({
	createDureWorkflowTransport: () => ({
		ensureCoordinatorBinding: (_route: unknown, request: unknown) =>
			mocks.ensureCoordinatorBinding(request),
		inspectDispatchSession: vi.fn(),
		rebindDispatchSession: vi.fn(),
	}),
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.registerCredential,
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	resolveSelectedDureBackendRouteAuthority: mocks.resolveRouteAuthority,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionsExact: async (
		targets: Array<{ sessionId: string; workspaceId: string }>,
	) => {
		const sessions = await mocks.listSessions();
		return targets.map((target) => {
			const session = sessions.find(
				(candidate: { sessionId: string; workspaceId: string }) =>
					candidate.sessionId === target.sessionId &&
					candidate.workspaceId === target.workspaceId,
			);
			return session
				? { outcome: "found", session }
				: { outcome: "not_found", ...target };
		});
	},
	sessionFromExactHmuxInspection: (result: {
		outcome: string;
		session?: unknown;
	}) => (result.outcome === "found" ? result.session : undefined),
}));

vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	executeManagedAgentRecovery: vi.fn(),
	managedCredentialAccount: mocks.managedCredentialAccount,
	MANAGED_BOOTSTRAP_GEOMETRY: { columns: 120, rows: 30 },
	preflightManagedAgentFreshStart: mocks.preflightFresh,
	preflightManagedAgentRecovery: vi.fn(),
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostCommit", () => ({
	commitManagedAgentNativeRehost: mocks.commitNativeRehost,
}));

import {
	executeManagedAgentFreshStart,
	inspectFreshManagedAgentCredentialSwitch,
	inspectManagedAgentFreshStart,
	managedAgentFreshStartSyncPayload,
	startFreshManagedAgentPane,
	switchFreshManagedAgentCredential,
} from "@/lib/sessions/managed/managedAgentFreshStart";
import {
	MANAGED_AGENT_REHOSTED_EVENT,
	parseManagedAgentRehostSyncPayload,
} from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { applyCommittedManagedAgentRehostProjection } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { emitCallsFor } from "@/test/emitCalls";

const sourceStopFence = stopFenceFixture({
	hostInstanceId: "host-source",
	terminalEpoch: "terminal-source",
});

const replacementStopFence = {
	...sourceStopFence,
	hostInstanceId: "host-fresh",
	terminalEpoch: "terminal-fresh",
};

type FreshRecoveryRequest = {
	recoveryId: string;
	sessionId: string;
	workspaceId: string;
	managedLaunch: {
		providerId: string;
		permissionMode: "default" | "bypass_approvals";
	};
};

function freshRecoveryReceipt(
	request: FreshRecoveryRequest,
	overrides: Record<string, unknown> = {},
) {
	const sessionId = `managed_rehost_${request.recoveryId}`;
	return {
		sourceSessionId: request.sessionId,
		targetBuildId: "build-current",
		action: "replace_ai_provider_with_fresh_conversation" as const,
		outcome: "replaced" as const,
		replayed: false,
		operationId: request.recoveryId,
		sourceStopReceipt: {
			schema: "hmux-managed-stop-v1",
			schemaVersion: 2,
			stopId: `managed_rehost_stop_${request.recoveryId}`,
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			runnerPrincipal: sourceStopFence.runnerPrincipal,
			runnerInstance: sourceStopFence.runnerInstance,
			channelEpoch: Number(sourceStopFence.channelEpoch),
			hostInstanceId: sourceStopFence.hostInstanceId,
			terminalEpoch: sourceStopFence.terminalEpoch,
			outcome: "stopped" as const,
			exitReason: "managed_rehost",
		},
		replacementTarget: {
			idempotencyKey: `managed_rehost_create_${request.recoveryId}`,
			sessionId,
			workspaceId: request.workspaceId,
			providerId: request.managedLaunch.providerId,
			permissionMode: request.managedLaunch.permissionMode,
			runnerPrincipal: replacementStopFence.runnerPrincipal,
			runnerInstance: replacementStopFence.runnerInstance,
			channelEpoch: replacementStopFence.channelEpoch,
			hostInstanceId: replacementStopFence.hostInstanceId,
			terminalEpoch: replacementStopFence.terminalEpoch,
		},
		replacementSession: {
			sessionId,
			workspaceId: request.workspaceId,
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			manifestLifecycle: "ready" as const,
			health: "current_healthy" as const,
			terminalEpoch: replacementStopFence.terminalEpoch,
			stopFence: replacementStopFence,
			outputSeq: "0",
			capabilities: [],
		},
		...overrides,
	};
}

function sourceAgent(): Agent {
	return managedAgentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-exited",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-exited",
			workspaceId: "workspace-1",
			createIdempotencyKey: "spawn-source",
			stopFence: sourceStopFence,
		}),
		conversationId: "conversation-source",
	});
}

describe("managed Agent fresh start", () => {
	let params: Record<string, unknown>;
	let updateParameters: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mocks.commitNativeRehost.mockReset().mockResolvedValue(undefined);
		mocks.registerCredential.mockReset().mockResolvedValue(undefined);
		mocks.resolveRouteAuthority
			.mockReset()
			.mockImplementation(async (profileId: string) => ({
				schemaVersion: 1,
				profileId,
				revision: `sha256:${"a".repeat(64)}`,
				backend: { id: `backend-${profileId}`, generation: "generation-1" },
				target: { source: "local", hostId: "local" },
			}));
		mocks.emit.mockReset().mockResolvedValue(undefined);
		mocks.ensureCoordinatorBinding
			.mockReset()
			.mockImplementation(async (request) => ({
				agentId: request.agentId,
				sessionId: request.sessionId,
				bindingGeneration: 2,
			}));
		mocks.executeRecovery.mockReset();
		mocks.reconcileRecovery.mockReset().mockResolvedValue(null);
		mocks.listSessions.mockReset().mockResolvedValue([
			{
				sessionId: "session-exited",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "exited",
				health: "exited",
				terminalEpoch: "terminal-source",
				outputSeq: "9",
				capabilities: [],
			},
		]);
		mocks.preflightFresh.mockReset().mockResolvedValue(undefined);
		mocks.managedCredentialAccount.mockReset().mockReturnValue(undefined);
		params = {
			agentRef: { agentId: "agent-managed" },
			agentId: "agent-managed",
			binding: sourceAgent().runtimeBinding,
		};
		updateParameters = vi.fn((next: Record<string, unknown>) => {
			params = next;
		});
		const panel = {
			id: "agent:agent-managed",
			api: {
				component: "agent",
				getParameters: () => params,
				updateParameters,
				setActive: vi.fn(),
			},
		};
		const dockApi = {
			getPanel: vi.fn(() => panel),
			toJSON: vi.fn(() => ({ panels: [params] })),
		};
		mocks.resolvePaneById.mockReset().mockResolvedValue({
			desktopId: "desktop-1",
			api: dockApi,
			panelId: "agent:agent-managed",
			cwd: "/repo/worktree",
		});
		mocks.resolvePaneReference.mockReset().mockImplementation(
			() => mocks.resolvePaneById(),
		);
		mocks.executeRecovery.mockImplementation(async (request) =>
			freshRecoveryReceipt(request, {
				replayed: mocks.executeRecovery.mock.calls.length > 1,
			}),
		);
		useStore.setState({
			activeSpaceId: "desktop-1",
			projects: [
				{
					id: "project-1",
					name: "repo",
					path: "/repo",
					kind: "local",
					isRepo: true,
				},
			],
			agents: [sourceAgent()],
			accounts: [],
			activeAccounts: {},
			skipPermissions: { codex: true },
			layouts: {},
			sessionCwd: { "session-exited": "/repo/worktree" },
			hmuxSessionMetadata: {},
		});
	});

	it.each(
		(["ui", "credential", "cli"] as const).flatMap((caller) =>
			(["backend", "pane"] as const).map((boundary) => ({ caller, boundary })),
		),
	)(
		"preserves newer metadata through $caller $boundary completion",
		async ({ caller, boundary }) => {
			if (caller === "credential") {
				const source = sourceAgent();
				const freshSource = {
					...source,
					conversationId: undefined,
					credentialId: "account-old",
					runtimeBinding: managedBindingFixture({
						...source.runtimeBinding,
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						credentialId: "account-old",
					}),
				};
				params.binding = freshSource.runtimeBinding;
				useStore.setState({ agents: [freshSource] });
				mocks.listSessions.mockResolvedValue([
					{
						...(await mocks.listSessions())[0],
						lifecycle: "ready",
						health: "current_healthy",
					},
				]);
			}
			let releaseBackend!: () => void;
			let releasePane!: () => void;
			const backend = new Promise<void>((resolve) => {
				releaseBackend = resolve;
			});
			const pane = new Promise<null>((resolve) => {
				releasePane = () => resolve(null);
			});
			mocks.commitNativeRehost.mockImplementationOnce(() => backend);
			const sourcePane = await mocks.resolvePaneById();
			let panePending = false;
			mocks.resolvePaneById.mockImplementation(async () => {
				if (useStore.getState().agents[0]?.sessionId === "session-exited")
					return sourcePane;
				panePending = true;
				return pane;
			});
			const completion =
				caller === "credential"
					? switchFreshManagedAgentCredential(
							"agent-managed",
							null,
							"agent:agent-managed",
						)
					: caller === "cli"
						? handleCliHmuxRehost(
								{
									name: "agent-managed",
									targetPanelId: "agent:agent-managed",
									freshStart: true,
									confirmRestart: true,
								},
								`fresh-${boundary}`,
							)
						: startFreshManagedAgentPane(
								"agent-managed",
								"agent:agent-managed",
							);
			void completion.catch(() => undefined);
			try {
				await vi.waitFor(() =>
					expect(mocks.commitNativeRehost).toHaveBeenCalledOnce(),
				);
				const replacement = (await mocks.executeRecovery.mock.results[0].value)
					.replacementSession;
				if (boundary === "pane") {
					releaseBackend();
					await vi.waitFor(() => expect(panePending).toBe(true));
				}
				useStore
					.getState()
					.setHmuxSessionMetadata({ ...replacement, outputSeq: "42" });
				const key = hmuxSessionMetadataKey(
					replacement.workspaceId,
					replacement.sessionId,
				);
				const observed = useStore.getState().hmuxSessionMetadata[key];
				releaseBackend();
				await vi.waitFor(() => expect(panePending).toBe(true));
				releasePane();
				const result = await completion;
				expect(result).toMatchObject(
					caller === "cli"
						? {
								ok: true,
								rehost: { outcome: "rehosted_fresh", presentation: "pending" },
							}
						: { projection: "applied", presentation: "pending" },
				);
				expect(mocks.executeRecovery).toHaveBeenCalledOnce();
				expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
				expect(rehostCalls()).toHaveLength(1);
				expect(useStore.getState().agents[0].sessionId).toBe(
					replacement.sessionId,
				);
				expect(useStore.getState().hmuxSessionMetadata[key]?.outputSeq).toBe(
					"42",
				);
				expect(useStore.getState().hmuxSessionMetadata[key]).toBe(observed);
			} finally {
				releaseBackend();
				releasePane();
				await completion.catch(() => undefined);
			}
		},
	);

	it("reconstructs one seedless successor after response loss and app restart", async () => {
		let durableReceipt: ReturnType<typeof freshRecoveryReceipt> | null = null;
		mocks.reconcileRecovery.mockImplementation(async () => durableReceipt);
		mocks.executeRecovery.mockImplementationOnce(async (request) => {
			durableReceipt = freshRecoveryReceipt(request, { replayed: true });
			throw new Error("response lost after durable completion");
		});
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		const first = await executeManagedAgentFreshStart(inspection);
		const retry = await executeManagedAgentFreshStart(inspection);
		useStore.setState({ agents: [sourceAgent()] });
		const restartedInspection =
			await inspectManagedAgentFreshStart("agent-managed");
		const restarted = await executeManagedAgentFreshStart(restartedInspection);

		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery.mock.calls[0][0]).toMatchObject({
			kind: "managed_provider_fresh",
			sessionId: "session-exited",
			workspaceId: "workspace-1",
			adapterSupportsExplicitResume: false,
			managedLaunch: {
				providerId: "codex",
			},
		});
		expect(
			mocks.executeRecovery.mock.calls[0][0].managedLaunch,
		).not.toHaveProperty("targetSessionId");
		expect(mocks.executeRecovery.mock.calls[0][0]).not.toHaveProperty(
			"conversationId",
		);
		expect(retry).toMatchObject({
			createIdempotencyKey: first.createIdempotencyKey,
			replacement: { sessionId: first.replacement.sessionId },
			receipt: { replayed: true },
		});
		expect(restarted).toMatchObject({
			createIdempotencyKey: first.createIdempotencyKey,
			replacement: { sessionId: first.replacement.sessionId },
			receipt: { replayed: true },
		});

		const payload = managedAgentFreshStartSyncPayload(
			restartedInspection,
			restarted,
		);
		expect(payload).toMatchObject({
			launchKind: "fresh",
			sourceConversationId: "conversation-source",
			conversationId: null,
			targetCredentialId: null,
			binding: {
				sessionId: first.replacement.sessionId,
				createIdempotencyKey: first.createIdempotencyKey,
			},
		});
		expect(payload.binding).not.toHaveProperty("conversationIdentity");
	});

	it("commits one Agent CAS and projects its canonical receipt without replaying launch", async () => {
		mocks.commitNativeRehost.mockResolvedValueOnce({
			executionProfile: { kind: "provider_default" },
			providerConversationRef: "conversation-fresh",
			launchSelection: { permissionMode: "default" },
		});
		await startFreshManagedAgentPane("agent-managed", "agent:agent-managed");
		const payload = rehostCalls()[0]?.[1];
		const committed = useStore.getState().agents[0];

		expect(committed).toMatchObject({
			sessionId: expect.stringMatching(/^managed_rehost_/),
			accountId: null,
			started: true,
			pendingCmd: undefined,
			runtimeBinding: {
				sessionId: expect.stringMatching(/^managed_rehost_/),
			},
			conversationId: "conversation-fresh",
		});
		expect(payload).toMatchObject({
			launchKind: "fresh",
			conversationId: "conversation-fresh",
		});
		expect(mocks.ensureCoordinatorBinding).not.toHaveBeenCalled();
		expect(updateParameters).not.toHaveBeenCalled();
		expect(params).toMatchObject({
			agentId: "agent-managed",
			binding: expect.objectContaining({ sessionId: "session-exited" }),
		});

		useStore.setState({
			agents: [sourceAgent()],
			skipPermissions: { codex: false },
		});
		const committedPayload = parseManagedAgentRehostSyncPayload(payload);
		if (!committedPayload) throw new Error("missing committed receipt");
		expect(applyCommittedManagedAgentRehostProjection(committedPayload)).toBe(
			true,
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: committed.sessionId,
			pendingCmd: undefined,
			conversationId: "conversation-fresh",
		});
		expect(
			parseManagedAgentRehostSyncPayload({
				...payload,
				providerId: "toString",
			}),
		).toBeUndefined();
		expect(
			parseManagedAgentRehostSyncPayload({
				...payload,
				permissionMode: undefined,
			}),
		).toBeUndefined();
	});

	it("does not use pane presence as fresh replacement authority", async () => {
		mocks.resolvePaneById.mockRejectedValue(
			new PaneCommandError("pane_not_found", "pane unmounted"),
		);
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		expect(inspection.sourcePaneState).toBe("absent");

		await expect(
			executeManagedAgentFreshStart(inspection),
		).resolves.toMatchObject({ replacement: { sessionClass: "managed" } });

		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("admits fresh replacement for an explicitly selected neutral pane ID", async () => {
		mocks.resolvePaneById.mockResolvedValue({
			...(await mocks.resolvePaneById()),
			panelId: "pane:stable-slot",
		});
		const inspection = await inspectManagedAgentFreshStart(
			"agent-managed",
			"pane:stable-slot",
		);
		expect(inspection).toMatchObject({
			panelId: "pane:stable-slot",
			sourcePaneState: "present",
		});
		await expect(
			executeManagedAgentFreshStart(inspection),
		).resolves.toMatchObject({
			replacement: { sessionClass: "managed" },
		});
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it("executes fresh replacement for an observed neutral pane ID", async () => {
		mocks.resolvePaneReference.mockResolvedValueOnce({
			...(await mocks.resolvePaneById()),
			panelId: "pane:stable-slot",
		});
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		expect(inspection.panelId).toBe("pane:stable-slot");
		await expect(
			executeManagedAgentFreshStart(inspection),
		).resolves.toMatchObject({
			replacement: { sessionClass: "managed" },
		});
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
	});

	it.each(
		(["ui", "cli"] as const).flatMap((caller) =>
			["rejected", "thrown"].map((failure) => ({ caller, failure })),
		),
	)(
		"keeps a committed $caller fresh start when its notification is $failure",
		async ({ caller, failure }) => {
			const error = new Error("WebView notification unavailable");
			mocks.emit.mockImplementation((event) => {
				if (event === MANAGED_AGENT_REHOSTED_EVENT) {
					if (failure === "thrown") throw error;
					return Promise.reject(error);
				}
				return Promise.resolve();
			});

			const committed =
				caller === "ui"
					? await startFreshManagedAgentPane(
							"agent-managed",
							"agent:agent-managed",
						)
					: await handleCliHmuxRehost(
							{
								name: "agent-managed",
								targetPanelId: "agent:agent-managed",
								freshStart: true,
								confirmRestart: true,
							},
							`fresh-notification-${failure}`,
						);

			expect(committed).toMatchObject(
				caller === "ui"
					? { presentation: "applied" }
					: { ok: true, rehost: { presentation: "applied" } },
			);
			expect(useStore.getState().agents[0].runtimeBinding).toEqual(
				rehostCalls()[0]?.[1].binding,
			);
			expect(mocks.executeRecovery).toHaveBeenCalledOnce();
			expect(mocks.commitNativeRehost).toHaveBeenCalledOnce();
			expect(rehostCalls()).toHaveLength(1);
		},
	);

	it("does not publish success when the authoritative commit fails", async () => {
		mocks.commitNativeRehost.mockRejectedValueOnce(
			new Error("control-plane commit unavailable"),
		);

		await expect(
			startFreshManagedAgentPane("agent-managed", "agent:agent-managed"),
		).rejects.toThrow("control-plane commit unavailable");

		expect(rehostCalls()).toHaveLength(0);
		expect(useStore.getState().agents[0].sessionId).toBe("session-exited");
	});

	it("switches an untouched ready Agent with a fresh credential launch and no invented conversation id", async () => {
		const crispy = {
			id: "account-crispy",
			provider: "codex" as const,
			name: "crispy",
			dir: "/profiles/codex-crispy",
		};
		const freshSource = {
			...sourceAgent(),
			conversationId: undefined,
		};
		params.binding = freshSource.runtimeBinding;
		useStore.setState({
			agents: [freshSource],
			accounts: [crispy],
			agentActivity: { "agent-managed": "waiting" },
			sessionAgentRuntimeState: {
				"session-exited": {
					terminalEpoch: "terminal-source",
					revision: "4",
					observedThroughOutputSeq: "9",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "process_lifecycle",
					turnCompletedCount: "0",
				},
			},
		});
		mocks.listSessions.mockResolvedValue([
			{
				sessionId: "session-exited",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				health: "current_healthy",
				terminalEpoch: "terminal-source",
				outputSeq: "9",
				capabilities: [],
			},
		]);
		mocks.preflightFresh.mockResolvedValue(crispy);
		mocks.managedCredentialAccount.mockReturnValue(crispy);
		mocks.executeRecovery.mockImplementationOnce(async (request) =>
			freshRecoveryReceipt(request),
		);

		const inspection = await inspectFreshManagedAgentCredentialSwitch(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
		);
		expect(inspection).toMatchObject({
			sourceDiscoveryState: "ready",
			sourceConversationId: undefined,
			sourceCredentialId: undefined,
			targetCredentialId: "account-crispy",
		});

		await switchFreshManagedAgentCredential(
			"agent-managed",
			"account-crispy",
			"agent:agent-managed",
		);

		expect(mocks.preflightFresh).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "account-crispy",
				runtimeBinding: expect.objectContaining({
					credentialId: "account-crispy",
					credentialGeneration: undefined,
				}),
			}),
			crispy,
		);
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "managed_provider_fresh",
				managedLaunch: expect.objectContaining({
					credentialId: "account-crispy",
					credentialDirectory: "/profiles/codex-crispy",
					credentialGeneration: undefined,
				}),
			}),
		);
		expect(mocks.executeRecovery.mock.calls[0][0]).not.toHaveProperty(
			"conversationId",
		);
		expect(useStore.getState().agents[0]).toMatchObject({
			accountId: "account-crispy",
			credentialId: "account-crispy",
			conversationId: undefined,
			pendingCmd: undefined,
		});
		expect(rehostCalls()[rehostCalls().length - 1]?.[1]).toMatchObject({
			launchKind: "fresh",
			conversationId: null,
			targetCredentialId: "account-crispy",
		});
	});

	it("replays the completed receipt and retargets after GC removes the source", async () => {
		mocks.listSessions.mockResolvedValueOnce([
			{
				sessionId: "session-exited",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				manifestLifecycle: "ready",
				health: "current_healthy",
				terminalEpoch: "terminal-source",
				outputSeq: "9",
				capabilities: [],
			},
		]);
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		expect(inspection.sourceDiscoveryState).toBe("ready");
		const completed = await executeManagedAgentFreshStart(inspection);
		mocks.listSessions.mockResolvedValue([completed.replacement]);

		const absentInspection =
			await inspectManagedAgentFreshStart("agent-managed");
		expect(absentInspection.sourceDiscoveryState).toBe("absent");
		const committed = await startFreshManagedAgentPane(
			"agent-managed",
			"agent:agent-managed",
		);

		expect(mocks.executeRecovery).toHaveBeenCalledTimes(2);
		expect(mocks.executeRecovery.mock.calls[1][0]).toEqual(
			mocks.executeRecovery.mock.calls[0][0],
		);
		expect(rehostCalls()[0]?.[1]).toMatchObject({
			sourcePaneState: "present",
			binding: {
				sessionId: completed.replacement.sessionId,
				createIdempotencyKey: completed.createIdempotencyKey,
			},
		});
		expect(committed).toMatchObject({
			presentation: "applied",
			pane: {
				sessionId: completed.replacement.sessionId,
				workspaceId: "workspace-1",
			},
		});
		expect(useStore.getState().agents[0]).toMatchObject({
			sessionId: completed.replacement.sessionId,
			runtimeBinding: {
				sessionId: completed.replacement.sessionId,
				createIdempotencyKey: completed.createIdempotencyKey,
			},
		});
	});

	it("requires a completed replay receipt when the source is absent", async () => {
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		const completed = await executeManagedAgentFreshStart(inspection);
		mocks.listSessions.mockResolvedValue([completed.replacement]);
		const absentInspection =
			await inspectManagedAgentFreshStart("agent-managed");
		mocks.executeRecovery.mockResolvedValueOnce({
			...completed.receipt,
			replayed: false,
		});

		await expect(
			executeManagedAgentFreshStart(absentInspection),
		).rejects.toThrow("managed fresh-start receipt identity mismatch");
	});

	it("accepts a fenced replay while its catalog projection is stale", async () => {
		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		const completed = await executeManagedAgentFreshStart(inspection);
		mocks.listSessions.mockResolvedValue([completed.replacement]);
		const absentInspection =
			await inspectManagedAgentFreshStart("agent-managed");
		mocks.executeRecovery.mockResolvedValueOnce({
			...completed.receipt,
			replayed: true,
			replacementSession: {
				...completed.replacement,
				lifecycle: "unavailable",
				health: "stale_transport",
			},
		});

		await expect(
			executeManagedAgentFreshStart(absentInspection),
		).resolves.toMatchObject({
			createIdempotencyKey: completed.createIdempotencyKey,
			replacement: {
				sessionId: completed.replacement.sessionId,
				lifecycle: "unavailable",
				health: "stale_transport",
			},
		});
	});

	it("lets the canonical journal resolve an absent source without a predicted target", async () => {
		mocks.listSessions.mockResolvedValueOnce([]);
		mocks.reconcileRecovery.mockImplementationOnce(async (request) =>
			freshRecoveryReceipt(
				{
					...request,
					managedLaunch: {
						providerId: "codex",
						permissionMode: "bypass_approvals",
					},
				},
				{
					replayed: true,
					replacementSession: undefined,
				},
			),
		);

		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		const completed = await executeManagedAgentFreshStart(inspection);

		expect(inspection.sourceDiscoveryState).toBe("absent");
		expect(completed).toMatchObject({
			createIdempotencyKey: expect.stringMatching(/^managed_rehost_create_/),
			replacement: {
				sessionId: expect.stringMatching(/^managed_rehost_/),
			},
			receipt: { replayed: true },
		});
		expect(mocks.preflightFresh).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("propagates a failed authoritative session census", async () => {
		mocks.listSessions.mockRejectedValueOnce(new Error("census unavailable"));

		await expect(
			inspectManagedAgentFreshStart("agent-managed"),
		).rejects.toThrow("census unavailable");
		expect(mocks.preflightFresh).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("replaces a ready source from its exact provider fence without idle observation", async () => {
		mocks.listSessions.mockResolvedValueOnce([
			{
				sessionId: "session-exited",
				workspaceId: "workspace-1",
				sessionClass: "managed",
				lifecycle: "ready",
				health: "current_healthy",
				terminalEpoch: "terminal-source",
				outputSeq: "9",
				capabilities: [],
			},
		]);
		mocks.executeRecovery.mockImplementationOnce(async (request) =>
			freshRecoveryReceipt(request),
		);

		const inspection = await inspectManagedAgentFreshStart("agent-managed");
		expect(inspection.sourceDiscoveryState).toBe("ready");
		await executeManagedAgentFreshStart(inspection);

		expect(mocks.executeRecovery).toHaveBeenCalledWith({
			recoveryId: expect.any(String),
			kind: "managed_provider_fresh",
			sessionId: "session-exited",
			workspaceId: "workspace-1",
			expectedSourceFence: sourceStopFence,
			adapterSupportsExplicitResume: false,
			confirmed: true,
			managedLaunch: expect.any(Object),
		});
	});
});
