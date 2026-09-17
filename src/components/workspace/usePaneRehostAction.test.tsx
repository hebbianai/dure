// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import * as refreshTiming from "@/lib/hmux/managed/managedRefreshTiming";
import { invokePaneAction } from "@/lib/workspace/pane/paneActionRegistry";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { usePaneRehostAction } from "./usePaneRehostAction";

const mocks = vi.hoisted(() => ({
	resume: vi.fn(),
	rehost: vi.fn(),
	recovery: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => ({
	resumeExactManagedAgentPane: mocks.resume,
}));
vi.mock("@/lib/sessions/managed/managedBuildRehostWorkflow", () => ({
	rehostManagedBuild: mocks.rehost,
}));
vi.mock("@/lib/sessions/managed/managedBuildRehostAuthority", () => ({
	managedAgentBuildRehostSource: (agent: { id: string }) => agent.id,
}));
vi.mock("@/lib/workspace/pane/paneMenuSignals", () => ({
	requestManagedRecovery: mocks.recovery,
}));
vi.mock("@/lib/workspace/pane/paneHmuxRehostAction", () => ({
	localHmuxRehostWorkflow: vi.fn(),
	executeLocalHmuxPaneRehost: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({
	showToast: vi.fn(),
	showErrorToast: mocks.error,
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("exact Refresh recovery", () => {
	it("accepts diagnostic selection only on the requested Refresh action", async () => {
		const createTiming = vi.spyOn(refreshTiming, "createManagedRefreshTiming");
		const binding = managedBindingFixture();
		const agent = agentFixture({
			runtimeBinding: binding,
			conversationId: "exact-conversation",
		});
		mocks.resume.mockResolvedValue(undefined);
		renderHook(() =>
			usePaneRehostAction({
				agent,
				api: { id: "agent:agent-1" } as IDockviewPanelHeaderProps["api"],
				commitWorkspaceLayout: undefined,
				hmuxBinding: binding,
				paneParamsRef: { current: { binding, sessionId: binding.sessionId } },
			}),
		);
		await act(async () => {
			await invokePaneAction("agent:agent-1", "refresh", {
				brokerTiming: "yes",
			});
		});
		expect(mocks.resume).not.toHaveBeenCalled();
		await act(async () => {
			const result = await invokePaneAction("agent:agent-1", "refresh", {
				brokerTiming: true,
			});
			expect(result).toMatchObject({
				ok: true,
				result: {
					outcome: "applied",
					value: {
						timing: {
							schemaVersion: 1,
							clock: "webview_monotonic",
							checkpoints: [
								{ phase: "action.start", elapsedMs: 0 },
								{ phase: "action.complete", elapsedMs: expect.any(Number) },
							],
						},
					},
				},
			});
		});
		expect(mocks.resume).toHaveBeenLastCalledWith(
			agent.id,
			"agent:agent-1",
			"exact-conversation",
			expect.objectContaining({
				brokerTiming: true,
				timing: expect.any(Object),
			}),
		);
		expect(createTiming).toHaveBeenCalledOnce();
		await act(async () => {
			const result = await invokePaneAction("agent:agent-1", "refresh");
			expect(result).toMatchObject({ result: { outcome: "applied" } });
			if (result.ok) expect(result.result).not.toHaveProperty("value");
		});
		expect(createTiming).toHaveBeenCalledOnce();
		expect(mocks.resume).toHaveBeenLastCalledWith(
			agent.id,
			"agent:agent-1",
			"exact-conversation",
			undefined,
		);
	});
	it.each([
		"hmux_managed_create_resolution_invalid",
		"hmux_managed_launch_failed: the exact completed managed-create generation has exited",
	])("preserves the chosen conversation after %s", async (message) => {
		const binding = managedBindingFixture();
		const agent = agentFixture({
			runtimeBinding: binding,
			conversationId: "exact-conversation",
		});
		mocks.resume.mockRejectedValueOnce(
			new ManagedCreateRetrySameError(
				"create_retryable",
				"managed_create_outcome_unknown",
				message,
			),
		);
		const { result } = renderHook(() =>
			usePaneRehostAction({
				agent,
				api: { id: "agent:agent-1" } as IDockviewPanelHeaderProps["api"],
				commitWorkspaceLayout: undefined,
				hmuxBinding: binding,
				paneParamsRef: { current: { binding, sessionId: binding.sessionId } },
			}),
		);
		act(() => result.current.refreshConversation?.());
		await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
		expect(mocks.resume).toHaveBeenCalledWith(
			agent.id,
			"agent:agent-1",
			"exact-conversation",
			undefined,
		);
		expect(mocks.recovery).not.toHaveBeenCalled();
		expect(mocks.rehost).not.toHaveBeenCalled();
	});
});
