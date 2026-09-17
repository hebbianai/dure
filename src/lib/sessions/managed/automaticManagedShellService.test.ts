// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getFrameBudgetScheduler,
	resetFrameBudgetSchedulerForTest,
} from "@/lib/scheduling/frameBudgetScheduler";
import { installAutomaticManagedShellService } from "@/lib/sessions/managed/automaticManagedShellService";
import { resetManagedControlPlaneObservationForTest } from "@/lib/sessions/managed/managedControlPlaneObservation";
import {
	clearHmuxPaneHealth,
	getHmuxPaneHealth,
} from "@/lib/terminal/hmuxPaneHealthStore";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import { stopFenceFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	inspectSessionsExact: vi.fn(),
	inspectStandaloneRecovery: vi.fn(),
	executeStandaloneRecovery: vi.fn(),
	upgradeManagedShell: vi.fn(),
	promote: vi.fn(),
	sweep: vi.fn(),
	stop: vi.fn(),
	publish: vi.fn(),
	visibleDesktopIds: new Set<string>(),
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
		visibleDesktopIds: new Set(mocks.visibleDesktopIds),
	}),
}));

vi.mock("@/lib/hmux/standalone/standaloneHmuxRecovery", () => ({
	inspectStandaloneHmuxRecovery: mocks.inspectStandaloneRecovery,
	executeStandaloneHmuxRecovery: mocks.executeStandaloneRecovery,
}));

vi.mock("@/lib/hmux/managed/managedHmuxShellUpgrade", () => ({
	tryUpgradeManagedHmuxShell: mocks.upgradeManagedShell,
}));

vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	mountedDockviewEntries: () => [],
}));

vi.mock("@/lib/hmux/standalone/hmuxStandaloneRollout", () => ({
	hmuxManagedShellReady: () => Promise.resolve(true),
}));

vi.mock("@/lib/workspace/layout/layoutPushChannel", () => ({
	publishLayoutPush: mocks.publish,
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		inspectSessionsExact: mocks.inspectSessionsExact,
		promoteAppStandaloneShell: mocks.promote,
		sweepAppStandaloneShell: mocks.sweep,
		stopManaged: mocks.stop,
	},
}));

const source = hmuxStandaloneBinding("source-session", "workspace-1");
const targetStopFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "target-epoch",
});

function sourceLayout() {
	return {
		panels: {
			"term:source-session": {
				contentComponent: "terminal",
				params: {
					sessionId: source.sessionId,
					cwd: "/repo",
					binding: source,
				},
			},
		},
	};
}

function sourceSession(patch: Record<string, unknown> = {}) {
	return {
		sessionId: source.sessionId,
		workspaceId: source.workspaceId,
		sessionClass: "standalone" as const,
		lifecycle: "ready" as const,
		manifestLifecycle: "ready" as const,
		health: "current_healthy" as const,
		inputAllowed: true,
		detachOnly: false,
		terminalEpoch: "source-epoch",
		outputSeq: "1",
		capabilities: [],
		retirementPolicy: {
			kind: "after_graceful_last_client_departure_v1" as const,
			gracePeriodMs: 2_000,
		},
		...patch,
	};
}

