// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { IDockviewPanelHeaderProps } from "dockview-react";
import { afterEach, expect, it, vi } from "vitest";
import { usePaneRehostAction } from "@/components/workspace/usePaneRehostAction";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import { registerPaneActions } from "@/lib/workspace/pane/paneActionRegistry";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const mocks = vi.hoisted(() => ({
	resume: vi.fn(async () => {}),
	localRehost: vi.fn<
		typeof import("@/lib/workspace/pane/paneHmuxRehostAction").executeLocalHmuxPaneRehost
	>(async () => {}),
}));
vi.mock("@/lib/sessions/managed/managedExactConversationResume", () => ({
	resumeExactManagedAgentPane: mocks.resume,
}));
vi.mock(
	"@/lib/workspace/pane/paneHmuxRehostAction",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/pane/paneHmuxRehostAction")
		>()),
		executeLocalHmuxPaneRehost: mocks.localRehost,
	}),
);
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanup();
	for (const remove of cleanups.splice(0)) remove();
	vi.clearAllMocks();
});
const paneId = "pane-rehost";
const api = {
	id: paneId,
	component: "agent",
} as IDockviewPanelHeaderProps["api"];

it.each(["runtime", "conversation", "decoration"])(
	"pins Refresh across a %s change without confusing it with a render",
	async (change) => {
		const binding = managedBindingFixture();
		const before = managedAgentFixture({
			runtimeBinding: binding,
			conversationId: "original-conversation",
		});
		const after =
			change === "runtime"
				? {
						...before,
						sessionId: "replacement-session",
						runtimeBinding: { ...binding, sessionId: "replacement-session" },
					}
				: change === "conversation"
					? { ...before, conversationId: "replacement-conversation" }
					: { ...before, name: "updated decoration" };
		cleanups.push(
			registerPaneActions({
				paneId,
				owner: {},
				status: "attached",
				actions: {},
			}),
		);
		const hook = renderHook(
			({ agent }) =>
				usePaneRehostAction({
					agent,
					api,
					commitWorkspaceLayout: undefined,
					hmuxBinding: agent.runtimeBinding,
					paneParamsRef: {
						current: {
							binding: agent.runtimeBinding,
							sessionId: agent.sessionId,
						},
					},
				}),
			{ initialProps: { agent: before } },
		);
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		let pending: Promise<boolean>;
		act(() => {
			pending = dispatchCliPaneActionRequest(
				{
					reqId: "refresh-claim",
					action: "pane.act",
					params: { targetPanelId: paneId, actionId: "refresh" },
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
		if (change === "decoration") {
			expect(mocks.resume).toHaveBeenCalledExactlyOnceWith(
				before.id,
				paneId,
				"original-conversation",
				undefined,
			);
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
		} else {
			expect(mocks.resume).not.toHaveBeenCalled();
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
		}
	},
);

it.each(["session", "generation", "conversation", "metadata"])(
	"uses the explicit terminal source for non-Agent rehost (%s)",
	async (change) => {
		const before = managedBindingFixture({
			stopFence: stopFenceFixture(),
			conversationIdentity: {
				...stopFenceFixture(),
				schemaVersion: 1,
				sessionId: "session-1",
				workspaceId: "workspace-1",
				revision: "1",
				observedThroughOutputSeq: "5",
				providerId: "codex",
				conversationId: "original-conversation",
				source: "provider_event",
			},
		});
		const after =
			change === "session"
				? { ...before, sessionId: "next-session" }
				: change === "generation"
					? {
							...before,
							stopFence: stopFenceFixture({ terminalEpoch: "next-terminal" }),
						}
					: change === "conversation"
						? {
								...before,
								conversationIdentity: {
									...before.conversationIdentity!,
									conversationId: "replacement-conversation",
								},
							}
						: {
								...before,
								stopFence: { ...before.stopFence! },
								conversationIdentity: {
									...before.conversationIdentity!,
									revision: "2",
									observedThroughOutputSeq: "10",
								},
								credentialId: "refreshed-legacy-display",
							};
		cleanups.push(
			registerPaneActions({
				paneId,
				owner: {},
				status: "attached",
				actions: {},
			}),
		);
		const terminalApi = { ...api, component: "terminal" };
		const hook = renderHook(
			({ binding }) =>
				usePaneRehostAction({
					agent: undefined,
					api: terminalApi,
					commitWorkspaceLayout: undefined,
					hmuxBinding: binding,
					paneParamsRef: { current: { binding, sessionId: binding.sessionId } },
				}),
			{ initialProps: { binding: before } },
		);
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		let pending: Promise<boolean>;
		act(() => {
			pending = dispatchCliPaneActionRequest(
				{
					reqId: "terminal-rehost-claim",
					action: "pane.act",
					params: { targetPanelId: paneId, actionId: "rehost" },
				},
				{
					claim: async () => {
						act(() => hook.rerender({ binding: after }));
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
		if (change === "metadata") {
			expect(mocks.localRehost).toHaveBeenCalledOnce();
			expect(mocks.localRehost.mock.calls[0][0]).toMatchObject({
				panelId: paneId,
				component: "terminal",
				binding: after,
			});
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
		} else {
			expect(mocks.localRehost).not.toHaveBeenCalled();
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
		}
	},
);
