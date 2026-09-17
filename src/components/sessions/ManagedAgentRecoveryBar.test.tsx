// @vitest-environment jsdom

import { chooseSelectValue } from "@/test/select";

import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentExitedSessionSurface } from "@/components/agents/AgentExitedSessionSurface";
import { WorkspaceRuntimeProvider } from "@/components/workspace/WorkspaceRuntimeContext";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { t } from "@/lib/i18n";
import { beginManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import {
	clearHmuxPaneHealth,
	publishHmuxPaneHealthObservation,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { TerminalPresentationRoleStore } from "@/lib/terminal/presentation/terminalPresentationRoleStore";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { hmuxPaneHealthId } from "@/lib/terminal/terminalHealth";
import { paneActionSnapshot } from "@/lib/workspace/pane/paneActionRegistry";
import { requestManagedRecovery } from "@/lib/workspace/pane/paneMenuSignals";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	inspectDisconnectedManagedAgentRecovery: vi.fn(),
	listConversations: vi.fn(),
	recoverExitedManagedConversationPane: vi.fn(),
	startFreshManagedAgentPane: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc")>()),
	listConversations: mocks.listConversations,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehost", () => ({
	inspectDisconnectedManagedAgentRecovery:
		mocks.inspectDisconnectedManagedAgentRecovery,
}));
vi.mock("@/lib/sessions/managed/managedAgentFreshStart", () => ({
	startFreshManagedAgentPane: mocks.startFreshManagedAgentPane,
}));
vi.mock("@/lib/sessions/managed/managedConversationLaunch", () => ({
	recoverExitedManagedConversationPane:
		mocks.recoverExitedManagedConversationPane,
}));

import { ManagedAgentRecoveryBar } from "@/components/sessions/ManagedAgentRecoveryBar";

const binding: HmuxManagedPaneBindingV1 = {
	schemaVersion: 1,
	runtime: "hmux_managed_v1",
	source: "local",
	hostId: "local",
	sessionId: "session-old",
	workspaceId: "workspace-1",
	createIdempotencyKey: "create-old",
};

const agent: Agent = {
	id: "agent-1",
	name: "managed-agent",
	provider: "codex",
	projectId: "project-1",
	worktreePath: "/repo/worktree",
	branch: "agent/managed-agent",
	sessionId: binding.sessionId,
	sessionKind: "pty",
	runtimeBinding: binding,
	conversationId: "conversation-1",
	started: true,
};

const attachRecovery: TerminalAttachRecovery = {
	intent: "resume",
	ownerKey: "fixture-runtime",
	resume: vi.fn().mockResolvedValue(undefined),
	context: "agent=agent-1 pane=agent:agent-1 session=session-old",
};

function RecoverySurfaceHarness() {
	const [resuming, setResuming] = useState(false);
	const currentAgent = useStore((state) =>
		state.agents.find((candidate) => candidate.id === agent.id),
	);
	const activity = useStore(
		(state) => state.agentActivity[agent.id] ?? "waiting",
	);
	if (!currentAgent) return null;
	return (
		<AgentExitedSessionSurface
			agentId={currentAgent.id}
			panelId="agent:agent-1"
			binding={currentAgent.runtimeBinding}
			activity={activity}
			authoritativeExit={false}
			attachRecovery={{ ...attachRecovery, transitioning: resuming }}
			resuming={resuming}
			onTransitioningChange={setResuming}
			structuredAttachRecoveryVisible={false}
			onRecoveryAvailabilityChange={() => {}}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listConversations.mockResolvedValue([]);
	mocks.recoverExitedManagedConversationPane.mockResolvedValue(
		"conversation-1",
	);
	mocks.startFreshManagedAgentPane.mockReset().mockResolvedValue({
		panelId: "agent:agent-1",
	});
	vi.mocked(attachRecovery.resume).mockClear();
	useStore.setState({
		agents: [agent],
		accounts: [],
		agentActivity: { [agent.id]: "exited" },
		hmuxSessionMetadata: {
			[hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)]: {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				sessionClass: "managed",
				lifecycle: "exited",
				health: "exited",
				terminalEpoch: "terminal-old",
				outputSeq: "9",
				capabilities: [],
			},
		},
	});
});

