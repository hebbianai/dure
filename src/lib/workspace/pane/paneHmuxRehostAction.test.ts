import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspectStandalone: vi.fn(),
	executeStandalone: vi.fn(),
	executeManaged: vi.fn(),
	upgradeManagedShell: vi.fn(),
	prepareConversion: vi.fn(),
	commitConversion: vi.fn(),
}));

vi.mock("@/lib/hmux/standalone/standaloneHmuxRecovery", () => ({
	inspectStandaloneHmuxRecovery: mocks.inspectStandalone,
	executeStandaloneHmuxRecovery: mocks.executeStandalone,
}));

vi.mock("@/lib/sessions/managed/managedAgentRecoveryReceipt", () => ({
	executeManagedBindingRecovery: mocks.executeManaged,
}));

vi.mock("@/lib/hmux/managed/managedHmuxShellUpgrade", () => ({
	tryUpgradeManagedHmuxShell: mocks.upgradeManagedShell,
}));

vi.mock("@/lib/hmux/conversion/hmuxSessionConversionWorkflow", () => ({
	prepareHmuxSessionConversion: mocks.prepareConversion,
	commitPreparedHmuxSessionConversion: mocks.commitConversion,
}));

import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import { executeLocalHmuxPaneRehost } from "@/lib/workspace/pane/paneHmuxRehostAction";
import { useStore } from "@/store";

const sourceFence = {
	runnerPrincipal: "runner-source",
	runnerInstance: "instance-source",
	channelEpoch: "1",
	hostInstanceId: "host-source",
	terminalEpoch: "terminal-source",
};
const targetFence = {
	runnerPrincipal: "runner-target",
	runnerInstance: "instance-target",
	channelEpoch: "2",
	hostInstanceId: "host-target",
	terminalEpoch: "terminal-target",
};

function managedReceipt(workspaceId: string) {
	return {
		providerId: "codex" as const,
		conversationId: "conversation-1",
		createIdempotencyKey: "create-target",
		credentialId: "account-1",
		replacement: {
			sessionId: "managed-target",
			workspaceId,
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			health: "current_healthy" as const,
			inputAllowed: true,
			detachOnly: false,
			terminalEpoch: targetFence.terminalEpoch,
			stopFence: targetFence,
			outputSeq: "0",
			capabilities: [],
		},
		receipt: {},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.upgradeManagedShell.mockResolvedValue(undefined);
	useStore.setState({
		agents: [],
		sessionAgent: {},
		sessionAgentPin: {},
		sessionCwd: {},
		hmuxSessionMetadata: {},
	});
});

it("executes standalone recovery only when requested", async () => {
	const binding = hmuxStandaloneBinding("standalone-1", "workspace-1");
	const inspection = { plan: { allowed: true } };
	mocks.inspectStandalone.mockResolvedValue(inspection);

	await executeLocalHmuxPaneRehost({
		component: "terminal",
		panelId: "term:1",
		binding,
		readParameters: () => ({ binding }),
		persistParameters: vi.fn(),
	});

	expect(mocks.inspectStandalone).toHaveBeenCalledWith("term:1");
	expect(mocks.executeStandalone).toHaveBeenCalledWith(inspection);
});

it("atomically moves a managed pane to its recovered generation", async () => {
	const binding = {
		...hmuxManagedBinding(
			"managed-source",
			"workspace-1",
			"account-1",
			undefined,
			sourceFence,
		),
		createIdempotencyKey: "create-source",
	};
	mocks.executeManaged.mockResolvedValue(managedReceipt(binding.workspaceId));
	useStore.setState({ sessionCwd: { [binding.sessionId]: "/repo" } });
	let current = { sessionId: binding.sessionId, cwd: "/repo", binding };
	const persistParameters = vi.fn((next) => {
		current = next;
		return true;
	});

	await executeLocalHmuxPaneRehost({
		component: "terminal",
		panelId: "term:1",
		binding,
		readParameters: () => current,
		persistParameters,
	});

	expect(current.sessionId).toBe("managed-target");
	expect(current.binding).toMatchObject({
		sessionId: "managed-target",
		createIdempotencyKey: "create-target",
		stopFence: targetFence,
	});
	expect(useStore.getState().sessionCwd).toEqual({
		"managed-target": "/repo",
	});
	expect(
		useStore.getState().hmuxSessionMetadata[
			hmuxSessionMetadataKey(binding.workspaceId, "managed-target")
		],
	).toBeDefined();
});

