import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";
import { ManagedAgentInputError } from "@/lib/sessions/managed/managedAgentInputError";
import type { Agent, Project } from "@/types";

const mocks = vi.hoisted(() => ({
	append: vi.fn(),
	receipt: vi.fn(),
	ensureManaged: vi.fn(),
	ensureRemoteManaged: vi.fn(),
	executePromptDelivery: vi.fn(),
	sendInitialPrompt: vi.fn(),
	sessionExists: vi.fn(),
	sessionWrite: vi.fn(),
	querySessionAgent: vi.fn(),
	screenSnapshot: vi.fn(),
	openPanel: vi.fn(),
	rawClose: vi.fn(),
	removeDurably: vi.fn(),
	rollbackRegistration: vi.fn(),
	requireProvider: vi.fn(),
	createWorktree: vi.fn(),
	listDir: vi.fn(),
	worktreeCommand: vi.fn(),
	provisionWorktree: vi.fn(),
	resolveExistingWorktree: vi.fn(),
}));

const localRuntimeBinding = {
	schemaVersion: 1,
	runtime: "hmux_managed_v1",
	source: "local",
	hostId: "local",
	sessionId: "agent-spawn",
	workspaceId: "workspace-1",
	createIdempotencyKey: "create-1",
} as const satisfies NonNullable<Agent["runtimeBinding"]>;

const agent: Agent = {
	id: "agent-spawn",
	name: "codex-1",
	provider: "codex" as const,
	projectId: "project-1",
	worktreePath: "/repo",
	branch: "main",
	sessionId: "agent-spawn",
	sessionKind: "pty" as const,
	runtimeBinding: localRuntimeBinding,
};

const successorRuntimeBinding = {
	...localRuntimeBinding,
	sessionId: "agent-spawn-successor",
	createIdempotencyKey: "create-successor",
	stopFence: {
		runnerPrincipal: "runner-principal",
		runnerInstance: "runner-successor",
		channelEpoch: "8",
		hostInstanceId: "host-successor",
		terminalEpoch: "terminal-successor",
	},
} as const;

const successorAgent: Agent = {
	...agent,
	sessionId: "agent-spawn-successor",
	started: true,
	runtimeBinding: successorRuntimeBinding,
};

const promptInputReceipt = {
	terminalEpoch: "terminal-successor",
	recordId: "1",
	inputBaselineOutputSequence: "0",
	initialAgentRuntimeRevision: "1",
};

const promptDigestHex =
	"bef4261f394bf71fd2b565cd76396ac9ed7953f9110c69ee49d7a82871238fbf";
const promptDigest = `sha256:${promptDigestHex}`;

function mockPromptDigest() {
	const bytes = Uint8Array.from(promptDigestHex.match(/../g) ?? [], (value) =>
		Number.parseInt(value, 16),
	);
	return vi
		.spyOn(globalThis.crypto.subtle, "digest")
		.mockResolvedValue(bytes.buffer as ArrayBuffer);
}

const localProject: Project = {
	id: "project-1",
	name: "project",
	kind: "local",
	path: "/repo",
	isRepo: true,
};

function remoteSpawnFixtures() {
	const project: Project = {
		id: "project-1",
		name: "project",
		kind: "ssh",
		path: "/srv/repo",
		sshHostId: "host-1",
		isRepo: true,
	};
	const registered: Agent = {
		...agent,
		worktreePath: project.path,
		branch: "",
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			sessionId: "agent-spawn",
			workspaceId: "project-1",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
		},
	};
	const stopFence = {
		runnerPrincipal: "runner-principal",
		runnerInstance: "runner-remote",
		channelEpoch: "8",
		hostInstanceId: "host-remote",
		terminalEpoch: "terminal-remote",
	};
	const launched = {
		...registered,
		started: true,
		runtimeBinding: {
			...registered.runtimeBinding,
			stopFence,
		},
	} as Agent;
	return { project, registered, launched, stopFence };
}

const store = {
	projects: [localProject] as Project[],
	agents: [] as Agent[],
	activeSpaceId: "desktop-1",
	skipPermissions: {},
	addAgent: vi.fn(async (_options: unknown) => agent),
};

