import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitManagedCredentialReplacement,
	reconcileManagedCredentialReplacement,
} from "@/lib/sessions/credentials/managedCredentialReplacementRuntime";
import { getManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { managedBindingFixture } from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	emit: vi.fn(),
	execute: vi.fn(),
	payload: vi.fn(),
	reconcile: vi.fn(),
	synchronize: vi.fn(),
	synchronizeReconciled: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@/lib/sessions/managed/managedAgentRehost", () => ({
	executeManagedAgentCredentialSwitch: mocks.execute,
	managedAgentCredentialSwitchSyncPayload: mocks.payload,
	reconcileManagedAgentRehost: mocks.reconcile,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostSynchronization", () => ({
	MANAGED_AGENT_REHOSTED_EVENT: "agent:managed-rehosted:v2",
	commitManagedAgentRehostReceipt: mocks.synchronize,
	commitReconciledManagedAgentRehostReceipt: mocks.synchronizeReconciled,
}));

const sourceBinding = managedBindingFixture({
	sessionId: "session-source",
	workspaceId: "workspace-1",
	credentialId: "account-1",
});

const inspection = {
	agentId: "agent-1",
	agentName: "agent-1",
	projectId: "project-1",
	providerId: "codex" as const,
	sourceBinding,
	sourceCredentialId: "account-1",
	sourceConversationId: "conversation-1",
	targetCredentialId: "account-1",
	targetAccount: undefined,
	conversationId: "conversation-1",
	cwd: "/repo/worktree",
	desktopId: "desktop-1",
	panelId: "agent:agent-1",
	permissionMode: "default" as const,
	terminalEnvironment: {},
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.execute.mockImplementation(
		async (
			_inspection: unknown,
			options?: { beforeStop?: () => unknown | Promise<unknown> },
		) => {
			await options?.beforeStop?.();
			return { recovery: {} };
		},
	);
	const payload = {
		agentId: "agent-1",
		operationId: "credential-replacement-1",
		binding: managedBindingFixture({ sessionId: "session-successor" }),
	};
	mocks.payload.mockReturnValue(payload);
	mocks.synchronize.mockResolvedValue({
		projection: "applied",
		presentation: "applied",
		pane: { panelId: "agent:agent-1" },
		payload,
	});
	mocks.synchronizeReconciled.mockResolvedValue({
		projection: "applied",
		presentation: "applied",
		pane: { panelId: "agent:agent-1" },
		payload,
	});
	mocks.reconcile.mockResolvedValue(null);
	mocks.emit.mockResolvedValue(undefined);
});

describe("managed credential replacement runtime", () => {
	it("finishes replacement cleanup when its window notification fails", async () => {
		mocks.emit.mockRejectedValueOnce(new Error("WebView notification lost"));
		const afterCommit = vi.fn();

		await expect(
			commitManagedCredentialReplacement(inspection, { afterCommit }),
		).resolves.toBeUndefined();

		expect(mocks.execute).toHaveBeenCalledOnce();
		expect(afterCommit).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
	});

	it("returns a reconciled successor when its window notification fails", async () => {
		const reconciliation = { payload: mocks.payload() };
		mocks.reconcile.mockResolvedValueOnce(reconciliation);
		mocks.emit.mockRejectedValueOnce(new Error("WebView notification lost"));

		await expect(
			reconcileManagedCredentialReplacement("agent-1", "agent:agent-1"),
		).resolves.toBe(reconciliation);

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
	});

	it("reconciles a durable receipt without executing another replacement", async () => {
		const reconciliation = { payload: { agentId: "agent-1" } };
		mocks.reconcile.mockResolvedValueOnce(reconciliation);

		await expect(
			reconcileManagedCredentialReplacement("agent-1", "agent:agent-1"),
		).resolves.toBe(reconciliation);

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.synchronizeReconciled).toHaveBeenCalledWith(reconciliation);
		expect(mocks.emit).toHaveBeenCalledOnce();
	});

	it("keeps a committed credential replacement successful while its pane is unmounted", async () => {
		const afterCommit = vi.fn();
		mocks.synchronize.mockResolvedValueOnce({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: { agentId: "agent-1" },
		});

		await expect(
			commitManagedCredentialReplacement(inspection, {
				afterCommit,
			}),
		).resolves.toBeUndefined();

		expect(mocks.emit).toHaveBeenCalledOnce();
		expect(afterCommit).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
	});

	it("keeps a replayed credential receipt successful while its pane is unmounted", async () => {
		const reconciliation = { payload: { agentId: "agent-1" } };
		mocks.reconcile.mockResolvedValueOnce(reconciliation);
		mocks.synchronizeReconciled.mockResolvedValueOnce({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload: { agentId: "agent-1" },
		});

		await expect(
			reconcileManagedCredentialReplacement("agent-1", "agent:agent-1"),
		).resolves.toBe(reconciliation);

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.emit).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
	});

	it("runs post-commit projection cleanup before releasing the transition", async () => {
		const afterCommit = vi.fn(() => {
			expect(getManagedCredentialSwitchTransition("agent-1")).toBe(true);
		});

		await commitManagedCredentialReplacement(inspection, {
			afterCommit,
		});

		expect(afterCommit).toHaveBeenCalledOnce();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
	});
});