it("routes an agentless managed local shell around provider recipe recovery", async () => {
	const binding = {
		...hmuxManagedBinding(
			"term-desk-AZ3_pX",
			"dure-local-shells-v1",
			undefined,
			undefined,
			sourceFence,
		),
		createIdempotencyKey: "shell_term-desk-AZ3_pX",
	};
	mocks.upgradeManagedShell.mockResolvedValue({ ok: true });
	mocks.executeManaged.mockRejectedValue(
		new Error(
			"hmux_managed_rehost_recipe_missing: source predates canonical managed rehost recipe storage",
		),
	);

	await expect(
		executeLocalHmuxPaneRehost({
			component: "terminal",
			panelId: "term:term-desk-AZ3_pX",
			binding,
			readParameters: () => ({ sessionId: binding.sessionId, binding }),
			persistParameters: vi.fn(),
		}),
	).resolves.toBeUndefined();

	expect(mocks.upgradeManagedShell).toHaveBeenCalledWith(
		{
			targetPanelId: "term:term-desk-AZ3_pX",
			confirmRestart: true,
			forceRestart: true,
		},
		expect.any(Function),
	);
	expect(mocks.executeManaged).not.toHaveBeenCalled();
});

it("rehosts a detected provider in a managed local shell through exact conversation conversion", async () => {
	const binding = {
		...hmuxManagedBinding(
			"term-zbO69IzS",
			"dure-local-shells-v1",
			undefined,
			undefined,
			sourceFence,
		),
		createIdempotencyKey: "shell_term-zbO69IzS",
	};
	const prepared = { request: {}, inspection: {} };
	mocks.prepareConversion.mockResolvedValue(prepared);
	mocks.commitConversion.mockResolvedValue({ panelId: "agent:promoted" });
	mocks.upgradeManagedShell.mockRejectedValue(
		new Error("managed Agent panes must use conversation-preserving rehost"),
	);
	useStore.setState({
		sessionAgentPin: { [binding.sessionId]: "codex" },
	});

	await expect(
		executeLocalHmuxPaneRehost({
			component: "terminal",
			panelId: "term:term-zbO69IzS",
			binding,
			readParameters: () => ({ sessionId: binding.sessionId, binding }),
			persistParameters: vi.fn(),
		}),
	).resolves.toBeUndefined();

	expect(mocks.prepareConversion).toHaveBeenCalledWith({
		sourceSessionId: binding.sessionId,
		sourceWorkspaceId: binding.workspaceId,
		panelId: "term:term-zbO69IzS",
		target: "managed",
	});
	expect(mocks.commitConversion).toHaveBeenCalledWith(prepared);
	expect(mocks.upgradeManagedShell).not.toHaveBeenCalled();
	expect(mocks.executeManaged).not.toHaveBeenCalled();
});

it("uses managed Agent recovery after a local shell has been promoted", async () => {
	const binding = {
		...hmuxManagedBinding(
			"managed-promoted",
			"dure-local-shells-v1",
			undefined,
			undefined,
			sourceFence,
		),
		createIdempotencyKey: "convert_promoted",
	};
	mocks.executeManaged.mockResolvedValue(managedReceipt(binding.workspaceId));
	useStore.setState({
		sessionAgentPin: { [binding.sessionId]: "codex" },
	});
	let current = { sessionId: binding.sessionId, binding };

	await executeLocalHmuxPaneRehost({
		component: "agent",
		panelId: "agent:promoted",
		binding,
		readParameters: () => current,
		persistParameters: (next) => {
			current = next as typeof current;
			return true;
		},
	});

	expect(mocks.prepareConversion).not.toHaveBeenCalled();
	expect(mocks.executeManaged).toHaveBeenCalledWith(binding);
	expect(current.sessionId).toBe("managed-target");
});

it("does not overwrite a newer managed generation", async () => {
	const source = hmuxManagedBinding(
		"managed-source",
		"workspace-1",
		"account-1",
		undefined,
		sourceFence,
	);
	const newer = hmuxManagedBinding(
		"managed-newer",
		source.workspaceId,
		"account-1",
		undefined,
		{ ...targetFence, terminalEpoch: "terminal-newer" },
	);
	let finish!: (value: ReturnType<typeof managedReceipt>) => void;
	mocks.executeManaged.mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	let current = { sessionId: source.sessionId, binding: source };
	const persistParameters = vi.fn();
	const request = executeLocalHmuxPaneRehost({
		component: "terminal",
		panelId: "term:1",
		binding: source,
		readParameters: () => current,
		persistParameters,
	});

	current = { sessionId: newer.sessionId, binding: newer };
	finish(managedReceipt(source.workspaceId));
	await request;

	expect(persistParameters).not.toHaveBeenCalled();
	expect(useStore.getState().hmuxSessionMetadata).toEqual({});
});