vi.mock("@/store", () => ({
	useStore: { getState: () => store },
}));
vi.mock("@/lib/agents/agentRegistration", () => ({
	addAgent: (options: unknown) => store.addAgent(options),
}));
vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensureManaged,
}));
vi.mock("@/lib/sessions/launch/remoteManagedAgentRuntime", () => ({
	ensureRemoteManagedAgentRuntime: mocks.ensureRemoteManaged,
}));
vi.mock("@/lib/sessions/managed/managedAgentInput", () => ({
	sendHmuxInitialAgentPrompt: mocks.sendInitialPrompt,
}));
vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openPanel,
	resolvePaneReference: vi.fn(),
}));
vi.mock("@/lib/workspace/dock/openAgentPanel", () => ({
	presentAgentPanelOnDockview: ({ desktopId, agent, position }: { desktopId: string; agent: Agent; position?: unknown }) => {
		const id = mocks.openPanel(desktopId, agent, position);
		return id ? { panel: { id }, paneOwnership: "created_by_request" } : false;
	},
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	getDockview: vi.fn(() => ({
		getPanel: () => ({ api: { close: mocks.rawClose } }),
	})),
}));
vi.mock("@/lib/workspace/pane/paneCloseCoordinator", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/pane/paneCloseCoordinator")>()),
	removePanelsWithoutSessionTeardown: mocks.removeDurably,
	preparePaneProjectionRemoval: (_desktopId: string, _api: unknown, panel: { id: string }) => () => {
		mocks.removeDurably([panel.id]);
		return true;
	},
}));
vi.mock("@/lib/agents/providerPreflight", () => ({
	ProviderPreflightError: class ProviderPreflightError extends Error {},
	requireProjectProvider: mocks.requireProvider,
}));
vi.mock("@/lib/agents/agentRegistrationRollback", () => ({
	launchAgentRegistrationEvidence: (candidate: Agent) => ({
		conversationId: candidate.conversationId,
		conversationIdentity: candidate.conversationIdentity
			? { ...candidate.conversationIdentity }
			: undefined,
	}),
	rollbackCreatedAgentRegistration: mocks.rollbackRegistration,
}));
vi.mock(
	"@/lib/sessions/launch/spawnPromptDelivery",
	async (importOriginal) => {
		const original = await importOriginal<
			typeof import("@/lib/sessions/launch/spawnPromptDelivery")
		>();
		mocks.executePromptDelivery.mockImplementation(
			original.executePromptDelivery,
		);
		return {
			...original,
			executePromptDelivery: mocks.executePromptDelivery,
		};
	},
);
vi.mock("@/lib/ipc", () => ({
	spawnJournal: { append: mocks.append, receipt: mocks.receipt },
	hmux: {},
	session: { exists: mocks.sessionExists, write: mocks.sessionWrite },
	listDir: mocks.listDir,
	createWorktree: mocks.createWorktree,
	provisionWorktree: mocks.provisionWorktree,
	resolveExistingWorktree: mocks.resolveExistingWorktree,
	querySessionCwd: vi.fn(),
	querySessionAgent: mocks.querySessionAgent,
	sessionScreenSnapshot: mocks.screenSnapshot,
	worktreeCommand: mocks.worktreeCommand,
}));
vi.mock("@/lib/i18n", () => ({ t: (value: string) => value }));
vi.mock("nanoid", () => ({ nanoid: () => "spawn" }));

import { runSpawnSagaFromCli } from "@/lib/sessions/launch/spawnSaga";

