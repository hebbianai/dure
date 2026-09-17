// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { useAgentPanelState } from "@/components/panels/useAgentPanelState";
import {
	type CliPaneActionDependencies,
	dispatchCliPaneActionRequest,
} from "@/lib/cli/cliPaneActions";
import {
	paneActionSnapshot,
	registerPaneActions,
} from "@/lib/workspace/pane/paneActionRegistry";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const originalAgents = useStore.getState().agents;
const cleanups: (() => void)[] = [];
afterEach(() => {
	cleanup();
	for (const remove of cleanups.splice(0)) remove();
	useStore.setState({ agents: originalAgents });
});
const paneId = "pane-projected-owner";
const agentId = "agent-projected-owner";
function agent(sessionId: string) {
	return managedAgentFixture({
		id: agentId,
		sessionId,
		conversationId: "original-conversation",
		runtimeBinding: managedBindingFixture({ sessionId }),
	});
}

it.each(["runtime", "conversation", "name"])(
	"carries the committed action target into the real setting registration (%s)",
	async (change) => {
		const before = agent("original-session");
		useStore.setState({ agents: [before] });
		cleanups.push(
			registerPaneActions({
				paneId,
				owner: {},
				status: "attached",
				actions: {},
			}),
		);
		const execute = vi.fn(
			async (_sessionId?: string, _conversationId?: string) => ({
				outcome: "applied" as const,
			}),
		);
		function RuntimeControls() {
			const controller = useAgentPanelState(agentId, paneId);
			const sessionId = controller.agent?.sessionId;
			return (
				<AgentLaunchSelectionControls
					provider="codex"
					launch={{
						...controller.launchSelection,
						switchSelection: () =>
							execute(sessionId, controller.agent?.conversationId),
					}}
					busy={false}
				/>
			);
		}
		render(<RuntimeControls />);
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		await dispatchCliPaneActionRequest(
			{
				reqId: "projected-owner-claim",
				action: "pane.act",
				params: {
					targetPanelId: paneId,
					actionId: "settings.permission",
					arguments: { value: "default" },
				},
			},
			{
				claim: async () => {
					act(() =>
						useStore.setState({
							agents: [
								change === "runtime"
									? agent("replacement-session")
									: change === "conversation"
										? { ...before, conversationId: "replacement-conversation" }
										: { ...before, name: "updated name" },
							],
						}),
					);
					return true;
				},
				complete,
				isFallbackWindow: () => false,
				delay: async () => {},
			},
		);
		if (change !== "name") {
			expect(execute).not.toHaveBeenCalled();
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: false });
		} else {
			expect(execute).toHaveBeenCalledExactlyOnceWith(
				"original-session",
				"original-conversation",
			);
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
		}
	},
);

it.each(["conversation", "metadata"])(
	"projects the canonical conversation and qualifies its claimed action (%s)",
	async (change) => {
		const before = agent("original-session");
		const binding = managedBindingFixture({
			sessionId: before.sessionId,
			conversationIdentity: {
				...stopFenceFixture(),
				schemaVersion: 1,
				sessionId: before.sessionId,
				workspaceId: "workspace-1",
				revision: "1",
				observedThroughOutputSeq: "5",
				providerId: "codex",
				conversationId: "canonical-conversation",
				source: "provider_event",
			},
		});
		useStore.setState({ agents: [{ ...before, runtimeBinding: binding }] });
		cleanups.push(
			registerPaneActions({
				paneId,
				owner: {},
				status: "attached",
				actions: {},
			}),
		);
		const execute = vi.fn(async () => ({ outcome: "applied" as const }));
		function Controls() {
			const controller = useAgentPanelState(agentId, paneId);
			return (
				<AgentLaunchSelectionControls
					provider="codex"
					launch={{ ...controller.launchSelection, switchSelection: execute }}
					busy={false}
				/>
			);
		}
		render(<Controls />);
		expect(
			paneActionSnapshot(paneId)?.actionDefinitions?.["settings.permission"]
				.current,
		).toMatchObject({ conversationId: "canonical-conversation" });
		const complete = vi.fn<CliPaneActionDependencies["complete"]>(
			async () => {},
		);
		await dispatchCliPaneActionRequest(
			{
				reqId: "canonical-settings-claim",
				action: "pane.act",
				params: {
					targetPanelId: paneId,
					actionId: "settings.permission",
					arguments: { value: "default" },
				},
			},
			{
				claim: async () => {
					act(() =>
						useStore.setState({
							agents: [
								{
									...before,
									runtimeBinding: {
										...binding,
										conversationIdentity: {
											...binding.conversationIdentity!,
											revision: "2",
											observedThroughOutputSeq: "10",
											conversationId:
												change === "conversation"
													? "replacement-conversation"
													: "canonical-conversation",
										},
									},
								},
							],
						}),
					);
					return true;
				},
				complete,
				isFallbackWindow: () => false,
				delay: async () => {},
			},
		);
		if (change === "conversation") {
			expect(execute).not.toHaveBeenCalled();
			expect(complete.mock.calls[0][1]).toMatchObject({
				ok: false,
				error: { code: "pane_changed" },
			});
		} else {
			expect(execute).toHaveBeenCalledOnce();
			expect(complete.mock.calls[0][1]).toMatchObject({ ok: true });
		}
	},
);
