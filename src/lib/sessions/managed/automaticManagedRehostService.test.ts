// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getFrameBudgetScheduler,
	resetFrameBudgetSchedulerForTest,
} from "@/lib/scheduling/frameBudgetScheduler";
import { installAutomaticManagedRehostService } from "@/lib/sessions/managed/automaticManagedRehostService";
import { HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY } from "@/lib/sessions/managed/automaticManagedRehostPolicy";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { resetManagedControlPlaneObservationForTest } from "@/lib/sessions/managed/managedControlPlaneObservation";
import {
	clearHmuxPaneHealth,
	getHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { emitCallsFor } from "@/test/emitCalls";

const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	inspectSessionsExact: vi.fn(),
	inspectDisconnectedRecovery: vi.fn(),
	executeUnavailableRecovery: vi.fn(),
	reconcileRehost: vi.fn(),
	inspectRehost: vi.fn(),
	executeRehost: vi.fn(),
	mountedEntries: vi.fn(),
	rehostPayload: vi.fn(),
	synchronizeRehost: vi.fn(),
	synchronizeReconciledRehost: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@/lib/workspace/dock/dockRegistry", async (original) => ({
	...(await original<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	mountedDockviewEntries: mocks.mountedEntries,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getAllWebviewWindows: () =>
		Promise.resolve([
			{
				label: "main",
				isVisible: () => Promise.resolve(true),
				isMinimized: () => Promise.resolve(false),
			},
		]),
}));

vi.mock("@/lib/workspace/desktop/desktopVisibilityLease", () => ({
	isDesktopWorkspaceWindowLabel: () => true,
	assessDesktopVisibilityLeases: () => ({
		complete: true,
		visibleDesktopIds: new Set<string>(["desktop-1"]),
	}),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: { inspectSessionsExact: mocks.inspectSessionsExact },
	remoteHmuxCatalog: vi.fn(),
	remoteHmuxKnownHostTrust: vi.fn(),
}));

vi.mock("@/lib/sessions/managed/managedAgentRehost", () => ({
	executeManagedAgentRehost: mocks.executeRehost,
	inspectManagedAgentRehost: mocks.inspectRehost,
	executeUnavailableManagedAgentRecovery: mocks.executeUnavailableRecovery,
	inspectDisconnectedManagedAgentRecovery: mocks.inspectDisconnectedRecovery,
	managedAgentRehostSyncPayload: mocks.rehostPayload,
	reconcileManagedAgentRehost: mocks.reconcileRehost,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostSynchronization", () => ({
	MANAGED_AGENT_REHOSTED_EVENT: "agent:managed-rehosted:v2",
	commitManagedAgentRehostReceipt: mocks.synchronizeRehost,
	commitReconciledManagedAgentRehostReceipt: mocks.synchronizeReconciledRehost,
}));

vi.mock("@/lib/sessions/credentials/remoteManagedCredentialSwitch", () => ({
	requestRemoteManagedBuildRehost: vi.fn(),
}));

const sourceFence = stopFenceFixture({
	runnerPrincipal: "local-user",
	runnerInstance: "runner-before-reboot",
	hostInstanceId: "host-before-reboot",
	terminalEpoch: "terminal-before-reboot",
});
const replacementFence = stopFenceFixture({
	runnerPrincipal: "local-user",
	runnerInstance: "runner-after-reboot",
	hostInstanceId: "host-after-reboot",
	terminalEpoch: "terminal-after-reboot",
});

function sourceAgent() {
	return managedAgentFixture({
		id: "agent-reboot",
		name: "reboot-pane",
		projectId: "project-1",
		worktreePath: "/repo/.worktrees/reboot-pane",
		branch: "agent/reboot-pane",
		sessionId: "session-before-reboot",
		conversationId: "conversation-exact",
		started: undefined,
		runtimeBinding: managedBindingFixture({
			sessionId: "session-before-reboot",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-before-reboot",
			stopFence: sourceFence,
		}),
	});
}

