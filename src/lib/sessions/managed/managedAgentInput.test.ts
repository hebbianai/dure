import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Agent, HmuxManagedStopFenceV1 } from "@/types";

const mocks = vi.hoisted(() => ({
	sendAgentChatMessage: vi.fn(),
	commandInput: vi.fn(),
	initialAgentPrompt: vi.fn(),
	remoteHmuxCommandInput: vi.fn(),
	remoteHmuxInitialAgentPrompt: vi.fn(),
	resolveRemoteHmuxStandaloneController: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc")>();
	return {
		...original,
		hmux: {
			...original.hmux,
			commandInput: mocks.commandInput,
			initialAgentPrompt: mocks.initialAgentPrompt,
		},
		remoteHmuxCommandInput: mocks.remoteHmuxCommandInput,
		remoteHmuxInitialAgentPrompt: mocks.remoteHmuxInitialAgentPrompt,
	};
});

vi.mock("@/lib/agents/chat/agentChatSessionRuntime", () => ({
	sendAgentChatMessage: mocks.sendAgentChatMessage,
}));

vi.mock("@/lib/hmux/remote/remoteHmuxControllerResolution", () => ({
	resolveRemoteHmuxStandaloneController:
		mocks.resolveRemoteHmuxStandaloneController,
}));

import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	executeExactHmuxInput,
	executeManagedAgentInput,
	MAX_MANAGED_AGENT_INPUT_BYTES,
	type PreparedManagedAgentInput,
	prepareExactHmuxInput,
	prepareManagedAgentInput,
	sendHmuxInitialAgentPrompt,
} from "@/lib/sessions/managed/managedAgentInput";
import { useStore } from "@/store";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const stopFence = stopFenceFixture({ terminalEpoch: "terminal-1" });

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-managed",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			createIdempotencyKey: undefined,
			stopFence,
		}),
		...patch,
	});
}

function remoteManagedAgent(
	persistedFence: HmuxManagedStopFenceV1 | null = stopFence,
): Agent {
	return managedAgent({
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-remote",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			createIdempotencyKey: "create-managed",
			commandBridgeNonce: "bridge-remote",
			...(persistedFence ? { stopFence: persistedFence } : {}),
		},
	});
}

const remoteTarget = {
	schemaVersion: 1 as const,
	hostId: "host-remote",
	host: "remote.test",
	port: 22,
	user: "agent",
	auth: "auto" as const,
	hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
};

function remoteCatalogSession(terminalEpoch = "terminal-1") {
	return {
		sessionId: "session-managed",
		sessionName: "remote-shell",
		workspaceId: "workspace-managed",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		providerId: "codex",
		runnerPrincipal: "principal-1",
		runnerInstance: "runner-1",
		channelEpoch: "7",
		hostInstanceId: "host-instance-1",
		terminalEpoch,
		supportedProtocol: {
			minimum: { major: 1, minor: 0 },
			maximum: { major: 1, minor: 0 },
		},
		capabilities: ["screen_snapshot", "shared_terminal_input"],
	};
}

function exactTarget(patch: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		targetPanelId: "agent:agent-managed",
		hostId: "host-remote",
		sessionId: "session-managed",
		workspaceId: "workspace-managed",
		...patch,
	};
}

beforeEach(() => {
	mocks.commandInput.mockReset().mockResolvedValue({
		terminalEpoch: "terminal-1",
		text: { recordId: "1", state: "written_to_pty" },
		submit: { recordId: "2", state: "written_to_pty" },
	});
	mocks.initialAgentPrompt.mockReset().mockResolvedValue({
		terminalEpoch: "terminal-1",
		recordId: "3",
		inputBaselineOutputSequence: "7",
		initialAgentRuntimeRevision: "2",
	});
	mocks.remoteHmuxCommandInput.mockReset().mockResolvedValue({
		terminalEpoch: "terminal-1",
		text: { recordId: "1", state: "written_to_pty" },
		submit: { recordId: "2", state: "written_to_pty" },
	});
	mocks.remoteHmuxInitialAgentPrompt.mockReset().mockResolvedValue({
		terminalEpoch: "terminal-1",
		recordId: "3",
		inputBaselineOutputSequence: "7",
		initialAgentRuntimeRevision: "2",
	});
	mocks.resolveRemoteHmuxStandaloneController.mockReset().mockResolvedValue({
		target: remoteTarget,
		session: remoteCatalogSession(),
	});
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "HebbianIDE",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [managedAgent()],
		sshHosts: [
			{
				id: "host-remote",
				name: "Remote",
				host: "remote.test",
				port: 22,
				user: "agent",
				auth: "auto",
			},
		],
	});
});

