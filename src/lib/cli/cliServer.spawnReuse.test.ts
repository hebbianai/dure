// @vitest-environment jsdom
import { createDockview } from "dockview-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HmuxExactSessionTarget } from "@/lib/ipc";
import type { AppState } from "@/store";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	addAgent: vi.fn(),
	openAgentPanel: vi.fn(() => true),
	requireProjectProvider: vi.fn(async () => ({ ready: true })),
	ensureManagedAgentRuntime: vi.fn(),
	ensureRemoteManagedAgentRuntime: vi.fn(),
	inspectRuntimeExact: vi.fn(),
	resolveBackendRoute: vi.fn(),
	resolveFencedManagedAgentPanel: vi.fn(),
	resolvePaneReference: vi.fn(),
	sendHmuxAgentCommandInput: vi.fn(),
	sendHmuxInitialAgentPrompt: vi.fn(),
	synchronize: vi.fn(),
	emit: vi.fn(),
	hmux: {
		inspectExistingManagedWriter: vi.fn(),
		inspectSessionsExact: vi.fn(),
		resolveManagedRehost: vi.fn(),
	},
}));

vi.mock("@tauri-apps/api/event", () => ({
	emit: mocks.emit,
	listen: vi.fn(),
}));

vi.mock("@/store", () => ({
	useStore: {
		getState: () => mocks.state,
		setState: vi.fn(),
	},
}));

vi.mock("@/lib/agents/agentRegistration", () => ({
	addAgent: mocks.addAgent,
}));

vi.mock("@/lib/ipc", () => ({
	homeDir: vi.fn(),
	sshConfigHosts: vi.fn(async () => ({ files: [], defaultUser: "fixture" })),
	hmux: mocks.hmux,
}));

vi.mock("@/lib/ipc/dureBackend", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureBackend")>()),
	resolveSelectedDureBackendRouteAuthority: mocks.resolveBackendRoute,
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/dureAgentRuntime")>()),
	createDureAgentRuntimeClient: () => ({
		inspectExact: mocks.inspectRuntimeExact,
	}),
}));

vi.mock("@/lib/workspace/dock", () => ({
	createTerminalPaneRelativeToSession: vi.fn(),
	openHmuxTerminalPanel: vi.fn(),
	openAgentPanel: mocks.openAgentPanel,
	resolvePaneById: vi.fn(),
	resolvePaneReference: mocks.resolvePaneReference,
}));
vi.mock(
	"@/lib/workspace/pane/paneCloseCoordinator",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/pane/paneCloseCoordinator")
		>()),
		closePanelById: vi.fn(),
	}),
);
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: vi.fn(),
	waitForDesktopDockview: vi.fn(async () => ({})),
}));
vi.mock(
	"@/lib/workspace/dock/standaloneShellTerminal",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/workspace/dock/standaloneShellTerminal")
		>()),
		openAndCommitHmuxStandaloneTerminalOn: vi.fn(),
	}),
);

vi.mock("@/lib/agents/providerPreflight", () => {
	class ProviderPreflightError extends Error {}
	return {
		ProviderPreflightError,
		requireProjectProvider: mocks.requireProjectProvider,
	};
});

vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensureManagedAgentRuntime,
}));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensureRemoteManagedAgentRuntime,
}));
vi.mock("@/lib/sessions/managed/managedAgentInput", () => ({
	sendHmuxAgentCommandInput: mocks.sendHmuxAgentCommandInput,
	sendHmuxInitialAgentPrompt: mocks.sendHmuxInitialAgentPrompt,
}));

vi.mock("@/lib/sessions/managed/managedAgentRehostInspection", () => ({
	resolveFencedManagedAgentPanel: mocks.resolveFencedManagedAgentPanel,
}));

vi.mock(
	"@/lib/sessions/managed/managedAgentRehostSynchronization",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@/lib/sessions/managed/managedAgentRehostSynchronization")
		>()),
		commitManagedAgentRehostReceipt: mocks.synchronize,
	}),
);