function staleSourceSession() {
	return {
		sessionId: "session-before-reboot",
		workspaceId: "workspace-1",
		sessionClass: "managed" as const,
		lifecycle: "unavailable" as const,
		manifestLifecycle: "ready" as const,
		health: "stale_transport" as const,
		hostProcessAlive: false,
		inputAllowed: false,
		detachOnly: true,
		terminalEpoch: sourceFence.terminalEpoch,
		stopFence: sourceFence,
		outputSeq: "42",
		capabilities: [],
	};
}

function replacementSession() {
	return {
		...staleSourceSession(),
		sessionId: "session-after-reboot",
		lifecycle: "ready" as const,
		manifestLifecycle: "ready" as const,
		health: "current_healthy" as const,
		inputAllowed: true,
		detachOnly: false,
		terminalEpoch: replacementFence.terminalEpoch,
		stopFence: replacementFence,
		outputSeq: "0",
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	resetFrameBudgetSchedulerForTest();
	vi.setSystemTime(new Date("2026-08-30T01:00:00Z"));
	resetManagedControlPlaneObservationForTest();
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	const agent = sourceAgent();
	const replacement = replacementSession();
	mocks.inspectSessionsExact.mockResolvedValue([
		{ outcome: "found", session: staleSourceSession() },
	]);
	mocks.reconcileRehost.mockResolvedValue(null);
	mocks.mountedEntries.mockReturnValue([]);
	mocks.inspectDisconnectedRecovery.mockImplementation(
		async (_agentId, _conversationId, panelId) => ({
			agentId: agent.id,
			agentName: agent.name,
			projectId: agent.projectId,
			providerId: agent.provider,
			sourceBinding: agent.runtimeBinding,
			sourceConversationId: agent.conversationId,
			sourceLifecycle: "unavailable",
			sourcePaneState: "present",
			conversationId: agent.conversationId,
			cwd: agent.worktreePath,
			desktopId: "desktop-1",
			panelId,
			permissionMode: "bypass_approvals",
			terminalEnvironment: {},
			plan: { allowed: true },
		}),
	);
	mocks.executeUnavailableRecovery.mockResolvedValue({
		recovery: { replacement },
	});
	mocks.rehostPayload.mockReturnValue({ schemaVersion: 2 });
	mocks.synchronizeRehost.mockImplementation(async () => {
		useStore.setState((state) => ({
			agents: state.agents.map((candidate) =>
				candidate.id === agent.id
					? {
							...candidate,
							sessionId: replacement.sessionId,
							runtimeBinding: {
								...candidate.runtimeBinding!,
								sessionId: replacement.sessionId,
								stopFence: replacementFence,
							},
						}
					: candidate,
			),
		}));
		return { payload: { schemaVersion: 2 } };
	});
	clearHmuxPaneHealth("desktop-1:agent:agent-reboot");
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "Repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [agent],
		spaces: [{ id: "desktop-1", name: "Desktop" }],
		activeSpaceId: "desktop-1",
		layouts: {
			"desktop-1": {
				panels: {
					"agent:agent-reboot": {
						contentComponent: "agent",
						params: {},
					},
				},
			},
		},
		hmuxSessionMetadata: {},
		sessionAgentRuntimeState: {},
		agentActivity: {},
		sshHosts: [],
	});
});

afterEach(() => {
	vi.clearAllMocks();
	resetFrameBudgetSchedulerForTest();
	vi.useRealTimers();
});

