import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	ensureRemoteRuntime: vi.fn(),
	mountedDockviewEntries: vi.fn(),
	navigateToPanel: vi.fn(),
	openAgentPanel: vi.fn(),
}));

vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensureRemoteRuntime,
	advanceRemoteManagedAgentRuntime: mocks.ensureRemoteRuntime,
}));
vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	openAgentPanel: mocks.openAgentPanel,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	mountedDockviewEntries: mocks.mountedDockviewEntries,
}));
vi.mock("@/lib/workspace/dock/panelFocusHandoff", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/panelFocusHandoff")
	>()),
	navigateToPanel: mocks.navigateToPanel,
}));

import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import { launchDiscoveredRemoteConversationPane } from "@/lib/sessions/launch/discoveredConversationLaunch";
import { useStore } from "@/store";
import type { Agent, HmuxManagedStopFenceV1, Project } from "@/types";

const stopFence: HmuxManagedStopFenceV1 = {
	runnerPrincipal: "runner-principal",
	runnerInstance: "runner-instance",
	channelEpoch: "7",
	hostInstanceId: "host-instance",
	terminalEpoch: "terminal-epoch",
};

const remoteProject: Project = {
	id: "project-remote",
	name: "product",
	path: "/srv/product",
	kind: "ssh",
	sshHostId: "build-mac",
	isRepo: true,
};

function remoteAgent(input: {
	id: string;
	hostId?: string;
	conversationId?: string;
	projectId?: string;
}): Agent {
	const hostId = input.hostId ?? "build-mac";
	return {
		id: input.id,
		name: input.id,
		provider: "codex",
		projectId: input.projectId ?? remoteProject.id,
		worktreePath: "/srv/product/.worktrees/rollout",
		branch: "",
		sessionId: input.id,
		sessionKind: "ssh",
		started: true,
		conversationId: input.conversationId ?? "remote-conversation",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId,
			sessionId: input.id,
			workspaceId: input.projectId ?? remoteProject.id,
			createIdempotencyKey: input.id,
			commandBridgeNonce: `bridge_${input.id}`,
			stopFence,
		},
	};
}

function launch(conversationId = "remote-conversation") {
	return launchDiscoveredRemoteConversationPane({
		provider: "codex",
		conversationId,
		cwd: "/srv/product/.worktrees/rollout",
		workspaceRoot: "/srv/product",
		hostId: "build-mac",
		desktopId: "desktop-active",
	});
}

beforeEach(() => {
	mocks.ensureRemoteRuntime.mockReset();
	mocks.mountedDockviewEntries.mockReset();
	mocks.mountedDockviewEntries.mockReturnValue([]);
	mocks.navigateToPanel.mockReset();
	mocks.openAgentPanel.mockReset();
	mocks.openAgentPanel.mockReturnValue(true);
	useStore.setState((state) => ({
		projects: [],
		agents: [],
		layouts: {},
		agentActivity: {},
		accounts: [],
		activeAccounts: {},
		sshHosts: [
			{
				id: "build-mac",
				name: "Build Mac",
				host: "build.test",
				port: 22,
				user: "agent",
				auth: "auto",
			},
		],
		stats: { ...state.stats, agentsStarted: 0 },
		sessionCwd: { "stable-session": "/stable/cwd" },
		ensureProjectForPath: vi.fn(async () => {
			useStore.setState({ projects: [remoteProject] });
			return remoteProject;
		}),
	}));
	mocks.ensureRemoteRuntime.mockImplementation(
		async (agent: Agent, options: { beforeCreate?: () => void }) => {
			options.beforeCreate?.();
			useStore.setState((state) => ({
				agents: state.agents.map((candidate) =>
					candidate.id === agent.id
						? {
								...candidate,
								started: true,
								runtimeBinding: candidate.runtimeBinding
									? { ...candidate.runtimeBinding, stopFence }
									: candidate.runtimeBinding,
							}
						: candidate,
				),
			}));
			const committed = useStore
				.getState()
				.agents.find((candidate) => candidate.id === agent.id);
			if (!committed) throw new Error("remote test commit was lost");
			return { agent: committed, stopFence };
		},
	);
});