const paneHealthId = hmuxPaneHealthId(undefined, "agent:agent-1");

afterEach(() => {
	cleanup();
	clearHmuxPaneHealth(paneHealthId);
	clearHmuxPaneHealth(hmuxPaneHealthId("desktop-1", "agent:agent-1"));
});

describe("ManagedAgentRecoveryBar", () => {
	it("keeps a forced recovery selection across equivalent Agent and account projections", async () => {
		mocks.listConversations.mockResolvedValue([
			{ id: "conversation-choice", title: "Choice", mtime: 1 },
		]);
		render(<RecoverySurfaceHarness />);
		act(() => requestManagedRecovery("agent:agent-1"));
		chooseSelectValue(await screen.findByLabelText("복구할 정확한 대화"), "conversation-choice");
		await act(async () => {
			useStore.setState((state) => ({
				agents: state.agents.map((current) => ({
					...current,
					displayName: "Updated title",
					runtimeBinding: { ...binding },
				})),
				accounts: [...state.accounts],
			}));
		});
		expect(mocks.listConversations).toHaveBeenCalledOnce();
		expect(
			screen.getByLabelText("복구할 정확한 대화").textContent,
		).toBe("Choice · conversation-choice");
	});

	it("keeps the selected conversation when the parent replaces its availability callback", async () => {
		useStore.setState({ agents: [{ ...agent, conversationId: undefined }] });
		mocks.listConversations.mockResolvedValue([
			{ id: "conversation-choice", title: "Choice", mtime: 1 },
		]);
		const props = { agentId: agent.id, panelId: "agent:agent-1", binding };
		const view = render(
			<ManagedAgentRecoveryBar {...props} onAvailabilityChange={vi.fn()} />,
		);
		chooseSelectValue(await screen.findByLabelText("복구할 정확한 대화"), "conversation-choice");
		view.rerender(
			<ManagedAgentRecoveryBar {...props} onAvailabilityChange={vi.fn()} />,
		);
		await act(async () => {});
		expect(mocks.listConversations).toHaveBeenCalledOnce();
		expect(
			screen.getByLabelText("복구할 정확한 대화").textContent,
		).toBe("Choice · conversation-choice");
		fireEvent.click(screen.getByRole("button", { name: "정확한 대화 재개" }));
		await waitFor(() =>
			expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledWith({
				agentId: agent.id,
				panelId: "agent:agent-1",
				target: { kind: "id", id: "conversation-choice" },
			}),
		);
	});

	it.each([undefined, "older-conversation"])(
		"uses the same Host conversation as terminal recovery when the agent hint is %s",
		async (conversationId) => {
			const exactBinding: HmuxManagedPaneBindingV1 = {
				...binding,
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					runnerPrincipal: "local-user",
					runnerInstance: "runner-1",
					channelEpoch: "1",
					hostInstanceId: "host-1",
					terminalEpoch: "terminal-1",
					providerId: "codex",
					conversationId: "host-conversation",
					revision: "1",
					observedThroughOutputSeq: "196",
					source: "provider_event",
				},
			};
			useStore.setState({
				agents: [{ ...agent, conversationId, runtimeBinding: exactBinding }],
			});
			render(
				<ManagedAgentRecoveryBar
					agentId={agent.id}
					panelId="agent:agent-1"
					binding={exactBinding}
					onAvailabilityChange={vi.fn()}
				/>,
			);
			await act(async () => {});
			expect(mocks.listConversations).not.toHaveBeenCalled();
			fireEvent.click(screen.getByRole("button", { name: "정확한 대화 재개" }));
			await waitFor(() =>
				expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledWith(
					{
						agentId: agent.id,
						panelId: "agent:agent-1",
						target: { kind: "id", id: "host-conversation" },
					},
				),
			);
			expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
		},
	);

	it("uses the inline terminal recovery card for a cleanly exited session", () => {
		const rendered = render(
			<AgentExitedSessionSurface
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				activity="exited"
				authoritativeExit
				attachRecovery={attachRecovery}
				resuming={false}
				structuredAttachRecoveryVisible
			/>,
		);

		expect(
			rendered.container.querySelector("[data-agent-exited-session-bar]"),
		).toBeNull();
		rendered.rerender(
			<AgentExitedSessionSurface
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				activity="exited"
				authoritativeExit
				attachRecovery={attachRecovery}
				resuming={false}
				structuredAttachRecoveryVisible={false}
			/>,
		);
		expect(
			rendered.container.querySelector("[data-agent-exited-session-bar]"),
		).toBeNull();
		expect(
			rendered.getByRole("button", { name: "세션 이어서 재개" }),
		).toBeTruthy();
	});

	it("labels recovery as a fresh start when no exact conversation is known", async () => {
		const startFresh = vi.fn().mockResolvedValue(undefined);
		render(
			<AgentExitedSessionSurface
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				activity="exited"
				authoritativeExit
				attachRecovery={{
					intent: "start_fresh",
					ownerKey: "fixture-runtime",
					resume: startFresh,
					context: "agent=agent-1 pane=agent:agent-1",
				}}
				resuming={false}
				structuredAttachRecoveryVisible={false}
			/>,
		);

		expect(paneActionSnapshot("agent:agent-1")?.actions).toContain(
			"start_fresh",
		);
		fireEvent.click(screen.getByRole("button", { name: "새로 시작" }));
		await waitFor(() => expect(startFresh).toHaveBeenCalledOnce());
		expect(paneActionSnapshot("agent:agent-1")?.actions).toEqual([]);
	});

	it.each(["exited", "unavailable", "unknown"])(
		"suspends the exited surface while replacement owns a %s source",
		(posture) => {
			if (posture !== "exited")
				useStore.setState({
					hmuxSessionMetadata:
						posture === "unknown"
							? {}
							: {
									[hmuxSessionMetadataKey(
										binding.workspaceId,
										binding.sessionId,
									)]: {
										sessionId: binding.sessionId,
										workspaceId: binding.workspaceId,
										sessionClass: "managed",
										lifecycle: "unavailable",
										health: "stale_transport",
										terminalEpoch: "terminal-old",
										outputSeq: "9",
										capabilities: [],
									},
								},
				});
			const props = {
				agentId: agent.id,
				panelId: "agent:agent-1",
				binding,
				activity: "exited" as const,
				authoritativeExit: false,
				attachRecovery: { ...attachRecovery, transitioning: true },
				structuredAttachRecoveryVisible: false,
			};
			const view = render(<AgentExitedSessionSurface {...props} resuming />);
			expect(view.queryAllByRole("button")).toEqual([]);
			expect(mocks.listConversations).not.toHaveBeenCalled();
			view.rerender(
				<AgentExitedSessionSurface
					{...props}
					attachRecovery={attachRecovery}
					resuming={false}
				/>,
			);
			expect(view.queryAllByRole("button").length).toBeGreaterThan(0);
		},
	);

	it("retains its recovery failure when the parent hides the pending action", async () => {
		useStore.setState({ hmuxSessionMetadata: {} });
		let rejectRecovery: ((error: Error) => void) | undefined;
		mocks.recoverExitedManagedConversationPane.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRecovery = reject;
				}),
		);
		render(<RecoverySurfaceHarness />);
		fireEvent.click(screen.getByRole("button", { name: "정확한 대화 재개" }));
		expect(screen.queryAllByRole("button")).toEqual([]);
		await act(async () =>
			rejectRecovery?.(new Error("Recovery target refused")),
		);
		expect(screen.getByText(/Recovery target refused/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "정확한 대화 재개" }),
		).toBeTruthy();
		expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledOnce();
	});

	it("disables every destructive recovery action during a runtime transition", async () => {
		useStore.setState({
			agents: [{ ...agent, conversationId: undefined }],
		});
		mocks.listConversations.mockResolvedValue([
			{ id: "conversation-choice", title: "Choice", mtime: 1 },
		]);
		const onOpenShell = vi.fn().mockResolvedValue(undefined);

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				disabled
				onOpenShell={onOpenShell}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		const picker = await screen.findByLabelText("복구할 정확한 대화");
		const openShell = screen.getByRole("button", { name: "Shell 열기" });
		const fresh = screen.getByRole("button", { name: "새 대화" });
		const resume = screen.getByRole("button", { name: "정확한 대화 재개" });
		for (const control of [picker, openShell, fresh, resume]) {
			expect((control as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(control);
		}
		expect(onOpenShell).not.toHaveBeenCalled();
		expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
		expect(mocks.recoverExitedManagedConversationPane).not.toHaveBeenCalled();
	});

	it("owns the parent runtime transition until a recovery mutation settles", async () => {
		let finishFreshStart: (() => void) | undefined;
		mocks.startFreshManagedAgentPane.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishFreshStart = () => resolve({ panelId: "agent:agent-1" });
				}),
		);
		const transitions: boolean[] = [];

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onTransitioningChange={(transitioning) =>
					transitions.push(transitioning)
				}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "새 대화" }));
		expect(transitions).toEqual([true]);
		expect(
			(screen.getByRole("button", { name: "새 대화" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		await act(async () => {
			finishFreshStart?.();
		});
		await waitFor(() => expect(transitions).toEqual([true, false]));
	});

	it("releases a forced recovery picker when resume replaces its runtime generation", async () => {
		useStore.setState({
			agentActivity: { [agent.id]: "waiting" },
		});
		mocks.listConversations.mockResolvedValue([
			{
				id: "conversation-selected",
				title: "selected",
				mtime: 1,
			},
		]);
		mocks.recoverExitedManagedConversationPane.mockImplementation(async () => {
			const replacementBinding: HmuxManagedPaneBindingV1 = {
				...binding,
				sessionId: "session-replacement",
				createIdempotencyKey: "create-replacement",
			};
			useStore.setState((state) => ({
				agents: state.agents.map((candidate) =>
					candidate.id === agent.id
						? {
								...candidate,
								sessionId: replacementBinding.sessionId,
								runtimeBinding: replacementBinding,
								conversationId: "conversation-selected",
							}
						: candidate,
				),
				agentActivity: {
					...state.agentActivity,
					[agent.id]: "connecting",
				},
			}));
			return "conversation-selected";
		});

		render(<RecoverySurfaceHarness />);
		act(() => requestManagedRecovery("agent:agent-1"));

		const selector = await screen.findByLabelText("복구할 정확한 대화");
		chooseSelectValue(selector, "conversation-selected");
		fireEvent.click(screen.getByRole("button", { name: "정확한 대화 재개" }));

		await waitFor(() =>
			expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledOnce(),
		);
		await waitFor(() =>
			expect(screen.queryByLabelText("복구할 정확한 대화")).toBeNull(),
		);
	});

	it("offers exact conversation selection after a healthy-pane rehost failure", async () => {
		useStore.setState({
			agentActivity: { [agent.id]: "waiting" },
			hmuxSessionMetadata: {
				[hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)]: {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					sessionClass: "managed",
					lifecycle: "ready",
					health: "current_healthy",
					terminalEpoch: "terminal-old",
					outputSeq: "9",
					capabilities: [],
				},
			},
		});
		mocks.listConversations.mockResolvedValue([
			{ id: "root-conversation", title: "Root conversation", mtime: 1 },
		]);

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				forceConversationSelection
				onAvailabilityChange={vi.fn()}
			/>,
		);

		expect(await screen.findByLabelText("복구할 정확한 대화")).toBeTruthy();
		expect(mocks.listConversations).toHaveBeenCalledWith(
			agent.worktreePath,
			agent.provider,
			undefined,
		);
	});

	it("lists exact recovery candidates from the pane credential profile", async () => {
		const account = {
			id: "account-work",
			provider: "codex" as const,
			name: "Work",
			dir: "/home/user/.dure/accounts/codex-work",
		};
		useStore.setState({
			agents: [
				{
					...agent,
					credentialId: "stale-account",
					executionProfile: {
						kind: "credential_reference",
						reference_id: account.id,
						credential_generation: "generation-work",
					},
				},
			],
			accounts: [account],
		});

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				forceConversationSelection
				onAvailabilityChange={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(mocks.listConversations).toHaveBeenCalledWith(
				agent.worktreePath,
				agent.provider,
				{ referenceId: account.id, directory: account.dir },
			),
		);
	});

	it("offers the stored exact conversation without planning against the source", async () => {
		const onAvailabilityChange = vi.fn();
		const { container } = render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={onAvailabilityChange}
			/>,
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "정확한 대화 재개" }),
		);
		await waitFor(() =>
			expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledWith({
				agentId: agent.id,
				panelId: "agent:agent-1",
				target: { kind: "id", id: "conversation-1" },
			}),
		);
		expect(
			mocks.inspectDisconnectedManagedAgentRecovery,
		).not.toHaveBeenCalled();
		expect(onAvailabilityChange).toHaveBeenCalledWith(true, false);
		expect(container.firstElementChild?.classList.contains("max-h-[50%]")).toBe(
			true,
		);
	});

	it("leaves a normal exited pane to its terminal actions when inspection is disabled", async () => {
		const onAvailabilityChange = vi.fn();
		const { container } = render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				inspectConfirmedExit={false}
				onAvailabilityChange={onAvailabilityChange}
			/>,
		);

		await waitFor(() =>
			expect(onAvailabilityChange).toHaveBeenCalledWith(false, false),
		);
		expect(container.innerHTML).toBe("");
		expect(
			mocks.inspectDisconnectedManagedAgentRecovery,
		).not.toHaveBeenCalled();
	});

	it("does not inspect Host proof for an unknown disconnected posture", async () => {
		useStore.setState({
			agentActivity: { [agent.id]: "exited" },
			hmuxSessionMetadata: {},
		});

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		expect(
			await screen.findByRole("button", { name: "정확한 대화 재개" }),
		).toBeTruthy();
		expect(
			mocks.inspectDisconnectedManagedAgentRecovery,
		).not.toHaveBeenCalled();
		expect(screen.queryByText(/Host 상태/)).toBeNull();
	});

	it("lets a disconnected local managed Agent become a managed shell immediately", async () => {
		useStore.setState({
			agentActivity: { [agent.id]: "working" },
			hmuxSessionMetadata: {
				[hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)]: {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					sessionClass: "managed",
					lifecycle: "ready",
					health: "stale_transport",
					terminalEpoch: "terminal-old",
					outputSeq: "10",
					capabilities: [],
				},
			},
		});
		const onOpenShell = vi.fn().mockResolvedValue(undefined);
		const onAvailabilityChange = vi.fn();

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onOpenShell={onOpenShell}
				onAvailabilityChange={onAvailabilityChange}
			/>,
		);

		await waitFor(() =>
			expect(onAvailabilityChange).toHaveBeenCalledWith(true, true),
		);
		fireEvent.click(await screen.findByRole("button", { name: "Shell 열기" }));
		await waitFor(() => expect(onOpenShell).toHaveBeenCalledOnce());
	});

	it("keeps a healthy pane hidden", async () => {
		useStore.setState({
			agentActivity: { [agent.id]: "working" },
			hmuxSessionMetadata: {
				[hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)]: {
					sessionId: binding.sessionId,
					workspaceId: binding.workspaceId,
					sessionClass: "managed",
					lifecycle: "ready",
					health: "current_healthy",
					inputAllowed: true,
					terminalEpoch: "terminal-old",
					outputSeq: "10",
					capabilities: [],
				},
			},
		});

		const { container } = render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(container.innerHTML).toBe("");
		expect(
			mocks.inspectDisconnectedManagedAgentRecovery,
		).not.toHaveBeenCalled();
	});

	it.each([undefined, "desktop-1"])(
		"does not offer automatic recovery when a census handshake fails but the exact attachment is live (desktop %s)",
		(desktopId) => {
			const paneHealthId = hmuxPaneHealthId(desktopId, "agent:agent-1");
			const key = hmuxSessionMetadataKey(
				binding.workspaceId,
				binding.sessionId,
			);
			const healthy = {
				...useStore.getState().hmuxSessionMetadata[key],
				lifecycle: "ready" as const,
				health: "current_healthy" as const,
				inputAllowed: true,
			};
			const unavailable = {
				...healthy,
				lifecycle: "unavailable" as const,
				health: "stale_transport" as const,
				inputAllowed: false,
			};
			useStore.setState({
				agentActivity: { [agent.id]: "working" },
				hmuxSessionMetadata: { [key]: healthy },
			});
			publishHmuxPaneHealthObservation(paneHealthId, {
				kind: "frame_received",
				terminalEpoch: healthy.terminalEpoch,
				sequence: "10",
			});
			const onAvailabilityChange = vi.fn();
			const recovery = (
				<ManagedAgentRecoveryBar
					agentId={agent.id}
					panelId="agent:agent-1"
					binding={binding}
					onOpenShell={vi.fn()}
					onAvailabilityChange={onAvailabilityChange}
				/>
			);
			render(
				desktopId ? (
					<WorkspaceRuntimeProvider
						desktopId={desktopId}
						active
						presentationRoleStore={new TerminalPresentationRoleStore()}
						commitLayout={() => false}
					>
						{recovery}
					</WorkspaceRuntimeProvider>
				) : (
					recovery
				),
			);
			for (const metadata of [unavailable, healthy, unavailable]) {
				act(() => useStore.getState().setHmuxSessionMetadata(metadata));
				expect(screen.queryAllByRole("button")).toHaveLength(0);
				expect(onAvailabilityChange).toHaveBeenLastCalledWith(false, false);
				// Presentation must not upgrade discovery capability or mutate its facts.
				expect(useStore.getState().hmuxSessionMetadata[key]).toEqual(metadata);
			}
			act(() => {
				publishHmuxPaneHealthObservation(paneHealthId, {
					kind: "connection",
					state: "error",
					reason: "host_disconnected",
				});
			});
			expect(
				screen.getByRole("button", { name: t("common.newConversation") }),
			).toBeTruthy();
			expect(onAvailabilityChange).toHaveBeenLastCalledWith(true, true);
			act(() => {
				publishHmuxPaneHealthObservation(paneHealthId, {
					kind: "frame_received",
					terminalEpoch: healthy.terminalEpoch,
					sequence: "11",
				});
			});
			expect(screen.queryByRole("button")).toBeNull();
			expect(onAvailabilityChange).toHaveBeenLastCalledWith(false, false);
			expect(mocks.listConversations).not.toHaveBeenCalled();
			expect(mocks.recoverExitedManagedConversationPane).not.toHaveBeenCalled();
			expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
		},
	);

	it.each(["unprobed", "generation_changed"] as const)(
		"keeps a working pane quiet across healthy -> %s -> healthy observations",
		(health) => {
			const key = hmuxSessionMetadataKey(
				binding.workspaceId,
				binding.sessionId,
			);
			const healthy = {
				...useStore.getState().hmuxSessionMetadata[key],
				lifecycle: "ready" as const,
				health: "current_healthy" as const,
				inputAllowed: true,
			};
			useStore.setState({
				agentActivity: { [agent.id]: "working" },
				hmuxSessionMetadata: { [key]: healthy },
			});
			const onAvailabilityChange = vi.fn();
			render(
				<ManagedAgentRecoveryBar
					agentId={agent.id}
					panelId="agent:agent-1"
					binding={binding}
					onOpenShell={vi.fn()}
					onAvailabilityChange={onAvailabilityChange}
				/>,
			);
			for (const metadata of [
				healthy,
				{
					...healthy,
					lifecycle: "unavailable" as const,
					health,
					inputAllowed: false,
				},
				healthy,
			]) {
				act(() => useStore.getState().setHmuxSessionMetadata(metadata));
				expect(screen.queryByRole("button")).toBeNull();
				expect(onAvailabilityChange).toHaveBeenLastCalledWith(false, false);
			}
			expect(mocks.listConversations).not.toHaveBeenCalled();
			expect(mocks.recoverExitedManagedConversationPane).not.toHaveBeenCalled();
			expect(mocks.startFreshManagedAgentPane).not.toHaveBeenCalled();
		},
	);

	it.each(["unprobed", "stale_transport"] as const)(
		"keeps explicit conversation selection available during a %s observation with a live attachment",
		async (health) => {
			const key = hmuxSessionMetadataKey(
				binding.workspaceId,
				binding.sessionId,
			);
			useStore.setState({
				agentActivity: { [agent.id]: "working" },
				hmuxSessionMetadata: {
					[key]: {
						...useStore.getState().hmuxSessionMetadata[key],
						lifecycle: "unavailable",
						health,
						inputAllowed: false,
					},
				},
			});
			publishHmuxPaneHealthObservation(paneHealthId, {
				kind: "frame_received",
				terminalEpoch: "terminal-old",
				sequence: "10",
			});
			render(<RecoverySurfaceHarness />);
			expect(screen.queryByRole("button")).toBeNull();
			act(() => requestManagedRecovery("agent:agent-1"));
			expect(
				await screen.findByRole("button", {
					name: t("common.newConversation"),
				}),
			).toBeTruthy();
			expect(mocks.recoverExitedManagedConversationPane).not.toHaveBeenCalled();
		},
	);

	it("does not inspect the retired binding during a credential replacement", async () => {
		const onAvailabilityChange = vi.fn();
		const endTransition = beginManagedCredentialSwitchTransition(agent.id);
		try {
			const { container } = render(
				<ManagedAgentRecoveryBar
					agentId={agent.id}
					panelId="agent:agent-1"
					binding={binding}
					onAvailabilityChange={onAvailabilityChange}
				/>,
			);

			await waitFor(() =>
				expect(onAvailabilityChange).toHaveBeenCalledWith(false, false),
			);
			expect(container.innerHTML).toBe("");
			expect(
				mocks.inspectDisconnectedManagedAgentRecovery,
			).not.toHaveBeenCalled();
		} finally {
			act(() => endTransition());
		}
	});

	it("recovers the selected conversation with one explicit click", async () => {
		const sourceWithoutConversation = {
			...agent,
			conversationId: undefined,
		};
		useStore.setState({ agents: [sourceWithoutConversation] });
		mocks.listConversations.mockResolvedValue([
			{
				id: "conversation-first",
				title: "first",
				mtime: 2,
			},
			{
				id: "conversation-selected",
				title: "selected",
				mtime: 1,
			},
		]);
		mocks.recoverExitedManagedConversationPane.mockResolvedValue(
			"conversation-selected",
		);

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		const selector = await screen.findByLabelText("복구할 정확한 대화");
		chooseSelectValue(selector, "conversation-selected");
		fireEvent.click(screen.getByRole("button", { name: "정확한 대화 재개" }));

		await waitFor(() =>
			expect(mocks.recoverExitedManagedConversationPane).toHaveBeenCalledWith({
				agentId: agent.id,
				panelId: "agent:agent-1",
				target: { kind: "id", id: "conversation-selected" },
			}),
		);
		expect(
			mocks.inspectDisconnectedManagedAgentRecovery,
		).not.toHaveBeenCalled();
	});

	it("keeps fresh start available while listing optional exact conversations", async () => {
		useStore.setState({
			agents: [{ ...agent, conversationId: undefined }],
		});
		mocks.listConversations.mockResolvedValue([
			{
				id: "conversation-1",
				title: "Recovered conversation",
				mtime: 1,
			},
		]);

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		await screen.findByLabelText("복구할 정확한 대화");
		const freshButton = screen.getByRole("button", { name: "새 대화" });
		expect(freshButton.getAttribute("data-variant")).toBe("secondary");
		expect(freshButton.parentElement?.className).toContain("flex-wrap");
		expect(screen.queryByRole("button", { name: "다시 검사" })).toBeNull();
		expect(mocks.listConversations).toHaveBeenCalledWith(
			agent.worktreePath,
			agent.provider,
			undefined,
		);
		fireEvent.click(freshButton);
		await waitFor(() =>
			expect(mocks.startFreshManagedAgentPane).toHaveBeenCalledWith(
				agent.id,
				"agent:agent-1",
			),
		);
	});

	it("starts a fresh conversation when no exact conversation can be recovered", async () => {
		mocks.startFreshManagedAgentPane.mockImplementationOnce(async () => {
			// The service's common projector owns initial activity, not this button.
			useStore.getState().setAgentActivity(agent.id, "connecting");
		});
		useStore.setState({
			agents: [{ ...agent, conversationId: undefined }],
		});
		const onAvailabilityChange = vi.fn();

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={onAvailabilityChange}
			/>,
		);

		const startButton = await screen.findByRole("button", { name: "새 대화" });
		expect(startButton.hasAttribute("disabled")).toBe(false);
		expect(screen.queryByLabelText("복구할 정확한 대화")).toBeNull();
		fireEvent.click(startButton);

		await waitFor(() =>
			expect(mocks.startFreshManagedAgentPane).toHaveBeenCalledWith(
				agent.id,
				"agent:agent-1",
			),
		);
		expect(useStore.getState().agentActivity[agent.id]).toBe("connecting");
		expect(onAvailabilityChange).toHaveBeenCalledWith(false, false);
	});

	it.each(["connecting", "working", "waiting", "exited", "removed"] as const)(
		"keeps %s runtime state when a delayed Fresh button callback completes",
		async (observation) => {
			useStore.setState({ agents: [{ ...agent, conversationId: undefined }] });
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			mocks.startFreshManagedAgentPane.mockReturnValueOnce(completion);
			render(
				<ManagedAgentRecoveryBar
					agentId={agent.id}
					panelId="agent:agent-1"
					binding={binding}
					onAvailabilityChange={vi.fn()}
				/>,
			);
			const button = await screen.findByRole("button", { name: "새 대화" });
			await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
			fireEvent.click(button);
			await waitFor(() =>
				expect(mocks.startFreshManagedAgentPane).toHaveBeenCalledOnce(),
			);
			await act(async () => {
				useStore.setState({
					agents:
						observation === "removed"
							? []
							: [
									{
										...agent,
										sessionId: "session-new",
										runtimeBinding: { ...binding, sessionId: "session-new" },
									},
								],
					agentActivity:
						observation === "removed" ? {} : { [agent.id]: observation },
				});
			});
			const current = useStore.getState().agents;
			await act(async () => {
				finish();
				await completion;
			});
			expect(useStore.getState().agents).toBe(current);
			expect(useStore.getState().agentActivity[agent.id]).toBe(
				observation === "removed" ? undefined : observation,
			);
		},
	);

	it("keeps the failed pane recoverable when a fresh start is refused", async () => {
		useStore.setState({
			agents: [{ ...agent, conversationId: undefined }],
		});
		mocks.startFreshManagedAgentPane.mockRejectedValue(
			new Error("fresh start refused"),
		);
		const onAvailabilityChange = vi.fn();

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={onAvailabilityChange}
			/>,
		);

		const button = await screen.findByRole("button", { name: "새 대화" });
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
		fireEvent.click(button);

		expect(await screen.findByText(/fresh start refused/)).toBeTruthy();
		expect(useStore.getState().agentActivity[agent.id]).toBe("exited");
		expect(onAvailabilityChange).not.toHaveBeenCalledWith(false, false);
		expect(screen.getByRole("button", { name: "새 대화" })).toBeTruthy();
	});

	it("keeps only the actionable backend refusal reason visible", async () => {
		const refusal = Object.assign(new Error("source_process_is_live"), {
			receipt: {
				outcome: "refused",
				reason: "source_process_is_live",
			},
		});
		mocks.recoverExitedManagedConversationPane.mockRejectedValue(refusal);

		render(
			<ManagedAgentRecoveryBar
				agentId={agent.id}
				panelId="agent:agent-1"
				binding={binding}
				onAvailabilityChange={vi.fn()}
			/>,
		);

		fireEvent.click(
			await screen.findByRole("button", { name: "정확한 대화 재개" }),
		);

		await waitFor(() =>
			expect(screen.getAllByText(/source_process_is_live/)).toHaveLength(1),
		);
		expect(screen.queryByText(/"outcome":"refused"/)).toBeNull();
	});
});