describe("automatic managed rehost service", () => {
	it.each(["pane-current", "agent:previous"])(
		"rehosts only the observed idle Agent in %s after the existing dwell",
		async (panelId) => {
			const agent = sourceAgent();
			const desktopId = "desktop-offscreen";
			const healthId = `${desktopId}:${panelId}`;
			useStore.setState({
				layouts: {
					[desktopId]: {
						panels: {
							[panelId]: {
								contentComponent: "agent",
								params: { agentRef: { agentId: agent.id } },
							},
						},
					},
				},
				sessionAgentRuntimeState: {
					[agent.sessionId]: {
						terminalEpoch: sourceFence.terminalEpoch,
						revision: "9",
						observedThroughOutputSeq: "42",
						lifecycle: "running",
						activity: "waiting",
						attention: "none",
						source: "provider_event",
						turnCompletedCount: "3",
					},
				},
			});
			mocks.inspectSessionsExact.mockResolvedValue([
				{
					outcome: "found",
					session: {
						...staleSourceSession(),
						lifecycle: "ready",
						health: "compatible_old_healthy",
						hostProcessAlive: true,
						inputAllowed: true,
						detachOnly: false,
						capabilities: [HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY],
					},
				},
			]);
			mocks.inspectRehost.mockResolvedValue({
				agentId: agent.id,
				desktopId,
				panelId,
				sourceBinding: agent.runtimeBinding,
				sourceLifecycle: "ready",
				conversationId: agent.conversationId,
			});
			mocks.executeRehost.mockImplementation(async (_inspection, options) => {
				expect(await options.beforeStop()).toMatchObject({
					runtimeRevision: "9",
					outputSequence: "42",
					providerId: agent.provider,
					conversationId: agent.conversationId,
				});
				return {};
			});
			publishHmuxPaneHealthObservation(healthId, {
				kind: "frame_presented",
				terminalEpoch: sourceFence.terminalEpoch,
				sequence: "42",
			});
			const dispose = installAutomaticManagedRehostService();
			try {
				await vi.advanceTimersByTimeAsync(2_300);
				expect(mocks.executeRehost).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(20_000);
				expect(mocks.inspectRehost).toHaveBeenCalledExactlyOnceWith(
					agent.id,
					panelId,
				);
				expect(mocks.executeRehost).toHaveBeenCalledOnce();
				expect(mocks.synchronizeRehost).toHaveBeenCalledExactlyOnceWith(
					expect.anything(),
					{ activate: false },
				);
			} finally {
				dispose();
				clearHmuxPaneHealth(healthId);
			}
		},
	);

	it("coalesces focus, visibility and store wakes behind foreground admission", async () => {
		mocks.inspectSessionsExact.mockResolvedValue([
			{
				outcome: "found",
				session: {
					...staleSourceSession(),
					lifecycle: "ready",
					health: "current_healthy",
				},
			},
		]);
		const scheduler = getFrameBudgetScheduler();
		const dispose = installAutomaticManagedRehostService();
		try {
			scheduler.notifyInteraction("desktop-switch-start");
			window.dispatchEvent(new Event("focus"));
			document.dispatchEvent(new Event("visibilitychange"));
			useStore.setState({ agentActivity: { "agent-reboot": "working" } });
			await vi.advanceTimersByTimeAsync(50);
			expect(mocks.inspectSessionsExact).not.toHaveBeenCalled();
			expect(scheduler.getTelemetry().maintenance.pending).toBe(1);
			scheduler.notifyInteraction("desktop-switch-settled");
			await vi.advanceTimersByTimeAsync(600);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledOnce();
			expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("disposes a focus wake before it can start an observation", async () => {
		const dispose = installAutomaticManagedRehostService();
		window.dispatchEvent(new Event("focus"));
		dispose();
		await vi.advanceTimersByTimeAsync(600);
		expect(mocks.inspectSessionsExact).not.toHaveBeenCalled();
	});

	it.each(
		[false, true].flatMap((socketOwnerAbsent) =>
			["agent:agent-reboot", "slot", "launcher:previous", "agent:previous"].map(
				(panelId) => ({ socketOwnerAbsent, panelId }),
			),
		),
	)(
		"converges the current $panelId pane without a click (socket owner absent: $socketOwnerAbsent)",
		async ({ socketOwnerAbsent, panelId }) => {
			useStore.setState({
				layouts: {
					"desktop-1": {
						panels: {
							[panelId]: {
								contentComponent: "agent",
								params: { agentRef: { agentId: "agent-reboot" } },
							},
						},
					},
				},
			});
			clearHmuxPaneHealth(`desktop-1:${panelId}`);
			if (socketOwnerAbsent)
				mocks.inspectSessionsExact.mockResolvedValue([
					{
						outcome: "found",
						session: {
							...staleSourceSession(),
							hostProcessAlive: true,
							hostSocketOwnerAbsent: true,
						},
					},
				]);
			const dispose = installAutomaticManagedRehostService();
			await vi.advanceTimersByTimeAsync(2_300);
			dispose();

			expect(mocks.inspectDisconnectedRecovery).toHaveBeenCalledWith(
				"agent-reboot",
				"conversation-exact",
				panelId,
			);
			expect(mocks.executeUnavailableRecovery).toHaveBeenCalledOnce();
			expect(mocks.executeUnavailableRecovery).toHaveBeenCalledWith(
				expect.objectContaining({
					conversationId: "conversation-exact",
					panelId,
				}),
				{ requireSocketOwnerAbsent: socketOwnerAbsent ? true : undefined },
			);
			expect(mocks.synchronizeRehost).toHaveBeenCalledOnce();
			expect(useStore.getState().agents[0].sessionId).toBe(
				"session-after-reboot",
			);
			expect(
				emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT),
			).toHaveLength(1);
			expect(getHmuxPaneHealth(`desktop-1:${panelId}`)?.state).toBe(
				"recovering",
			);
		},
	);

	it.each(["closed", "retargeted", "invalid-ref"])(
		"does not recover a saved Agent pane that is currently %s",
		async (change) => {
			const params = {
				agentRef:
					change === "invalid-ref" ? null : { agentId: "another-agent" },
			};
			mocks.mountedEntries.mockReturnValue([
				[
					"desktop-1",
					{
						panels:
							change === "closed"
								? []
								: [
										{
											id: "agent:agent-reboot",
											params,
											api: { component: "agent", getParameters: () => params },
										},
									],
					},
				],
			]);
			const dispose = installAutomaticManagedRehostService();
			try {
				await vi.advanceTimersByTimeAsync(2_300);
				expect(mocks.inspectDisconnectedRecovery).not.toHaveBeenCalled();
				expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
			} finally {
				dispose();
			}
		},
	);

	it("does not replace when socket absence is withdrawn at the fresh observation", async () => {
		mocks.inspectSessionsExact
			.mockResolvedValueOnce([
				{
					outcome: "found",
					session: {
						...staleSourceSession(),
						hostProcessAlive: true,
						hostSocketOwnerAbsent: true,
					},
				},
			])
			.mockResolvedValue([
				{
					outcome: "found",
					session: { ...staleSourceSession(), hostProcessAlive: true },
				},
			]);
		const dispose = installAutomaticManagedRehostService();
		try {
			await vi.advanceTimersByTimeAsync(2_300);
			expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
			expect(mocks.synchronizeRehost).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it.each([undefined, true])(
		"keeps a live pane through a handshake failure with Host liveness %s",
		async (hostProcessAlive) => {
			const agent = sourceAgent();
			useStore.setState({ agentActivity: { [agent.id]: "working" } });
			mocks.inspectSessionsExact.mockResolvedValue([
				{
					outcome: "found",
					session: { ...staleSourceSession(), hostProcessAlive },
				},
			]);
			const dispose = installAutomaticManagedRehostService();
			try {
				await vi.advanceTimersByTimeAsync(2_300);
				expect(mocks.inspectSessionsExact).toHaveBeenCalled();
				expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
				expect(mocks.inspectDisconnectedRecovery).not.toHaveBeenCalled();
				expect(
					getHmuxPaneHealth("desktop-1:agent:agent-reboot"),
				).toBeUndefined();

				mocks.inspectSessionsExact.mockResolvedValue([
					{
						outcome: "found",
						session: {
							...staleSourceSession(),
							hostProcessAlive,
							lifecycle: "ready",
							health: "current_healthy",
							inputAllowed: true,
							detachOnly: false,
						},
					},
				]);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(useStore.getState().agents[0]).toEqual(agent);
				expect(useStore.getState().agentActivity[agent.id]).toBe("working");
				expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
				expect(mocks.synchronizeRehost).not.toHaveBeenCalled();
				expect(emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT)).toEqual(
					[],
				);
			} finally {
				dispose();
			}
		},
	);

	it.each(["rejected", "deferred"])(
		"keeps completed replacement recovering when synchronization is %s, then reconciles without replacing again",
		async (outcome) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			if (outcome === "rejected") {
				mocks.synchronizeRehost.mockRejectedValueOnce(
					new Error("backend unavailable"),
				);
			} else {
				mocks.synchronizeRehost.mockResolvedValueOnce(null);
			}
			const dispose = installAutomaticManagedRehostService();
			try {
				await vi.advanceTimersByTimeAsync(2_300);
				expect(mocks.executeUnavailableRecovery).toHaveBeenCalledOnce();
				expect(getHmuxPaneHealth("desktop-1:agent:agent-reboot")?.state).toBe(
					"recovering",
				);
				expect(emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT)).toEqual(
					[],
				);

				const reconciliation = {
					payload: { schemaVersion: 2, agentId: "agent-reboot" },
					replacement: replacementSession(),
				};
				mocks.reconcileRehost.mockResolvedValue(reconciliation);
				mocks.synchronizeReconciledRehost.mockResolvedValue({
					payload: reconciliation.payload,
				});
				await vi.advanceTimersByTimeAsync(20_000);
				expect(mocks.synchronizeReconciledRehost).toHaveBeenCalledWith(
					reconciliation,
					{ activate: false },
				);
				expect(mocks.executeUnavailableRecovery).toHaveBeenCalledOnce();
				expect(
					emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT).length,
				).toBeGreaterThan(0);
			} finally {
				dispose();
				warning.mockRestore();
			}
		},
	);

	it.each([false, true])(
		"does not overwrite a completed successor's health after late synchronization failure (live frame: %s)",
		async (liveFrame) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			mocks.reconcileRehost.mockResolvedValue({
				payload: { schemaVersion: 2, agentId: "agent-reboot" },
				replacement: replacementSession(),
			});
			mocks.synchronizeReconciledRehost.mockImplementationOnce(async () => {
				if (liveFrame)
					publishHmuxPaneHealthObservation("desktop-1:agent:agent-reboot", {
						kind: "frame_presented",
						terminalEpoch: replacementFence.terminalEpoch,
						sequence: "7",
					});
				throw new Error("backend unavailable");
			});
			const dispose = installAutomaticManagedRehostService();
			try {
				await vi.advanceTimersByTimeAsync(2_300);
				expect(getHmuxPaneHealth("desktop-1:agent:agent-reboot")?.state).toBe(
					liveFrame ? "live" : "recovering",
				);
				expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
				expect(emitCallsFor(mocks.emit, MANAGED_AGENT_REHOSTED_EVENT)).toEqual(
					[],
				);
			} finally {
				dispose();
				warning.mockRestore();
			}
		},
	);

	it("retains a real failure before any completed replacement is observed", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.executeUnavailableRecovery.mockRejectedValueOnce(
			new Error("source stop refused"),
		);
		const dispose = installAutomaticManagedRehostService();
		try {
			await vi.advanceTimersByTimeAsync(2_300);
			expect(getHmuxPaneHealth("desktop-1:agent:agent-reboot")).toMatchObject({
				state: "error",
				reason: "automatic_reboot_recovery_failed",
			});
			expect(mocks.synchronizeRehost).not.toHaveBeenCalled();
		} finally {
			dispose();
			warning.mockRestore();
		}
	});

	it("reconciles a durable successor without making the active desktop authoritative", async () => {
		useStore.setState({ activeSpaceId: "desktop-2" });
		const reconciliation = {
			payload: { schemaVersion: 2, agentId: "agent-reboot" },
			replacement: replacementSession(),
		};
		mocks.reconcileRehost.mockResolvedValueOnce(reconciliation);
		mocks.synchronizeReconciledRehost.mockResolvedValueOnce({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: reconciliation.payload,
		});

		const dispose = installAutomaticManagedRehostService();
		await vi.advanceTimersByTimeAsync(2_300);
		dispose();

		expect(mocks.reconcileRehost).toHaveBeenCalledWith(
			"agent-reboot",
			"agent:agent-reboot",
		);
		expect(mocks.synchronizeReconciledRehost).toHaveBeenCalledWith(
			reconciliation,
			{ activate: false },
		);
		expect(mocks.executeUnavailableRecovery).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			reconciliation.payload,
		);
	});
});
