// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePanePermissionModeActions } from "@/components/workspace/usePanePermissionModeActions";
import { dispatchCliPaneActionRequest } from "@/lib/cli/cliPaneActions";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({ inspect: vi.fn() }));
vi.mock(
	"@/lib/sessions/managed/managedAgentRehost",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/sessions/managed/managedAgentRehost")
		>()),
		inspectManagedAgentRehost: mocks.inspect,
	}),
);
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

it.each(["runtime", "conversation", "name"])(
	"keeps permission relaunch on its claimed recipient (%s)",
	async (change) => {
		const before = managedAgentFixture({
			conversationId: "original-conversation",
		});
		const after =
			change === "runtime"
				? {
						...before,
						sessionId: "replacement-session",
						runtimeBinding: managedBindingFixture({
							sessionId: "replacement-session",
						}),
					}
				: change === "conversation"
					? { ...before, conversationId: "replacement-conversation" }
					: { ...before, name: "updated name" };
		const paneId = "pane-permission-claim";
		const removeStatus = registerPaneActions({
			paneId,
			owner: {},
			status: "attached",
			actions: {},
		});
		// Stop at the actual inspection boundary; this fixture never launches a provider.
		mocks.inspect.mockRejectedValue(
			new Error("fixture inspection unavailable"),
		);
		const hook = renderHook(
			({ agent }) =>
				usePanePermissionModeActions({
					agent,
					binding: agent.runtimeBinding,
					paneId,
				}),
			{ initialProps: { agent: before } },
		);
		const complete = vi.fn(async () => {});
		try {
			let pending: Promise<boolean>;
			act(() => {
				pending = dispatchCliPaneActionRequest(
					{
						reqId: "permission-claim",
						action: "pane.act",
						params: {
							targetPanelId: paneId,
							actionId: "permission_mode:default",
						},
					},
					{
						claim: async () => {
							act(() => hook.rerender({ agent: after }));
							return true;
						},
						complete,
						isFallbackWindow: () => false,
						delay: async () => {},
					},
				);
			});
			await act(async () => {
				await pending;
			});
			if (change === "name") {
				expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(
					before.id,
					paneId,
				);
				expect(complete).toHaveBeenCalledWith(
					"permission-claim",
					{
						ok: false,
						error: expect.objectContaining({
							code: "pane_action_failed",
							message: "fixture inspection unavailable",
						}),
					},
					"pane.act",
				);
			} else {
				expect(mocks.inspect).not.toHaveBeenCalled();
				expect(complete).toHaveBeenCalledWith(
					"permission-claim",
					{
						ok: false,
						error: expect.objectContaining({ code: "pane_changed" }),
					},
					"pane.act",
				);
			}
		} finally {
			removeStatus();
		}
	},
);
