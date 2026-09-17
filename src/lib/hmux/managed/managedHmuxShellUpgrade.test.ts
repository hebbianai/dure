import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createManagedShell: vi.fn(),
	stopManaged: vi.fn(),
	stopManagedCreateChain: vi.fn(),
	inspectExact: vi.fn(),
	resolvePaneById: vi.fn(),
	commitMutation: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		createManagedShell: mocks.createManagedShell,
		stopManaged: mocks.stopManaged,
		stopManagedCreateChain: mocks.stopManagedCreateChain,
	},
	homeDir: vi.fn(async () => "/Users/test"),
}));

vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: mocks.inspectExact,
}));

vi.mock("@/lib/workspace/dock", () => ({
	resolvePaneById: mocks.resolvePaneById,
}));

vi.mock("@/lib/workspace/dock/dockPanelParameters", () => ({
	dockPanelParameters: (panel: { params?: unknown }) => panel.params ?? {},
}));

vi.mock("@/lib/workspace/dock/explicitDockviewCommit", () => ({
	commitExplicitDockviewMutation: mocks.commitMutation,
}));

vi.mock("@/lib/theme/themePreference", () => ({
	currentTerminalDefaultColors: () => ({
		foreground: "#ffffff",
		background: "#000000",
	}),
}));

import { tryUpgradeManagedHmuxShell } from "@/lib/hmux/managed/managedHmuxShellUpgrade";
import {
	hmuxLocalBinding,
	hmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import { stopFenceFixture } from "@/test/agentFixtures";

const sourceFence = stopFenceFixture({
	hostInstanceId: "host-source",
	terminalEpoch: "terminal-source",
});
const targetFence = stopFenceFixture({
	hostInstanceId: "host-target",
	terminalEpoch: "terminal-target",
});

function shellBinding() {
	return {
		...hmuxManagedBinding(
			"term-desk-AZ3_pX",
			"dure-local-shells-v1",
			undefined,
			undefined,
			sourceFence,
		),
		createIdempotencyKey: "shell_term-desk-AZ3_pX",
	};
}

function installShellPane(sourceBinding = shellBinding(), panelId = "term:term-desk-AZ3_pX") {
	const panel = {
		id: panelId,
		params: {
			sessionId: sourceBinding.sessionId,
			cwd: "/Users/test/project",
			binding: sourceBinding,
		},
		api: {
			component: "terminal",
			getParameters: vi.fn(() => ({})),
			updateParameters: vi.fn((params) => {
				panel.params = { ...panel.params, ...params };
			}),
			setActive: vi.fn(),
		},
	};
	mocks.resolvePaneById.mockResolvedValue({
		desktopId: "desktop-1",
		panelId,
		api: { getPanel: vi.fn(() => panel) },
	});
	return { panel, sourceBinding };
}

function installCreatedShellReceipt() {
	mocks.createManagedShell.mockImplementation(async (request) => ({
		idempotencyKey: request.idempotencyKey,
		outcome: "created",
		session: {
			sessionId: request.sessionId,
			workspaceId: request.workspaceId,
			sessionClass: "managed",
			lifecycle: "ready",
			manifestLifecycle: "ready",
			health: "current_healthy",
			inputAllowed: true,
			detachOnly: false,
			terminalEpoch: targetFence.terminalEpoch,
			stopFence: targetFence,
			outputSeq: "0",
			capabilities: ["terminal_state_binary_v1"],
		},
	}));
}

describe("managed Hmux shell upgrade", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useStore.setState({
			agents: [],
			sessionAgent: {},
			sessionAgentPin: {},
			sessionCwd: {},
			hmuxSessionMetadata: {},
		});
		mocks.commitMutation.mockImplementation(
			({ mutate }: { mutate: () => unknown }) => mutate(),
		);
		mocks.stopManaged.mockResolvedValue({ outcome: "already_exited" });
		mocks.stopManagedCreateChain.mockResolvedValue({});
	});

	it.each(["term:term-desk-AZ3_pX", "slot", "launcher:previous", "agent:previous"])("replaces the exact managed shell in terminal content at %s", async (panelId) => {
		const { panel, sourceBinding } = installShellPane(undefined, panelId);
		mocks.inspectExact.mockResolvedValue({
			sessionId: sourceBinding.sessionId,
			workspaceId: sourceBinding.workspaceId,
			sessionClass: "managed",
			lifecycle: "unavailable",
			manifestLifecycle: "ready",
			health: "stale_transport",
			inputAllowed: false,
			detachOnly: true,
			terminalEpoch: sourceFence.terminalEpoch,
			stopFence: sourceFence,
			outputSeq: "42",
			capabilities: [],
		});
		installCreatedShellReceipt();

		const result = await tryUpgradeManagedHmuxShell(
			{
				targetPanelId: panelId,
				confirmRestart: true,
				activate: false,
			},
			async () => true,
		);

		expect(result?.upgrade.outcome).toBe("rehosted");
		expect(mocks.createManagedShell).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: "dure-local-shells-v1",
				cwd: "/Users/test/project",
			}),
		);
		expect(panel.params).toMatchObject({
			sessionId: expect.stringMatching(/^managed_shell_/),
			binding: {
				runtime: "hmux_managed_v1",
				stopFence: targetFence,
			},
		});
		expect(panel.api.setActive).not.toHaveBeenCalled();
		expect(mocks.stopManagedCreateChain).toHaveBeenCalledWith(
			sourceBinding.createIdempotencyKey,
			sourceBinding.sessionId,
			sourceBinding.workspaceId,
		);
	});

	it("rehosts a healthy current-build shell when the pane action explicitly requests restart", async () => {
		const { sourceBinding } = installShellPane();
		mocks.inspectExact.mockResolvedValue({
			sessionId: sourceBinding.sessionId,
			workspaceId: sourceBinding.workspaceId,
			sessionClass: "managed",
			lifecycle: "ready",
			manifestLifecycle: "ready",
			health: "current_healthy",
			inputAllowed: true,
			detachOnly: false,
			terminalEpoch: sourceFence.terminalEpoch,
			stopFence: sourceFence,
			outputSeq: "42",
			capabilities: ["terminal_state_binary_v1"],
		});
		installCreatedShellReceipt();

		const result = await tryUpgradeManagedHmuxShell(
			{
				targetPanelId: "term:term-desk-AZ3_pX",
				confirmRestart: true,
				forceRestart: true,
			},
			async () => true,
		);

		expect(result?.upgrade.outcome).toBe("rehosted");
		expect(mocks.createManagedShell).toHaveBeenCalledOnce();
		expect(mocks.stopManagedCreateChain).toHaveBeenCalledWith(
			sourceBinding.createIdempotencyKey,
			sourceBinding.sessionId,
			sourceBinding.workspaceId,
		);
	});

	it("rehosts from the pane's exact fence after the source manifest disappears", async () => {
		const { sourceBinding } = installShellPane();
		mocks.inspectExact.mockResolvedValue(undefined);
		installCreatedShellReceipt();

		const result = await tryUpgradeManagedHmuxShell(
			{
				targetPanelId: "term:term-desk-AZ3_pX",
				confirmRestart: true,
				forceRestart: true,
			},
			async () => true,
		);

		expect(result?.upgrade.outcome).toBe("rehosted");
		expect(mocks.createManagedShell).toHaveBeenCalledOnce();
		expect(mocks.stopManagedCreateChain).toHaveBeenCalledWith(
			sourceBinding.createIdempotencyKey,
			sourceBinding.sessionId,
			sourceBinding.workspaceId,
		);
	});

	it.each([undefined, "original-shell-create"])(
		"finishes pending cleanup after reboot (create identity: %s)",
		async (sourceCreateIdempotencyKey) => {
			const targetBinding = {
				...hmuxManagedBinding(
					"managed-shell-target",
					"dure-local-shells-v1",
					undefined,
					undefined,
					targetFence,
				),
				createIdempotencyKey: "upgrade-shell-target",
			};
			const { panel } = installShellPane(targetBinding);
			(panel.params as Record<string, unknown>).managedShellUpgrade = {
				schemaVersion: 1,
				operationId: "upgrade-before-reboot",
				sourceSessionId: "source-before-reboot",
				sourceWorkspaceId: "dure-local-shells-v1",
				sourceStopFence: sourceFence,
				sourceCreateIdempotencyKey,
				targetSessionId: targetBinding.sessionId,
				targetWorkspaceId: targetBinding.workspaceId,
			};
			mocks.inspectExact.mockResolvedValue(undefined);

			const result = await tryUpgradeManagedHmuxShell(
				{
					targetPanelId: "term:term-desk-AZ3_pX",
					confirmRestart: true,
					forceRestart: true,
					activate: false,
				},
				async () => true,
			);

			expect(result?.upgrade).toMatchObject({
				outcome: "rehosted",
				replayed: true,
			});
			expect(mocks.stopManaged).not.toHaveBeenCalled();
			if (sourceCreateIdempotencyKey) {
				expect(mocks.stopManagedCreateChain).toHaveBeenCalledWith(
					sourceCreateIdempotencyKey,
					"source-before-reboot",
					"dure-local-shells-v1",
				);
			} else {
				expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
			}
			expect(mocks.createManagedShell).not.toHaveBeenCalled();
			expect(
				(panel.params as Record<string, unknown>).managedShellUpgrade,
			).toBeUndefined();
		},
	);

	it("retains exact-generation cleanup for an observed shell without create authority", async () => {
		const { panel, sourceBinding } = installShellPane();
		(panel.params as Record<string, unknown>).binding = hmuxLocalBinding(
			sourceBinding.sessionId,
			sourceBinding.workspaceId,
		);
		mocks.inspectExact.mockResolvedValue({
			sessionClass: "managed",
			lifecycle: "unavailable",
			manifestLifecycle: "ready",
			stopFence: sourceFence,
		});
		installCreatedShellReceipt();
		await tryUpgradeManagedHmuxShell(
			{
				targetPanelId: "term:term-desk-AZ3_pX",
				confirmRestart: true,
			},
			async () => true,
		);
		expect(mocks.stopManagedCreateChain).not.toHaveBeenCalled();
		expect(mocks.stopManaged).toHaveBeenCalledWith(
			expect.stringMatching(/^stop_upgrade_shell_/),
			sourceBinding.sessionId,
			sourceBinding.workspaceId,
			sourceFence,
		);
	});
});
