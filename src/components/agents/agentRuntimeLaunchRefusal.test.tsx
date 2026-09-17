// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { useAgentPanelState } from "@/components/panels/useAgentPanelState";
import { setLang, t } from "@/lib/i18n";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { codexModelCatalog } from "@/test/providerModelCatalogFixtures";
import { openSelect } from "@/test/select";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	transition: vi.fn(),
	converge: vi.fn(),
	inspectNative: vi.fn(),
}));

vi.mock("@/lib/sessions/managed/managedAgentRehost", () => ({
	inspectManagedAgentCredentialSwitch: mocks.inspectNative,
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		inspect: mocks.inspect,
		inspectExact: mocks.inspect,
		transition: mocks.transition,
	}),
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: mocks.converge,
}));

const originalConversation = "conversation-command-n";
const source = {
	state: "stable" as const,
	agentId: "agent-1",
	providerId: "codex" as const,
	backend: { id: "local", generation: "backend-1" },
	backendProfileId: "local",
	routeAuthority: testDureBackendRouteAuthority("local", "backend-1"),
	selectionRevision: 2,
	interactionProfile: "native_cli" as const,
	executionProfile: { kind: "provider_default" as const },
	providerConversationRef: originalConversation,
	sessionId: "session-1",
	workspaceId: "workspace-1",
	launchIdempotencyKey: "create-1",
	stopFence: stopFenceFixture(),
	launchSelection: {
		model: "gpt-6-astra",
		effort: "high",
		permissionMode: "default" as const,
	},
};
beforeEach(() => {
	setLang("en");
	vi.resetAllMocks();
	mocks.converge.mockResolvedValue(null);
	mocks.inspect.mockResolvedValue(source);

	useStore.setState({
		agents: [
			agentFixture({
				conversationId: originalConversation,
				runtimeBinding: managedBindingFixture({
					backendProfileId: "local",
					stopFence: source.stopFence,
				}),
			}),
		],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agentRuntimeLaunchPresentation: {},
		sessionAgentRuntimeState: {},
	});
});