import { handleCliAgentReuse, reuseAgentByName } from "@/lib/cli/cliAgentReuse";
import { spawnAgent } from "@/lib/cli/cliServer";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function managedAgent(): Agent {
	return managedAgentFixture({
		id: "agent-cleaner",
		name: "cleaner",
		worktreePath: "/repo/.worktrees/cleaner",
		branch: "agent/cleaner",
		sessionId: "managed-source",
		conversationId: "conversation-1",
		runtimeBinding: managedBindingFixture({
			sessionId: "managed-source",
			createIdempotencyKey: "managed-source",
			stopFence: stopFenceFixture({
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-source",
				hostInstanceId: "host-source",
				terminalEpoch: "terminal-source",
			}),
		}),
	});
}

describe("spawn --reuse managed successor reconciliation", () => {
	async function prepareDirectIdAliasCollision() {
		mocks.state = {
			...mocks.state,
			accounts: [
				{
					id: "codex-shared",
					provider: "codex",
					name: "Direct",
					dir: "/profiles/codex-direct",
				},
				{
					id: "account-b",
					provider: "codex",
					name: "Alias",
					dir: "/profiles/codex-shared",
				},
			],
		};
		const resolution = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockResolvedValue({
			...resolution,
			launchIdentity: {
				launchReference: "codex-shared",
				conversationId: "conversation-2",
			},
		});
		const target = await mocks.hmux.inspectExistingManagedWriter({});
		mocks.hmux.inspectExistingManagedWriter.mockResolvedValue({
			...target,
			conversationId: "conversation-2",
			launchReference: "codex-shared",
		});
		return target;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.resolvePaneReference.mockReset();
		mocks.ensureManagedAgentRuntime.mockReset();
		mocks.ensureRemoteManagedAgentRuntime.mockReset();
		mocks.inspectRuntimeExact.mockReset();
		mocks.resolveBackendRoute.mockResolvedValue(
			testDureBackendRouteAuthority("backend-local", "generation-local"),
		);
		mocks.resolveFencedManagedAgentPanel.mockImplementation(async () => ({
			desktopId: "space-1",
			panelId: "pane:stable-reuse-slot",
			api: { toJSON: vi.fn(() => ({})) },
			livePanel: { api: { setActive: vi.fn() } },
		}));
		const existing = managedAgent();
		const duplicate: Agent = {
			...existing,
			id: "agent-duplicate",
			sessionId: "blank-provider",
			runtimeBinding: undefined,
		};
		mocks.addAgent.mockResolvedValue(duplicate);
		mocks.state = {
			projects: [
				{ id: "project-1", name: "HebbianIDE", kind: "local", path: "/repo" },
			],
			agents: [existing],
			activeSpaceId: "space-active",
			spaces: [
				{ id: "space-active", name: "active" },
				{ id: "space-1", name: "agent-space" },
			],
			skipPermissions: false,
			accounts: [],
			saveLayout: vi.fn(),
		};
		const successor = {
			sessionId: "managed-successor",
			workspaceId: "workspace-1",
			sessionClass: "managed",
			lifecycle: "ready",
			inputAllowed: true,
			stopFence: {
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-successor",
				channelEpoch: "8",
				hostInstanceId: "host-successor",
				terminalEpoch: "terminal-successor",
			},
			terminalEpoch: "terminal-successor",
			outputSeq: "0",
			capabilities: [],
		};
		mocks.hmux.inspectSessionsExact.mockImplementation(
			async (targets: HmuxExactSessionTarget[]) =>
				targets.map((target) => ({
					outcome: "found",
					session: {
						sessionId: target.sessionId,
						workspaceId: target.workspaceId,
						sessionClass: "managed",
						lifecycle: "ready",
						inputAllowed: true,
						stopFence: {
							runnerPrincipal: "runner-principal",
							runnerInstance: "runner-source",
							channelEpoch: "7",
							hostInstanceId: "host-source",
							terminalEpoch: "terminal-source",
						},
						terminalEpoch: "terminal-source",
						outputSeq: "0",
						capabilities: [],
					},
				})),
		);
		mocks.hmux.inspectExistingManagedWriter.mockResolvedValue({
			session: successor,
			idempotencyKey: "managed-successor",
			conversationId: "conversation-1",
			permissionMode: "default",
		});
		mocks.hmux.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: ["rehost-operation-1"],
			sourceGeneration: {
				sessionId: "managed-source",
				workspaceId: "workspace-1",
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-source",
				channelEpoch: "7",
				hostInstanceId: "host-source",
				terminalEpoch: "terminal-source",
			},
			currentGeneration: {
				sessionId: "managed-successor",
				workspaceId: "workspace-1",
				runnerPrincipal: "runner-principal",
				runnerInstance: "runner-successor",
				channelEpoch: "8",
				hostInstanceId: "host-successor",
				terminalEpoch: "terminal-successor",
			},
			providerId: "codex",
			permissionMode: "default",
		});
		mocks.synchronize.mockImplementation(async (payload) => {
			mocks.state = {
				...mocks.state,
				agents: (mocks.state.agents as Agent[]).map((agent) =>
					agent.id === payload.agentId
						? {
								...agent,
								sessionId: payload.binding.sessionId,
								runtimeBinding: payload.binding,
								conversationId: payload.conversationId ?? undefined,
								...(payload.targetCredentialId !== undefined
									? {
											accountId: payload.targetCredentialId,
											credentialId: payload.targetCredentialId ?? undefined,
										}
									: {}),
							}
						: agent,
				),
			};
			return {
				pane: {
					desktopId: payload.desktopId,
					panelId: payload.panelId,
					sessionId: payload.binding.sessionId,
					workspaceId: payload.binding.workspaceId,
				},
				payload,
			};
		});
	});

	it("starts a fresh Codex turn inside the exact managed create", async () => {
		const predecessor = managedAgent();
		if (predecessor.runtimeBinding?.runtime !== "hmux_managed_v1") {
			throw new Error("expected managed predecessor");
		}
		const successor: Agent = {
			...predecessor,
			sessionId: "managed-fresh-successor",
			runtimeBinding: {
				...predecessor.runtimeBinding,
				sessionId: "managed-fresh-successor",
				createIdempotencyKey: "managed-fresh-successor",
				stopFence: stopFenceFixture({
					terminalEpoch: "terminal-fresh-successor",
				}),
			},
		};
		mocks.state = { ...mocks.state, agents: [] };
		mocks.addAgent.mockResolvedValueOnce(predecessor);
		mocks.ensureManagedAgentRuntime.mockResolvedValueOnce({
			agent: successor,
			session: {
				sessionId: successor.sessionId,
				workspaceId: "workspace-1",
			},
			idempotencyKey: "managed-fresh-successor",
			cwd: successor.worktreePath,
			initialPromptAccepted: true,
		});
		mocks.sendHmuxInitialAgentPrompt.mockResolvedValueOnce(undefined);

		const launched = await spawnAgent({
			project: "HebbianIDE",
			provider: "codex",
			name: predecessor.name,
			prompt: "continue",
		});

		expect(launched).toBe(successor);
		expect(mocks.ensureManagedAgentRuntime).toHaveBeenCalledWith(predecessor, {
			columns: 120,
			initialPrompt: "continue",
			rows: 30,
		});
		expect(mocks.sendHmuxInitialAgentPrompt).not.toHaveBeenCalled();
		expect(mocks.sendHmuxAgentCommandInput).not.toHaveBeenCalled();
	});

	it("starts a fresh SSH Agent through the remote managed creator", async () => {
		const remote: Agent = {
			...managedAgent(),
			id: "agent-remote",
			name: "remote",
			worktreePath: "/srv/repo",
			branch: "",
			sessionId: "remote-session",
			sessionKind: "ssh",
			conversationId: undefined,
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "host-1",
				sessionId: "remote-session",
				workspaceId: "project-1",
				createIdempotencyKey: "remote-create",
				commandBridgeNonce: "remote-bridge",
			},
		};
		const successor = {
			...remote,
			started: true,
		} satisfies Agent;
		mocks.state = {
			...mocks.state,
			projects: [
				{
					id: "project-1",
					name: "Remote",
					kind: "ssh",
					path: "/srv/repo",
					sshHostId: "host-1",
					isRepo: true,
				},
			],
			agents: [],
		};
		mocks.addAgent.mockResolvedValueOnce(remote);
		mocks.ensureRemoteManagedAgentRuntime.mockResolvedValueOnce({
			agent: successor,
			sessionId: "remote-session",
			workspaceId: "project-1",
			idempotencyKey: "remote-create",
			initialPromptAccepted: true,
		});

		const launched = await spawnAgent({
			project: "Remote",
			provider: "codex",
			name: "remote",
			prompt: "continue",
			useWorktree: false,
		});

		expect(launched).toBe(successor);
		expect(mocks.ensureRemoteManagedAgentRuntime).toHaveBeenCalledWith(remote, {
			columns: 120,
			initialPrompt: "continue",
			rows: 30,
		});
		expect(mocks.ensureManagedAgentRuntime).not.toHaveBeenCalled();
		expect(mocks.sendHmuxInitialAgentPrompt).not.toHaveBeenCalled();
	});

	it("reuses the exact Agent from minimal pane params when its retired source has one durable successor", async () => {
		const reused = await spawnAgent({
			project: "HebbianIDE",
			provider: "codex",
			name: "cleaner",
			prompt: "continue",
			reuse: true,
		});

		expect(reused).toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-successor",
		});
		expect(mocks.resolveFencedManagedAgentPanel).toHaveBeenCalledWith(
			"agent-cleaner",
		);
		expect(mocks.hmux.resolveManagedRehost).toHaveBeenCalledWith(
			"managed-source",
			"workspace-1",
		);
		expect(mocks.hmux.inspectExistingManagedWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "managed-successor",
				workspaceId: "workspace-1",
				conversationId: "conversation-1",
			}),
		);
		expect(mocks.hmux.inspectSessionsExact).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
		expect(mocks.sendHmuxAgentCommandInput).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "agent-cleaner",
				sessionId: "managed-successor",
			}),
			"continue",
			true,
		);
		expect(mocks.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "agent-cleaner",
				desktopId: "space-1",
				panelId: "pane:stable-reuse-slot",
			}),
		);
	});

	it("reuses the actual Agent pane when its old ID now contains a terminal", async () => {
		mocks.state = { ...mocks.state, layouts: {} };
		const dock = await vi.importActual<typeof import("@/lib/workspace/dock")>(
			"@/lib/workspace/dock",
		);
		const inspection = await vi.importActual<
			typeof import("@/lib/sessions/managed/managedAgentRehostInspection")
		>("@/lib/sessions/managed/managedAgentRehostInspection");
		const { registerDockview, unregisterDockview } = await import(
			"@/lib/workspace/dock/dockRegistry"
		);
		const container = document.createElement("div");
		document.body.append(container);
		const api = createDockview(container, {
			createComponent: () => ({
				element: document.createElement("div"),
				init() {},
			}),
		});
		api.layout(900, 600);
		try {
			registerDockview("space-1", api);
			api.addPanel({
				id: "agent:agent-cleaner",
				component: "terminal",
				params: { sessionId: "managed-source" },
			});
			api.addPanel({
				id: "pane:actual-agent",
				component: "agent",
				params: { agentRef: { agentId: "agent-cleaner" } },
			});
			mocks.resolvePaneReference.mockImplementation(dock.resolvePaneReference);
			mocks.resolveFencedManagedAgentPanel.mockImplementation(
				inspection.resolveFencedManagedAgentPanel,
			);
			const reused = await reuseAgentByName({
				projectId: "project-1",
				projectName: "HebbianIDE",
				name: "cleaner",
				prompt: "continue",
			});
			expect(reused).toMatchObject({
				id: "agent-cleaner",
				sessionId: "managed-successor",
			});
			expect(mocks.synchronize).toHaveBeenCalledWith(
				expect.objectContaining({
					panelId: "pane:actual-agent",
					agentId: "agent-cleaner",
				}),
			);
			expect(mocks.sendHmuxAgentCommandInput).toHaveBeenCalledWith(
				reused, "continue", true,
			);
			expect(mocks.addAgent).not.toHaveBeenCalled();
			expect(api.panels.map((pane) => pane.id)).toEqual([
				"agent:agent-cleaner", "pane:actual-agent",
			]);
		} finally {
			unregisterDockview("space-1", api);
			api.dispose();
			container.remove();
		}
	});

	it("reuses the canonical final launch identity through the CLI path", async () => {
		mocks.state = {
			...mocks.state,
			accounts: [
				{
					id: "account-b",
					provider: "codex",
					name: "B",
					dir: "/profiles/codex-b",
				},
			],
		};
		const resolution = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockResolvedValue({
			...resolution,
			launchIdentity: {
				launchReference: "account-b",
				conversationId: "conversation-2",
			},
		});
		const target = await mocks.hmux.inspectExistingManagedWriter({});
		mocks.hmux.inspectExistingManagedWriter.mockResolvedValue({
			...target,
			conversationId: "conversation-2",
			launchReference: "account-b",
		});

		await spawnAgent({
			project: "HebbianIDE",
			provider: "codex",
			name: "cleaner",
			reuse: true,
		});

		expect(mocks.hmux.inspectExistingManagedWriter).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sessionId: "managed-successor",
				conversationId: "conversation-2",
				launchReference: "account-b",
			}),
		);
		expect(mocks.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				launchKind: "exact_resume",
				conversationId: "conversation-2",
				targetCredentialId: "account-b",
				binding: expect.objectContaining({ credentialId: "account-b" }),
			}),
		);
	});

	it("reuses the durable Host conversation when the rebooted pane projection has none", async () => {
		const existing = managedAgent();
		mocks.state = {
			...mocks.state,
			agents: [
				{
					...existing,
					conversationId: undefined,
					runtimeBinding: {
						...existing.runtimeBinding,
						conversationIdentity: undefined,
					},
				},
			],
		};
		const resolution = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockResolvedValue({
			...resolution,
			launchIdentity: { conversationId: "conversation-1" },
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).resolves.toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-successor",
		});
		expect(mocks.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceConversationId: null,
				conversationId: "conversation-1",
			}),
		);
	});

	it("uses the CP canonical credential when a direct id collides with another account alias", async () => {
		const target = await prepareDirectIdAliasCollision();
		mocks.inspectRuntimeExact.mockResolvedValue({
			state: "stable",
			agentId: "agent-cleaner",
			providerId: "codex",
			interactionProfile: "native_cli",
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-b",
				credential_generation: "account-b-generation-2",
			},
			providerConversationRef: "conversation-2",
			sessionId: "managed-successor",
			workspaceId: "workspace-1",
			launchIdempotencyKey: "managed-successor",
			stopFence: target.session.stopFence,
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "continue",
				reuse: true,
			}),
		).resolves.toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-successor",
			credentialId: "account-b",
			runtimeBinding: expect.objectContaining({ credentialId: "account-b" }),
		});
		expect(mocks.inspectRuntimeExact).toHaveBeenCalledWith(
			"agent-cleaner",
			testDureBackendRouteAuthority("backend-local", "generation-local"),
		);
		expect(mocks.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				targetCredentialId: "account-b",
				binding: expect.objectContaining({ credentialId: "account-b" }),
			}),
		);
		expect(mocks.sendHmuxAgentCommandInput).toHaveBeenCalledWith(
			expect.objectContaining({
				credentialId: "account-b",
				runtimeBinding: expect.objectContaining({ credentialId: "account-b" }),
			}),
			"continue",
			true,
		);
	});

	it("fails closed before CLI synchronization when an id-alias collision has no CP proof", async () => {
		await prepareDirectIdAliasCollision();
		mocks.inspectRuntimeExact.mockResolvedValue({ state: "unmanaged" });

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "continue",
				reuse: true,
			}),
		).rejects.toThrow(
			"managed rehost launch reference has no canonical target credential",
		);
		expect(mocks.inspectRuntimeExact).toHaveBeenCalledOnce();
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.sendHmuxAgentCommandInput).not.toHaveBeenCalled();
	});

	it("uses the control-plane canonical binding and Host conversation for prompt reuse", async () => {
		mocks.synchronize.mockImplementationOnce(async (payload) => {
			if (!payload.binding.stopFence) {
				throw new Error("expected fenced canonical target binding");
			}
			const canonicalBinding = {
				...payload.binding,
				credentialId: "account-canonical",
			};
			const hostBinding = {
				...canonicalBinding,
				conversationIdentity: {
					schemaVersion: 1 as const,
					sessionId: payload.binding.sessionId,
					workspaceId: payload.binding.workspaceId,
					...payload.binding.stopFence,
					revision: "2",
					observedThroughOutputSeq: "4",
					providerId: payload.providerId,
					conversationId: "conversation-canonical",
					source: "provider_event" as const,
				},
			};
			const canonicalPayload = {
				...payload,
				conversationId: "conversation-canonical",
				targetCredentialId: "account-canonical",
				binding: canonicalBinding,
			};
			mocks.state = {
				...mocks.state,
				agents: (mocks.state.agents as Agent[]).map((agent) =>
					agent.id === payload.agentId
						? {
								...agent,
								sessionId: canonicalBinding.sessionId,
								runtimeBinding: hostBinding,
								conversationId: "conversation-top-level-stale",
								accountId: canonicalPayload.targetCredentialId,
								credentialId: canonicalPayload.targetCredentialId,
							}
						: agent,
				),
			};
			return {
				pane: {
					desktopId: canonicalPayload.desktopId,
					panelId: canonicalPayload.panelId,
					sessionId: canonicalBinding.sessionId,
					workspaceId: canonicalBinding.workspaceId,
				},
				payload: canonicalPayload,
			};
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "continue",
				reuse: true,
			}),
		).resolves.toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-successor",
			conversationId: "conversation-top-level-stale",
			credentialId: "account-canonical",
			runtimeBinding: expect.objectContaining({
				credentialId: "account-canonical",
				conversationIdentity: expect.objectContaining({
					conversationId: "conversation-canonical",
				}),
			}),
		});
		expect(mocks.sendHmuxAgentCommandInput).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-top-level-stale",
				credentialId: "account-canonical",
				runtimeBinding: expect.objectContaining({
					credentialId: "account-canonical",
					conversationIdentity: expect.objectContaining({
						conversationId: "conversation-canonical",
					}),
				}),
			}),
			"continue",
			true,
		);
	});

	it("rejects prompt reuse when the Agent advances past the canonical control-plane binding", async () => {
		mocks.synchronize.mockImplementationOnce(async (payload) => {
			const canonicalBinding = {
				...payload.binding,
				credentialId: "account-canonical",
			};
			const canonicalPayload = {
				...payload,
				conversationId: "conversation-canonical",
				targetCredentialId: "account-canonical",
				binding: canonicalBinding,
			};
			const newerBinding = {
				...canonicalBinding,
				stopFence: {
					...canonicalBinding.stopFence,
					terminalEpoch: "terminal-newer",
				},
			};
			mocks.state = {
				...mocks.state,
				agents: (mocks.state.agents as Agent[]).map((agent) =>
					agent.id === payload.agentId
						? {
								...agent,
								sessionId: newerBinding.sessionId,
								runtimeBinding: newerBinding,
								conversationId: "conversation-newer",
							}
						: agent,
				),
			};
			return {
				pane: {
					desktopId: canonicalPayload.desktopId,
					panelId: canonicalPayload.panelId,
					sessionId: canonicalBinding.sessionId,
					workspaceId: canonicalBinding.workspaceId,
				},
				payload: canonicalPayload,
			};
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "continue",
				reuse: true,
			}),
		).rejects.toThrow("successor projection did not commit");
		expect(mocks.sendHmuxAgentCommandInput).not.toHaveBeenCalled();
	});

	it("reuses through the Host-owned conversation when the top-level projection is stale", async () => {
		const existing = managedAgent();
		if (
			existing.runtimeBinding?.runtime !== "hmux_managed_v1" ||
			existing.runtimeBinding.source !== "local" ||
			!existing.runtimeBinding.stopFence
		) {
			throw new Error("expected local managed binding");
		}
		const binding = {
			...existing.runtimeBinding,
			conversationIdentity: {
				schemaVersion: 1 as const,
				sessionId: existing.runtimeBinding.sessionId,
				workspaceId: existing.runtimeBinding.workspaceId,
				...existing.runtimeBinding.stopFence,
				revision: "3",
				observedThroughOutputSeq: "9",
				providerId: existing.provider,
				conversationId: "conversation-1",
				source: "provider_event" as const,
			},
		};
		mocks.state = {
			...mocks.state,
			agents: [
				{
					...existing,
					conversationId: "conversation-stale",
					runtimeBinding: binding,
				},
			],
		};

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "continue",
				reuse: true,
			}),
		).resolves.toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-successor",
		});
		expect(mocks.hmux.inspectExistingManagedWriter).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: "conversation-1" }),
		);
		expect(mocks.synchronize).toHaveBeenCalledOnce();
	});

	it("reuses the final permission mode after Hmux committed ahead of the Agent projection", async () => {
		const resolution = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockResolvedValue({
			...resolution,
			permissionMode: "bypass_approvals",
		});
		const target = await mocks.hmux.inspectExistingManagedWriter({});
		mocks.hmux.inspectExistingManagedWriter.mockResolvedValue({
			...target,
			permissionMode: "bypass_approvals",
		});

		await spawnAgent({
			project: "HebbianIDE",
			provider: "codex",
			name: "cleaner",
			reuse: true,
		});

		expect(mocks.synchronize).toHaveBeenCalledWith(
			expect.objectContaining({
				sourcePermissionMode: "default",
				permissionMode: "bypass_approvals",
			}),
		);
	});

	it("exposes successor reuse without a provider-creation fallback", async () => {
		const claim = vi.fn(async () => true);
		const result = await handleCliAgentReuse(
			{
				schemaVersion: 1,
				project: "HebbianIDE",
				name: "cleaner",
				prompt: "continue",
				idempotencyKey: "reuse-cleaner-1",
			},
			"request-1",
			{
				claim,
				state: () => mocks.state as unknown as AppState,
				reuse: reuseAgentByName,
			},
		);

		expect(result).toMatchObject({
			ok: true,
			agent: {
				id: "agent-cleaner",
				sessionId: "managed-successor",
				runtime: "hmux_managed_v1",
			},
		});
		expect(claim).toHaveBeenCalledOnce();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("returns not found instead of creating a replacement Agent", async () => {
		mocks.state = { ...mocks.state, agents: [] };
		const claim = vi.fn(async () => true);
		const result = await handleCliAgentReuse(
			{
				schemaVersion: 1,
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				prompt: "",
				idempotencyKey: "reuse-cleaner-missing",
			},
			"request-missing",
			{
				claim,
				state: () => mocks.state as unknown as AppState,
				reuse: reuseAgentByName,
			},
		);

		expect(result).toEqual({
			ok: false,
			error: {
				code: "agent_reuse_not_found",
				message: "agent HebbianIDE/cleaner is not safely reusable",
			},
		});
		expect(claim).toHaveBeenCalledOnce();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("does not create an Agent when the retired source has no successor", async () => {
		mocks.hmux.resolveManagedRehost.mockResolvedValueOnce({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: { sessionId: "managed-source", workspaceId: "workspace-1" },
		});
		mocks.hmux.inspectSessionsExact.mockResolvedValueOnce([
			{
				outcome: "not_found",
				sessionId: "managed-source",
				workspaceId: "workspace-1",
			},
		]);

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("source exited without a durable successor");
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("reuses the exact source when no durable successor exists and its generation is ready", async () => {
		mocks.hmux.resolveManagedRehost.mockResolvedValueOnce({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: { sessionId: "managed-source", workspaceId: "workspace-1" },
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).resolves.toMatchObject({
			id: "agent-cleaner",
			sessionId: "managed-source",
		});
		expect(mocks.hmux.inspectSessionsExact).toHaveBeenCalledWith([
			{ sessionId: "managed-source", workspaceId: "workspace-1" },
		]);
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("does not create an Agent while the durable rehost is incomplete", async () => {
		mocks.hmux.resolveManagedRehost.mockResolvedValueOnce({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "retry_required",
			code: "hmux_managed_rehost_retry_required",
			operationId: "rehost-operation-1",
			source: { sessionId: "managed-source", workspaceId: "workspace-1" },
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("rehost rehost-operation-1 is incomplete");
		expect(mocks.hmux.inspectSessionsExact).not.toHaveBeenCalled();
		expect(mocks.hmux.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("does not mutate when the durable successor changes during reconciliation", async () => {
		const initial = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockClear();
		mocks.hmux.resolveManagedRehost
			.mockResolvedValueOnce(initial)
			.mockResolvedValueOnce({
				...initial,
				operationIds: ["rehost-operation-1", "rehost-operation-2"],
				currentGeneration: {
					...initial.currentGeneration,
					sessionId: "managed-newer",
					terminalEpoch: "terminal-newer",
				},
			});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow(
			"managed rehost lineage changed during successor inspection",
		);
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("rejects a durable mapping for a different source generation", async () => {
		const resolution = await mocks.hmux.resolveManagedRehost(
			"managed-source",
			"workspace-1",
		);
		mocks.hmux.resolveManagedRehost.mockResolvedValueOnce({
			...resolution,
			sourceGeneration: {
				...resolution.sourceGeneration,
				terminalEpoch: "terminal-other",
			},
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("managed rehost resolution changed its exact lineage");
		expect(mocks.hmux.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("rejects a successor whose inspected Host generation changed", async () => {
		const target = await mocks.hmux.inspectExistingManagedWriter({});
		mocks.hmux.inspectExistingManagedWriter.mockResolvedValueOnce({
			...target,
			session: {
				...target.session,
				stopFence: {
					...target.session.stopFence,
					hostInstanceId: "host-other",
				},
			},
		});

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("managed rehost successor changed its exact generation");
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("does not mutate when the exact existing pane is missing", async () => {
		mocks.resolveFencedManagedAgentPanel.mockRejectedValueOnce(
			new Error("pane missing"),
		);

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("pane missing");
		expect(mocks.hmux.inspectExistingManagedWriter).not.toHaveBeenCalled();
		expect(mocks.synchronize).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});

	it("fails closed when the registry has two same-name Agents", async () => {
		mocks.state = {
			...mocks.state,
			agents: [
				...(mocks.state.agents as Agent[]),
				{ ...(mocks.state.agents as Agent[])[0], id: "agent-other" },
			],
		};

		await expect(
			spawnAgent({
				project: "HebbianIDE",
				provider: "codex",
				name: "cleaner",
				reuse: true,
			}),
		).rejects.toThrow("2 agents named cleaner");
		expect(mocks.hmux.resolveManagedRehost).not.toHaveBeenCalled();
		expect(mocks.addAgent).not.toHaveBeenCalled();
	});
});