describe("managed agent external input", () => {
	it.each(["codex", "claude"] as const)(
		"sends a %s first prompt as one Host semantic operation",
		async (provider) => {
			const agent = managedAgent({ provider });
			useStore.setState({ agents: [agent] });

			await sendHmuxInitialAgentPrompt(agent, "first turn");

			expect(mocks.initialAgentPrompt).toHaveBeenCalledWith({
				sessionId: "session-managed",
				workspaceId: "workspace-managed",
				expectedFence: stopFence,
				prompt: "first turn",
			});
			expect(mocks.commandInput).not.toHaveBeenCalled();
		},
	);

	it("preserves a definite Host refusal for the prompt journal", async () => {
		mocks.initialAgentPrompt.mockRejectedValueOnce({
			code: "hmux_agent_prompt_not_waiting",
			message: "provider is not waiting",
			deliveryState: "not_written",
		});

		await expect(
			sendHmuxInitialAgentPrompt(managedAgent(), "first turn"),
		).rejects.toMatchObject({
			code: "hmux_agent_prompt_not_waiting",
			deliveryState: "not_written",
			bodyDelivered: false,
		});
	});

	it("preserves a pre-dispatch backend refusal for safe retry", async () => {
		mocks.initialAgentPrompt.mockRejectedValueOnce({
			code: "hmux_initial_agent_prompt_backend_unavailable",
			message: "hmux_initial_agent_prompt_backend_unavailable",
			deliveryState: "not_written",
		});

		await expect(
			sendHmuxInitialAgentPrompt(managedAgent(), "first turn"),
		).rejects.toMatchObject({
			code: "hmux_initial_agent_prompt_backend_unavailable",
			deliveryState: "not_written",
		});
	});

	it("never upgrades an ambiguous Host failure to safe retry", async () => {
		mocks.initialAgentPrompt.mockRejectedValueOnce({
			code: "hmux_agent_prompt_outcome_unknown",
			message: "connection lost after dispatch",
			deliveryState: "unknown",
		});

		await expect(
			sendHmuxInitialAgentPrompt(managedAgent(), "first turn"),
		).rejects.toMatchObject({
			code: "hmux_agent_prompt_outcome_unknown",
			deliveryState: "unknown",
		});
	});

	it("routes a fresh SSH prompt through one remote Host operation", async () => {
		const agent = remoteManagedAgent();
		useStore.setState({
			agents: [agent],
			sshHosts: [
				{
					id: "host-remote",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
		});

		await sendHmuxInitialAgentPrompt(agent, "first remote turn");

		expect(mocks.initialAgentPrompt).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxInitialAgentPrompt).toHaveBeenCalledWith({
			target: remoteTarget,
			session: remoteCatalogSession(),
			prompt: "first remote turn",
		});
	});

	it("refuses a fresh SSH prompt without an exact persisted generation", async () => {
		const agent = remoteManagedAgent(null);
		useStore.setState({ agents: [agent] });

		await expect(
			sendHmuxInitialAgentPrompt(agent, "first remote turn"),
		).rejects.toMatchObject({
			code: "remote_hmux_managed_generation_unavailable",
			deliveryState: "not_written",
		});
		expect(mocks.remoteHmuxInitialAgentPrompt).not.toHaveBeenCalled();
	});

	it("refuses a replacement SSH generation before prompt dispatch", async () => {
		const agent = remoteManagedAgent();
		useStore.setState({ agents: [agent] });
		mocks.resolveRemoteHmuxStandaloneController.mockResolvedValueOnce({
			target: remoteTarget,
			session: remoteCatalogSession("terminal-replacement"),
		});

		await expect(
			sendHmuxInitialAgentPrompt(agent, "first remote turn"),
		).rejects.toMatchObject({
			code: "remote_hmux_managed_generation_unavailable",
			deliveryState: "not_written",
		});
		expect(mocks.remoteHmuxInitialAgentPrompt).not.toHaveBeenCalled();
	});

	it("resolves exact identity and preserves separate text and submit receipts", async () => {
		const prepared = prepareManagedAgentInput({
			name: "HebbianIDE/codex-1",
			text: "status",
			enter: true,
			targetPanelId: "agent:agent-managed",
		});

		await expect(executeManagedAgentInput(prepared)).resolves.toMatchObject({
			agentId: "agent-managed",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			byteLength: 7,
			enter: true,
			receipt: {
				terminalEpoch: "terminal-1",
				text: { recordId: "1", state: "written_to_pty" },
				submit: { recordId: "2", state: "written_to_pty" },
			},
		});
		expect(mocks.commandInput).toHaveBeenCalledWith({
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			expectedFence: stopFence,
			text: "status",
			submit: true,
		});
	});

	it("preserves no-enter input and rejects oversized bytes before writing", async () => {
		const prepared = prepareManagedAgentInput({
			name: "session-managed",
			text: "draft",
			enter: false,
		});
		mocks.commandInput.mockResolvedValueOnce({
			terminalEpoch: "terminal-1",
			text: { recordId: "1", state: "written_to_pty" },
		});
		useAgentAttention.setState({ armedCompletions: {} });
		await executeManagedAgentInput(prepared);
		expect(mocks.commandInput).toHaveBeenCalledWith(
			expect.objectContaining({ text: "draft", submit: false }),
		);
		expect(useAgentAttention.getState().armedCompletions).toEqual({});

		expect(() =>
			prepareManagedAgentInput({
				name: "session-managed",
				text: "가".repeat(MAX_MANAGED_AGENT_INPUT_BYTES),
			}),
		).toThrowError(expect.objectContaining({ code: "input_too_large" }));
		expect(mocks.commandInput).toHaveBeenCalledTimes(1);
	});

	it("sends Enter-only as exactly one submit intent", async () => {
		mocks.commandInput.mockResolvedValueOnce({
			terminalEpoch: "terminal-1",
			submit: { recordId: "1", state: "written_to_pty" },
		});
		const prepared = prepareManagedAgentInput({
			name: "session-managed",
			text: "",
			enter: true,
		});

		await expect(executeManagedAgentInput(prepared)).resolves.toMatchObject({
			byteLength: 1,
			receipt: {
				submit: { recordId: "1", state: "written_to_pty" },
			},
		});
		expect(mocks.commandInput).toHaveBeenCalledWith(
			expect.objectContaining({ text: "", submit: true }),
		);
	});

	it("preserves body-delivered authority when submit fails", async () => {
		mocks.commandInput.mockRejectedValueOnce({
			code: "hmux_terminal_input_outcome_unknown",
			message: "submit outcome is unknown",
			deliveryState: "body_written_submit_unknown",
		});
		const prepared = prepareManagedAgentInput({
			name: "session-managed",
			text: "status",
		});

		const error = await executeManagedAgentInput(prepared).catch(
			(value) => value,
		);
		expect(error).toMatchObject({
			code: "hmux_terminal_input_outcome_unknown",
			bodyDelivered: true,
			deliveryState: "body_written_submit_unknown",
		});
	});

	it("rejects malformed targetPanelId before resolving or writing", () => {
		expect(() =>
			prepareManagedAgentInput({
				name: "session-managed",
				text: "status",
				targetPanelId: 7,
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
		expect(mocks.commandInput).not.toHaveBeenCalled();
	});

	it("fails closed when a short name is ambiguous", () => {
		useStore.setState((state) => ({
			projects: [
				...state.projects,
				{
					id: "project-2",
					name: "Other",
					path: "/other",
					kind: "local" as const,
					isRepo: true,
				},
			],
			agents: [
				...state.agents,
				managedAgent({
					id: "agent-other",
					projectId: "project-2",
					sessionId: "session-other",
					runtimeBinding: managedBindingFixture({
						sessionId: "session-other",
						workspaceId: "workspace-other",
						createIdempotencyKey: undefined,
					}),
				}),
			],
		}));

		expect(() =>
			prepareManagedAgentInput({ name: "codex-1", text: "status" }),
		).toThrowError(expect.objectContaining({ code: "pane_ambiguous" }));
	});

	it("rechecks exact session and workspace identity immediately before writing", async () => {
		const prepared = prepareManagedAgentInput({
			name: "agent-managed",
			text: "status",
		});
		useStore.setState((state) => ({
			agents: state.agents.map((agent) =>
				agent.id === "agent-managed"
					? {
							...agent,
							sessionId: "session-replaced",
							runtimeBinding: {
								...agent.runtimeBinding!,
								sessionId: "session-replaced",
								workspaceId: "workspace-replaced",
							},
						}
					: agent,
			),
		}));

		await expect(executeManagedAgentInput(prepared)).rejects.toMatchObject({
			code: "pane_changed",
		});
		expect(mocks.commandInput).not.toHaveBeenCalled();
	});

	it("rejects old prepared input after reattach and permits a freshly prepared request", async () => {
		const prepared = prepareManagedAgentInput({
			name: "agent-managed",
			text: "after-reattach",
		});
		const replacementFence = { ...stopFence, terminalEpoch: "terminal-2" };
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				runtimeBinding: {
					...agent.runtimeBinding!,
					stopFence: replacementFence,
				},
			})),
		}));
		mocks.commandInput.mockResolvedValueOnce({
			terminalEpoch: "terminal-2",
			text: { recordId: "1", state: "written_to_pty" },
			submit: { recordId: "2", state: "written_to_pty" },
		});

		await expect(executeManagedAgentInput(prepared)).rejects.toMatchObject({
			code: "pane_changed",
		});
		expect(mocks.commandInput).not.toHaveBeenCalled();
		await expect(
			executeManagedAgentInput(
				prepareManagedAgentInput({
					name: "agent-managed",
					text: "after-reattach",
				}),
			),
		).resolves.toMatchObject({
			receipt: { terminalEpoch: "terminal-2" },
		});
		expect(mocks.commandInput).toHaveBeenCalledWith(
			expect.objectContaining({ expectedFence: replacementFence }),
		);
	});

	it("writes to an unfocused exact local pane without activating it", async () => {
		useStore.setState({ activeSpaceId: "desktop-visible" });
		const prepared = prepareExactHmuxInput({
			target: exactTarget({ hostId: "local" }),
			text: "status",
			enter: true,
		});

		await expect(executeExactHmuxInput(prepared)).resolves.toMatchObject({
			panelId: "agent:agent-managed",
			hostId: "local",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			receipt: {
				text: { recordId: "1", state: "written_to_pty" },
				submit: { recordId: "2", state: "written_to_pty" },
			},
		});
		expect(useStore.getState().activeSpaceId).toBe("desktop-visible");
		expect(mocks.commandInput).toHaveBeenCalledWith(
			expect.objectContaining({ text: "status", submit: true }),
		);
		expect(mocks.resolveRemoteHmuxStandaloneController).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
	});

	it("uses the same correlated input path for a standalone Hmux Agent", async () => {
		useStore.setState((state) => ({
			agents: state.agents.map((agent) => ({
				...agent,
				sessionId: "session-standalone",
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_standalone_v1" as const,
					source: "local" as const,
					hostId: "local" as const,
					sessionId: "session-standalone",
					workspaceId: "workspace-standalone",
				},
			})),
		}));

		const prepared = prepareManagedAgentInput({
			name: "agent-managed",
			text: "status",
		});
		await expect(executeManagedAgentInput(prepared)).resolves.toMatchObject({
			sessionId: "session-standalone",
			workspaceId: "workspace-standalone",
		});
		expect(mocks.commandInput).toHaveBeenCalledWith({
			sessionId: "session-standalone",
			workspaceId: "workspace-standalone",
			expectedFence: undefined,
			text: "status",
			submit: true,
		});
	});

	it("writes to an unfocused exact SSH pane without changing UI focus", async () => {
		useStore.setState({
			agents: [remoteManagedAgent()],
			sshHosts: [
				{
					id: "host-remote",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
			activeSpaceId: "desktop-visible",
		});
		const prepared = prepareExactHmuxInput({
			target: exactTarget(),
			text: "status",
			enter: true,
		});

		await expect(executeExactHmuxInput(prepared)).resolves.toMatchObject({
			panelId: "agent:agent-managed",
			hostId: "host-remote",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			byteLength: 7,
			receipt: {
				text: { recordId: "1", state: "written_to_pty" },
				submit: { recordId: "2", state: "written_to_pty" },
			},
		});
		expect(useStore.getState().activeSpaceId).toBe("desktop-visible");
		expect(mocks.commandInput).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxCommandInput).toHaveBeenCalledWith({
			target: remoteTarget,
			session: remoteCatalogSession(),
			text: "status",
			submit: true,
		});
	});

	it("routes name-based input through the exact SSH Hmux binding", async () => {
		useStore.setState({
			agents: [remoteManagedAgent()],
			sshHosts: [
				{
					id: "host-remote",
					name: "remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
				},
			],
		});
		const prepared = prepareManagedAgentInput({
			name: "codex-1",
			text: "status",
			enter: true,
		});

		await expect(executeManagedAgentInput(prepared)).resolves.toMatchObject({
			agentId: "agent-managed",
			hostId: "host-remote",
			sessionId: "session-managed",
			workspaceId: "workspace-managed",
			receipt: {
				text: { recordId: "1", state: "written_to_pty" },
				submit: { recordId: "2", state: "written_to_pty" },
			},
		});
		expect(mocks.commandInput).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxCommandInput).toHaveBeenCalledWith({
			target: remoteTarget,
			session: remoteCatalogSession(),
			text: "status",
			submit: true,
		});
	});

	it("requires a new preparation for a replacement remote generation after reconnect", async () => {
		useStore.setState({ agents: [remoteManagedAgent()] });
		const prepared = prepareExactHmuxInput({
			target: exactTarget(),
			text: "retry",
		});
		mocks.resolveRemoteHmuxStandaloneController
			.mockRejectedValueOnce(new Error("remote_hmux_session_stale"))
			.mockResolvedValueOnce({
				target: remoteTarget,
				session: remoteCatalogSession("terminal-2"),
			});

		await expect(executeExactHmuxInput(prepared)).rejects.toThrow(
			"remote_hmux_session_stale",
		);
		mocks.remoteHmuxCommandInput.mockResolvedValueOnce({
			terminalEpoch: "terminal-2",
			text: { recordId: "1", state: "written_to_pty" },
			submit: { recordId: "2", state: "written_to_pty" },
		});
		await expect(executeExactHmuxInput(prepared)).rejects.toThrow(
			"remote_hmux_managed_attach_generation_changed",
		);
		expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
		useStore.setState({
			agents: [
				remoteManagedAgent({ ...stopFence, terminalEpoch: "terminal-2" }),
			],
		});
		mocks.resolveRemoteHmuxStandaloneController.mockResolvedValueOnce({
			target: remoteTarget,
			session: remoteCatalogSession("terminal-2"),
		});
		await expect(
			executeExactHmuxInput(
				prepareExactHmuxInput({ target: exactTarget(), text: "retry" }),
			),
		).resolves.toMatchObject({
			receipt: { terminalEpoch: "terminal-2" },
		});
		expect(mocks.resolveRemoteHmuxStandaloneController).toHaveBeenCalledTimes(
			3,
		);
		expect(mocks.remoteHmuxCommandInput).toHaveBeenCalledWith(
			expect.objectContaining({
				session: expect.objectContaining({ terminalEpoch: "terminal-2" }),
			}),
		);
	});

	it.each(["generation", "host"])(
		"refuses a %s replacement during remote resolution",
		async (kind) => {
			useStore.setState({ agents: [remoteManagedAgent()] });
			const prepared = prepareExactHmuxInput({
				target: exactTarget(),
				text: "must-not-land",
			});
			mocks.resolveRemoteHmuxStandaloneController.mockImplementationOnce(
				async () => {
					if (kind === "generation")
						useStore.setState({
							agents: [
								remoteManagedAgent({
									...stopFence,
									terminalEpoch: "replacement",
								}),
							],
						});
					else
						useStore.setState((state) => ({
							sshHosts: state.sshHosts.map((host) => ({
								...host,
								host: "replacement.test",
							})),
						}));
					return { target: remoteTarget, session: remoteCatalogSession() };
				},
			);
			await expect(executeExactHmuxInput(prepared)).rejects.toMatchObject({
				code: "pane_changed",
			});
			expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
		},
	);
	it("refuses a remote host edit between name-based preparation and execution", async () => {
		useStore.setState({ agents: [remoteManagedAgent()] });
		const prepared = prepareManagedAgentInput({
			name: "codex-1",
			text: "must-not-land",
		});
		useStore.setState((state) => ({
			sshHosts: state.sshHosts.map((host) => ({
				...host,
				user: "replacement",
			})),
		}));
		await expect(executeManagedAgentInput(prepared)).rejects.toMatchObject({
			code: "pane_changed",
		});
		expect(mocks.resolveRemoteHmuxStandaloneController).not.toHaveBeenCalled();
		expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
	});

	it("refuses a pane retarget that races remote fence resolution", async () => {
		useStore.setState({ agents: [remoteManagedAgent()] });
		const prepared = prepareExactHmuxInput({
			target: exactTarget(),
			text: "must-not-land",
		});
		mocks.resolveRemoteHmuxStandaloneController.mockImplementationOnce(
			async () => {
				useStore.setState((state) => ({
					agents: state.agents.map((candidate) => ({
						...candidate,
						sessionId: "session-replaced",
						runtimeBinding: {
							...candidate.runtimeBinding!,
							sessionId: "session-replaced",
							workspaceId: "workspace-replaced",
						},
					})),
				}));
				return { target: remoteTarget, session: remoteCatalogSession() };
			},
		);

		await expect(executeExactHmuxInput(prepared)).rejects.toMatchObject({
			code: "pane_changed",
		});
		expect(mocks.remoteHmuxCommandInput).not.toHaveBeenCalled();
	});
});