describe("spawn saga journal authority and compensation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sendInitialPrompt.mockReset().mockResolvedValue(promptInputReceipt);
		store.projects = [localProject];
		store.agents = [];
		store.addAgent.mockImplementation(async () => agent);
		mocks.openPanel.mockReturnValue("agent:agent-spawn");
		mocks.requireProvider.mockResolvedValue(undefined);
		mocks.ensureManaged.mockRejectedValue(new Error("managed create failed"));
		mocks.rollbackRegistration.mockResolvedValue(true);
		mocks.sessionExists.mockResolvedValue(true);
		mocks.sessionWrite.mockResolvedValue(undefined);
		mocks.querySessionAgent.mockResolvedValue("codex");
		mocks.screenSnapshot.mockResolvedValue("before");
		mocks.append.mockResolvedValue(undefined);
		mocks.listDir.mockRejectedValue(new Error("missing"));
		mocks.worktreeCommand.mockResolvedValue([
			"git worktree add",
			"/repo/.worktrees/codex-1",
			"agent/codex-1",
		]);
		mocks.createWorktree.mockResolvedValue({
			path: "/repo/.worktrees/codex-1",
			branch: "agent/codex-1",
		});
		mocks.provisionWorktree.mockResolvedValue({
			path: "/repo/.worktrees/codex-1",
			branch: "agent/codex-1",
		});
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				accountId: "account-codex-work",
				useWorktree: false,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});
	});

	it("routes an SSH root spawn through the remote Host prompt authority", async () => {
		const digest = mockPromptDigest();
		const { project, registered, launched, stopFence } = remoteSpawnFixtures();
		try {
			store.projects = [project];
			store.addAgent.mockImplementation(async () => {
				store.agents = [registered];
				return registered;
			});
			mocks.receipt.mockResolvedValue({
				v: 1,
				receiptId: "spawn-1",
				request: {
					receiptId: "spawn-1",
					project: "project",
					provider: "codex",
					useWorktree: false,
					promptDigest,
					promptLen: 7,
				},
				steps: [],
				state: "running",
				updatedAt: 1,
			});
			mocks.ensureRemoteManaged.mockResolvedValue({
				agent: launched,
				stopFence,
				sessionId: "agent-spawn",
				workspaceId: "project-1",
				idempotencyKey: "create-remote",
			});

			await runSpawnSagaFromCli({ receiptId: "spawn-1", prompt: "ship it" });

			expect(mocks.ensureRemoteManaged).toHaveBeenCalledOnce();
			expect(mocks.ensureManaged).not.toHaveBeenCalled();
			expect(mocks.append).toHaveBeenCalledWith(
				"spawn-1",
				expect.objectContaining({
					event: "step_succeeded",
					step: "runtime_session",
					detail: expect.objectContaining({
						sessionId: "agent-spawn",
						workspaceId: "project-1",
						idempotencyKey: "create-remote",
					}),
				}),
			);
			expect(mocks.sendInitialPrompt).toHaveBeenCalledWith(launched, "ship it");
			expect(mocks.append).toHaveBeenCalledWith(
				"spawn-1",
				expect.objectContaining({ event: "saga_finished", state: "succeeded" }),
			);
		} finally {
			digest.mockRestore();
		}
	});

	it("retains the SSH registration and retries the same create identity after retry_same", async () => {
		const { project, registered, launched, stopFence } = remoteSpawnFixtures();
		const request = {
			receiptId: "spawn-1",
			project: "project",
			provider: "codex",
			useWorktree: false,
		};
		store.projects = [project];
		store.addAgent.mockImplementation(async () => {
			store.agents = [registered];
			return registered;
		});
		mocks.receipt
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [],
				state: "running",
				updatedAt: 1,
			})
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [
					{ step: "preflight", status: "ok" },
					{ step: "worktree", status: "skipped" },
					{
						step: "pane",
						status: "ok",
						artifacts: [
							{ kind: "agent_registration", id: registered.id },
							{
								kind: "pane",
								id: `agent:${registered.id}`,
								desktopId: "desktop-1",
							},
						],
					},
					{ step: "runtime_session", status: "failed" },
				],
				state: "failed",
				updatedAt: 2,
			});
		mocks.ensureRemoteManaged
			.mockRejectedValueOnce(
				new ManagedCreateRetrySameError(
					"create_retryable",
					"remote_create_outcome_unknown",
					"remote create outcome is not known yet",
				),
			)
			.mockResolvedValueOnce({
				agent: launched,
				stopFence,
				sessionId: "agent-spawn",
				workspaceId: "project-1",
				idempotencyKey: "create-remote",
			});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.append).toHaveBeenCalledWith("spawn-1", {
			event: "step_failed",
			step: "runtime_session",
			error: {
				code: "managed_create_retry_same",
				message: "remote create outcome is not known yet",
			},
		});
		expect(mocks.append).toHaveBeenCalledWith("spawn-1", {
			event: "saga_finished",
			state: "failed",
			reason: "managed_create_retry_same",
		});
		expect(mocks.append).not.toHaveBeenCalledWith("spawn-1", {
			event: "compensation_started",
		});
		expect(mocks.rollbackRegistration).not.toHaveBeenCalled();

		mocks.append.mockClear();
		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(store.addAgent).toHaveBeenCalledOnce();
		expect(mocks.ensureRemoteManaged).toHaveBeenNthCalledWith(
			2,
			registered,
			{ columns: 120, rows: 30 },
		);
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({ event: "saga_finished", state: "succeeded" }),
		);
	});

	it("refuses an SSH worktree before creating any artifact", async () => {
		store.projects = [
			{
				id: "project-1",
				name: "project",
				kind: "ssh",
				path: "/srv/repo",
				sshHostId: "host-1",
				isRepo: true,
			},
		];
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: true,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_failed",
				step: "preflight",
				error: expect.objectContaining({ code: "remote_worktree_unsupported" }),
			}),
		);
		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.ensureManaged).not.toHaveBeenCalled();
		expect(mocks.ensureRemoteManaged).not.toHaveBeenCalled();
	});

	it.each(["pending", "ok"] as const)(
		"delivers through the exact create successor when runtime_session is %s",
		async (runtimeSessionStatus) => {
			const digest = mockPromptDigest();
			try {
				const receipt = {
					v: 1,
					receiptId: "spawn-1",
					request: {
						receiptId: "spawn-1",
						project: "project",
						provider: "codex",
						useWorktree: false,
						promptDigest,
						promptLen: 7,
					},
					steps: [
						{ step: "preflight", status: "ok", artifacts: [] },
						{ step: "worktree", status: "skipped", artifacts: [] },
						{
							step: "pane",
							status: "ok",
							artifacts: [
								{ kind: "agent_registration", id: "agent-spawn" },
							],
						},
						{
							step: "runtime_session",
							status: runtimeSessionStatus,
							artifacts: [],
						},
						{ step: "provider_exec", status: "pending", artifacts: [] },
						{ step: "prompt_delivery", status: "pending", artifacts: [] },
					],
					state: "running",
					updatedAt: 1,
				};
				store.agents = [agent];
				mocks.receipt.mockResolvedValue(receipt);
				mocks.ensureManaged.mockResolvedValue({
					agent: successorAgent,
					session: {
						sessionId: "agent-spawn-successor",
						workspaceId: "workspace-1",
					},
					idempotencyKey: "create-successor",
					cwd: "/repo",
					outcome: "created",
				});
				mocks.sendInitialPrompt.mockResolvedValue(promptInputReceipt);

				await runSpawnSagaFromCli({
					receiptId: "spawn-1",
					prompt: "ship it",
				});

				expect(mocks.ensureManaged).toHaveBeenCalledOnce();
				expect(mocks.sendInitialPrompt).toHaveBeenCalledWith(
					successorAgent,
					"ship it",
				);
			} finally {
				digest.mockRestore();
			}
		},
	);

	it("resumes an accepted launch without needing the raw prompt or a PTY", async () => {
		store.agents = [agent];
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: false,
				promptDigest,
				promptLen: 7,
			},
			steps: [
				{ step: "preflight", status: "ok", artifacts: [] },
				{ step: "worktree", status: "skipped", artifacts: [] },
				{
					step: "pane",
					status: "ok",
					artifacts: [{ kind: "agent_registration", id: "agent-spawn" }],
				},
				{
					step: "runtime_session",
					status: "ok",
					artifacts: [],
					detail: { initialPromptAccepted: true },
				},
				{ step: "provider_exec", status: "ok", artifacts: [] },
				{ step: "prompt_delivery", status: "pending", artifacts: [] },
			],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.ensureManaged).not.toHaveBeenCalled();
		expect(mocks.sendInitialPrompt).not.toHaveBeenCalled();
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_succeeded",
				step: "prompt_delivery",
				detail: expect.objectContaining({
					deliveryContract: "provider_launch_v1",
					promptDigest,
					promptLen: 7,
				}),
			}),
		);
	});

	it("classifies resume-time runtime resolution failure before prompt dispatch as not written", async () => {
		const digest = mockPromptDigest();
		try {
			store.agents = [agent];
			mocks.receipt.mockResolvedValue({
				v: 1,
				receiptId: "spawn-1",
				request: {
					receiptId: "spawn-1",
					project: "project",
					provider: "codex",
					useWorktree: false,
					promptDigest,
					promptLen: 7,
				},
				steps: [
					{ step: "preflight", status: "ok", artifacts: [] },
					{ step: "worktree", status: "skipped", artifacts: [] },
					{
						step: "pane",
						status: "ok",
						artifacts: [{ kind: "agent_registration", id: "agent-spawn" }],
					},
					{ step: "runtime_session", status: "ok", artifacts: [] },
					{ step: "provider_exec", status: "ok", artifacts: [] },
					{ step: "prompt_delivery", status: "pending", artifacts: [] },
				],
				state: "running",
				updatedAt: 1,
			});
			mocks.ensureManaged.mockRejectedValueOnce(new Error("catalog unavailable"));

			await runSpawnSagaFromCli({ receiptId: "spawn-1", prompt: "ship it" });

			expect(mocks.sendInitialPrompt).not.toHaveBeenCalled();
			expect(mocks.append).toHaveBeenCalledWith(
				"spawn-1",
				expect.objectContaining({
					event: "step_failed",
					step: "prompt_delivery",
					error: expect.objectContaining({
						code: "managed_runtime_unavailable",
						deliveryState: "not_written",
					}),
				}),
			);
		} finally {
			digest.mockRestore();
		}
	});

	it("rolls back a created registration and its pane through one durable authority", async () => {
		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(store.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "account-codex-work" }),
		);
		expect(mocks.removeDurably).not.toHaveBeenCalled();
		expect(mocks.rawClose).not.toHaveBeenCalled();
		expect(mocks.rollbackRegistration).toHaveBeenCalledWith(agent, {
			conversationId: undefined,
			conversationIdentity: undefined,
		});
	});

	it("rolls back the admitted create generation after prompt delivery fails", async () => {
		mocks.ensureManaged.mockResolvedValue({
			agent: successorAgent,
			session: {
				sessionId: successorAgent.sessionId,
				workspaceId: successorRuntimeBinding.workspaceId,
			},
			idempotencyKey: successorRuntimeBinding.createIdempotencyKey,
			cwd: successorAgent.worktreePath,
			outcome: "created",
		});
		mocks.executePromptDelivery.mockRejectedValueOnce(
			new Error("post-create delivery setup failed"),
		);

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.rollbackRegistration).toHaveBeenCalledWith(successorAgent, {
			conversationId: undefined,
			conversationIdentity: undefined,
		});
		expect(mocks.removeDurably).not.toHaveBeenCalled();
	});

	it.each(["agent:agent-spawn", "slot", "launcher:previous", "agent:unrelated"])("preserves an owned conversation successor when its pane is %s", async (paneId) => {
		mocks.openPanel.mockReturnValue(paneId);
		const admitted = {
			...agent,
			started: true,
		};
		const conversationSuccessor = {
			...admitted,
			conversationId: "conversation-successor",
			conversationIdentity: {
				state: "ready" as const,
				conversationId: "conversation-successor",
			},
		};
		mocks.ensureManaged.mockResolvedValue({
			agent: admitted,
			session: {
				sessionId: admitted.sessionId,
				workspaceId: localRuntimeBinding.workspaceId,
			},
			idempotencyKey: localRuntimeBinding.createIdempotencyKey,
			cwd: admitted.worktreePath,
			outcome: "created",
		});
		mocks.executePromptDelivery.mockImplementationOnce(async () => {
			store.agents = [conversationSuccessor];
			throw new Error("post-create delivery setup failed");
		});
		mocks.rollbackRegistration.mockImplementationOnce(
			async (
				_registration: typeof admitted,
				evidence?: {
					conversationId?: string;
					conversationIdentity?: typeof conversationSuccessor.conversationIdentity;
				},
			) => {
				const current = store.agents[0] as typeof conversationSuccessor | undefined;
				const evidenceStillMatches =
					evidence !== undefined &&
					current !== undefined &&
						current.conversationId === evidence.conversationId &&
						current.conversationIdentity?.state ===
							evidence.conversationIdentity?.state &&
						current.conversationIdentity?.conversationId ===
							evidence.conversationIdentity?.conversationId;
				if (!evidence || evidenceStillMatches) store.agents = [];
				return evidenceStillMatches;
			},
		);

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.rollbackRegistration).toHaveBeenCalledWith(admitted, {
			conversationId: undefined,
			conversationIdentity: undefined,
		});
		expect(store.agents).toEqual([conversationSuccessor]);
		expect(mocks.removeDurably).not.toHaveBeenCalled();
		expect(mocks.append).toHaveBeenCalledWith("spawn-1", expect.objectContaining({ event: "artifact_created", artifact: { kind: "pane", id: paneId, agentId: agent.id, desktopId: "desktop-1" } }));
	});

	it("rolls back the admitted create generation when reused-session cwd validation fails", async () => {
		const existingWorktreeRef = {
			canonicalPath: agent.worktreePath,
			gitCommonDir: "/repo/.git",
			gitDir: "/repo/.git/worktrees/main",
			branch: agent.branch,
			head: "0123456789abcdef0123456789abcdef01234567",
		};
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				accountId: "account-codex-work",
				useWorktree: true,
				existingWorktreeRef,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});
		mocks.resolveExistingWorktree.mockResolvedValue({
			state: "resolved",
			handle: {
				reference: existingWorktreeRef,
				disposition: "reused",
				claimId: "wtc_exact",
				receiptId: "spawn-1",
			},
		});
		mocks.ensureManaged.mockResolvedValue({
			agent: successorAgent,
			session: {
				sessionId: successorAgent.sessionId,
				workspaceId: successorRuntimeBinding.workspaceId,
			},
			idempotencyKey: successorRuntimeBinding.createIdempotencyKey,
			cwd: "/different-checkout",
			outcome: "created",
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.rollbackRegistration).toHaveBeenCalledWith(successorAgent, {
			conversationId: undefined,
			conversationIdentity: undefined,
		});
		expect(mocks.rollbackRegistration).toHaveBeenCalledOnce();
	});

	it("removes only the pane when compensation adopted an existing registration", async () => {
		store.agents = [agent];
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				name: agent.name,
				provider: "codex",
				useWorktree: false,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.removeDurably).toHaveBeenCalledWith(["agent:agent-spawn"]);
		expect(mocks.rollbackRegistration).not.toHaveBeenCalled();
	});

	it("hands the planless worktree artifact to pane registration without replanning", async () => {
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: true,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.createWorktree).toHaveBeenCalledTimes(1);
		expect(store.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				useWorktree: true,
				provisionedWorktree: {
					path: "/repo/.worktrees/codex-1",
					branch: "agent/codex-1",
				},
			}),
		);
	});

	it("resumes pane registration from the journaled worktree artifact", async () => {
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: true,
			},
			steps: [
				{
					step: "worktree",
					status: "ok",
					artifacts: [
						{
							kind: "worktree",
							id: "/repo/.worktrees/codex-1",
							branch: "agent/codex-1",
						},
					],
				},
			],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.createWorktree).not.toHaveBeenCalled();
		expect(store.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				provisionedWorktree: {
					path: "/repo/.worktrees/codex-1",
					branch: "agent/codex-1",
				},
			}),
		);
	});

	it("fails closed when a completed worktree step lost its typed artifact", async () => {
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: true,
			},
			steps: [
				{
					step: "worktree",
					status: "ok",
					artifacts: [
						{ kind: "worktree", id: "/repo/.worktrees/codex-1" },
					],
				},
			],
			state: "running",
			updatedAt: 1,
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_failed",
				step: "pane",
				error: expect.objectContaining({ code: "worktree_artifact_missing" }),
			}),
		);
	});

	it("blocks a second provider on the same exact worktree before agent, pane, or runtime mutation", async () => {
		const existingWorktreeRef = {
			canonicalPath: "/repo/.worktrees/shared",
			gitCommonDir: "/repo/.git",
			gitDir: "/repo/.git/worktrees/shared",
			branch: "agent/shared",
			head: "0123456789abcdef0123456789abcdef01234567",
		};
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				name: "claude-shared",
				provider: "claude",
				useWorktree: true,
				existingWorktreeRef,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});
		mocks.resolveExistingWorktree.mockResolvedValue({
			state: "refused",
			code: "existing_worktree_live_owned",
			message: "agent-codex already owns this checkout",
			recovery: "close agent-codex first",
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.resolveExistingWorktree).toHaveBeenCalledWith(
			"/repo",
			existingWorktreeRef,
			"spawn-1",
		);
		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.openPanel).not.toHaveBeenCalled();
		expect(mocks.ensureManaged).not.toHaveBeenCalled();
		expect(mocks.provisionWorktree).not.toHaveBeenCalled();
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_failed",
				step: "worktree",
				error: expect.objectContaining({
					code: "existing_worktree_live_owned",
				}),
			}),
		);
	});

	it("reuses the existing saga and records reused checkout plus verified pane/session cwd", async () => {
		const existingWorktreeRef = {
			canonicalPath: "/repo/.worktrees/existing",
			gitCommonDir: "/repo/.git",
			gitDir: "/repo/.git/worktrees/existing",
			branch: "agent/existing",
			head: "0123456789abcdef0123456789abcdef01234567",
		};
		const reusedAgent = {
			...agent,
			name: "agent-existing",
			worktreePath: existingWorktreeRef.canonicalPath,
			branch: existingWorktreeRef.branch,
		};
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				name: reusedAgent.name,
				provider: "codex",
				useWorktree: true,
				existingWorktreeRef,
			},
			steps: [],
			state: "running",
			updatedAt: 1,
		});
		mocks.resolveExistingWorktree.mockResolvedValue({
			state: "resolved",
			handle: {
				reference: existingWorktreeRef,
				disposition: "reused",
				claimId: "wtc_exact",
				receiptId: "spawn-1",
			},
		});
		store.addAgent.mockResolvedValue(reusedAgent);
		mocks.ensureManaged.mockResolvedValue({
			agent: reusedAgent,
			session: { sessionId: "agent-spawn", workspaceId: "workspace-1" },
			idempotencyKey: "create-1",
			cwd: existingWorktreeRef.canonicalPath,
			outcome: "created",
		});

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.resolveExistingWorktree).toHaveBeenCalledTimes(2);
		expect(store.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				provisionedWorktree: {
					path: existingWorktreeRef.canonicalPath,
					branch: existingWorktreeRef.branch,
				},
			}),
		);
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "artifact_adopted",
				step: "worktree",
				artifact: expect.objectContaining({ disposition: "reused" }),
			}),
		);
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_succeeded",
				step: "pane",
				detail: expect.objectContaining({ cwd: existingWorktreeRef.canonicalPath }),
			}),
		);
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_succeeded",
				step: "runtime_session",
				detail: expect.objectContaining({ cwd: existingWorktreeRef.canonicalPath }),
			}),
		);
	});

	it("stops after an unjournaled worktree and adopts that exact artifact on retry", async () => {
		const request = {
			receiptId: "spawn-1",
			project: "project",
			name: "feature",
			provider: "codex",
			useWorktree: true,
			worktreePlan: {
				branch: "feature",
				worktreePath: "/repo/.worktrees/feature",
				action: "create-new-branch",
			},
		};
		mocks.receipt
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [],
				state: "running",
				updatedAt: 1,
			})
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [
					{ step: "preflight", status: "ok", artifacts: [] },
					{
						step: "worktree",
						status: "running",
						artifacts: [],
						detail: {
							intent: {
								path: "/repo/.worktrees/feature",
								branch: "feature",
								agentName: "feature",
								mode: "planned",
							},
						},
					},
				],
				state: "running",
				updatedAt: 2,
			});
		mocks.ensureManaged.mockResolvedValue({
			session: { sessionId: "agent-spawn", workspaceId: "workspace-1" },
			idempotencyKey: "create-1",
		});
		mocks.listDir
			.mockRejectedValueOnce(new Error("missing"))
			.mockResolvedValueOnce([]);
		mocks.provisionWorktree.mockResolvedValue({
			path: "/repo/.worktrees/feature",
			branch: "feature",
		});
		let rejectedArtifact = false;
		mocks.append.mockImplementation(
			async (_receiptId: string, event: Record<string, unknown>) => {
				if (
					!rejectedArtifact &&
					event.event === "artifact_created" &&
					event.step === "worktree"
				) {
					rejectedArtifact = true;
					throw new Error("journal fsync failed");
				}
			},
		);

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.createWorktree).not.toHaveBeenCalled();
		expect(mocks.provisionWorktree).toHaveBeenCalledTimes(1);
		expect(mocks.append).toHaveBeenCalledWith("spawn-1", {
			event: "step_started",
			step: "worktree",
			detail: {
				intent: {
					path: "/repo/.worktrees/feature",
					branch: "feature",
					agentName: "feature",
					mode: "planned",
				},
			},
		});
		expect(mocks.provisionWorktree).toHaveBeenLastCalledWith({
			repo: "/repo",
			branch: "feature",
			worktreePath: "/repo/.worktrees/feature",
			action: "create-new-branch",
		});
		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.ensureManaged).not.toHaveBeenCalled();
		expect(mocks.rollbackRegistration).not.toHaveBeenCalled();

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.createWorktree).not.toHaveBeenCalled();
		expect(mocks.provisionWorktree).toHaveBeenCalledTimes(2);
		expect(mocks.provisionWorktree).toHaveBeenLastCalledWith({
			repo: "/repo",
			branch: "feature",
			worktreePath: "/repo/.worktrees/feature",
			action: "adopt-worktree",
		});
		expect(store.addAgent).toHaveBeenCalledTimes(1);
		expect(mocks.ensureManaged).toHaveBeenCalledTimes(1);
	});

	it("never turns a fresh-path collision into implicit worktree reuse", async () => {
		const request = {
			receiptId: "spawn-1",
			project: "project",
			name: "feature",
			provider: "codex",
			useWorktree: true,
			worktreePlan: {
				branch: "feature",
				worktreePath: "/repo/.worktrees/feature",
				action: "create-new-branch",
			},
		};
		mocks.receipt
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [],
				state: "running",
				updatedAt: 1,
			})
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [
					{ step: "preflight", status: "ok", artifacts: [] },
					{
						step: "worktree",
						status: "failed",
						artifacts: [],
						detail: {
							intent: {
								path: "/repo/.worktrees/feature",
								branch: "feature",
								agentName: "feature",
								mode: "planned",
							},
						},
					},
				],
				state: "failed",
				updatedAt: 2,
			});
		mocks.listDir.mockResolvedValue([]);

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });
		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(mocks.provisionWorktree).not.toHaveBeenCalled();
		expect(store.addAgent).not.toHaveBeenCalled();
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_failed",
				step: "worktree",
				error: expect.objectContaining({ code: "worktree_path_collision" }),
			}),
		);
	});

	it("does not launch the provider after pane success could not be journaled", async () => {
		const request = {
			receiptId: "spawn-1",
			project: "project",
			name: "codex-1",
			provider: "codex",
			useWorktree: false,
		};
		mocks.receipt
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [],
				state: "running",
				updatedAt: 1,
			})
			.mockResolvedValueOnce({
				v: 1,
				receiptId: "spawn-1",
				request,
				steps: [
					{ step: "preflight", status: "ok", artifacts: [] },
					{ step: "worktree", status: "skipped", artifacts: [] },
					{
						step: "pane",
						status: "running",
						artifacts: [
							{ kind: "agent_registration", id: "agent-spawn" },
							{ kind: "pane", id: "agent:agent-spawn" },
						],
					},
				],
				state: "running",
				updatedAt: 2,
			});
		mocks.ensureManaged.mockResolvedValue({
			session: { sessionId: "agent-spawn", workspaceId: "workspace-1" },
			idempotencyKey: "create-1",
		});
		store.addAgent.mockImplementation(async () => {
			store.agents = [agent];
			return agent;
		});
		let rejectedPaneSuccess = false;
		mocks.append.mockImplementation(
			async (_receiptId: string, event: Record<string, unknown>) => {
				if (
					!rejectedPaneSuccess &&
					event.event === "step_succeeded" &&
					event.step === "pane"
				) {
					rejectedPaneSuccess = true;
					throw new Error("journal fsync failed");
				}
			},
		);

		await runSpawnSagaFromCli({ receiptId: "spawn-1" });
		await runSpawnSagaFromCli({ receiptId: "spawn-1" });

		expect(store.addAgent).toHaveBeenCalledTimes(1);
		expect(mocks.ensureManaged).toHaveBeenCalledTimes(1);
		expect(mocks.removeDurably).not.toHaveBeenCalled();
		expect(mocks.rollbackRegistration).not.toHaveBeenCalled();
	});

	it("re-enters the Host after a successful receipt cannot be fsynced", async () => {
		const digest = mockPromptDigest();
		mocks.ensureManaged.mockResolvedValue({
			agent,
			session: { sessionId: "agent-spawn", workspaceId: "workspace-1" },
			idempotencyKey: "create-1",
			cwd: "/repo",
			outcome: "reused",
		});
		try {
			const promptStep: Record<string, unknown> = {
				step: "prompt_delivery",
				status: "pending",
				artifacts: [],
			};
			const receipt = {
				v: 1,
				receiptId: "spawn-1",
				request: {
					receiptId: "spawn-1",
					project: "project",
					provider: "codex",
					useWorktree: false,
					promptDigest,
					promptLen: 7,
				},
				steps: [
					{ step: "preflight", status: "ok", artifacts: [] },
					{ step: "worktree", status: "skipped", artifacts: [] },
					{ step: "runtime_session", status: "ok", artifacts: [] },
					{
						step: "pane",
						status: "ok",
						artifacts: [
							{ kind: "agent_registration", id: "agent-spawn" },
						],
					},
					{ step: "provider_exec", status: "ok", artifacts: [] },
					promptStep,
				],
				state: "running",
				updatedAt: 1,
			};
			store.agents = [agent];
			mocks.receipt.mockImplementation(async () => structuredClone(receipt));
			const refusal = new ManagedAgentInputError(
				"hmux_agent_prompt_runtime_changed",
				"one-shot already consumed",
			);
			refusal.deliveryState = "not_written";
			mocks.sendInitialPrompt
				.mockResolvedValueOnce(promptInputReceipt)
				.mockRejectedValueOnce(refusal);
			let refusedSuccessAppend = false;
			mocks.append.mockImplementation(
				async (_receiptId: string, event: Record<string, unknown>) => {
					if (
						event.event === "step_started" &&
						event.step === "prompt_delivery"
					) {
						promptStep.status = "running";
						if (event.detail !== undefined) promptStep.detail = event.detail;
						return;
					}
					if (
						event.event === "step_succeeded" &&
						event.step === "prompt_delivery" &&
						!refusedSuccessAppend
					) {
						refusedSuccessAppend = true;
						expect(event.detail).toMatchObject({
							deliveryContract: "host_atomic_v1",
							receipt: promptInputReceipt,
						});
						throw new Error("Host receipt fsync failed");
					}
					if (
						event.event === "step_failed" &&
						event.step === "prompt_delivery"
					) {
						promptStep.status = "failed";
						promptStep.error = event.error;
						return;
					}
					if (event.event === "saga_finished") {
						receipt.state = String(event.state);
					}
				},
			);

			await runSpawnSagaFromCli({
				receiptId: "spawn-1",
				prompt: "ship it",
			});

			await runSpawnSagaFromCli({
				receiptId: "spawn-1",
				prompt: "ship it",
			});
			await runSpawnSagaFromCli({
				receiptId: "spawn-1",
				prompt: "ship it",
			});

			expect(mocks.sendInitialPrompt).toHaveBeenCalledTimes(2);
			expect(mocks.sendInitialPrompt).toHaveBeenCalledWith(
				agent,
				"ship it",
			);
			expect(receipt.state).toBe("manual_intervention_required");
			expect(promptStep.error).toMatchObject({
				code: "hmux_agent_prompt_runtime_changed",
				deliveryState: "unknown",
			});
		} finally {
			digest.mockRestore();
		}
	});

	it("fails closed for an agent without a managed binding — the legacy runtime is retired", async () => {
		const orphanAgent = {
			...agent,
			runtimeBinding: undefined,
		} as unknown as typeof agent;
		const receipt = {
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				provider: "codex",
				useWorktree: false,
				promptDigest,
				promptLen: 7,
			},
			steps: [
				{ step: "preflight", status: "ok", artifacts: [] },
				{ step: "worktree", status: "skipped", artifacts: [] },
				{
					step: "pane",
					status: "ok",
					artifacts: [{ kind: "agent_registration", id: "agent-spawn" }],
				},
				{ step: "runtime_session", status: "pending", artifacts: [] },
				{ step: "provider_exec", status: "pending", artifacts: [] },
				{ step: "prompt_delivery", status: "pending", artifacts: [] },
			],
			state: "running",
			updatedAt: 1,
		};
		store.agents = [orphanAgent];
		mocks.receipt.mockResolvedValue(receipt);

		await runSpawnSagaFromCli({ receiptId: "spawn-1", prompt: "ship it" });

		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({
				event: "step_failed",
				step: "runtime_session",
				error: expect.objectContaining({ code: "legacy_runtime_retired" }),
			}),
		);
		expect(mocks.append).toHaveBeenCalledWith(
			"spawn-1",
			expect.objectContaining({ event: "saga_finished", state: "failed" }),
		);
		expect(mocks.sessionWrite).not.toHaveBeenCalled();
	});

	it("keeps the durable worktree input authoritative over retry hints", async () => {
		const worktreePlan = {
			branch: "feature",
			worktreePath: "/repo/.worktrees/feature",
			action: "create-new-branch",
		};
		mocks.receipt.mockResolvedValue({
			v: 1,
			receiptId: "spawn-1",
			request: {
				receiptId: "spawn-1",
				project: "project",
				name: "feature",
				provider: "codex",
				useWorktree: true,
				worktreePlan,
			},
			steps: [
				{ step: "preflight", status: "ok", artifacts: [] },
				{
					step: "worktree",
					status: "running",
					artifacts: [],
					detail: {
						intent: {
							path: worktreePlan.worktreePath,
							branch: worktreePlan.branch,
							agentName: "feature",
							mode: "planned",
						},
					},
				},
			],
			state: "running",
			updatedAt: 2,
		});
		mocks.listDir.mockRejectedValue(new Error("missing"));
		mocks.provisionWorktree.mockResolvedValue({
			path: worktreePlan.worktreePath,
			branch: worktreePlan.branch,
		});
		mocks.ensureManaged.mockResolvedValue({
			session: { sessionId: "agent-spawn", workspaceId: "workspace-1" },
			idempotencyKey: "create-1",
		});

		await runSpawnSagaFromCli({
			receiptId: "spawn-1",
			name: "changed-hint",
			worktreePlan: {
				branch: "changed-hint",
				worktreePath: "/repo/.worktrees/changed-hint",
				action: "create-new-branch",
			},
		});

		expect(mocks.provisionWorktree).toHaveBeenCalledWith({
			repo: "/repo",
			...worktreePlan,
		});
		expect(store.addAgent).toHaveBeenCalledWith(
			expect.objectContaining({ name: "feature" }),
		);
	});
});