function PaneControls() {
	const { launchSelection } = useAgentPanelState("agent-1", "agent:agent-1");
	return (
		<AgentLaunchSelectionControls
			provider="codex"
			catalog={[
				...codexModelCatalog,
				{
					...codexModelCatalog[0],
					value: "gpt-6-astra",
					displayName: "GPT-6 Astra",
				},
			]}
			launch={launchSelection}
			observedModel="gpt-6-astra"
			busy={false}
		/>
	);
}
const edits = [
	{ name: "model", trigger: "agents.chat.modelLabel", choice: "GPT-5.6 Sol" },
	{ name: "effort", trigger: "agents.chat.effortLabel", choice: "XHigh" },
	{
		name: "permission",
		trigger: "agents.chat.permissionLabel",
		choice: "Bypass approvals",
	},
] as const;
afterEach(cleanup);
describe("runtime setting refusal through the mounted controls", () => {
	it("keeps an active permission edit pending for the same conversation", async () => {
		const current = useStore.getState().agents[0];
		useStore.setState({
			sessionAgentRuntimeState: {
				"session-1": {
					terminalEpoch: source.stopFence.terminalEpoch,
					revision: "2",
					observedThroughOutputSeq: "5",
					lifecycle: "running",
					activity: "working",
					attention: "none",
					source: "provider_event",
					turnCompletedCount: "0",
				},
			},
		});
		mocks.inspectNative.mockResolvedValue({
			agentId: current.id,
			panelId: "agent:agent-1",
			sourceBinding: current.runtimeBinding,
			conversationId: originalConversation,
			sourceCredentialId: null,
			targetCredentialId: null,
		});
		mocks.transition.mockRejectedValue(
			new DureAgentRuntimeSourceActiveError(
				new DureBackendRequestError("agent_runtime_source_busy", "busy", {
					kind: "operation",
					disposition: "terminal",
				}),
				2,
			),
		);
		render(<PaneControls />);
		openSelect(
			screen.getByRole("combobox", { name: t("agents.chat.permissionLabel") }),
		);
		fireEvent.click(screen.getByRole("option", { name: "Bypass approvals" }));
		await waitFor(() =>
			expect(
				useStore.getState().agents[0].pendingCredentialSwitch,
			).toMatchObject({
				sourceSelectionRevision: 2,
				sourceConversationId: originalConversation,
				targetLaunchSelection: {
					model: "gpt-6-astra",
					effort: "high",
					permissionMode: "skip_permissions",
				},
			}),
		);
		expect(mocks.transition).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].sessionId).toBe("session-1");
		expect(screen.queryByRole("alert")).toBeNull();
	});
	it.each(["cancel", "apply"])(
		"can %s an active settings change from the pending menu",
		async (action) => {
			const current = useStore.getState().agents[0];
			useStore.setState({
				sessionAgentRuntimeState: {
					"session-1": {
						terminalEpoch: source.stopFence.terminalEpoch,
						revision: "2",
						observedThroughOutputSeq: "5",
						lifecycle: "running",
						activity: "working",
						attention: "none",
						source: "provider_event",
						turnCompletedCount: "0",
					},
				},
			});
			mocks.inspectNative.mockResolvedValue({
				agentId: current.id,
				panelId: "agent:agent-1",
				sourceBinding: current.runtimeBinding,
				conversationId: originalConversation,
				sourceCredentialId: null,
				targetCredentialId: null,
			});
			mocks.transition.mockRejectedValueOnce(
				new DureAgentRuntimeSourceActiveError(
					new DureBackendRequestError("agent_runtime_source_busy", "busy", {
						kind: "operation",
						disposition: "terminal",
					}),
					2,
				),
			);
			render(<PaneControls />);
			openSelect(
				screen.getByRole("combobox", {
					name: t("agents.chat.permissionLabel"),
				}),
			);
			fireEvent.click(screen.getByRole("option", { name: "Bypass approvals" }));
			const pendingButton = await screen.findByRole("button", {
				name: t("agents.runtime.settingsPending"),
			});
			mocks.transition.mockImplementationOnce(async (request) => ({
				...source,
				selectionRevision: 3,
				sessionId: "session-next",
				launchSelection: request.targetLaunchSelection,
			}));
			fireEvent.pointerDown(pendingButton, {
				button: 0,
				ctrlKey: false,
				pointerType: "mouse",
			});
			fireEvent.click(
				await screen.findByRole("menuitem", {
					name: t(
						action === "cancel"
							? "agents.runtime.cancelPendingSettings"
							: "agents.runtime.applySettingsNow",
					),
				}),
			);
			await waitFor(() =>
				expect(
					useStore.getState().agents[0].pendingCredentialSwitch,
				).toBeUndefined(),
			);
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
			if (action === "cancel") {
				expect(mocks.transition).toHaveBeenCalledOnce();
				expect(useStore.getState().agents[0].sessionId).toBe("session-1");
			} else {
				expect(mocks.transition).toHaveBeenCalledTimes(2);
				expect(mocks.transition).toHaveBeenLastCalledWith(
					expect.objectContaining({
						sourceStopPolicy: "discard",
						expectedSourceRevision: 2,
						targetLaunchSelection: {
							model: "gpt-6-astra",
							effort: "high",
							permissionMode: "skip_permissions",
						},
					}),
				);
				expect(useStore.getState().agents[0].sessionId).toBe("session-next");
			}
		},
	);

	it.each(edits)(
		"$name explains a retained source without a generic runtime failure",
		async ({ trigger, choice }) => {
			mocks.transition.mockRejectedValue(
				new DureAgentRuntimeSourceActiveError(
					new DureBackendRequestError(
						"agent_runtime_source_retained",
						"agent_runtime_source_retained",
						{ kind: "operation", disposition: "terminal" },
					),
					2,
				),
			);
			render(<PaneControls />);
			openSelect(screen.getByRole("combobox", { name: t(trigger) }));
			fireEvent.click(screen.getByRole("option", { name: choice }));
			await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
			await waitFor(() =>
				expect(screen.getByRole("alert").textContent).toBe(
					"Settings unchanged. The current session could not be safely paused.",
				),
			);
			expect(screen.queryByText(t("agents.runtime.switchFailed"))).toBeNull();
			expect(mocks.transition).toHaveBeenCalledWith(
				expect.objectContaining({ sourceStopPolicy: "preserve" }),
			);
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
			expect(useStore.getState().agents[0].sessionId).toBe(source.sessionId);
			mocks.transition.mockImplementationOnce(async (request) => ({
				...source,
				selectionRevision: 3,
				sessionId: "session-next",
				launchSelection: request.targetLaunchSelection,
			}));
			openSelect(screen.getByRole("combobox", { name: t(trigger) }));
			fireEvent.click(screen.getByRole("option", { name: choice }));
			await waitFor(() =>
				expect(useStore.getState().agents[0].sessionId).toBe("session-next"),
			);
			expect(screen.queryByRole("alert")).toBeNull();
			expect(mocks.transition).toHaveBeenCalledTimes(2);
			expect(
				mocks.transition.mock.calls.every(
					([request]) => request.sourceStopPolicy === "preserve",
				),
			).toBe(true);
			expect(useStore.getState().agents[0].conversationId).toBe(
				originalConversation,
			);
		},
	);
	it.each(["active", "unknown"] as const)(
		"keeps %s failures distinct",
		async (kind) => {
			mocks.transition.mockRejectedValue(
				kind === "active"
					? new DureAgentRuntimeSourceActiveError(
							new DureBackendRequestError("agent_runtime_source_busy", "busy", {
								kind: "operation",
								disposition: "terminal",
							}),
							2,
						)
					: new Error("backend_transport_closed"),
			);
			render(<PaneControls />);
			openSelect(
				screen.getByRole("combobox", { name: t("agents.chat.modelLabel") }),
			);
			fireEvent.click(screen.getByRole("option", { name: "GPT-5.6 Sol" }));
			await waitFor(() =>
				expect(screen.getByRole("alert").textContent).toBe(
					t(
						kind === "active"
							? "agents.runtime.sourceActive"
							: "agents.runtime.switchFailed",
					),
				),
			);
			expect(mocks.transition).toHaveBeenCalledOnce();
			expect(useStore.getState().agents[0].sessionId).toBe(source.sessionId);
		},
	);
});