describe("structured chat agent input", () => {
	const chatProfile = {
		schemaVersion: 1 as const,
		kind: "structured_protocol" as const,
		backendProfileId: "local",
		interactionSessionId: "codex-chat-1",
	};
	const chatAgent = managedAgent({
		id: "agent-chat",
		name: "chat-1",
		runtimeBinding: undefined,
		interactionProfile: chatProfile,
	});

	beforeEach(() => {
		mocks.sendAgentChatMessage
			.mockReset()
			.mockResolvedValue({ delivery: "sent" });
		useStore.setState({ agents: [chatAgent] });
	});

	it("separates the captured selection from compatibility-only receipt metadata", () => {
		type Submitted = Extract<PreparedManagedAgentInput, { kind: "structured" }>;
		expectTypeOf<keyof Submitted>().toEqualTypeOf<
			"kind" | "agent" | "selection" | "profile" | "text" | "byteLength"
		>();
		expect(
			prepareManagedAgentInput({ name: "chat-1", text: "hello" }),
		).not.toHaveProperty("panelId");
	});

	it.each([undefined, "agent:agent-chat", " agent:agent-chat "])(
		"routes submitted chat through the composer's own session send (hint=%s)",
		async (targetPanelId) => {
			const prepared = prepareManagedAgentInput({
				name: "chat-1",
				text: "hello",
				targetPanelId,
			});
			expect(prepared).toMatchObject({
				kind: "structured",
				profile: chatProfile,
				text: "hello",
			});
			await expect(executeManagedAgentInput(prepared)).resolves.toEqual({
				agentId: "agent-chat",
				name: "chat-1",
				panelId: "agent:agent-chat",
				sessionId: "codex-chat-1",
				byteLength: 6,
				enter: true,
				receipt: { kind: "structured_chat", delivery: "sent" },
			});
			expect(mocks.sendAgentChatMessage).toHaveBeenCalledWith({
				agentId: "agent-chat",
				profile: chatProfile,
				text: "hello",
			});
		},
	);

	it.each(["steered", "queued"])(
		"reports %s delivery while a turn is running",
		async (delivery) => {
			mocks.sendAgentChatMessage.mockResolvedValue({ delivery });
			const prepared = prepareManagedAgentInput({
				name: "chat-1",
				text: "later",
			});
			await expect(executeManagedAgentInput(prepared)).resolves.toMatchObject({
				receipt: { kind: "structured_chat", delivery },
			});
		},
	);

	it("refuses a mismatching explicit pane hint before delivery", () => {
		expect(() =>
			prepareManagedAgentInput({
				name: "chat-1",
				text: "hello",
				targetPanelId: "agent:someone-else",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "pane_changed",
				message: "selected pane references a different Agent",
			}),
		);
		expect(mocks.sendAgentChatMessage).not.toHaveBeenCalled();
	});

	it("checks the selected interaction profile before a legacy pane hint", () => {
		expect(() =>
			prepareManagedAgentInput({
				name: "chat-1",
				text: "hello",
				targetPanelId: "agent:someone-else",
				expectedInteractionProfile: {
					...chatProfile,
					interactionSessionId: "previous-conversation",
				},
			}),
		).toThrowError(
			expect.objectContaining({
				code: "pane_changed",
				message:
					"The structured input recipient changed since it was selected.",
			}),
		);
		expect(mocks.sendAgentChatMessage).not.toHaveBeenCalled();
	});

	it("keeps the selected recipient and receipt when the Agent projection changes during delivery", async () => {
		const prepared = prepareManagedAgentInput({
			name: "chat-1",
			text: "hello",
		});
		useStore.setState({
			agents: [
				{
					...chatAgent,
					id: "replacement-agent",
					interactionProfile: {
						...chatProfile,
						interactionSessionId: "replacement-conversation",
					},
				},
			],
		});
		mocks.sendAgentChatMessage.mockImplementationOnce(async () => {
			useStore.setState({ agents: [] });
			return { delivery: "sent" };
		});
		await expect(executeManagedAgentInput(prepared)).resolves.toEqual({
			agentId: "agent-chat",
			name: "chat-1",
			panelId: "agent:agent-chat",
			sessionId: "codex-chat-1",
			byteLength: 6,
			enter: true,
			receipt: { kind: "structured_chat", delivery: "sent" },
		});
		expect(mocks.sendAgentChatMessage).toHaveBeenCalledExactlyOnceWith({
			agentId: "agent-chat",
			profile: chatProfile,
			text: "hello",
		});
		expect(useStore.getState().agents).toEqual([]);
	});

	it("propagates a delivery failure without resending or claiming success", async () => {
		const failure = new Error("fixture delivery outcome unavailable");
		mocks.sendAgentChatMessage.mockRejectedValueOnce(failure);
		const prepared = prepareManagedAgentInput({
			name: "chat-1",
			text: "hello",
		});
		await expect(executeManagedAgentInput(prepared)).rejects.toBe(failure);
		expect(mocks.sendAgentChatMessage).toHaveBeenCalledTimes(1);
	});

	it("prepares a no-enter draft and refuses blank submitted text for a chat pane", () => {
		expect(
			prepareManagedAgentInput({ name: "chat-1", text: "hello", enter: false }),
		).toMatchObject({ kind: "structured_draft", text: "hello", enter: false });
		expect(() =>
			prepareManagedAgentInput({ name: "chat-1", text: "   " }),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
		expect(mocks.sendAgentChatMessage).not.toHaveBeenCalled();
	});

	it("cannot append through the runtime-only executor without an observed draft pane", async () => {
		const before = useStore.getState().chatDrafts;
		const prepared = prepareManagedAgentInput({
			name: "chat-1",
			text: "draft without a view",
			enter: false,
		});
		await expect(executeManagedAgentInput(prepared)).rejects.toMatchObject({
			code: "invalid_request",
		});
		expect(useStore.getState().chatDrafts).toBe(before);
		expect(mocks.sendAgentChatMessage).not.toHaveBeenCalled();
	});
});