function promotionReceipt() {
	return {
		sourceSessionId: source.sessionId,
		sourceWorkspaceId: source.workspaceId,
		sourceTerminalEpoch: "source-epoch",
		cwd: "/repo",
		target: {
			idempotencyKey: "promote_shell_test",
			outcome: "created" as const,
			session: {
				...sourceSession(),
				sessionId: "managed-target",
				sessionClass: "managed" as const,
				terminalEpoch: "target-epoch",
				stopFence: targetStopFence,
				retirementPolicy: undefined,
			},
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	resetFrameBudgetSchedulerForTest();
	vi.setSystemTime(new Date("2026-07-31T00:00:00Z"));
	mocks.visibleDesktopIds.clear();
	// 고정 epoch 재설정 아래에서 이전 테스트의 공유 관측 캐시가 TTL 안으로
	// 보일 수 있다 — 테스트마다 모듈 전역 상태를 격리한다.
	resetManagedControlPlaneObservationForTest();
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	mocks.inspectSessionsExact.mockResolvedValue([
		{ outcome: "found", session: sourceSession() },
	]);
	mocks.promote.mockResolvedValue(promotionReceipt());
	mocks.sweep.mockResolvedValue({ state: "retirement_armed" });
	clearHmuxPaneHealth("desktop-1:term:managed-shell-source");
	clearHmuxPaneHealth("desktop-1:term:source-session");
	useStore.setState({
		spaces: [{ id: "desktop-1", name: "Desktop" }] as never,
		activeSpaceId: "another-desktop",
		layouts: { "desktop-1": sourceLayout() },
		agents: [],
		sessionAgent: {},
		sessionAgentPin: {},
		hmuxSessionMetadata: {},
	});
});

afterEach(() => {
	vi.clearAllMocks();
	resetFrameBudgetSchedulerForTest();
	vi.useRealTimers();
});

describe("automatic managed shell service", () => {
	it("coalesces focus and visibility wakes behind foreground admission", async () => {
		const scheduler = getFrameBudgetScheduler();
		const dispose = installAutomaticManagedShellService();
		try {
			scheduler.notifyInteraction("desktop-switch-start");
			window.dispatchEvent(new Event("focus"));
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(50);
			expect(mocks.inspectSessionsExact).not.toHaveBeenCalled();
			expect(scheduler.getTelemetry().maintenance.pending).toBe(1);
			scheduler.notifyInteraction("desktop-switch-settled");
			await vi.advanceTimersByTimeAsync(600);
			expect(mocks.inspectSessionsExact).toHaveBeenCalledOnce();
			expect(mocks.promote).not.toHaveBeenCalled();
		} finally {
			dispose();
		}
	});

	it("rehosts a visible reboot-stale managed shell without a click", async () => {
		const sourceFence = stopFenceFixture({
			terminalEpoch: "managed-shell-before-reboot",
		});
		const binding = {
			...hmuxManagedBinding(
				"managed-shell-source",
				"dure-local-shells-v1",
				undefined,
				undefined,
				sourceFence,
			),
			createIdempotencyKey: "shell_managed-shell-source",
		};
		mocks.visibleDesktopIds.add("desktop-1");
		mocks.inspectSessionsExact.mockResolvedValue([
			{
				outcome: "found",
				session: {
					...sourceSession({
						sessionId: binding.sessionId,
						workspaceId: binding.workspaceId,
						sessionClass: "managed",
						lifecycle: "unavailable",
						health: "stale_transport",
						hostProcessAlive: false,
						inputAllowed: false,
						detachOnly: true,
						terminalEpoch: sourceFence.terminalEpoch,
						stopFence: sourceFence,
					}),
				},
			},
		]);
		useStore.setState({
			layouts: {
				"desktop-1": {
					panels: {
						"term:managed-shell-source": {
							contentComponent: "terminal",
							params: {
								sessionId: binding.sessionId,
								cwd: "/repo",
								binding,
							},
						},
					},
				},
			},
		});
		mocks.upgradeManagedShell.mockImplementation(
			async (_params, claim: () => Promise<boolean>) =>
				(await claim()) ? { upgrade: { outcome: "rehosted" } } : null,
		);

		const dispose = installAutomaticManagedShellService();
		await vi.advanceTimersByTimeAsync(2_300);
		dispose();

		expect(mocks.upgradeManagedShell).toHaveBeenCalledWith(
			{
				targetPanelId: "term:managed-shell-source",
				confirmRestart: true,
				forceRestart: true,
				activate: false,
			},
			expect.any(Function),
		);
		expect(
			getHmuxPaneHealth("desktop-1:term:managed-shell-source")?.state,
		).toBe("recovering");
	});

	it("recovers a visible reboot-stale standalone pane without a click", async () => {
		mocks.visibleDesktopIds.add("desktop-1");
		mocks.inspectSessionsExact.mockResolvedValue([
			{
				outcome: "found",
				session: sourceSession({
					lifecycle: "unavailable",
					health: "stale_transport",
					hostProcessAlive: false,
					inputAllowed: false,
					detachOnly: true,
				}),
			},
		]);
		const inspection = {
			source: {
				desktopId: "desktop-1",
				panelId: "term:source-session",
				sessionId: source.sessionId,
				workspaceId: source.workspaceId,
			},
			plan: { action: "restore_plain_shell_with_current_build" },
		};
		mocks.inspectStandaloneRecovery.mockResolvedValue(inspection);
		mocks.executeStandaloneRecovery.mockResolvedValue({
			pane: { sessionId: "replacement-session" },
		});

		const dispose = installAutomaticManagedShellService();
		await vi.advanceTimersByTimeAsync(2_300);
		dispose();

		expect(mocks.inspectStandaloneRecovery).toHaveBeenCalledWith(
			"term:source-session",
		);
		expect(mocks.executeStandaloneRecovery).toHaveBeenCalledWith(inspection);
		expect(getHmuxPaneHealth("desktop-1:term:source-session")?.state).toBe(
			"recovering",
		);
	});

	it("promotes after dwell, journals the layout, then retires the exact source", async () => {
		const dispose = installAutomaticManagedShellService();
		// 마지막 틱 발화 + maintenance 레인 슬라이스(폴백 시계 250ms 이내) 경과.
		await vi.advanceTimersByTimeAsync(20_000 + 300);
		dispose();

		expect(mocks.promote).toHaveBeenCalledOnce();
		expect(mocks.sweep).toHaveBeenCalledWith(
			"source-session",
			"workspace-1",
			"source-epoch",
			"managed-target",
			"workspace-1",
			"target-epoch",
		);
		const params = (
			useStore.getState().layouts["desktop-1"] as ReturnType<
				typeof sourceLayout
			>
		).panels["term:source-session"].params as Record<string, unknown>;
		expect(params).toMatchObject({
			sessionId: "managed-target",
			binding: {
				runtime: "hmux_managed_v1",
				sessionId: "managed-target",
				createIdempotencyKey: "promote_shell_test",
				stopFence: targetStopFence,
			},
		});
		expect(params.managedShellMigration).toBeUndefined();
		expect(mocks.publish).toHaveBeenCalled();
	});

	it("keeps a busy-source marker and retries retirement without creating twice", async () => {
		mocks.sweep
			.mockResolvedValueOnce({
				state: "session_preserved",
				reason: "provider_busy",
			})
			.mockResolvedValueOnce({ state: "retirement_armed" });
		const dispose = installAutomaticManagedShellService();
		await vi.advanceTimersByTimeAsync(20_000 + 300);
		const pendingParams = (
			useStore.getState().layouts["desktop-1"] as ReturnType<
				typeof sourceLayout
			>
		).panels["term:source-session"].params as Record<string, unknown>;
		expect(pendingParams.managedShellMigration).toBeDefined();

		await vi.advanceTimersByTimeAsync(5_000 + 300);
		dispose();

		expect(mocks.promote).toHaveBeenCalledOnce();
		expect(mocks.sweep).toHaveBeenCalledTimes(2);
		const settledParams = (
			useStore.getState().layouts["desktop-1"] as ReturnType<
				typeof sourceLayout
			>
		).panels["term:source-session"].params as Record<string, unknown>;
		expect(settledParams.managedShellMigration).toBeUndefined();
	});
});