describe("launchDiscoveredRemoteConversationPane", () => {
	it("retries a stopped SSH generation after a transient advance failure", async () => {
		const existing = remoteAgent({ id: "retry-exited-agent" });
		useStore.setState({
			projects: [remoteProject],
			agents: [existing],
			agentActivity: { [existing.id]: "exited" },
		});
		const transient = new ManagedCreateRetrySameError(
			"authority_unavailable",
			"remote_authority_unavailable",
			"retry the exact identity",
		);
		mocks.ensureRemoteRuntime.mockImplementationOnce(async (agent: Agent) => {
			useStore.getState().setAgentActivity(agent.id, "connecting");
			throw transient;
		});
		await expect(launch()).rejects.toBe(transient);
		await expect(launch()).resolves.toMatchObject({ id: existing.id });
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.ensureRemoteRuntime.mock.calls[1][0]).toBe(existing);
	});

	it("resumes an exited SSH owner through its existing create identity", async () => {
		const existing = remoteAgent({ id: "exited-agent" });
		useStore.setState({
			projects: [remoteProject],
			agents: [existing],
			agentActivity: { [existing.id]: "exited" },
		});
		await expect(launch()).resolves.toMatchObject({
			id: existing.id,
			started: true,
			conversationId: existing.conversationId,
		});
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
		expect(mocks.ensureRemoteRuntime.mock.calls[0][0]).toBe(existing);
		expect(useStore.getState().ensureProjectForPath).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toHaveLength(1);
	});
	it("continues a retained SSH create on the next explicit resume", async () => {
		const transient = new ManagedCreateRetrySameError(
			"authority_unavailable",
			"remote_authority_unavailable",
			"retry the exact identity",
		);
		mocks.ensureRemoteRuntime.mockRejectedValueOnce(transient);
		await expect(launch()).rejects.toBe(transient);
		const retained = useStore.getState().agents[0];
		await expect(launch()).resolves.toMatchObject({
			id: retained.id,
			started: true,
		});
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.ensureRemoteRuntime.mock.calls[1][0]).toBe(retained);
		expect(useStore.getState().agents).toHaveLength(1);
	});

	it("registers a canonical path-shaped provider conversation identity", async () => {
		const conversationId = "threads/2026-08-30:turn_1";

		const agent = await launch(conversationId);

		expect(agent.conversationId).toBe(conversationId);
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
		expect(mocks.openAgentPanel).toHaveBeenCalledWith("desktop-active", agent);
	});

	it.each(["conversation+alias", `/${"a".repeat(160)}`])(
		"rejects a non-canonical remote conversation identity: %s",
		async (conversationId) => {
			await expect(launch(conversationId)).rejects.toThrow(
				"invalid_conversation_identity",
			);

			expect(useStore.getState().ensureProjectForPath).not.toHaveBeenCalled();
			expect(mocks.ensureRemoteRuntime).not.toHaveBeenCalled();
		},
	);

	it("coalesces concurrent clicks for the same host-scoped conversation", async () => {
		let register: ((project: Project) => void) | undefined;
		const ensureProjectForPath = vi.fn(
			() =>
				new Promise<Project>((resolve) => {
					register = resolve;
				}),
		);
		useStore.setState({ ensureProjectForPath });

		const first = launch();
		const concurrent = launch();
		expect(concurrent).toBe(first);
		register?.(remoteProject);
		useStore.setState({ projects: [remoteProject] });

		await expect(Promise.all([first, concurrent])).resolves.toHaveLength(2);
		expect(ensureProjectForPath).toHaveBeenCalledOnce();
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
		expect(mocks.openAgentPanel).toHaveBeenCalledOnce();
	});

	it("registers the exact host/path and opens only after remote admission", async () => {
		let admit: ((fence: HmuxManagedStopFenceV1) => void) | undefined;
		mocks.ensureRemoteRuntime.mockImplementationOnce(
			async (agent: Agent, options: { beforeCreate?: () => void }) => {
				options.beforeCreate?.();
				const fence = await new Promise<HmuxManagedStopFenceV1>((resolve) => {
					admit = resolve;
				});
				useStore.setState((state) => ({
					agents: state.agents.map((candidate) =>
						candidate.id === agent.id
							? {
									...candidate,
									started: true,
									runtimeBinding: candidate.runtimeBinding
										? { ...candidate.runtimeBinding, stopFence: fence }
										: candidate.runtimeBinding,
								}
							: candidate,
					),
				}));
				const committed = useStore
					.getState()
					.agents.find((candidate) => candidate.id === agent.id);
				if (!committed) throw new Error("remote test commit was lost");
				return { agent: committed, stopFence: fence };
			},
		);

		const pending = launch();
		await vi.waitFor(() => expect(useStore.getState().agents).toHaveLength(1));
		const staged = useStore.getState().agents[0];
		expect(staged).toMatchObject({
			provider: "codex",
			projectId: remoteProject.id,
			worktreePath: "/srv/product/.worktrees/rollout",
			conversationId: "remote-conversation",
			started: false,
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "build-mac",
				workspaceId: remoteProject.id,
			},
		});
		expect(useStore.getState().ensureProjectForPath).toHaveBeenCalledWith(
			"/srv/product",
			"build-mac",
		);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();

		admit?.(stopFence);
		const opened = await pending;

		expect(opened.started).toBe(true);
		expect(opened.runtimeBinding).toMatchObject({ stopFence });
		expect(mocks.openAgentPanel).toHaveBeenCalledWith("desktop-active", opened);
		expect(useStore.getState().stats.agentsStarted).toBe(1);
	});

	it("opens the exact ledger successor after remote create advances", async () => {
		let successor: Agent | undefined;
		mocks.ensureRemoteRuntime.mockImplementationOnce(
			async (initial: Agent, options: { beforeCreate?: () => void }) => {
				options.beforeCreate?.();
				const binding = initial.runtimeBinding;
				if (
					binding?.runtime !== "hmux_managed_v1" ||
					binding.source !== "ssh"
				) {
					throw new Error("expected remote managed predecessor");
				}
				const committed: Agent = {
					...initial,
					sessionId: "remote-successor-session",
					started: true,
					runtimeBinding: {
						...binding,
						sessionId: "remote-successor-session",
						createIdempotencyKey: "remote-successor-create",
						stopFence,
					},
				};
				successor = committed;
				useStore.setState((state) => ({
					agents: state.agents.map((agent) =>
						agent.id === initial.id ? committed : agent,
					),
				}));
				return { agent: committed, stopFence };
			},
		);

		const opened = await launch();

		expect(opened).toBe(successor);
		expect(mocks.openAgentPanel).toHaveBeenCalledWith(
			"desktop-active",
			successor,
		);
	});

	it("rolls back its Agent and pane when remote admission is refused", async () => {
		const refusal = new Error("remote_transport_failed");
		mocks.ensureRemoteRuntime.mockRejectedValueOnce(refusal);

		await expect(launch()).rejects.toBe(refusal);

		expect(useStore.getState().agents).toEqual([]);
		expect(useStore.getState().agentActivity).toEqual({});
		expect(useStore.getState().stats.agentsStarted).toBe(0);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it.each([
		new ManagedCreateRetrySameError(
			"authority_unavailable",
			"remote_authority_unavailable",
			"retry the exact identity",
		),
		new ManagedCreateRetrySameError(
			"create_retryable",
			"managed_create_outcome_unknown",
			"backend_transport_remote_error",
		),
	])(
		"preserves its exact registration when remote reconciliation is non-terminal",
		async (reconciliation) => {
			mocks.ensureRemoteRuntime.mockRejectedValueOnce(reconciliation);

			await expect(launch()).rejects.toBe(reconciliation);

			expect(useStore.getState().agents).toHaveLength(1);
			expect(useStore.getState().agents[0]).toMatchObject({
				started: false,
				conversationId: "remote-conversation",
				runtimeBinding: {
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "build-mac",
				},
			});
			expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
			expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		},
	);

	it("keeps an admitted remote generation registered when pane mount fails", async () => {
		mocks.openAgentPanel.mockReturnValueOnce(false);

		await expect(launch()).rejects.toThrow(
			"managed conversation target desktop is not mounted",
		);

		expect(useStore.getState().agents).toHaveLength(1);
		expect(useStore.getState().agents[0]).toMatchObject({
			started: true,
			runtimeBinding: { stopFence },
		});
		expect(useStore.getState().stats.agentsStarted).toBe(0);
	});

	it("opens a known exact host-scoped owner without registering a duplicate", async () => {
		const existing = remoteAgent({ id: "existing-agent" });
		useStore.setState({
			projects: [remoteProject],
			agents: [existing],
			agentActivity: { [existing.id]: "waiting" },
		});

		await expect(launch()).resolves.toMatchObject(existing);

		expect(useStore.getState().ensureProjectForPath).not.toHaveBeenCalled();
		expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
		expect(mocks.openAgentPanel).toHaveBeenCalledWith(
			"desktop-active",
			existing,
		);
	});

	it.each([
		"agent:existing-agent",
		"slot",
		"launcher:previous",
		"agent:previous",
	])(
		"focuses the existing %s pane instead of duplicating its Agent in the active desktop",
		async (panelId) => {
			const existing = remoteAgent({ id: "existing-agent" });
			useStore.setState({
				projects: [remoteProject],
				agents: [existing],
				agentActivity: { [existing.id]: "working" },
				layouts: {
					"desktop-existing": {
						panels: {
							[panelId]: {
								contentComponent: "agent",
								params: { agentRef: { agentId: existing.id } },
							},
						},
					},
				},
			});

			await expect(launch()).resolves.toMatchObject(existing);

			expect(mocks.navigateToPanel).toHaveBeenCalledWith(
				"desktop-existing",
				panelId,
			);
			expect(mocks.openAgentPanel).not.toHaveBeenCalled();
			expect(mocks.ensureRemoteRuntime).toHaveBeenCalledOnce();
		},
	);

	it("does not let the same conversation id on another host claim this launch", async () => {
		const otherProject: Project = {
			...remoteProject,
			id: "project-other",
			sshHostId: "other-host",
		};
		const other = remoteAgent({
			id: "other-host-agent",
			hostId: "other-host",
			projectId: otherProject.id,
		});
		useStore.setState({ projects: [otherProject], agents: [other] });

		const opened = await launch();

		expect(opened.id).not.toBe(other.id);
		expect(opened.runtimeBinding).toMatchObject({ hostId: "build-mac" });
		expect(useStore.getState().agents).toEqual([other, opened]);
	});

	it("rechecks host-scoped ownership immediately before remote create", async () => {
		const competitor = remoteAgent({ id: "competing-agent" });
		mocks.ensureRemoteRuntime.mockImplementationOnce(
			async (_agent: Agent, options: { beforeCreate?: () => void }) => {
				useStore.setState((state) => ({
					agents: [...state.agents, competitor],
					agentActivity: {
						...state.agentActivity,
						[competitor.id]: "working",
					},
				}));
				options.beforeCreate?.();
				return stopFence;
			},
		);

		await expect(launch()).rejects.toThrow(
			"remote conversation owner appeared before create",
		);

		expect(useStore.getState().agents).toEqual([competitor]);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("refuses a changed conversation at the final remote create boundary", async () => {
		let createStarted = false;
		mocks.ensureRemoteRuntime.mockImplementationOnce(
			async (initial: Agent, options: { beforeCreate?: () => void }) => {
				useStore.setState((state) => ({
					agents: state.agents.map((candidate) =>
						candidate.id === initial.id
							? {
									...candidate,
									conversationId: "conversation-successor",
									conversationIdentity: {
										state: "ready",
										conversationId: "conversation-successor",
									},
								}
							: candidate,
					),
				}));
				options.beforeCreate?.();
				createStarted = true;
				const committed = useStore
					.getState()
					.agents.find((candidate) => candidate.id === initial.id);
				if (!committed) throw new Error("remote test commit was lost");
				return { agent: committed, stopFence };
			},
		);

		await expect(launch()).rejects.toThrow(
			"remote conversation registration changed before create",
		);

		expect(createStarted).toBe(false);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([
			expect.objectContaining({
				conversationId: "conversation-successor",
				conversationIdentity: {
					state: "ready",
					conversationId: "conversation-successor",
				},
			}),
		]);
	});
});
